import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, basename, extname, dirname } from 'node:path';
import { allowedConnectorOrigin, CONNECTOR_PORTS, CONNECTOR_PROTOCOL, MAX_CONNECTOR_BYTES, type ConnectorClient, type ConnectorRequest } from './protocol';

type Waiting = { request: ConnectorRequest; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export async function createConnectorServer(options: { client: ConnectorClient; version: string; ports?: number[]; callTimeout?: number; leaseTimeout?: number }) {
  let port = 0;
  const session = randomBytes(3).toString('hex').toUpperCase();
  let pair: { token: string; origin: string; lastSeen: number } | undefined;
  let polling: ServerResponse | undefined;
  const pending = new Map<string, Waiting>();
  let queue: ConnectorRequest[] = [];
  const staged = new Map<string, { path: string; token: string; size: number; mime: string }>();
  const destinations = new Map<string, { path: string; token: string }>();
  const leaseTimeout = options.leaseTimeout ?? 45_000;
  const send = (response: ServerResponse, code: number, value: unknown) => {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify(value);
    response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
  };
  const disconnect = (reason: string) => {
    pair = undefined; staged.clear(); destinations.clear();
    if (polling) { send(polling, 410, { error: reason }); polling = undefined; }
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(reason)); }
    pending.clear(); queue = [];
  };
  const expire = () => { if (pair && !pending.size && Date.now() - pair.lastSeen > leaseTimeout) disconnect('The browser tab disconnected. Click Connect in CutWright again.'); };
  const flush = () => {
    if (!polling || !queue.length) return;
    const response = polling; polling = undefined;
    send(response, 200, { requests: queue.splice(0, 1) });
  };
  const body = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON required.');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_CONNECTOR_BYTES) throw new Error('Request exceeds connector limit.');
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== `127.0.0.1:${port}`) { send(response, 403, { error: 'Loopback host required.' }); return; }
      const origin = request.headers.origin;
      if (origin && !allowedConnectorOrigin(origin)) { send(response, 403, { error: 'Origin is not allowed.' }); return; }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.setHeader('Access-Control-Max-Age', '600');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      expire();
      if (request.method === 'GET' && request.url === '/health') {
        send(response, 200, { application: 'cutwright-connector', protocol: CONNECTOR_PROTOCOL, version: options.version, client: options.client, session, paired: !!pair, port, processId: process.pid }); return;
      }
      if (!origin) { send(response, 403, { error: 'Browser origin required.' }); return; }
      if (request.method === 'POST' && request.url?.startsWith('/downloads/')) {
        const key = request.url.slice('/downloads/'.length), target = destinations.get(key);
        if (!pair || origin !== pair.origin || !target || request.headers.authorization !== `Bearer ${target.token}`) { send(response, 401, { error: 'Local transfer is unavailable.' }); return; }
        destinations.delete(key); pair.lastSeen = Date.now();
        let created = false, bytes = 0;
        const output = createWriteStream(target.path, { flags: 'wx' });
        output.once('open', () => { created = true; });
        request.on('data', chunk => { bytes += chunk.length; });
        try { await pipeline(request, output); send(response, 200, { ok: true, outputPath: target.path, bytes }); }
        catch (error) { if (created) await unlink(target.path).catch(() => {}); throw error; }
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/media/')) {
        const file = staged.get(request.url.slice('/media/'.length));
        if (!pair || origin !== pair.origin || !file || request.headers.authorization !== `Bearer ${file.token}`) { send(response, 401, { error: 'Local transfer is unavailable.' }); return; }
        pair.lastSeen = Date.now();
        response.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.size, 'Cache-Control': 'no-store' });
        const stream = createReadStream(file.path);
        response.once('close', () => stream.destroy());
        stream.on('error', () => response.destroy()); stream.pipe(response); return;
      }
      if (request.method === 'POST' && request.url === '/connect') {
        const input = await body(request);
        if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) { send(response, 400, { error: 'A fresh per-tab token is required.' }); return; }
        if (pair && (pair.token !== input.token || pair.origin !== origin)) { send(response, 409, { error: 'This agent session is connected to another tab. Disconnect there first, or choose another agent session.' }); return; }
        pair = { token: input.token, origin, lastSeen: Date.now() };
        send(response, 200, { ok: true, session }); return;
      }
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!pair || origin !== pair.origin || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(pair.token))) {
        send(response, 401, { error: 'This tab is not connected. Click Connect in CutWright.' }); return;
      }
      if (request.method === 'GET' && request.url === '/poll') {
        pair.lastSeen = Date.now();
        if (polling) { send(response, 409, { error: 'A poll is already active.' }); return; }
        polling = response;
        const timer = setTimeout(() => { if (polling === response) { polling = undefined; send(response, 200, { requests: [] }); } }, 15_000);
        response.once('close', () => { clearTimeout(timer); if (polling === response) polling = undefined; });
        flush(); return;
      }
      if (request.method === 'POST' && request.url === '/result') {
        const input = await body(request);
        const item = typeof input.id === 'string' ? pending.get(input.id) : undefined;
        if (!item) { send(response, 409, { error: 'Request expired or was already answered.' }); return; }
        pending.delete(item.request.id); clearTimeout(item.timer); pair.lastSeen = Date.now();
        item.resolve(input.result); send(response, 200, { ok: true }); return;
      }
      if (request.method === 'POST' && request.url === '/disconnect') {
        disconnect('Disconnected from CutWright.'); send(response, 200, { ok: true }); return;
      }
      send(response, 404, { error: 'Unknown connector request.' });
    } catch (error) { send(response, 400, { error: error instanceof Error ? error.message : 'Invalid connector request.' }); }
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 24;
  for (const candidate of options.ports ?? CONNECTOR_PORTS) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener('listening', listening); reject(error); };
        const listening = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', listening); server.listen(candidate, '127.0.0.1');
      });
      port = (server.address() as { port: number }).port; break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  if (!port) throw new Error('All CutWright connector slots are in use. Close an unused agent conversation and retry.');
  const timer = setInterval(expire, 5000); timer.unref();
  return {
    port, session,
    async stageDestination(path: unknown) {
      if (!pair) throw new Error('Connect the intended browser tab first.');
      if (typeof path !== 'string' || !isAbsolute(path) || !/\.(mp4|json)$/i.test(path)) throw new Error('Expected an absolute .mp4 or .json output path.');
      if (!(await stat(dirname(path))).isDirectory()) throw new Error('Output directory is unavailable.');
      try { await stat(path); throw new Error('The output file already exists. Choose another filename.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const key = randomUUID(), token = randomBytes(32).toString('hex'); destinations.set(key, { path, token });
      return { target: { url: `http://127.0.0.1:${port}/downloads/${key}`, token }, release() { destinations.delete(key); } };
    },
    async stageFiles(paths: unknown, projectFile: boolean | 'font' = false) {
      if (!pair) throw new Error('Connect the intended browser tab first.');
      if (!Array.isArray(paths) || !paths.length || paths.length > 20) throw new Error('Provide 1 to 20 absolute file paths.');
      const entries: { id: string; name: string; path: string; token: string; size: number; mime: string }[] = [];
      const mimes: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.json': 'application/json' };
      Object.assign(mimes, { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' });
      for (const path of paths) {
        if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute local file path.');
        const extension = extname(path).toLowerCase();
        const isFont = mimes[extension]?.startsWith('font/');
        if (projectFile === 'font' ? !isFont : projectFile ? extension !== '.json' : !mimes[extension] || extension === '.json' || isFont) throw new Error('Unsupported local file type.');
        const info = await stat(path);
        if (!info.isFile() || !info.size || info.size > (projectFile === 'font' ? 1024 * 1024 : projectFile ? 8 * 1024 * 1024 : 32 * 1024 * 1024 * 1024)) throw new Error('Expected a nonempty local file within the supported size limit.');
        entries.push({ id: randomUUID(), name: basename(path), path, token: randomBytes(32).toString('hex'), size: info.size, mime: mimes[extension] });
      }
      for (const entry of entries) staged.set(entry.id, entry);
      return { files: entries.map(entry => ({ name: entry.name, url: `http://127.0.0.1:${port}/media/${entry.id}`, token: entry.token })), release() { for (const entry of entries) staged.delete(entry.id); } };
    },
    request(name: string, args: Record<string, unknown>): Promise<unknown> {
      expire();
      if (!pair) return Promise.reject(new Error(`Open CutWright → Agent → ${options.client === 'codex' ? 'Codex' : 'Claude'} → Connect. If several sessions appear, choose ${session}. Keep that tab open.`));
      if (pending.size >= 8) return Promise.reject(new Error('Too many pending requests. Wait for the current edit.'));
      const request = { id: randomUUID(), name, args };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(request.id); queue = queue.filter(item => item.id !== request.id); reject(new Error('The browser did not answer. Reconnect the tab and read the project again before retrying.')); }, options.callTimeout ?? (['import_media', 'open_project', 'save_download'].includes(name) ? 300_000 : 40_000));
        pending.set(request.id, { request, resolve, reject, timer }); queue.push(request); flush();
      });
    },
    async close() { clearInterval(timer); disconnect('Agent session closed.'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
