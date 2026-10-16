// Local correction for @mediabunny/aac-encoder 1.61.5 (MPL-2.0).
// Upstream: https://github.com/Vanilagy/mediabunny/tree/v1.61.5/packages/aac-encoder
// Copyright (c) 2026-present Vanilagy and contributors. Original license and
// source remain in the installed dependency. This script records our changes:
// retain libavcodec's negative priming PTS and trim padding packet duration to
// the last actual input sample. No WASM, encoded bytes, or codecs are modified.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const manifest = new URL('../node_modules/@mediabunny/aac-encoder/package.json', import.meta.url);
const bundle = new URL('../node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs', import.meta.url);
const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
if (version !== '1.61.5') throw new Error(`AAC timing patch requires exactly 1.61.5; found ${version}. Review the upstream implementation before upgrading.`);
const originalHash = 'a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214';
const patchedHash = 'c0cf276b1b8d23d43f8424486b499c6e6ddd456963e8495f30e42317e8aae000';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const source = readFileSync(bundle, 'utf8'), currentHash = hash(source);
if (currentHash === patchedHash) { console.log('AAC timing patch already applied (1.61.5).'); process.exit(0); }
if (currentHash !== originalHash) throw new Error(`AAC encoder bundle hash changed (${currentHash}); refusing an unreviewed patch.`);
const changes = [
  ['  resetInternalState() {\n    this.pendingFrames = 0;\n    this.nextSampleTimestampInSamples = null;', '  resetInternalState() {\n    this.pendingFrames = 0;\n    this.nextSampleTimestampInSamples = null;\n    this.inputEndTimestampInSamples = null;'],
  ['    const incomingFrames = audioSample.numberOfFrames;', '    const incomingFrames = audioSample.numberOfFrames;\n    this.inputEndTimestampInSamples = Math.round(audioSample.timestamp * this.sampleRate) + incomingFrames;'],
  ['    for (const p of packets) {\n      let data = new Uint8Array(p.encodedData);', '    for (const p of packets) {\n      if (this.inputEndTimestampInSamples !== null && p.pts >= this.inputEndTimestampInSamples) continue;\n      const duration = this.inputEndTimestampInSamples === null ? p.duration : Math.min(p.duration, this.inputEndTimestampInSamples - p.pts);\n      let data = new Uint8Array(p.encodedData);'],
  ['        this.nextPacketTimestampInSamples / this.sampleRate,\n        p.duration / this.sampleRate', '        p.pts / this.sampleRate,\n        duration / this.sampleRate'],
];
let patched = source;
for (const [before, after] of changes) {
  if (patched.split(before).length !== 2) throw new Error('AAC timing patch anchor is missing or ambiguous.');
  patched = patched.replace(before, after);
}
const resultHash = hash(patched);
if (process.argv.includes('--print-hash')) { console.log(resultHash); process.exit(0); }
if (resultHash !== patchedHash) throw new Error(`AAC timing patch result hash mismatch (${resultHash}); refusing to write.`);
writeFileSync(fileURLToPath(bundle), patched);
console.log('AAC timing patch applied (1.61.5): priming PTS and final sample boundary.');
