import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const MAX_AGENT_MESSAGE_BYTES = 4 * 1024 * 1024;
export interface AgentRequest { id: string; method: 'list' | 'call'; name?: string; args?: Record<string, unknown> }
export interface AgentResponse { id: string; result?: unknown; error?: string }
export interface AgentConnectionStatus { enabled: boolean; editor?: string; command?: string; args?: string[]; env?: Record<string, string>; error?: string }
export interface AgentBridgeOptions {
  userDataPath: string;
  command: string;
  argsPrefix?: string[];
  env?: Record<string, string>;
  locatorDirectory?: string;
  onRequest(request: AgentRequest): void;
  onStatus?(status: AgentConnectionStatus): void;
  timeoutMs?: number;
  maxMessageBytes?: number;
  maxPending?: number;
}
const validSession = /^cutwright-[a-f0-9]{16}-[a-f0-9]{32}$/;
const validEditor = /^cutwright-[a-f0-9]{16}$/;
const defaultLocatorDirectory = () => path.join(os.homedir(), '.cutwright', 'agent-connections');
function locatorPath(editor: string, directory: string): string {
  if (!validEditor.test(editor)) throw new Error('Invalid editor profile identity.');
  return path.join(directory, `${editor}.json`);
}
export function resolveAgentEditor(editor: string, directory = defaultLocatorDirectory()): string {
  const file = locatorPath(editor, directory);
  try {
    if (fs.statSync(file).size > 4096) throw new Error('Invalid locator size');
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record(value) || value.version !== 1 || value.editor !== editor || typeof value.session !== 'string'
      || !validSession.test(value.session) || !value.session.startsWith(editor + '-')) throw new Error('Invalid locator');
    return value.session;
  } catch { throw new Error('This editor profile is not connected. Open it and enable External agent connections.'); }
}
export function agentPipeAddress(session: string): string {
  if (!validSession.test(session)) throw new Error('Invalid editor connection session.');
  return process.platform === 'win32' ? `\\\\.\\pipe\\${session}` : path.join(os.tmpdir(), `${session}.sock`);
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Bounded newline-delimited JSON for the local pipe, never an HTTP port. */
function readLines(socket: net.Socket, maxBytes: number, receive: (value: unknown) => void, fail: (message: string) => void) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > maxBytes) { fail('Agent message exceeds the local connection limit.'); return; }
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (!line.toString('utf8').trim()) continue;
      try { receive(JSON.parse(line.toString('utf8'))); }
      catch { fail('Invalid JSON on the local agent connection.'); return; }
      if (socket.destroyed) return;
    }
    if (pending.length > maxBytes) fail('Agent message exceeds the local connection limit.');
  });
}
function send(socket: net.Socket, message: unknown, maxBytes: number): void {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('Agent response exceeds the local connection limit.');
  if (socket.destroyed || socket.writableLength > maxBytes * 2) throw new Error('Agent connection closed or stopped reading.');
  socket.write(json + '\n');
}

/** Only the enabled editor owns a listening pipe. Every enable generates a
 * fresh session capability, scoped to this userData directory and process. */
export function createAgentBridge(options: AgentBridgeOptions) {
  const maxBytes = options.maxMessageBytes ?? MAX_AGENT_MESSAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxPending = options.maxPending ?? 16;
  const owner = createHash('sha256').update(path.resolve(options.userDataPath)).digest('hex').slice(0, 16);
  const editor = `cutwright-${owner}`;
  const directory = options.locatorDirectory ?? defaultLocatorDirectory();
  const locator = locatorPath(editor, directory), lock = locator + '.lock';
  let activeSession = '';
  let lockFd: number | null = null;
  let server: net.Server | null = null;
  let status: AgentConnectionStatus = { enabled: false };
  let address = '';
  let disposed = false;
  let changing = Promise.resolve<AgentConnectionStatus>(status);
  const sockets = new Set<net.Socket>();
  const pending = new Map<string, { socket: net.Socket; clientId: string; timer: ReturnType<typeof setTimeout> }>();
  const getStatus = () => ({ ...status, ...(status.args ? { args: [...status.args] } : {}), ...(status.env ? { env: { ...status.env } } : {}) });
  const publish = () => { options.onStatus?.(getStatus()); return getStatus(); };
  const reply = (socket: net.Socket, value: unknown) => {
    try { send(socket, value, maxBytes); } catch { socket.destroy(); }
  };
  const forgetSocket = (socket: net.Socket) => {
    sockets.delete(socket);
    for (const [id, request] of pending) if (request.socket === socket) { clearTimeout(request.timer); pending.delete(id); }
  };
  const removeOwnedFile = (file: string) => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { session?: string };
      if (value.session === activeSession) fs.unlinkSync(file);
    } catch { /* Missing or owned by another editor. */ }
  };
  const acquireProfile = (session: string) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { lockFd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerAlive = true;
      try {
        if (fs.statSync(lock).size > 4096) throw new Error('Invalid lock');
        const previous = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: number };
        if (!Number.isInteger(previous.pid) || previous.pid! <= 0) throw new Error('Invalid lock');
        try { process.kill(previous.pid!, 0); } catch (probe) { ownerAlive = (probe as NodeJS.ErrnoException).code !== 'ESRCH'; }
      } catch { throw new Error('Another editor owns this profile connection. Close it before enabling this connection.'); }
      if (ownerAlive) throw new Error('Another editor already has External agent connections enabled for this profile. Disable that connection first.');
      fs.unlinkSync(lock);
      lockFd = fs.openSync(lock, 'wx', 0o600);
    }
    activeSession = session;
    fs.writeFileSync(lockFd, JSON.stringify({ version: 1, editor, session, pid: process.pid }));
  };
  const publishLocator = () => {
    const temporary = path.join(directory, `.${activeSession}.partial`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, editor, session: activeSession, pid: process.pid }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, locator);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const close = async () => {
    status = { enabled: false };
    if (activeSession) removeOwnedFile(locator);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      reply(request.socket, { id: request.clientId, error: 'External agent connection was disabled.' });
    }
    pending.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    const previous = server; server = null;
    if (previous) await new Promise<void>((resolve) => previous.close(() => resolve()));
    // Unix sockets are removed by Node on close; only unlink our exact
    // generated socket path if startup failed before Node could remove it.
    if (process.platform !== 'win32' && address && fs.existsSync(address)) {
      try { fs.unlinkSync(address); } catch { /* already removed */ }
    }
    address = '';
    if (lockFd !== null) { fs.closeSync(lockFd); lockFd = null; }
    if (activeSession) removeOwnedFile(lock);
    activeSession = '';
  };
  const respond = (response: AgentResponse) => {
    if (!record(response) || typeof response.id !== 'string') return;
    const request = pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(response.id);
    try {
      send(request.socket, response.error ? { id: request.clientId, error: String(response.error).slice(0, 4000) }
        : { id: request.clientId, result: response.result ?? null }, maxBytes);
    } catch (error) { reply(request.socket, { id: request.clientId, error: error instanceof Error ? error.message : String(error) }); }
  };
  const setEnabled = (enabled: boolean): Promise<AgentConnectionStatus> => {
    changing = changing.then(async () => {
      if (!enabled) { await close(); return publish(); }
      if (disposed) return { enabled: false, error: 'The editor connection is closed.' };
      if (status.enabled) return getStatus();
      const session = `cutwright-${owner}-${randomBytes(16).toString('hex')}`;
      try { acquireProfile(session); }
      catch (error) { await close(); status = { enabled: false, error: error instanceof Error ? error.message : String(error) }; return publish(); }
      address = agentPipeAddress(session);
      const listener = net.createServer((socket) => {
        if (!status.enabled || sockets.size >= 16) { socket.destroy(); return; }
        sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.once('close', () => forgetSocket(socket));
        const fail = (message: string) => { reply(socket, { id: null, error: message }); socket.end(() => socket.destroy()); };
        readLines(socket, maxBytes, (value) => {
          if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128
            || (value.method !== 'list' && value.method !== 'call')
            || value.method === 'call' && (typeof value.name !== 'string' || !value.name || value.name.length > 256 || value.name.includes('\0') || value.args !== undefined && !record(value.args))) {
            fail('Invalid editor tool request.'); return;
          }
          if (pending.size >= maxPending) { reply(socket, { id: value.id, error: 'Too many pending editor requests. Wait for the current request to finish.' }); return; }
          if ([...pending.values()].some((p) => p.socket === socket && p.clientId === value.id)) { fail('Duplicate editor request ID.'); return; }
          const id = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reply(socket, { id: value.id, error: 'Editor request timed out. Inspect the editor state before retrying a change.' });
          }, timeoutMs);
          pending.set(id, { socket, clientId: value.id, timer });
          try { options.onRequest({ id, method: value.method, ...(value.method === 'call' ? { name: value.name as string, args: value.args as Record<string, unknown> ?? {} } : {}) }); }
          catch (error) { respond({ id, error: error instanceof Error ? error.message : String(error) }); }
        }, fail);
      });
      server = listener;
      try {
        await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(address, resolve); });
        if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
        listener.on('error', () => { void setEnabled(false); });
        status = { enabled: true, editor, command: options.command, args: [...(options.argsPrefix ?? []), '--mcp-stdio', `--editor=${editor}`], ...(options.env ? { env: { ...options.env } } : {}) };
        publishLocator();
      } catch (error) {
        await close();
        status = { enabled: false, error: `Could not enable the local agent connection: ${error instanceof Error ? error.message : String(error)}` };
      }
      return publish();
    });
    return changing;
  };
  return { setEnabled, getStatus, respond, async dispose() { disposed = true; return setEnabled(false); }, get pendingCount() { return pending.size; } };
}

/** Headless stdio adapters connect only to the current enabled pipe. */
export async function connectAgentSession(session: string, options: { timeoutMs?: number; maxMessageBytes?: number } = {}) {
  const maxBytes = options.maxMessageBytes ?? MAX_AGENT_MESSAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? 35_000;
  const socket = net.createConnection(agentPipeAddress(session));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Timed out connecting to the editor.')); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => { clearTimeout(timer); reject(new Error('Editor connection is disabled or no longer available. Enable External agent connections in the open editor.')); });
  });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  socket.once('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The editor connection closed or was disabled.')); }
    pending.clear(); resolveClosed();
  });
  readLines(socket, maxBytes, (value) => {
    if (!record(value) || typeof value.id !== 'string') { socket.destroy(); return; }
    const request = pending.get(value.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(value.id);
    if (typeof value.error === 'string') request.reject(new Error(value.error)); else request.resolve(value.result);
  }, () => socket.destroy());
  const request = (method: 'list' | 'call', name?: string, args?: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new Error('The editor connection is closed.')); return; }
    if (pending.size >= 16) { reject(new Error('Too many pending editor tool requests.')); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Editor request timed out. Inspect its state before retrying a change.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send(socket, { id, method, ...(method === 'call' ? { name, args: args ?? {} } : {}) }, maxBytes); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
  });
  return { request, closed, dispose: () => socket.destroy() };
}
