import { build } from 'esbuild';
import { packExtension } from '@anthropic-ai/mcpb';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let checkoutTag = '';
try { checkoutTag = execFileSync('git', ['describe', '--tags', '--exact-match'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const version = process.env.RELEASE_TAG || (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(checkoutTag) ? checkoutTag : pkg.version);
const output = path.resolve('public', 'connectors', version);
const extension = path.resolve('.local', 'connector-build', version, 'claude');
mkdirSync(path.join(extension, 'server'), { recursive: true });
mkdirSync(output, { recursive: true });
const name = `cutwright-connector-${version}.cjs`;
const result = await build({ entryPoints: ['connector/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: path.join(output, name), define: { CONNECTOR_VERSION: JSON.stringify(version) }, metafile: true, legalComments: 'inline' });
copyFileSync(path.join(output, name), path.join(extension, 'server', 'cutwright-connector.cjs'));
const licenses = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(file => file.includes('node_modules/'))) {
  let folder = path.dirname(path.resolve(input));
  let pkg;
  while (path.dirname(folder) !== folder) {
    if (existsSync(path.join(folder, 'package.json'))) { const candidate = JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')); if (candidate.name) { pkg = candidate; break; } }
    folder = path.dirname(folder);
  }
  if (!pkg) throw new Error(`Cannot identify bundled dependency: ${input}`);
  if (licenses.has(pkg.name)) continue;
  const files = readdirSync(folder).filter(file => /^(licen[sc]e|copying)(\.|$)/i.test(file));
  if (!files.length) throw new Error(`Bundled dependency needs a license notice: ${pkg.name}`);
  licenses.set(pkg.name, `## ${pkg.name} ${pkg.version} (${pkg.license})\n\n${files.map(file => readFileSync(path.join(folder, file), 'utf8')).join('\n')}`);
}
const notices = [...licenses.values()].sort().join('\n\n---\n\n');
const license = readFileSync('LICENSE', 'utf8');
// Keep notices inside the single-file Codex download as well as the extension.
const bundled = readFileSync(path.join(output, name), 'utf8');
writeFileSync(path.join(output, name), bundled + '\n/*\n' + license.replaceAll('*/', '* /') + '\n' + notices.replaceAll('*/', '* /') + '\n*/\n');
copyFileSync(path.join(output, name), path.join(extension, 'server', 'cutwright-connector.cjs'));
writeFileSync(path.join(extension, 'LICENSE'), license);
writeFileSync(path.join(extension, 'THIRD_PARTY_NOTICES.txt'), notices);
copyFileSync('public/branding/cutwright-icon.png', path.join(extension, 'icon.png'));
writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: '0.3', name: 'cutwright', display_name: 'CutWright', version,
  description: 'Edit the CutWright project open in your browser. Pair from Agent → Claude → Connect. No CutWright Windows app or hosted relay required.',
  author: { name: 'iwatkot', url: 'https://github.com/iwatkot' },
  homepage: 'https://cutwright.cc/docs/agents/',
  documentation: 'https://cutwright.cc/docs/agents/#connect-claude',
  repository: { type: 'git', url: 'https://github.com/iwatkot/cutwright' },
  license: 'AGPL-3.0-only', icon: 'icon.png',
  server: { type: 'node', entry_point: 'server/cutwright-connector.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/cutwright-connector.cjs', '--client=claude'] } },
  compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=22.0.0' } },
}, null, 2));
const claude = `cutwright-claude-${version}.mcpb`;
if (!await packExtension({ extensionPath: extension, outputPath: path.join(output, claude), silent: true })) throw new Error('Claude extension packaging failed.');
const assets = [name, claude].map(file => { const bytes = readFileSync(path.join(output, file)); return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
const commit = process.env.CW_SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(path.join(output, 'connector-manifest.json'), JSON.stringify({ version, commit, protocol: 1, assets }, null, 2));
console.log(`Built Codex connector and Claude extension ${version}: ${assets.map(asset => `${asset.file} (${asset.bytes} bytes)`).join(', ')}`);
