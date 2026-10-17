import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createConnectorServer } from '../connector/server';
import { codexConfiguration } from '../connector/installCodex';
import { createBrowserConnector } from '../src/lib/browserConnector';
import { createEditorToolController } from '../src/lib/editorTools';
import { useStore, emptyProject } from '../src/lib/store';
import { parse } from 'smol-toml';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { installCodex } from '../connector/installCodex';

const origin = 'https://app.cutwright.cc';
const initial = useStore.getState();
const servers: Awaited<ReturnType<typeof createConnectorServer>>[] = [];
const adapters: ReturnType<typeof createBrowserConnector>[] = [];
const controllers: ReturnType<typeof createEditorToolController>[] = [];
beforeEach(() => useStore.setState({ ...initial, project: emptyProject(), past: [], future: [] }, true));
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.disconnect()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  controllers.splice(0).forEach(controller => controller.dispose());
  useStore.setState(initial, true);
});
async function server(options: Partial<Parameters<typeof createConnectorServer>[0]> = {}) {
  const value = await createConnectorServer({ client: 'codex', version: '0.0.3', ports: [0], ...options }); servers.push(value); return value;
}
function adapter(ports: number[]) {
  const controller = createEditorToolController(); controllers.push(controller);
  const browserFetch: typeof fetch = (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Origin: origin } });
  const value = createBrowserConnector(controller, { fetch: browserFetch, ports, timeout: 1200 }); adapters.push(value); return { value, controller };
}
const call = (port: number, route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${route}`, { ...init, headers: { Origin: origin, ...init.headers } });
const pair = (port: number, token = 'a'.repeat(64)) => call(port, '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });

describe('browser ↔ local MCP connector', () => {
  it('edits the live project, preserves revision checks and undo/redo, then revokes access', async () => {
    const bridge = await server(), { value, controller } = adapter([bridge.port]);
    expect(await value.connect('codex')).toBe(true);
    expect(value.status.connected).toBe(true);
    const first = await bridge.request('get_project', {}) as { ok: boolean; revision: string };
    expect(first.ok).toBe(true);
    const edited = await bridge.request('apply_edits', { expectedRevision: first.revision, ops: [{ type: 'addMarker', time: 2, label: 'Connector check', color: '#FFD44B' }] }) as { ok: boolean; revision: string };
    expect(edited.ok).toBe(true); expect(useStore.getState().project.markers?.[0].label).toBe('Connector check');
    expect(useStore.getState().past).toHaveLength(1);
    expect(await bridge.request('apply_edits', { expectedRevision: first.revision, ops: [{ type: 'setProjectSize', width: 720, height: 1280 }] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const undone = await bridge.request('undo', { expectedRevision: edited.revision }) as { revision: string };
    expect(useStore.getState().project.markers ?? []).toHaveLength(0);
    expect(await bridge.request('redo', { expectedRevision: undone.revision })).toMatchObject({ ok: true });
    expect(useStore.getState().project.markers).toHaveLength(1);
    await value.disconnect();
    expect(controller.enabled).toBe(false);
    expect(await controller.execute('get_project')).toMatchObject({ ok: false, error: { code: 'DISABLED' } });
    await expect(bridge.request('get_project', {})).rejects.toThrow('Connect');
  });

  it('keeps agent apps and sessions separate and requires a choice when ambiguous', async () => {
    const first = await server(), second = await server(), claude = await server({ client: 'claude' });
    const { value } = adapter([first.port, second.port, claude.port]);
    expect(await value.connect('codex')).toBe(false);
    expect(value.status.candidates).toHaveLength(2);
    expect(value.status.error).toContain('Choose');
    expect(await value.connect('codex', second.port)).toBe(true);
    await expect(first.request('get_project', {})).rejects.toThrow(first.session);
    expect(await second.request('get_project', {})).toMatchObject({ ok: true });
    expect(await value.connect('claude')).toBe(true);
    await expect(second.request('get_project', {})).rejects.toThrow('Connect');
    expect(await claude.request('get_project', {})).toMatchObject({ ok: true });
  });

  it('refuses another tab instead of silently replacing its connection', async () => {
    const bridge = await server();
    expect((await pair(bridge.port)).status).toBe(200);
    expect((await pair(bridge.port, 'b'.repeat(64))).status).toBe(409);
    expect((await call(bridge.port, '/poll', { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(401);
    expect((await call(bridge.port, '/disconnect', { method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(64)}` } })).status).toBe(200);
    expect((await pair(bridge.port, 'b'.repeat(64))).status).toBe(200);
  });

  it('rejects foreign origins, missing origins, forms, invalid tokens and spoofed hosts', async () => {
    const bridge = await server();
    const evil = await call(bridge.port, '/connect', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) });
    expect(evil.status).toBe(403); expect(evil.headers.has('access-control-allow-origin')).toBe(false);
    expect((await fetch(`http://127.0.0.1:${bridge.port}/connect`, { method: 'POST' })).status).toBe(403);
    expect((await call(bridge.port, '/connect', { method: 'POST', body: 'token=abc' })).status).toBe(400);
    expect((await pair(bridge.port, 'weak')).status).toBe(400);
    const spoofed = await new Promise<number>(resolve => { const request = httpRequest({ host: '127.0.0.1', port: bridge.port, path: '/health', headers: { Host: `evil.example:${bridge.port}` } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
    expect(spoofed).toBe(403);
    const preflight = await call(bridge.port, '/connect', { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('expires abandoned tabs, times out queued requests and rejects late results', async () => {
    const bridge = await server({ leaseTimeout: 60, callTimeout: 20 });
    await pair(bridge.port);
    await expect(bridge.request('get_project', {})).rejects.toThrow('did not answer');
    expect((await call(bridge.port, '/result', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(64)}` }, body: JSON.stringify({ id: 'expired', result: { ok: true } }) })).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(await (await call(bridge.port, '/health')).json()).toMatchObject({ paired: false });
    await expect(bridge.request('get_project', {})).rejects.toThrow('Connect');
  });
});

describe('Codex one-time setup', () => {
  it('installs a permanent connector, backs up settings and safely updates its entry', () => {
    const parent = path.resolve('.local', 'installer-tests'); mkdirSync(parent, { recursive: true });
    const home = mkdtempSync(path.join(parent, 'profile-'));
    const configHome = path.join(home, 'codex'); mkdirSync(configHome);
    const config = path.join(configHome, 'config.toml'), source = path.join(home, 'download.cjs');
    writeFileSync(config, '# Preserve this\nmodel="gpt-6.1"\n'); writeFileSync(source, '// Connector fixture');
    installCodex(source, '0.0.3', { home, configHome });
    const installed = path.join(home, '.cutwright', 'connector', '0.0.3', 'cutwright-connector.cjs');
    expect(readFileSync(installed, 'utf8')).toBe('// Connector fixture');
    expect(parse(readFileSync(config, 'utf8'))).toMatchObject({ model: 'gpt-6.1', mcp_servers: { 'cutwright-browser': { args: [installed, '--client=codex'] } } });
    expect(readdirSync(configHome).some(file => file.startsWith('config.toml.cutwright-backup-'))).toBe(true);
    installCodex(source, '0.0.4', { home, configHome });
    expect(readFileSync(config, 'utf8').match(/BEGIN CutWright/g)).toHaveLength(1);
    expect(readFileSync(config, 'utf8')).toContain('# Preserve this');
  });
  it('preserves unrelated settings and comments, and updates only its managed entry', () => {
    const original = '# My settings\nmodel = "gpt-6.1"\n[mcp_servers.other]\ncommand = "other"\n';
    const added = codexConfiguration(original, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Name\\connector.cjs');
    expect(added).toContain(original.trim());
    expect(parse(added)).toMatchObject({ model: 'gpt-6.1', mcp_servers: { other: { command: 'other' }, 'cutwright-browser': { args: ['C:\\Users\\Name\\connector.cjs', '--client=codex'] } } });
    const updated = codexConfiguration(added, '/usr/bin/node', '/home/name/connector.cjs');
    expect(updated.match(/BEGIN CutWright/g)).toHaveLength(1);
    expect(updated).toContain(original.trim());
    expect(parse(updated)).toMatchObject({ mcp_servers: { 'cutwright-browser': { command: '/usr/bin/node' } } });
  });
  it('refuses conflicting or invalid configuration without replacing it', () => {
    expect(() => codexConfiguration('[mcp_servers.cutwright-browser]\ncommand="other"', 'node', '/tmp/a')).toThrow('not managed');
    expect(() => codexConfiguration('# BEGIN CutWright browser connector', 'node', '/tmp/a')).toThrow('markers');
    expect(() => codexConfiguration('invalid = [', 'node', '/tmp/a')).toThrow();
  });
});
