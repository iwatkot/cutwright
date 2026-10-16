// Read-only Movavi .mepj -> CutWright converter.
// A .mepj is a plain ZIP (meta.json + config.json). This script reads it
// without modifying anything, converts the timeline via src/lib/movavi.ts,
// preserves native editable overlays and renders PNG fallback thumbnails,
// then writes a new
// CutWright project + a conversion report next to it.
// Usage: node scripts/convert-movavi.mjs <input.mepj> <output.cutwright.json> [--name "Project name"]
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: convert-movavi.mjs <input.mepj|config.json> <output.cutwright.json> [--name X]'); process.exit(2); }
const nameIdx = process.argv.indexOf('--name');
const projectName = nameIdx > 0 ? process.argv[nameIdx + 1] : undefined;

// --- minimal ZIP reader (stored + deflate entries) -------------------------
function readZip(buf) {
  // Parse the central directory (local headers may carry zero sizes when
  // data descriptors are used, as Movavi writes them).
  const files = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('No ZIP end-of-central-directory record');
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function loadMovaviConfig(file) {
  const buf = readFileSync(file);
  if (buf.subarray(0, 2).toString('latin1') === 'PK') {
    const files = readZip(buf);
    const cfg = files.get('config.json');
    if (!cfg) throw new Error('ZIP has no config.json — not a Movavi .mepj?');
    return JSON.parse(cfg.toString('utf8'));
  }
  return JSON.parse(buf.toString('utf8'));
}

// --- PNG encoder (RGBA) + segment rasterizer for arrows --------------------
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0; }
import { deflateSync } from 'node:zlib';
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { rows[y * (w * 4 + 1)] = 0; rgba.copy(rows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}
function hexToRgba(hex) { const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim()); if (!m) return [255, 0, 0, 255]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255]; }
function renderArrowPng(arrow, w, h) {
  const rgba = Buffer.alloc(w * h * 4, 0);
  const [r, g, b, a] = hexToRgba(arrow.color);
  const segs = [[arrow.x1, arrow.y1, arrow.x2, arrow.y2]];
  if (arrow.head) {
    const ang = Math.atan2(arrow.y2 - arrow.y1, arrow.x2 - arrow.x1);
    const hl = Math.max(18, arrow.width * 2.4);
    for (const da of [2.6, -2.6]) segs.push([arrow.x2, arrow.y2, arrow.x2 + hl * Math.cos(ang + da), arrow.y2 + hl * Math.sin(ang + da)]);
  }
  const half = arrow.width / 2;
  for (const [x1, y1, x2, y2] of segs) {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1)); const maxX = Math.min(w - 1, Math.ceil(Math.max(x1, x2) + half + 1));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1)); const maxY = Math.min(h - 1, Math.ceil(Math.max(y1, y2) + half + 1));
    const dx = x2 - x1; const dy = y2 - y1; const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      let t = ((x - x1) * dx + (y - y1) * dy) / len2; t = Math.max(0, Math.min(1, t));
      const px = x1 + t * dx; const py = y1 + t * dy;
      if ((x - px) * (x - px) + (y - py) * (y - py) <= half * half) { const i = (y * w + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a; }
    }
  }
  return encodePng(rgba, w, h);
}

// --- convert -----------------------------------------------------------------
const config = loadMovaviConfig(input);
const bundlePath = path.join(tmpdir(), `cw-movavi-bundle-${process.pid}.mjs`);
await build({ entryPoints: [path.join(root, 'src', 'lib', 'movavi.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundlePath, logLevel: 'silent' });
const { convertMovaviConfig } = await import(pathToFileURL(bundlePath).href);

const assetsDir = output.replace(/\.cutwright\.json$/i, '').replace(/\.json$/i, '') + '-assets';
mkdirSync(assetsDir, { recursive: true });
const { project, assets, report } = convertMovaviConfig(config, {
  projectName: projectName ?? `${path.basename(input).replace(/\.mepj$/i, '')} (Movavi import)`,
  assetSrcPrefix: pathToFileURL(assetsDir + path.sep).href.replace(/\/$/, ''),
});

// Render PNG assets.
const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const fontDirs = [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts'), 'C:/Windows/Fonts'].filter(existsSync);
const fontFiles = fontDirs.flatMap((dir) => readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(dir, f)));
const fontKey = (s) => s.toLowerCase().replace(/\.(ttf|otf)$/i, '').replace(/[^a-z0-9]/g, '');
const fontFor = (family) => fontFiles.find((f) => fontKey(path.basename(f)) === fontKey(family))
  ?? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arial.ttf'].find(existsSync);
const resolvedFonts = new Map();
let assetsRendered = 0;
for (const asset of assets) {
  const out = path.join(assetsDir, asset.fileName);
  if (asset.kind === 'arrow' && asset.arrow) {
    writeFileSync(out, renderArrowPng(asset.arrow, project.width, project.height));
    assetsRendered++;
  } else if (asset.kind === 'title' && asset.title) {
    const font = fontFor(asset.title.fontFamily);
    resolvedFonts.set(asset.title.fontFamily, font ?? null);
    writeFileSync(path.join(assetsDir, asset.fileName + '.txt'), asset.title.lines.join('\n'), 'utf8');
    const color = asset.title.color.replace('#', '0x');
    const fontArg = font ? `:fontfile='${font.replace(/\\/g, '/').replace(/:/g, '\\:')}'` : '';
    const escText = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    // Movavi paragraphs are align=center: draw each line centered in the
    // serialized block (a single textfile drawtext would left-align lines).
    const lineStep = asset.title.lineHeight;
    const drawChain = asset.title.lines.map((line, i) =>
      `drawtext=text='${escText(line)}':fontsize=${asset.title.fontSizePx}:fontcolor=white${fontArg}:x=${asset.title.x}+(${Math.max(0, asset.title.blockWidth)}-text_w)/2:y=${asset.title.y + i * lineStep}`,
    ).join(',');
    // True transparency: draw white text on black, then alphamerge its luma
    // as the alpha of a solid serialized-color canvas. (A color=black@0
    // source negotiates to an opaque format and would black out footage.)
    const renderTitle = () => spawnSync(ffmpeg, ['-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=${project.width}x${project.height}:d=1`,
      '-f', 'lavfi', '-i', `color=c=black:s=${project.width}x${project.height}:d=1`,
      '-filter_complex', `[1:v]${drawChain},format=gray[alph];[0:v][alph]alphamerge,format=rgba[out]`,
      '-map', '[out]', '-frames:v', '1', out], { encoding: 'utf8' });
    const r = renderTitle();
    if (r.status !== 0) { console.error(`title asset failed for ${asset.fileName}: ${(r.stderr ?? '').slice(-300)}`); process.exitCode = 1; continue; }
    assetsRendered++;
  }
}

writeFileSync(output, JSON.stringify(project, null, 2), 'utf8');
const reportPath = output.replace(/\.json$/i, '.conversion-report.json');
writeFileSync(reportPath, JSON.stringify({
  input, output, assetsDir, assetsRendered,
  resolvedFonts: Object.fromEntries(resolvedFonts),
  note: 'PNG assets are thumbnail/fallback images. Native editable overlay descriptors in the project are the preview/export source.',
  assets: assets.map((a) => a.kind === 'title'
    ? { fileName: a.fileName, kind: a.kind, lines: a.title.lines.length, fontFamily: a.title.fontFamily, fontSizePx: a.title.fontSizePx, x: a.title.x, y: a.title.y, blockWidth: a.title.blockWidth, overlay: a.overlay }
    : { fileName: a.fileName, kind: a.kind, arrow: a.arrow, overlay: a.overlay }),
  ...report,
}, null, 2), 'utf8');
console.log(`Converted ${report.source.clips} Movavi clips / ${report.source.tracks} tracks / ${report.source.transitions} transitions -> ${project.clips.length} CutWright clips, ${project.media.length} media, ${assetsRendered} overlay PNGs`);
console.log(`Project: ${output}\nReport:  ${reportPath}\nDuration: ${report.source.durationSec.toFixed(3)}s at ${project.width}x${project.height} fps=${project.fps}`);
for (const w of report.warnings) console.log('WARN:', w);
