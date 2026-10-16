// Build a self-contained static browser distribution without rewriting the
// renderer or installer currently under desktop verification.
import { build } from 'vite';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeNotices } from './prepare-runtime-notices.mjs';

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const release = path.join(root, 'release');
mkdirSync(release, { recursive: true });
if (realpathSync(release) !== release || lstatSync(release).isSymbolicLink()) throw new Error('The release directory must be inside the project, without a symbolic link.');
const output = path.join(release, 'browser');
const snapshot = path.join(release, `.browser-source-${randomUUID()}`);
for (const target of [output, snapshot]) {
  if (path.dirname(target) !== release || target === release || existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Unsafe browser build path.');
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pkg = readJson(path.join(root, 'package.json'));
const installerName = `CutWright-Setup-${pkg.version}.exe`;
const configuredDownloadUrl = process.env.CW_DESKTOP_DOWNLOAD_URL;
let downloadUrl = `downloads/${installerName}`;
if (configuredDownloadUrl !== undefined) {
  let parsed;
  try { parsed = new URL(configuredDownloadUrl); }
  catch { throw new Error('CW_DESKTOP_DOWNLOAD_URL must be an absolute HTTPS URL without credentials or a fragment.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('CW_DESKTOP_DOWNLOAD_URL must be an absolute HTTPS URL without credentials or a fragment.');
  }
  downloadUrl = parsed.href;
}
const bundledInstaller = configuredDownloadUrl === undefined;
for (const patch of ['patch-aac-encoder.mjs', 'patch-mediabunny-mp3.mjs']) {
  execFileSync(process.execPath, [path.join(root, 'scripts', patch)], { cwd: root, stdio: 'inherit', windowsHide: true });
}
const installer = path.join(release, installerName);
if (!existsSync(installer) || !statSync(installer).isFile()) throw new Error(`Build the Electron installer first: ${installerName} is missing from release/.`);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const installerSourceHash = hash(installer);
const installerSourceBytes = statSync(installer).size;
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported in the browser source snapshot: ${entry.name}`);
  return entry.isDirectory() ? walk(file) : [file];
});
const sourceFiles = [
  ...['src', 'scripts', 'tests', 'public'].filter(directory => existsSync(path.join(root, directory))).flatMap((directory) => walk(path.join(root, directory))),
  ...['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.electron.json', 'vite.config.ts', 'README.md', 'BROWSER.md', 'PRODUCT_GOALS.md'].map((name) => path.join(root, name)).filter(existsSync),
].sort();
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [path.relative(root, file).replaceAll('\\', '/'), hash(file)]));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().length > 0;
mkdirSync(snapshot);
let successful = false;
try {
  for (const file of sourceFiles) {
    const relative = path.relative(root, file);
    const copied = path.join(snapshot, relative);
    mkdirSync(path.dirname(copied), { recursive: true });
    copyFileSync(file, copied);
    if (hash(copied) !== sourceHashes[relative.replaceAll('\\', '/')]) throw new Error(`Source changed while being captured: ${relative}. Run the build again after the edit finishes.`);
  }
  // The snapshot is a descendant of the project and resolves the existing
  // node_modules, but each source file is frozen before Vite sees it.
  await build({ root: snapshot, configFile: path.join(snapshot, 'vite.config.ts'), base: './',
    build: { outDir: output, emptyOutDir: true, manifest: true },
  });
  if (bundledInstaller) {
    mkdirSync(path.join(output, 'downloads'), { recursive: true });
    copyFileSync(installer, path.join(output, downloadUrl));
  }
  // GitHub Pages and other static hosts can serve the app while a pinned
  // release asset serves the larger installer. The local accepted installer
  // remains the source of its recorded identity in either packaging mode.
  writeFileSync(path.join(output, '.nojekyll'), '');
  const desktopIdentityPath = path.join(root, 'screenshots/desktop-installed-artifacts.json');
  const desktopIdentity = existsSync(desktopIdentityPath) ? readJson(desktopIdentityPath) : null;
  const installerHash = bundledInstaller ? hash(path.join(output, downloadUrl)) : installerSourceHash;
  if (installerHash !== installerSourceHash || hash(installer) !== installerSourceHash || statSync(installer).size !== installerSourceBytes) throw new Error('The Electron installer changed during packaging. Run the browser package again after that build finishes.');
  const knownInstaller = desktopIdentity?.artifacts?.find((artifact) => path.basename(artifact.path) === installerName);
  const instructions = [
    '# CutWright static browser distribution', '',
    'Serve this entire directory from an HTTPS static host. It also runs on http://localhost for local verification.',
    bundledInstaller ? 'Keep the assets and downloads directories alongside index.html. The app can be mounted at a URL subpath.'
      : 'Keep the assets directory alongside index.html. The app can be mounted at a URL subpath; the desktop installer is downloaded separately from the pinned HTTPS URL below.',
    'Serve .js files as JavaScript and .wasm files as application/wasm. No application backend or upload endpoint is needed.',
    'Use current Chrome or Edge with local storage enabled for browser video export. Opening index.html directly with file:// is not supported.',
    `The desktop download is ${downloadUrl}. Its SHA-256 is ${installerHash}.`,
    'The included build manifest records source and artifact identities. A successful build alone does not certify release quality.',
    'Keep media originals and save project files separately; local browser storage belongs to the current site and browser profile.', '',
  ].join('\n');
  writeFileSync(path.join(output, 'DEPLOY.md'), instructions);
  const browserPackages = ['react', 'react-dom', 'scheduler', 'zustand', 'mediabunny', '@mediabunny/aac-encoder', '@ffmpeg/ffmpeg', '@ffmpeg/types', '@ffmpeg/core'];
  mkdirSync(path.join(output, 'licenses'), { recursive: true });
  const dependencies = browserPackages.map((name) => {
    const directory = path.join(root, 'node_modules', name);
    const info = readJson(path.join(directory, 'package.json'));
    const packagedLicense = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING'].map((file) => path.join(directory, file)).find(existsSync);
    const licenseFile = packagedLicense ?? (name.startsWith('@ffmpeg/')
      ? path.join(root, 'scripts/licenses', name === '@ffmpeg/core' ? 'FFmpeg-GPLv2.txt' : 'ffmpeg-wasm-MIT.txt') : null);
    if (!licenseFile || !existsSync(licenseFile)) throw new Error(`License text is missing for ${name}.`);
    const notice = `licenses/${name.replaceAll('@', '').replaceAll('/', '-')}.txt`;
    copyFileSync(licenseFile, path.join(output, notice));
    const entry = typeof info.module === 'string' ? info.module : typeof info.main === 'string' ? info.main : 'index.js';
    const entryFile = path.join(directory, entry);
    return { name, version: info.version, license: info.license, repository: typeof info.repository === 'string' ? info.repository : info.repository?.url, notice,
      declaredEntry: entry, declaredEntrySha256: existsSync(entryFile) ? hash(entryFile) : null };
  });
  copyFileSync(path.join(root, 'node_modules/@mediabunny/aac-encoder/README.md'), path.join(output, 'licenses/aac-encoder-build-and-dependencies.md'));
  if (existsSync(path.join(root, 'scripts/patch-aac-encoder.mjs'))) copyFileSync(path.join(root, 'scripts/patch-aac-encoder.mjs'), path.join(output, 'licenses/aac-encoder-local-patch.mjs'));
  if (existsSync(path.join(root, 'scripts/patch-mediabunny-mp3.mjs'))) {
    copyFileSync(path.join(root, 'scripts/patch-mediabunny-mp3.mjs'), path.join(output, 'licenses/mediabunny-mp3-local-patch.mjs'));
    copyFileSync(path.join(root, 'node_modules/mediabunny/src/isobmff/isobmff-demuxer.ts'), path.join(output, 'licenses/mediabunny-isobmff-demuxer.ts'));
    copyFileSync(path.join(root, 'node_modules/mediabunny/dist/modules/src/isobmff/isobmff-demuxer.js'), path.join(output, 'licenses/mediabunny-isobmff-demuxer.js'));
  }
  writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), [
    '# Browser runtime components', '',
    'The following components retain their own licenses. Their installed versions and license texts accompany this distribution.', '',
    ...dependencies.map((dependency) => `- ${dependency.name} ${dependency.version}: ${dependency.license}; [license text](${dependency.notice}); source repository: ${dependency.repository}`), '',
    'The AAC extension includes a libavcodec-based encoder. Its upstream build instructions and dependency details are included in licenses/aac-encoder-build-and-dependencies.md.',
    'The local AAC JavaScript timing correction, if present, is included as licenses/aac-encoder-local-patch.mjs, with the upstream attribution and a record of the changes. Dependency entry hashes are recorded in distribution-manifest.json.',
    'The local Mediabunny MP3 sample-entry correction, if present, is included as licenses/mediabunny-mp3-local-patch.mjs, alongside the modified demuxer source and JavaScript under the original MPL-2.0 license. It recognizes QuickTime MP3 tracks without changing packet data.',
    'The unmodified FFmpeg WebAssembly core has the license of FFmpeg and its compiled external libraries. See https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm and the upstream source/build scripts at https://github.com/ffmpegwasm/ffmpeg.wasm.', '',
  ].join('\n'));
  prepareRuntimeNotices(path.join(output, 'third-party'), { root });
  const assets = Object.fromEntries(walk(output).map((file) => [path.relative(output, file).replaceAll('\\', '/'), { bytes: statSync(file).size, sha256: hash(file) }]));
  const manifest = {
    schemaVersion: 1, application: pkg.name, version: pkg.version, builtAt: new Date().toISOString(),
    source: { commit: sourceCommit, dirty: sourceDirty, files: sourceHashes },
    browser: { base: './', requiresApplicationBackend: false, assets, dependencies },
    vendorCorrections: {
      aacEncoder: { script: sourceHashes['scripts/patch-aac-encoder.mjs'], moduleSha256: hash(path.join(root, 'node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs')) },
      mp3SampleEntry: { script: sourceHashes['scripts/patch-mediabunny-mp3.mjs'], moduleSha256: hash(path.join(root, 'node_modules/mediabunny/dist/modules/src/isobmff/isobmff-demuxer.js')), sourceSha256: hash(path.join(root, 'node_modules/mediabunny/src/isobmff/isobmff-demuxer.ts')) },
    },
    desktop: { url: downloadUrl, bundled: bundledInstaller, sha256: installerHash, bytes: installerSourceBytes,
      sourceCommit: knownInstaller?.sha256?.toLowerCase() === installerHash ? desktopIdentity.sourceCommit : null,
      matchesRecordedInstalledArtifact: knownInstaller?.sha256?.toLowerCase() === installerHash,
    },
    acceptance: 'pending-verification',
  };
  writeFileSync(path.join(output, 'distribution-manifest.json'), JSON.stringify(manifest, null, 2));
  successful = true;
  console.log(`Static browser distribution: ${output}`);
  console.log(`Electron download: ${downloadUrl}`);
  console.log(`Installer SHA-256: ${installerHash}`);
} finally {
  // All recursive cleanup stays in the exact snapshot path validated above.
  if (path.dirname(snapshot) !== release || !path.basename(snapshot).startsWith('.browser-source-')) throw new Error('Refusing unsafe snapshot cleanup.');
  rmSync(snapshot, { recursive: true, force: true });
  if (!successful) console.error('The browser distribution did not finish; do not publish its partial output.');
}
