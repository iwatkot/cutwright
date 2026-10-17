import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const tag = process.env.RELEASE_TAG;
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(tag || '')) throw new Error('Exact unprefixed release tag required.');
const folder = path.resolve('.local', 'published-connectors', tag);
mkdirSync(folder, { recursive: true });
const base = `https://app.cutwright.cc/connectors/${tag}/`;
const get = async (name) => { const response = await fetch(base + name); if (!response.ok) throw new Error(`Connector download failed: ${response.status}`); return Buffer.from(await response.arrayBuffer()); };
const manifestBytes = await get('connector-manifest.json');
const manifest = JSON.parse(manifestBytes);
if (manifest.version !== tag || manifest.commit !== process.env.SOURCE_COMMIT || manifest.assets.length !== 2) throw new Error('Deployed connectors do not match this release source.');
const files = [];
for (const expected of [`cutwright-connector-${tag}.cjs`, `cutwright-claude-${tag}.mcpb`]) {
  const asset = manifest.assets.find(item => item.file === expected);
  if (!asset) throw new Error(`Missing connector: ${expected}`);
  const bytes = await get(expected);
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Connector checksum mismatch: ${expected}`);
  const destination = path.join(folder, expected); writeFileSync(destination, bytes); files.push(destination);
}
const manifestFile = path.join(folder, 'connector-manifest.json'); writeFileSync(manifestFile, manifestBytes); files.push(manifestFile);
execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' });
console.log(`Published the exact deployed connector assets for ${tag}.`);
