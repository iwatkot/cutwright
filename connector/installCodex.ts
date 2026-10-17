import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

const BEGIN = '# BEGIN CutWright browser connector';
const END = '# END CutWright browser connector';
export function codexConfiguration(original: string, command: string, entry: string): string {
  parse(original);
  const managed = original.includes(BEGIN) || original.includes(END);
  if (managed && (original.split(BEGIN).length !== 2 || original.split(END).length !== 2 || original.indexOf(BEGIN) > original.indexOf(END))) throw new Error('The managed CutWright configuration was changed. Restore its markers before updating.');
  const clean = managed ? original.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\r?\\n?`), '') : original;
  if ((parse(clean).mcp_servers as Record<string, unknown> | undefined)?.['cutwright-browser']) throw new Error('An existing cutwright-browser server is not managed by this installer. Remove or rename it in Codex MCP settings first.');
  const result = clean.trimEnd() + '\n\n' + [BEGIN, '[mcp_servers.cutwright-browser]', `command = ${JSON.stringify(command)}`, `args = [${JSON.stringify(entry)}, "--client=codex"]`, 'startup_timeout_sec = 20', END, ''].join('\n');
  parse(result);
  return result;
}
export function installCodex(source: string, version: string, options: { home?: string; configHome?: string } = {}) {
  const homeDirectory = options.home || homedir();
  const configHome = options.configHome || process.env.CODEX_HOME || path.join(homeDirectory, '.codex');
  const folder = path.join(homeDirectory, '.cutwright', 'connector', version);
  const destination = path.join(folder, 'cutwright-connector.cjs');
  const config = path.join(configHome, 'config.toml');
  mkdirSync(configHome, { recursive: true });
  const before = existsSync(config) ? readFileSync(config, 'utf8') : '';
  const after = codexConfiguration(before, process.execPath, destination);
  mkdirSync(folder, { recursive: true });
  if (path.resolve(source) !== path.resolve(destination)) copyFileSync(source, destination);
  if (existsSync(config)) copyFileSync(config, `${config}.cutwright-backup-${Date.now()}`);
  const temporary = `${config}.cutwright-${process.pid}.tmp`;
  writeFileSync(temporary, after, { mode: 0o600 });
  renameSync(temporary, config);
  console.log(`CutWright ${version} added to Codex. Restart Codex, open a new conversation, then click Agent → Codex → Connect in your browser.\nInstalled connector: ${destination}\nOnly the managed cutwright-browser server entry was added or updated.`);
}
