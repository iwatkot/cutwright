import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EDITOR_TOOL_DEFINITIONS } from '../src/lib/editorToolDefinitions';
import { createConnectorServer } from './server';
import { installCodex } from './installCodex';
import { MAX_CONNECTOR_BYTES } from './protocol';

declare const CONNECTOR_VERSION: string;
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('CutWright connector requires Node.js 22 or newer.');
  if (process.argv.includes('--install-codex')) { installCodex(process.argv[1], CONNECTOR_VERSION); return; }
  if (process.argv.includes('--version')) { console.log(CONNECTOR_VERSION); return; }
  const client = process.argv.includes('--client=claude') ? 'claude' : 'codex';
  const bridge = await createConnectorServer({ client, version: CONNECTOR_VERSION });
  const server = new Server({ name: 'cutwright-browser', version: CONNECTOR_VERSION }, {
    capabilities: { tools: {} },
    instructions: `Control only the browser tab explicitly connected in CutWright's Agent dialog. If disconnected, ask the user to choose ${client} and Connect; your session code is ${bridge.session}. Read get_project before every edit and pass its current revision as expectedRevision. Tool batches are atomic and undoable. Export is local and asynchronous; poll get_export. Never claim a successful connection or edit when the tool reports an error.`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: EDITOR_TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let staged: Awaited<ReturnType<typeof bridge.stageFiles>> | undefined;
    let destination: Awaited<ReturnType<typeof bridge.stageDestination>> | undefined;
    try {
      if (!EDITOR_TOOL_DEFINITIONS.some(tool => tool.name === request.params.name)) throw new Error('Unknown editor tool.');
      let args = request.params.arguments ?? {};
      if (request.params.name === 'import_media') {
        if (!Array.isArray(args.paths) || args.files !== undefined) throw new Error('Provide absolute local paths; files is reserved for the connector.');
        staged = await bridge.stageFiles(args.paths);
        const { paths: _paths, ...rest } = args; args = { ...rest, files: staged.files };
      }
      if (request.params.name === 'open_project') {
        if (typeof args.path !== 'string' || args.file !== undefined) throw new Error('Provide an absolute project path; file is reserved for the connector.');
        staged = await bridge.stageFiles([args.path], true);
        const { path: _path, ...rest } = args; args = { ...rest, file: staged.files[0] };
      }
      if (request.params.name === 'save_download') {
        if (args.destination !== undefined) throw new Error('destination is reserved for the connector.');
        destination = await bridge.stageDestination(args.outputPath);
        const { outputPath: _outputPath, ...rest } = args; args = { ...rest, destination: destination.target };
      }
      const value = await bridge.request(request.params.name, args);
      const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { ok: false, error: { message: 'Invalid editor response.' } };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.ok === false ? { isError: true } : {}) };
    } catch (error) {
      const result = { ok: false, error: { code: 'CONNECTION_ERROR', message: error instanceof Error ? error.message : String(error) } };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
    } finally { staged?.release(); destination?.release(); }
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_CONNECTOR_BYTES });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  server.onclose = finished;
  server.onerror = error => process.stderr.write(`CutWright: ${error.message}\n`);
  const close = () => { void server.close().finally(finished); };
  process.stdin.once('end', close); process.once('SIGINT', close); process.once('SIGTERM', close);
  try { await server.connect(transport); await done; }
  finally { await bridge.close(); await server.close(); }
}
void main().catch(error => { process.stderr.write(`CutWright: ${error.message}\n`); process.exitCode = 1; });
