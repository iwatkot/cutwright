// The installed Electron executable supplies its embedded Node runtime through
// ELECTRON_RUN_AS_NODE. No Electron/Chromium profile or editor window is opened.
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveAgentEditor } from './mcpBridge';
import { mcpTargetArgument, runMcpStdio } from './mcpStdio';

export function nodeAgentLocatorDirectory(env = process.env, platform = process.platform): string {
  const appData = platform === 'win32' ? env.APPDATA
    : platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  if (!appData || !path.isAbsolute(appData)) throw new Error('The current user application-data directory is unavailable.');
  return path.join(appData, 'CutWright', 'agent-connections');
}

export async function runNodeMcp(args = process.argv): Promise<void> {
  const target = mcpTargetArgument(args);
  if (!target) throw new Error('This helper requires --mcp-stdio and --editor=<profile identity>.');
  const session = target.session ?? (target.editor ? resolveAgentEditor(target.editor, nodeAgentLocatorDirectory()) : null);
  if (!session) throw new Error('Missing editor profile identity.');
  await runMcpStdio(session);
}

if (require.main === module) {
  void runNodeMcp().then(() => process.exit(0), (error) => {
    process.stderr.write(`CutWright MCP: ${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
  });
}
