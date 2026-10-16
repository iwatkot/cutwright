import coreAsset from '@ffmpeg/core?url';
import wasmAsset from '@ffmpeg/core/wasm?url';
import workerAsset from '@ffmpeg/ffmpeg/worker?worker&url';

export const DEFAULT_MAX_PCM_BYTES = 64 * 1024 * 1024;
export interface TempoRequest {
  pcm: Float32Array;
  sampleRate: number;
  channels: 1 | 2;
  speed: number;
  targetFrames: number;
  signal?: AbortSignal;
}
export interface TempoWorker {
  load(config: { coreURL: string; wasmURL: string; classWorkerURL: string }): Promise<unknown>;
  writeFile(path: string, bytes: Uint8Array): Promise<unknown>;
  exec(args: string[]): Promise<number>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<unknown>;
  terminate(): void;
  on?(event: 'log', listener: (event: { message: string }) => void): void;
}
export interface TempoOptions {
  coreURL?: string;
  wasmURL?: string;
  classWorkerURL?: string;
  maxPCMBytes?: number;
  /** Allows deterministic worker lifecycle tests without launching WASM. */
  createWorker?: () => Promise<TempoWorker>;
}

export const audioTempoFilters = (speed: number): string[] => {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Audio speed must be greater than zero.');
  const filters: string[] = [];
  let rest = speed;
  while (rest > 2) { filters.push('atempo=2.000'); rest /= 2; }
  while (rest < .5) { filters.push('atempo=0.500'); rest *= 2; }
  filters.push(`atempo=${rest.toFixed(3)}`);
  return filters;
};
const aborted = () => new DOMException('Audio preparation cancelled', 'AbortError');
const absoluteAsset = (url: string) => new URL(url, globalThis.location?.href ?? 'http://localhost/').href;

/** Local, single-thread WASM handles decoded PCM only. Original media stays
 * in Mediabunny's bounded decoder; this worker never runs a video graph. */
export function createAudioTempoProcessor(options: TempoOptions = {}) {
  const maxPCMBytes = options.maxPCMBytes ?? DEFAULT_MAX_PCM_BYTES;
  if (!Number.isSafeInteger(maxPCMBytes) || maxPCMBytes <= 0) throw new Error('Decoded audio memory limit must be a positive integer.');
  let worker: TempoWorker | null = null;
  let loaded: Promise<TempoWorker> | null = null;
  let generation = 0;
  let disposed = false;
  let queue = Promise.resolve();
  let diagnostic = '';
  const terminate = () => {
    generation++;
    worker?.terminate();
    worker = null;
    loaded = null;
  };
  const load = () => loaded ??= (async () => {
    const epoch = generation;
    const next = options.createWorker ? await options.createWorker() : new (await import('@ffmpeg/ffmpeg')).FFmpeg();
    if (epoch !== generation || disposed) { next.terminate(); throw aborted(); }
    worker = next;
    next.on?.('log', ({ message }) => { diagnostic = (diagnostic + '\n' + message).slice(-4000); });
    await next.load({
      coreURL: absoluteAsset(options.coreURL ?? coreAsset),
      wasmURL: absoluteAsset(options.wasmURL ?? wasmAsset),
      classWorkerURL: absoluteAsset(options.classWorkerURL ?? workerAsset),
    });
    if (epoch !== generation || disposed) throw aborted();
    return next;
  })().catch((error) => { loaded = null; throw error; });

  const process = async (request: TempoRequest): Promise<Float32Array> => {
    const { pcm, sampleRate, channels, speed, targetFrames, signal } = request;
    if (disposed) throw new Error('Audio tempo processor is closed.');
    if (signal?.aborted) throw aborted();
    if (!(pcm instanceof Float32Array) || ![1, 2].includes(channels) || pcm.length % channels
      || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000
      || !Number.isSafeInteger(targetFrames) || targetFrames < 0) throw new Error('Invalid decoded audio window.');
    const filters = audioTempoFilters(speed);
    const outputBytes = targetFrames * channels * Float32Array.BYTES_PER_ELEMENT;
    if (pcm.byteLength + outputBytes > maxPCMBytes) {
      throw new Error(`This speed change needs ${Math.ceil((pcm.byteLength + outputBytes) / 1048576)} MiB of decoded audio. Split the clip into shorter sections (limit ${Math.floor(maxPCMBytes / 1048576)} MiB).`);
    }
    if (speed === 1 || targetFrames === 0) {
      const result = new Float32Array(targetFrames * channels);
      result.set(pcm.subarray(0, result.length));
      return result;
    }
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    if (signal?.aborted || disposed) { release(); throw aborted(); }
    const epoch = generation;
    const cancel = () => terminate();
    signal?.addEventListener('abort', cancel, { once: true });
    let active: TempoWorker | null = null;
    try {
      active = await load();
      if (signal?.aborted || epoch !== generation) throw aborted();
      diagnostic = '';
      // writeFile transfers its Uint8Array. Copy only this bounded window so
      // the caller's decoded PCM is never detached by the worker transport.
      const bytes = new Uint8Array(pcm.byteLength);
      bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      await active.writeFile('tempo-input.f32', bytes);
      const code = await active.exec(['-v', 'error', '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels),
        '-i', 'tempo-input.f32', '-af', [...filters, 'apad', `atrim=end_sample=${targetFrames}`].join(','),
        '-f', 'f32le', 'tempo-output.f32']);
      if (signal?.aborted || epoch !== generation) throw aborted();
      if (code !== 0) throw new Error(`Audio speed processing failed (${code}). ${diagnostic.trim()}`);
      const output = await active.readFile('tempo-output.f32');
      if (typeof output === 'string' || output.byteLength !== outputBytes) throw new Error('Audio speed processing returned an incomplete PCM window.');
      const result = new Float32Array(targetFrames * channels);
      new Uint8Array(result.buffer).set(output);
      return result;
    } catch (error) {
      if (signal?.aborted || epoch !== generation || disposed) throw aborted();
      // A failed core can retain MEMFS allocations or a pending command.
      terminate();
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (active && epoch === generation) {
        await Promise.allSettled([active.deleteFile('tempo-input.f32'), active.deleteFile('tempo-output.f32')]);
      }
      release();
    }
  };
  return { process, terminate, dispose: () => { disposed = true; terminate(); } };
}
