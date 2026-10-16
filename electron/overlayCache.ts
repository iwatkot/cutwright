import { BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface OverlayInput {
  overlay: Record<string, unknown>;
  width: number;
  height: number;
  fps: number;
  duration: number;
  offset: number;
  speed: number;
}

/** Rasterize native vector animation once into a reusable lossless alpha
 * clip. The isolated renderer runs the exact preview SVG generator, using
 * installed fonts and composition pixels; FFmpeg only compresses its PNGs.
 */
export function createOverlayPreparation(ffmpegPath: string, cacheDir: string) {
  let window: BrowserWindow | null = null;
  const browserScript = fs.readFileSync(path.join(__dirname, 'overlay-browser.js'), 'utf8');
  const scriptHash = createHash('sha256').update(browserScript).digest('hex');
  const getWindow = async () => {
    if (window && !window.isDestroyed()) return window;
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await window.loadURL('data:text/html;charset=utf-8,<canvas id="overlay"></canvas>');
    await window.webContents.executeJavaScript(browserScript);
    return window;
  };
  return {
    async prepareInput(input: string, signal: AbortSignal): Promise<string> {
      if (!input.startsWith('cutwright-overlay:')) return input.startsWith('file:') ? fileURLToPath(input) : input;
      const descriptor = JSON.parse(input.slice('cutwright-overlay:'.length)) as OverlayInput;
      if (!(descriptor.width > 0 && descriptor.width <= 7680 && descriptor.height > 0 && descriptor.height <= 4320
        && descriptor.fps > 0 && descriptor.fps <= 120 && descriptor.duration > 0 && descriptor.duration <= 86400)) throw new Error('Invalid native overlay export dimensions or timing.');
      fs.mkdirSync(cacheDir, { recursive: true });
      const key = createHash('sha256').update(scriptHash).update(JSON.stringify(descriptor)).digest('hex');
      const output = path.join(cacheDir, key + '.mkv');
      if (fs.existsSync(output) && fs.statSync(output).size > 0) return output;
      const partial = output + `.${process.pid}.partial.mkv`;
      const renderer = await getWindow();
      if (signal.aborted) throw new Error('Export cancelled');
      const child = spawn(ffmpegPath, ['-y', '-nostdin', '-hide_banner', '-v', 'error', '-threads', '2',
        '-f', 'image2pipe', '-framerate', String(descriptor.fps), '-i', 'pipe:0',
        '-an', '-c:v', 'ffv1', '-threads', '2', '-level', '3', '-pix_fmt', 'bgra', partial], { windowsHide: true });
      let errors = '';
      child.stderr.on('data', (data: Buffer) => { errors = (errors + data.toString()).slice(-4000); });
      child.stdin.on('error', () => { /* Child close reports the useful FFmpeg diagnostic. */ });
      const closed = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? -1));
      });
      void closed.catch(() => undefined); // Observe spawn errors during asynchronous rasterization too.
      const cancel = () => child.kill();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const frames = Math.max(1, Math.ceil(descriptor.duration * descriptor.fps));
        for (let i = 0; i < frames; i += 6) {
          if (signal.aborted) throw new Error('Export cancelled');
          const count = Math.min(6, frames - i);
          const pngs = await renderer.webContents.executeJavaScript(`(async () => {
            const d = ${JSON.stringify(descriptor)};
            const canvas = document.getElementById('overlay');
            canvas.width = d.width; canvas.height = d.height;
            const ctx = canvas.getContext('2d');
            const pngs = [];
            for (let j = 0; j < ${count}; j++) {
              const svg = CutWrightOverlay.overlaySvg(d.overlay, d.width, d.height, d.offset + (${i} + j) / d.fps * d.speed);
              const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              try {
                const image = new Image(); image.src = url; await image.decode();
                ctx.clearRect(0, 0, d.width, d.height); ctx.drawImage(image, 0, 0);
                pngs.push(canvas.toDataURL('image/png').split(',')[1]);
              } finally { URL.revokeObjectURL(url); }
            }
            return pngs;
          })()`);
          for (const png of pngs as string[]) {
            if (child.exitCode !== null || child.killed) throw new Error(errors || 'Native overlay encoder stopped.');
            if (!child.stdin.write(Buffer.from(png, 'base64'))) await Promise.race([
              once(child.stdin, 'drain'),
              closed.then((code) => { throw new Error(`Native overlay encoder closed while writing (${code}): ${errors}`); }),
            ]);
          }
        }
        child.stdin.end();
        const code = await closed;
        if (signal.aborted) throw new Error('Export cancelled');
        if (code !== 0) throw new Error(`Native overlay rendering failed (${code}): ${errors}`);
        fs.renameSync(partial, output);
        return output;
      } finally {
        signal.removeEventListener('abort', cancel);
        if (child.exitCode === null) child.kill();
        await closed.catch(() => undefined);
        fs.rmSync(partial, { force: true });
      }
    },
    dispose() { if (window && !window.isDestroyed()) window.destroy(); window = null; },
  };
}
