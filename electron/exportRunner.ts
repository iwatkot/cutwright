import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
  log?: string;
  logPath?: string;
  progressPath?: string;
}

export interface ExportTask {
  result: Promise<ExportResult>;
  cancel(): void;
}

/** One transaction owns its child, scratch files and cancellation state.
 * FFmpeg never writes the chosen destination until it finishes successfully.
 * In particular, a cancelled/retried job cannot truncate an earlier export.
 */
export function startExport(options: {
  ffmpegPath: string;
  args: string[];
  destination: string;
  srt: string | null;
  logDir: string;
  duration: number;
  onProgress?: (seconds: number, total: number) => void;
  onSpawn?: (pid: number) => void;
  onProgressDetails?: (progress: Record<string, string>) => void;
  prepareInput?: (input: string, signal: AbortSignal) => Promise<string>;
}): ExportTask {
  const abort = new AbortController();
  let child: ChildProcessWithoutNullStreams | null = null;
  const result = (async (): Promise<ExportResult> => {
    let scratch = '';
    let partial = '';
    let logPath: string | undefined;
    let logFd: number | null = null;
    let progressFd: number | null = null;
    let progressPath: string | undefined;
    let tail = '';
    let firstError = '';
    let logWriteFailed = false;
    const appendLog = (value: string) => {
      try { if (logFd !== null) fs.writeSync(logFd, value); }
      catch (error) {
        if (!logWriteFailed) tail += `\nExport log could not be written: ${String(error)}\n`;
        logWriteFailed = true;
      }
      tail = (tail + value).slice(-6000);
      if (!firstError) firstError = value.split(/\r?\n/).find((line) => /error|invalid|failed|no such|matches no streams/i.test(line))?.trim() ?? '';
    };
    try {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cutwright-export-'));
      const suffix = path.basename(scratch);
      partial = path.join(path.dirname(options.destination), `.${suffix}.partial.mp4`);
      fs.mkdirSync(options.logDir, { recursive: true });
      logPath = path.join(options.logDir, `${suffix}.txt`);
      logFd = fs.openSync(logPath, 'w');
      progressPath = path.join(options.logDir, `${suffix}.progress.txt`);
      progressFd = fs.openSync(progressPath, 'w');
      let escapedSrt = '';
      if (options.srt) {
        const extension = /^\s*\[Script Info\]/i.test(options.srt) ? 'ass' : 'srt';
        const subPath = path.join(scratch, `subtitles.${extension}`);
        fs.writeFileSync(subPath, options.srt, 'utf8');
        escapedSrt = subPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      }
      const args = [...options.args];
      // Callers may supply a concrete output path (verification scripts) or
      // the renderer's placeholder. Both use the same atomic destination.
      args[args.length - 1] = partial;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-i') {
          const input = args[i + 1];
          args[i + 1] = options.prepareInput ? await options.prepareInput(input, abort.signal) : input.startsWith('file:') ? fileURLToPath(input) : input;
          if (abort.signal.aborted) throw new Error('Export cancelled');
        }
        if (args[i] === '-filter_complex') {
          // Windows CreateProcess has a 32767-character command limit. A
          // real timeline's graph easily exceeds it; the script is unlimited.
          const graphPath = path.join(scratch, 'composition.ffgraph');
          fs.writeFileSync(graphPath, args[i + 1].replaceAll('CWSRTTOKEN', escapedSrt), 'utf8');
          args[i] = '-filter_complex_script';
          args[i + 1] = graphPath;
        }
      }
      if (abort.signal.aborted) throw new Error('Export cancelled');
      const code = await new Promise<number>((resolve, reject) => {
        child = spawn(options.ffmpegPath, ['-nostdin', '-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
        if (child.pid) options.onSpawn?.(child.pid);
        let pending = '';
        let lastSent = -1;
        let encodedFrames = 0;
        const progress: Record<string, string> = {};
        const frameRateIndex = args.lastIndexOf('-r');
        const frameRate = frameRateIndex >= 0 ? Number(args[frameRateIndex + 1]) : 0;
        child.stdout.on('data', (data: Buffer) => {
          try { if (progressFd !== null) fs.writeSync(progressFd, data); }
          catch { /* A diagnostic disk failure must not crash the editor or orphan its encoder. */ }
          pending += data.toString();
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            const equal = line.indexOf('=');
            if (equal >= 0) progress[line.slice(0, equal)] = line.slice(equal + 1);
            if (line.startsWith('frame=')) encodedFrames = Number(line.slice(6)) || 0;
            if (line.startsWith('progress=')) options.onProgressDetails?.({ ...progress });
            if (!line.startsWith('out_time_us=')) continue;
            const elapsed = frameRate > 0 ? encodedFrames / frameRate : Number(line.slice(12)) / 1_000_000;
            const seconds = Math.min(options.duration, Math.max(0, elapsed));
            if (Number.isFinite(seconds) && seconds - lastSent >= 0.25) {
              lastSent = seconds;
              options.onProgress?.(seconds, options.duration);
            }
          }
        });
        child.stderr.on('data', (data: Buffer) => appendLog(data.toString()));
        child.once('error', reject);
        child.once('close', (exitCode) => { child = null; resolve(exitCode ?? -1); });
      });
      if (abort.signal.aborted) return { ok: false, error: 'Export cancelled', logPath, progressPath };
      if (code !== 0) return { ok: false, error: `FFmpeg exited ${code}${firstError ? ': ' + firstError : ''}`, log: tail, logPath, progressPath };
      if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) throw new Error('FFmpeg produced an empty output file.');
      fs.renameSync(partial, options.destination);
      options.onProgress?.(options.duration, options.duration);
      return { ok: true, path: options.destination, log: tail, logPath, progressPath };
    } catch (error) {
      return { ok: false, error: abort.signal.aborted ? 'Export cancelled' : String(error), log: tail, logPath, progressPath };
    } finally {
      if (logFd !== null) fs.closeSync(logFd);
      if (progressFd !== null) fs.closeSync(progressFd);
      if (partial) fs.rmSync(partial, { force: true });
      // Verify the resolved recursive-delete target is exactly a scratch
      // directory created beneath the system temporary directory.
      if (scratch && path.dirname(path.resolve(scratch)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()
        && path.basename(scratch).startsWith('cutwright-export-')) fs.rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return { result, cancel: () => { abort.abort(); child?.kill(); } };
}
