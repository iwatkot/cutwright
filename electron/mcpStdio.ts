import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { connectAgentSession, MAX_AGENT_MESSAGE_BYTES } from './mcpBridge';

export function mcpTargetArgument(args: string[]): { editor?: string; session?: string } | null {
  if (!args.includes('--mcp-stdio')) return null;
  const sessions = args.filter((arg) => arg.startsWith('--session='));
  const editors = args.filter((arg) => arg.startsWith('--editor='));
  if (sessions.length + editors.length !== 1) throw new Error('MCP stdio needs exactly one --editor=<profile identity> argument.');
  return editors.length ? { editor: editors[0].slice('--editor='.length) } : { session: sessions[0].slice('--session='.length) };
}

/** Official MCP SDK owns JSON-RPC on stdin/stdout. Diagnostics use stderr;
 * all tool execution stays in the enabled live editor via a local pipe. */
export async function runMcpStdio(session: string): Promise<void> {
  const bridge = await connectAgentSession(session);
  const server = new Server({ name: 'cutwright', version: '0.1.0' }, { capabilities: { tools: {} },
    instructions: 'Control the open CutWright editor. Read the current revision before changes. Export tools create jobs; query their status rather than holding a tool call open.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const result = await bridge.request('list');
      return ListToolsResultSchema.parse({ tools: Array.isArray(result) ? result : [] });
    } catch (error) { throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : String(error)); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await bridge.request('call', request.params.name, request.params.arguments ?? {});
      const structuredContent = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { ok: true, result: result ?? null };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, ...(structuredContent.ok === false ? { isError: true } : {}) };
    } catch (error) {
      const structuredContent = { ok: false, error: { code: 'CONNECTION_ERROR', message: error instanceof Error ? error.message : String(error) } };
      return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
    }
  });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_AGENT_MESSAGE_BYTES });
  let end!: () => void;
  const stopped = new Promise<void>((resolve) => { end = resolve; });
  const close = () => { void server.close().finally(end); };
  server.onclose = end;
  server.onerror = (error) => { process.stderr.write(`CutWright MCP: ${error.message}\n`); };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  void bridge.closed.then(close);
  try { await server.connect(transport); await stopped; }
  finally {
    process.stdin.removeListener('end', close);
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
    bridge.dispose(); await server.close();
  }
}
