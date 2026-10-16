// Local correction for Mediabunny 1.61.5 (MPL-2.0).
// Upstream: https://github.com/Vanilagy/mediabunny/tree/v1.61.5
// Copyright (c) 2026-present Vanilagy and contributors. Original license and
// attribution stay in the dependency. This correction recognizes QuickTime's
// '.mp3' sample-entry tag; no packet bytes, timestamps, or codecs are changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = new URL('../node_modules/mediabunny/package.json', import.meta.url);
const moduleFile = new URL('../node_modules/mediabunny/dist/modules/src/isobmff/isobmff-demuxer.js', import.meta.url);
const preferredSource = new URL('../node_modules/mediabunny/src/isobmff/isobmff-demuxer.ts', import.meta.url);
const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
if (version !== '1.61.5') throw new Error(`MP3 sample-entry correction requires Mediabunny 1.61.5; found ${version}. Review the upstream parser before upgrading.`);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const targets = [
  { file: moduleFile, original: 'dedd752aef9931e2ab463cf50ad752a3a86b0b79d0060517b811d1881354a40a', patched: '45cb52a678685430bc30a2de4e928d572615df373f286ec103e0d6ed42b7395d' },
  { file: preferredSource, original: '452f1faa94435afcdbf9ddb500b51753b127920fa3e4f5d565f8cb84bc31495b', patched: '7c8502d6649fd437968928010dfd6b8e96ff97a0c4bc9e9a8b093a3cc66d8443' },
];
const writes = [];
for (const target of targets) {
  const source = readFileSync(target.file, 'utf8');
  const currentHash = hash(source);
  if (currentHash === target.patched) continue;
  if (currentHash !== target.original) throw new Error(`Mediabunny MP4 parser hash changed (${currentHash}); refusing an unreviewed correction.`);
  const anchor = source.match(/^([ \t]+)if \(codecName === 'mp4a'\) \{\r?\n([ \t]+)\/\/ The codec is set by the esds box\r?\n([ \t]+)\}/m);
  if (!anchor || source.split(anchor[0]).length !== 2) throw new Error('The MP4 audio sample-entry parser anchor is missing or ambiguous.');
  const replacement = `${anchor[0]}\n${anchor[3]}else if (codecName === '.mp3') {\n${anchor[2]}track.info.codec = 'mp3';\n${anchor[3]}}`;
  const patched = '// CutWright modification (2026-10-16): recognize the QuickTime MP3 sample entry.\n' + source.replace(anchor[0], replacement);
  const resultHash = hash(patched);
  if (process.argv.includes('--print-hash')) { console.log(`${target.file.pathname}: ${resultHash}`); continue; }
  if (resultHash !== target.patched) throw new Error(`MP3 sample-entry correction result hash mismatch (${resultHash}); refusing to write.`);
  writes.push({ file: target.file, patched });
}
if (process.argv.includes('--print-hash')) process.exit(0);
for (const write of writes) writeFileSync(write.file, write.patched);
console.log(`MP3 sample-entry correction ${writes.length ? 'applied' : 'already applied'} (Mediabunny 1.61.5).`);
