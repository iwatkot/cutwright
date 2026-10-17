import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unpackExtension } from '@anthropic-ai/mcpb';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const folder = path.resolve('.local', 'connector-smoke', version);
mkdirSync(folder, { recursive: true });
await build({ entryPoints: ['src/lib/editorTools.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(folder, 'controller.cjs') });
const { createEditorToolController } = createRequire(import.meta.url)(path.join(folder, 'controller.cjs'));
const files = path.resolve('public', 'connectors', version);
const extension = path.join(folder, 'unpacked-claude');
assert(await unpackExtension({ mcpbPath: path.join(files, `cutwright-claude-${version}.mcpb`), outputDir: extension, silent: true }));
const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, version); assert.equal(manifest.server.type, 'node');
const report = { version, codex: false, claude: false, discoveredTools: false, liveRead: false, edits: false, undoRedo: false, staleRejected: false, disconnectRevoked: false };
for (const provider of ['codex', 'claude']) {
  const entry = provider === 'codex' ? path.join(files, `cutwright-connector-${version}.cjs`) : path.join(extension, manifest.server.entry_point);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, `--client=${provider}`], stderr: 'pipe' });
  const client = new Client({ name: `cutwright-${provider}-release-check`, version });
  const controller = createEditorToolController({ enabled: true });
  const abort = new AbortController();
  let loop;
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, version);
    const tools = await client.listTools(); assert.equal(tools.tools.length, 7); report.discoveredTools = true;
    const missing = await client.callTool({ name: 'get_project', arguments: {} }); assert.equal(missing.isError, true);
    const candidates = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      try { const response = await fetch(`http://127.0.0.1:${47831 + i}/health`, { signal: AbortSignal.timeout(1000) }); const value = await response.json(); return value.processId === transport.pid ? value : undefined; } catch { return undefined; }
    }));
    const info = candidates.find(Boolean); assert(info, 'Packaged MCP process did not expose its loopback connector.'); assert.equal(info.client, provider);
    const base = `http://127.0.0.1:${info.port}`, token = randomBytes(32).toString('hex');
    const headers = { Origin: 'https://app.cutwright.cc', Authorization: `Bearer ${token}` };
    const paired = await fetch(`${base}/connect`, { method: 'POST', headers: { Origin: headers.Origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); assert(paired.ok);
    loop = (async () => {
      while (!abort.signal.aborted) {
        const response = await fetch(`${base}/poll`, { headers, signal: abort.signal });
        if (!response.ok) return;
        const value = await response.json();
        for (const item of value.requests) {
          const result = await controller.execute(item.name, item.args);
          const acknowledged = await fetch(`${base}/result`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, result }), signal: abort.signal }); assert(acknowledged.ok);
        }
      }
    })().catch(error => { if (!abort.signal.aborted) throw error; });
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    const project = await call('get_project'); assert.equal(project.ok, true); report.liveRead = true;
    const edited = await call('apply_edits', { expectedRevision: project.revision, ops: [{ type: 'addMarker', time: 1, label: `${provider} packaged check`, color: '#FFD44B' }] }); assert.equal(edited.ok, true); report.edits = true;
    const stale = await call('undo', { expectedRevision: project.revision }); assert.equal(stale.error.code, 'STALE_REVISION'); report.staleRejected = true;
    const undone = await call('undo', { expectedRevision: edited.revision }); assert.equal(undone.ok, true);
    const redone = await call('redo', { expectedRevision: undone.revision }); assert.equal(redone.ok, true); report.undoRedo = true;
    controller.setEnabled(false);
    assert((await fetch(`${base}/disconnect`, { method: 'POST', headers })).ok);
    assert.equal((await call('get_project')).ok, false); report.disconnectRevoked = true;
    report[provider] = true;
  } finally { abort.abort(); if (loop) await loop; controller.dispose(); await client.close(); }
}
writeFileSync(path.join(files, 'smoke-connectors.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
