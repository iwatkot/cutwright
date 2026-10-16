import { prepareRuntimeNotices } from './prepare-runtime-notices.mjs';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd(), work = mkdtempSync(path.join(tmpdir(), 'cw-runtime-notices-test-'));
const evidence = path.join(root, 'screenshots', `runtime-notices-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); if (!ok) process.exitCode = 1; };
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
try {
  const target = path.join(work, 'third-party'), first = prepareRuntimeNotices(target), manifestFile = path.join(target, 'runtime-manifest.json');
  check('actual installed runtime dependency inventory includes both editions and transitive dependencies', first.dependencies > 20 && ['@modelcontextprotocol/sdk', 'zod', 'mediabunny', '@ffmpeg/core', 'ffmpeg-static', 'react'].every((name) => first.manifest.dependencies.some((entry) => entry.name === name)), first.dependencies);
  check('every dependency has existing license text and exact version', first.manifest.dependencies.every((entry) => entry.version && entry.licenses.length && entry.licenses.every((file) => statSync(path.join(target, file)).size > 100)));
  check('dependency registry identity is recorded without filesystem paths', first.manifest.dependencies.every((entry) => entry.packageIntegrity && /^https:\/\//.test(entry.packageTarball) && !JSON.stringify(entry).includes(root)));
  const module = path.join(target, 'sources/aac-encoder/modified/mediabunny-aac-encoder.mjs');
  check('corrected readable AAC module is copied byte-for-byte', hash(module) === hash(path.join(root, 'node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs')) && readFileSync(module, 'utf8').includes('inputEndTimestampInSamples'));
  const source = path.join(root, 'node_modules/@mediabunny/aac-encoder/src');
  check('all upstream preferred AAC C and TypeScript files are included unchanged', walk(source).every((file) => hash(file) === hash(path.join(target, 'sources/aac-encoder/upstream/src', path.relative(source, file)))), walk(source).length);
  check('exact AAC patch, version, MPL license and build instructions accompany its source', ['patch-aac-encoder.mjs', 'package.json', 'LICENSE', 'README.md', 'CHANGES.md'].every((file) => statSync(path.join(target, 'sources/aac-encoder', file)).size > 100)
    && hash(path.join(target, 'sources/aac-encoder/patch-aac-encoder.mjs')) === hash(path.join(root, 'scripts/patch-aac-encoder.mjs'))
    && JSON.parse(readFileSync(path.join(target, 'sources/aac-encoder/package.json'))).version === '1.61.5');
  check('modified MP3 preferred source and consumed JS are copied byte-for-byte', hash(path.join(target, 'sources/mediabunny/modified/isobmff-demuxer.ts')) === hash(path.join(root, 'node_modules/mediabunny/src/isobmff/isobmff-demuxer.ts'))
    && hash(path.join(target, 'sources/mediabunny/modified/isobmff-demuxer.js')) === hash(path.join(root, 'node_modules/mediabunny/dist/modules/src/isobmff/isobmff-demuxer.js')));
  check('exact MP3 correction script is included', hash(path.join(target, 'sources/mediabunny/patch-mediabunny-mp3.mjs')) === hash(path.join(root, 'scripts/patch-mediabunny-mp3.mjs')));
  const ffmpeg = readFileSync(path.join(target, 'ffmpeg/SOURCES_AND_BUILDS.md'), 'utf8');
  check('FFmpeg core/source/build references retain versioned upstream identities', ffmpeg.includes('v0.12.10') && ffmpeg.includes('n5.1.4') && ffmpeg.includes('Dockerfile') && ffmpeg.includes('contribution/core'));
  check('native FFmpeg supplier source/build/license records are retained', hash(path.join(target, 'ffmpeg/native-binary-README.txt')) === hash(path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe.README'))
    && hash(path.join(target, 'ffmpeg/native-binary-LICENSE.txt')) === hash(path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE')));
  check('manifest hashes describe every copied file', Object.entries(first.manifest.files).every(([file, entry]) => hash(path.join(target, file)) === entry.sha256 && statSync(path.join(target, file)).size === entry.bytes));
  const before = hash(manifestFile); prepareRuntimeNotices(target); check('repeated preparation is deterministic', hash(manifestFile) === before);
  check('source record excludes original media, executable copies, private user paths and credentials', walk(target).every((file) => !/\.(?:mp4|mov|mepj|exe|wasm)$/i.test(file)
    && !/iwatkot|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(readFileSync(file, 'utf8'))));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  check('desktop and browser build scripts prepare notices immediately after Vite', ['build', 'build:web'].every((name) => pkg.scripts[name].includes('vite build && node scripts/prepare-runtime-notices.mjs')));
  check('static distribution includes shared notices before its asset manifest', /prepareRuntimeNotices\(path\.join\(output, 'third-party'\), \{ root \}\);\s+const assets/.test(readFileSync(path.join(root, 'scripts/build-browser-distribution.mjs'), 'utf8')));

  // A tiny isolated dependency fixture verifies the guard without mutating npm.
  const invalid = path.join(work, 'unpatched');
  const put = (file, contents) => { const target = path.join(invalid, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents); };
  put('package-lock.json', '{"packages":{}}');
  for (const name of ['@mediabunny/aac-encoder', 'mediabunny']) put(`node_modules/${name}/package.json`, '{"version":"1.61.5"}');
  put('node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs', '// unpatched fixture');
  mkdirSync(path.join(invalid, 'scripts'), { recursive: true });
  for (const file of ['patch-aac-encoder.mjs', 'patch-mediabunny-mp3.mjs']) copyFileSync(path.join(root, 'scripts', file), path.join(invalid, 'scripts', file));
  let guarded = false; try { prepareRuntimeNotices(path.join(work, 'rejected'), { root: invalid }); } catch (error) { guarded = /version\/hash-pinned/.test(error.message); }
  check('unreviewed or unapplied codec corrections fail before packaging source records', guarded);
  copyFileSync(manifestFile, path.join(evidence, 'runtime-manifest.json'));
} catch (error) { check('runtime source/notice verification completes', false, error.stack ?? String(error)); }
writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), work, results }, null, 2));
console.log(`${results.filter((entry) => entry.ok).length}/${results.length} runtime notice checks; ${evidence}`);
