// Package locally installed notices and source records. No downloads, codec
// rebuilds, dependency mutations, original media or private projects are used.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const relative = (base, file) => path.relative(base, file).replaceAll('\\', '/');
function packageDirectory(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(directory) === directory) throw new Error(`Installed runtime dependency is missing: ${name}`);
  }
}
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error(`Refusing a symbolic link in packaged notices: ${entry.name}`);
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function runtimePackages(root) {
  const pending = Object.keys(json(path.join(root, 'package.json')).dependencies).map((name) => ({ name, from: root }));
  const seen = new Set(), packages = [];
  while (pending.length) {
    const { name, from, optional } = pending.shift();
    let directory;
    try { directory = packageDirectory(name, from); } catch (error) { if (optional) continue; throw error; }
    if (seen.has(directory)) continue;
    seen.add(directory);
    const info = json(path.join(directory, 'package.json'));
    packages.push({ directory, info });
    for (const [dependency] of Object.entries(info.dependencies ?? {})) pending.push({ name: dependency, from: directory, optional: !!info.optionalDependencies?.[dependency] });
    for (const [dependency] of Object.entries({ ...info.optionalDependencies, ...info.peerDependencies })) pending.push({ name: dependency, from: directory, optional: true });
  }
  return packages.sort((a, b) => `${a.info.name}@${a.info.version}`.localeCompare(`${b.info.name}@${b.info.version}`));
}

export function prepareRuntimeNotices(output = path.join(projectRoot, 'dist', 'third-party'), { root = projectRoot } = {}) {
  output = path.resolve(output);
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('The runtime notice destination must not be a symbolic link.');
  mkdirSync(output, { recursive: true });
  const copy = (source, destination) => {
    if (!statSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error(`Missing regular notice/source file: ${path.basename(source)}`);
    const target = path.join(output, destination); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target); return destination.replaceAll('\\', '/');
  };
  const write = (destination, text) => { const target = path.join(output, destination); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  const lock = json(path.join(root, 'package-lock.json'));
  const aac = packageDirectory('@mediabunny/aac-encoder', root), mp3 = packageDirectory('mediabunny', root);
  const aacInfo = json(path.join(aac, 'package.json')), mp3Info = json(path.join(mp3, 'package.json'));
  const aacPatch = readFileSync(path.join(root, 'scripts/patch-aac-encoder.mjs'), 'utf8');
  const mp3Patch = readFileSync(path.join(root, 'scripts/patch-mediabunny-mp3.mjs'), 'utf8');
  const aacExpected = aacPatch.match(/const patchedHash = '([a-f0-9]{64})'/)?.[1];
  const mp3Expected = [...mp3Patch.matchAll(/patched: '([a-f0-9]{64})'/g)].map((match) => match[1]);
  if (aacInfo.version !== '1.61.5' || mp3Info.version !== '1.61.5' || !aacExpected || mp3Expected.length !== 2
    || hash(path.join(aac, 'dist/bundles/mediabunny-aac-encoder.mjs')) !== aacExpected
    || !mp3Expected.includes(hash(path.join(mp3, 'src/isobmff/isobmff-demuxer.ts')))
    || !mp3Expected.includes(hash(path.join(mp3, 'dist/modules/src/isobmff/isobmff-demuxer.js')))) {
    throw new Error('Runtime source corrections do not match the version/hash-pinned patches. Run the reviewed postinstall scripts before building.');
  }
  copy(path.join(root, 'LICENSE'), 'CutWright-LICENSE.txt');
  const packages = runtimePackages(root);
  const dependencies = packages.map(({ directory, info }) => {
    const slug = `${info.name.replaceAll('@', '').replaceAll('/', '-')}-${info.version}`;
    const licenses = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)).map((entry) =>
      copy(path.join(directory, entry.name), path.join('licenses', slug, entry.name)));
    if (!licenses.length && info.name.startsWith('@ffmpeg/')) {
      const fallback = info.name === '@ffmpeg/core' ? 'FFmpeg-GPLv2.txt' : 'ffmpeg-wasm-MIT.txt';
      licenses.push(copy(path.join(root, 'scripts/licenses', fallback), path.join('licenses', slug, fallback)));
    }
    if (!licenses.length) {
      const readme = readdirSync(directory).find((name) => /^readme(?:\.md|\.txt)?$/i.test(name));
      if (readme && /Permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/i.test(readFileSync(path.join(directory, readme), 'utf8'))) {
        licenses.push(copy(path.join(directory, readme), path.join('licenses', slug, 'README-with-license.md')));
      }
    }
    if (!licenses.length) throw new Error(`Runtime license text is missing for ${info.name}@${info.version}.`);
    const installed = relative(root, directory), locked = lock.packages?.[installed];
    return { name: info.name, version: info.version, license: info.license ?? null,
      repository: typeof info.repository === 'string' ? info.repository : info.repository?.url ?? null,
      packageJsonSha256: hash(path.join(directory, 'package.json')), licenses,
      packageTarball: locked?.resolved ?? null, packageIntegrity: locked?.integrity ?? null };
  });
  const corrections = [
    { name: 'AAC priming and final sample duration', package: '@mediabunny/aac-encoder', version: aacInfo.version,
      patch: copy(path.join(root, 'scripts/patch-aac-encoder.mjs'), 'sources/aac-encoder/patch-aac-encoder.mjs'),
      modified: [copy(path.join(aac, 'dist/bundles/mediabunny-aac-encoder.mjs'), 'sources/aac-encoder/modified/mediabunny-aac-encoder.mjs')],
      preferredUpstream: walk(path.join(aac, 'src')).map((source) => copy(source, path.join('sources/aac-encoder/upstream/src', relative(path.join(aac, 'src'), source)))) },
    { name: 'QuickTime MP3 sample-entry recognition', package: 'mediabunny', version: mp3Info.version,
      patch: copy(path.join(root, 'scripts/patch-mediabunny-mp3.mjs'), 'sources/mediabunny/patch-mediabunny-mp3.mjs'),
      modified: [copy(path.join(mp3, 'src/isobmff/isobmff-demuxer.ts'), 'sources/mediabunny/modified/isobmff-demuxer.ts'),
        copy(path.join(mp3, 'dist/modules/src/isobmff/isobmff-demuxer.js'), 'sources/mediabunny/modified/isobmff-demuxer.js')] },
  ];
  for (const [directory, destination] of [[aac, 'aac-encoder'], [mp3, 'mediabunny']]) {
    copy(path.join(directory, 'package.json'), `sources/${destination}/package.json`);
    copy(path.join(directory, 'README.md'), `sources/${destination}/README.md`);
    copy(path.join(directory, 'LICENSE'), `sources/${destination}/LICENSE`);
  }
  write('sources/aac-encoder/CHANGES.md', [
    '# CutWright AAC timing correction', '',
    `Upstream package: @mediabunny/aac-encoder ${aacInfo.version}. The original copyright and MPL-2.0 license are retained.`,
    'modified/mediabunny-aac-encoder.mjs is the readable JavaScript module actually consumed by this build, including the original embedded encoder.',
    'upstream/src contains the preferred TypeScript and C source files supplied in that exact installed package. These upstream source files are unmodified.',
    'The correction is applied to the consumed JavaScript module: preserve libavcodec packet PTS (including negative priming), omit packets beyond the actual input end, and trim the final packet duration.',
    'patch-aac-encoder.mjs records the exact substitutions and original/result SHA-256 values. Apply it in a CutWright checkout after installing the recorded package version; it refuses other versions/hashes.',
    'README.md contains the upstream FFmpeg/encoder build instructions. No codec or embedded WASM bytes are changed by the local timing correction.',
    'The package version, registry tarball/integrity, copied-file hashes and upstream repository are recorded in ../../runtime-manifest.json.', '',
  ].join('\n'));
  write('sources/mediabunny/CHANGES.md', [
    '# CutWright MP3 sample-entry correction', '',
    `Upstream package: Mediabunny ${mp3Info.version}, MPL-2.0.`,
    "The modified TypeScript and JavaScript recognize QuickTime's .mp3 audio sample-entry tag. Packet bytes, timestamps and codecs are unchanged.",
    'patch-mediabunny-mp3.mjs contains the exact version/hash guards and substitutions. The original notices are retained in both modified files.',
    'Package identity, upstream repository and copied-file hashes are recorded in ../../runtime-manifest.json.', '',
  ].join('\n'));
  const native = packageDirectory('ffmpeg-static', root), nativeInfo = json(path.join(native, 'package.json'));
  const nativeReadme = readdirSync(native).find((name) => /^ffmpeg(?:\.exe)?\.README$/i.test(name));
  const nativeLicense = readdirSync(native).find((name) => /^ffmpeg(?:\.exe)?\.LICENSE$/i.test(name));
  copy(path.join(native, 'README.md'), 'ffmpeg/native-package-README.md');
  if (nativeReadme) copy(path.join(native, nativeReadme), 'ffmpeg/native-binary-README.txt');
  if (nativeLicense) copy(path.join(native, nativeLicense), 'ffmpeg/native-binary-LICENSE.txt');
  write('ffmpeg/SOURCES_AND_BUILDS.md', [
    '# FFmpeg components and upstream build references', '',
    'CutWright does not modify these codec binaries. This directory records their installed-package identity, license texts and upstream source/build references; it does not rebuild or download FFmpeg.', '',
    '## Browser audio tempo core', '',
    '- Installed @ffmpeg/core version and registry integrity are recorded in ../runtime-manifest.json; the wrapper and core have distinct licenses.',
    '- The 0.12.10 core upstream source/build configuration: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10',
    '- That Dockerfile pins FFmpeg n5.1.4 and lists external-library repositories/versions: https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v0.12.10/Dockerfile',
    '- FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n5.1.4',
    '- Core build scripts: https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10/build',
    '- Core build instructions: https://ffmpegwasm.netlify.app/docs/contribution/core/',
    '- Upstream license explanation: https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm', '',
    '## AAC extension', '',
    `- @mediabunny/aac-encoder ${aacInfo.version} embeds a libavcodec-based AAC encoder.`,
    '- Its supplied C/TypeScript source and complete upstream build instructions accompany this distribution under ../sources/aac-encoder/.',
    '- The local correction changes JavaScript packet timing only; the embedded encoder bytes are unchanged.', '',
    '## Desktop executable', '',
    `- Installed ffmpeg-static package: ${nativeInfo.version}; binary release tag: ${nativeInfo['ffmpeg-static']?.['binary-release-tag'] ?? 'see package README'}.`,
    '- native-package-README.md describes the upstream binary suppliers and build/release links.',
    '- native-binary-README.txt and native-binary-LICENSE.txt, when supplied by the installed package, retain the binary supplier version, source commit, external-library list and license.',
    '- FFmpeg source and legal information: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html', '',
    'Electron also ships its own LICENSE and LICENSES.chromium.html alongside the installed executable; retain those files when redistributing it.', '',
  ].join('\n'));
  write('THIRD_PARTY_NOTICES.md', [
    '# CutWright runtime components', '',
    'The installed runtime dependency versions below retain their own licenses. This inventory includes the desktop and browser dependency closure; a particular edition may use only a subset.', '',
    ...dependencies.map((dependency) => `- ${dependency.name} ${dependency.version}: ${dependency.license}; ${dependency.licenses.map((file) => `[${path.basename(file)}](${file})`).join(', ')}`), '',
    'Local source corrections and their exact patch scripts are in [sources/](sources/). AAC upstream preferred C/TypeScript source, the consumed modified module, version metadata and build instructions are included.',
    'See [FFmpeg source/build references](ffmpeg/SOURCES_AND_BUILDS.md) for the distinct browser core, AAC extension and native executable.',
    'See [runtime-manifest.json](runtime-manifest.json) for package identities, registry integrity and SHA-256 hashes of the accompanying files.', '',
  ].join('\n'));
  const files = Object.fromEntries(walk(output).filter((file) => path.basename(file) !== 'runtime-manifest.json').map((file) => [relative(output, file), { bytes: statSync(file).size, sha256: hash(file) }]));
  const manifest = { schemaVersion: 1, dependencies, corrections, files };
  write('runtime-manifest.json', JSON.stringify(manifest, null, 2));
  return { output, dependencies: dependencies.length, files: Object.keys(files).length, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = prepareRuntimeNotices(process.argv[2]);
  console.log(`Runtime notices prepared: ${result.output} (${result.dependencies} dependencies, ${result.files} files).`);
}
