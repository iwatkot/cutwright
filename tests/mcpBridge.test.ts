import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { createAgentBridge, connectAgentSession, agentPipeAddress, resolveAgentEditor } from '../electron/mcpBridge';
import { validateMp4Destination } from '../electron/exportDestination';
import { mcpTargetArgument } from '../electron/mcpStdio';
import { nodeAgentLocatorDirectory } from '../electron/mcpNode';
const bridges: ReturnType<typeof createAgentBridge>[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose())); });
const make = (options: Partial<Parameters<typeof createAgentBridge>[0]> = {}) => {
  const directory = options.locatorDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-test-'));
  const bridge = Object.assign(createAgentBridge({ userDataPath: 'C:/test/user-data', command: 'C:/Program Files/CutWright.exe', onRequest: () => {}, ...options, locatorDirectory: directory }), { directory });
  bridges.push(bridge); return bridge;
};
const sessionOf = (bridge: ReturnType<typeof make>, editor?: string) => resolveAgentEditor(editor ?? bridge.getStatus().editor!, bridge.directory);
describe('local editor agent pipe', () => {
  it('starts disabled, exposes exact argv and only listens after enable', async () => {
    const bridge = make(); expect(bridge.getStatus()).toEqual({ enabled: false });
    const status = await bridge.setEnabled(true);
    expect(status.enabled).toBe(true); expect(status.command).toBe('C:/Program Files/CutWright.exe');
    expect(status.args).toEqual(['--mcp-stdio', `--editor=${status.editor}`]);
    const session = sessionOf(bridge);
    expect(() => agentPipeAddress('../other-pipe')).toThrow(/Invalid/);
    await bridge.setEnabled(false);
    expect(() => sessionOf(bridge, status.editor)).toThrow(/not connected/);
    await expect(connectAgentSession(session)).rejects.toThrow(/disabled|available/);
  });
  it('keeps the bundled runtime environment in reusable configuration', async () => {
    const bridge = make({ argsPrefix: ['C:/CutWright/resources/app.asar/dist-electron/mcpNode.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const status = await bridge.setEnabled(true);
    expect(status.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(status.args).toEqual(['C:/CutWright/resources/app.asar/dist-electron/mcpNode.js', '--mcp-stdio', `--editor=${status.editor}`]);
    status.env!.ELECTRON_RUN_AS_NODE = '0'; status.args![0] = 'changed';
    expect(bridge.getStatus().env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(bridge.getStatus().args![0]).toContain('app.asar');
  });
  it('correlates requests from multiple clients without exposing renderer IDs', async () => {
    let bridge: ReturnType<typeof make>;
    bridge = make({ onRequest: (request) => {
      expect(request.id).toMatch(/^[a-f0-9-]{36}$/);
      setTimeout(() => bridge.respond({ id: request.id, result: { ok: true, method: request.method, value: request.args?.value } }), request.args?.value === 'slow' ? 20 : 0);
    } });
    await bridge.setEnabled(true); const a = await connectAgentSession(sessionOf(bridge)), b = await connectAgentSession(sessionOf(bridge));
    try {
      const [first, second, list] = await Promise.all([a.request('call', 'test', { value: 'slow' }), b.request('call', 'test', { value: 'fast' }), a.request('list')]);
      expect(first).toEqual({ ok: true, method: 'call', value: 'slow' }); expect(second).toEqual({ ok: true, method: 'call', value: 'fast' }); expect(list).toEqual({ ok: true, method: 'list' });
      expect(bridge.pendingCount).toBe(0);
    } finally { a.dispose(); b.dispose(); }
  });
  it('times out an unresponsive editor and clears pending state', async () => {
    const bridge = make({ timeoutMs: 20 }); await bridge.setEnabled(true); const client = await connectAgentSession(sessionOf(bridge));
    try { await expect(client.request('list')).rejects.toThrow(/timed out/); expect(bridge.pendingCount).toBe(0); }
    finally { client.dispose(); }
  });
  it('disabling rejects pending work and rotates the capability on re-enable', async () => {
    let received!: () => void; const ready = new Promise<void>((resolve) => { received = resolve; });
    const bridge = make({ onRequest: () => received() }), initial = await bridge.setEnabled(true), initialSession = sessionOf(bridge), client = await connectAgentSession(initialSession);
    const pending = client.request('call', 'change', {}); const rejected = expect(pending).rejects.toThrow(/disabled|closed/);
    await ready; await bridge.setEnabled(false); await rejected; await client.closed;
    expect(bridge.pendingCount).toBe(0);
    const next = await bridge.setEnabled(true); expect(next.args).toEqual(initial.args); expect(sessionOf(bridge)).not.toBe(initialSession);
    await expect(connectAgentSession(initialSession)).rejects.toThrow(/disabled|available/);
  });
  it('bounds pending work and large renderer responses without crashing', async () => {
    const requests: string[] = [], bridge = make({ maxPending: 1, maxMessageBytes: 256, onRequest: (request) => requests.push(request.id) });
    await bridge.setEnabled(true); const client = await connectAgentSession(sessionOf(bridge));
    try {
      const first = client.request('list'); const rejected = expect(first).rejects.toThrow(/exceeds/);
      while (!requests.length) await new Promise((resolve) => setImmediate(resolve));
      await expect(client.request('list')).rejects.toThrow(/Too many pending/);
      bridge.respond({ id: requests[0], result: { value: 'x'.repeat(1000) } });
      await rejected; expect(bridge.pendingCount).toBe(0);
    } finally { client.dispose(); }
  });
  it('rejects oversized or malformed NDJSON and closes the socket', async () => {
    const bridge = make({ maxMessageBytes: 128 }); await bridge.setEnabled(true);
    for (const input of ['not-json\n', JSON.stringify({ id: 'x', method: 'call', name: 'x', args: { text: 'x'.repeat(256) } }) + '\n']) {
      const socket = net.createConnection(agentPipeAddress(sessionOf(bridge))); let response = '';
      socket.on('data', (data) => { response += data; }); socket.on('error', () => undefined);
      await once(socket, 'connect'); const closed = once(socket, 'close'); socket.write(input); await closed;
      expect(response).toMatch(/Invalid JSON|exceeds/); expect(bridge.pendingCount).toBe(0);
    }
  });
  it('keeps stable configuration across restart and isolates multiple profiles', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-profiles-'));
    const first = make({ userDataPath: 'C:/profiles/first', locatorDirectory: directory }), second = make({ userDataPath: 'C:/profiles/second', locatorDirectory: directory });
    const a = await first.setEnabled(true), b = await second.setEnabled(true);
    expect(a.editor).not.toBe(b.editor); expect(sessionOf(first)).not.toBe(sessionOf(second));
    const old = sessionOf(first); await first.dispose();
    const restarted = make({ userDataPath: 'C:/profiles/first', locatorDirectory: directory }), fresh = await restarted.setEnabled(true);
    expect(fresh.args).toEqual(a.args); expect(sessionOf(restarted)).not.toBe(old);
    expect(sessionOf(second)).toBe(resolveAgentEditor(b.editor!, directory));
    await expect(connectAgentSession(old)).rejects.toThrow(/disabled|available/);
  });
  it('does not redirect a profile connection to another live editor', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mcp-exclusive-'));
    const first = make({ locatorDirectory: directory }), second = make({ locatorDirectory: directory });
    await first.setEnabled(true); const initial = sessionOf(first);
    expect(await second.setEnabled(true)).toMatchObject({ enabled: false, error: expect.stringMatching(/Another editor/) });
    expect(sessionOf(first)).toBe(initial);
    await first.setEnabled(false); expect((await second.setEnabled(true)).enabled).toBe(true);
  });
});
describe('headless MCP launcher', () => {
  it('requires a single explicit editor target and derives the user locator without Electron', () => {
    expect(mcpTargetArgument(['program'])).toBeNull();
    expect(mcpTargetArgument(['program', '--mcp-stdio', '--editor=cutwright-0123456789abcdef'])).toEqual({ editor: 'cutwright-0123456789abcdef' });
    for (const args of [['--mcp-stdio'], ['--mcp-stdio', '--editor=a', '--session=b'], ['--mcp-stdio', '--editor=a', '--editor=b']]) expect(() => mcpTargetArgument(args)).toThrow(/exactly one/);
    expect(nodeAgentLocatorDirectory({ APPDATA: 'C:/Users/Test/AppData/Roaming' }, 'win32')).toBe(path.join('C:/Users/Test/AppData/Roaming', 'CutWright', 'agent-connections'));
    expect(() => nodeAgentLocatorDirectory({}, 'win32')).toThrow(/unavailable/);
    expect(() => nodeAgentLocatorDirectory({ APPDATA: '../other' }, 'win32')).toThrow(/unavailable/);
  });
});
describe('agent export destinations', () => {
  it('accepts absolute MP4 paths, including spaces, unicode and UNC', () => {
    expect(validateMp4Destination('C:/Users/Test/Видео export.MP4', 'win32')).toBe('C:\\Users\\Test\\Видео export.MP4');
    expect(validateMp4Destination('\\\\server\\share\\output.mp4', 'win32')).toBe('\\\\server\\share\\output.mp4');
    expect(validateMp4Destination('/tmp/output.mp4', 'linux')).toBe('/tmp/output.mp4');
  });
  it('rejects relative, device, alternate-stream, non-MP4 and invalid paths', () => {
    for (const value of ['output.mp4', 'C:output.mp4', '\\output.mp4', 'C:/out.mov', 'C:/out.mp4:stream', '\\\\.\\pipe\\out.mp4', 'C:/out.mp4\0', 12]) expect(() => validateMp4Destination(value, 'win32')).toThrow(/absolute .mp4/);
  });
});
