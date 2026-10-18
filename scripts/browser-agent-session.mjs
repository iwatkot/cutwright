import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// A persistent MCP SDK client for CLI environments that cannot add MCP servers
// to a running conversation. The application still owns all tool execution.
const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let sourceCommit;
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A distributed source archive may not have Git metadata. */ }
const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const port = Number(options.port ?? 47903), provider = options.client ?? 'codex';
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['codex', 'claude'].includes(provider)) throw new Error('Use --port=1024..65535 and --client=codex|claude.');
const entry = options.connector ? path.resolve(options.connector) : path.join(root, 'public', 'connectors', version, `cutwright-connector-${version}.cjs`);
let client, transport, definitions;
async function connect() {
  transport = new StdioClientTransport({ command: process.execPath, args: [entry, `--client=${provider}`], stderr: 'inherit' });
  client = new Client({ name: 'cutwright-cli', version });
  await client.connect(transport);
  definitions = await client.listTools();
}
await connect();
let queue = Promise.resolve();
const health = () => ({ application: 'cutwright-cli', pid: process.pid, connectorPid: transport.pid, version, sourceCommit, client: provider, endpoint: `http://127.0.0.1:${port}`, connector: entry });
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  try {
    // No browser-origin calls or DNS rebinding. Only local CLI clients may call.
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin) { response.writeHead(403); response.end('{}'); return; }
    if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify(health())); return; }
    if (request.method === 'GET' && request.url === '/tools') { response.end(JSON.stringify(await client.listTools())); return; }
    if (request.method === 'POST' && request.url === '/reload-connector') {
      await queue; await client.close(); await connect(); response.end(JSON.stringify(health())); return;
    }
    if (request.method !== 'POST' || request.url !== '/call') { response.writeHead(404); response.end('{}'); return; }
    let body = '', bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Request exceeds 4 MiB.'); body += chunk; }
    const input = JSON.parse(body);
    if (!definitions.tools.some(tool => tool.name === input.name)) throw new Error('Unknown MCP tool. Discover /tools first.');
    const work = queue.then(() => client.callTool({ name: input.name, arguments: input.arguments ?? {} }, undefined, { timeout: 300000 }));
    queue = work.catch(() => {});
    response.end(JSON.stringify(await work));
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.requestTimeout = 300000;
server.on('error', async error => { console.error(error.message); await client.close(); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify(health())));
async function stop() { server.close(); await client.close(); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
