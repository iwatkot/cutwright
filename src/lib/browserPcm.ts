import { AudioSampleSink, type AudioSample, type InputAudioTrack } from 'mediabunny';

export interface PcmTrack {
  getNumberOfChannels(): Promise<number>;
  getSampleRate(): Promise<number>;
}
interface PcmSample {
  timestamp: number;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: 'f32'; frameOffset: number; frameCount: number }): void;
  close(): void;
}
export interface PcmSink { samples(startTimestamp?: number): AsyncGenerator<PcmSample, void, unknown> }
export interface PcmReaderOptions {
  /** Injection for deterministic decode/lifetime tests. Production uses AudioSampleSink. */
  createSink?: (track: PcmTrack) => PcmSink;
  /** Safety limit for the caller's returned PCM, independent of source length. */
  maxReadBytes?: number;
}
interface Chunk { start: number; frames: number; data: Float32Array }
const abortError = () => new DOMException('Audio reading was aborted', 'AbortError');
const sinc = (v: number) => Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v);

function resampleInto(pcm: Float32Array, pcmStart: number, sourceStart: number, frameCount: number, sourceRate: number, targetRate: number, result: Float32Array, outputStart: number, kernels: Map<number, Float64Array>) {
  const step = sourceRate / targetRate, cutoff = Math.min(1, targetRate / sourceRate), radius = Math.ceil(16 / cutoff);
  const exact = sourceRate === targetRate && Math.abs(sourceStart - Math.round(sourceStart)) < 1e-6;
  const origin = exact ? Math.round(sourceStart) : sourceStart;
  for (let i = 0; i < frameCount; i++) {
    const position = origin + i * step;
    if (exact) {
      const source = (Math.round(position) - pcmStart) * 2;
      result[(outputStart + i) * 2] = pcm[source] ?? 0; result[(outputStart + i) * 2 + 1] = pcm[source + 1] ?? 0;
    } else {
      const base = Math.floor(position), phase = Math.round((position - base) * 1e9);
      let weights = kernels.get(phase);
      if (!weights) {
        weights = new Float64Array(radius * 2); let sum = 0;
        for (let j = 0; j < weights.length; j++) {
          const distance = phase / 1e9 - (j - radius + 1);
          const w = Math.abs(distance) >= radius ? 0 : cutoff * sinc(distance * cutoff) * (.42 + .5 * Math.cos(Math.PI * distance / radius) + .08 * Math.cos(2 * Math.PI * distance / radius));
          weights[j] = w; sum += w;
        }
        for (let j = 0; j < weights.length; j++) weights[j] /= sum;
        if (kernels.size >= 2048) kernels.delete(kernels.keys().next().value!);
        kernels.set(phase, weights);
      }
      const begin = base - radius + 1 - pcmStart; let left = 0, right = 0;
      for (let j = 0; j < weights.length; j++) { const at = (begin + j) * 2; left += (pcm[at] ?? 0) * weights[j]; right += (pcm[at + 1] ?? 0) * weights[j]; }
      result[(outputStart + i) * 2] = left; result[(outputStart + i) * 2 + 1] = right;
    }
  }
}

/** Read/resample an already prepared bounded stereo buffer, using the same
 * source clock and bandlimited kernel as the streaming decoder path. */
export function resamplePcmWindow(pcm: Float32Array, sourceRate: number, startSeconds: number, frameCount: number, targetRate: number): Float32Array {
  if (pcm.length % 2 || !Number.isFinite(startSeconds) || !Number.isInteger(frameCount) || frameCount < 0 || !Number.isInteger(sourceRate) || sourceRate < 8000 || sourceRate > 384000 || !Number.isInteger(targetRate) || targetRate < 8000 || targetRate > 192000) throw new Error('Invalid PCM resampling window');
  const result = new Float32Array(frameCount * 2);
  resampleInto(pcm, 0, startSeconds * sourceRate, frameCount, sourceRate, targetRate, result, 0, new Map());
  return result;
}

/** A lazy, bounded stereo reader. Timestamps are absolute source seconds;
 * repeated block reads use one decoder cursor, and backward seeks restart it.
 * Mono duplicates to stereo; surround requires an explicit future downmix.
 * The input owner must also dispose its Mediabunny Input when aborting. */
export function createPcmReader(track: PcmTrack, signal?: AbortSignal, options: PcmReaderOptions = {}) {
  const sink = options.createSink?.(track) ?? new AudioSampleSink(track as InputAudioTrack);
  const limit = options.maxReadBytes ?? 64 * 1024 * 1024;
  let metadata: Promise<{ channels: number; rate: number }> | undefined;
  let cursor: AsyncGenerator<PcmSample | AudioSample, void, unknown> | undefined;
  let chunks: Chunk[] = [], done = false, disposed = false, busy = false;
  let lastRead = -Infinity, lastDecodedEnd = -Infinity, cursorStart = -Infinity;
  let cancelPull: (() => void) | undefined;
  let peakBufferedFrames = 0, decodedFrames = 0, cursorResets = 0;
  const bufferedFrames = () => chunks.reduce((sum, c) => sum + c.frames, 0);
  const check = () => { if (signal?.aborted) throw abortError(); if (disposed) throw new Error('PCM reader was disposed'); };
  const stopCursor = () => { const previous = cursor; cursor = undefined; if (previous) void previous.return().catch(() => undefined); };
  const dispose = () => { if (disposed) return; disposed = true; cancelPull?.(); stopCursor(); chunks = []; signal?.removeEventListener('abort', dispose); };
  signal?.addEventListener('abort', dispose, { once: true });

  async function info() {
    metadata ??= Promise.all([track.getNumberOfChannels(), track.getSampleRate()]).then(([channels, rate]) => {
      if (channels !== 1 && channels !== 2) throw new Error(`Browser audio supports mono/stereo; this source has ${channels} channels`);
      if (!Number.isFinite(rate) || rate < 8000 || rate > 384000) throw new Error(`Unsupported source sample rate: ${rate}`);
      return { channels, rate };
    });
    return metadata;
  }
  async function pull(): Promise<IteratorResult<PcmSample | AudioSample, void>> {
    check();
    const iterator = cursor!;
    return new Promise((resolve, reject) => {
      let canceled = false;
      const cancel = () => { canceled = true; reject(signal?.aborted ? abortError() : new Error('PCM reader was disposed')); };
      cancelPull = cancel;
      iterator.next().then((result) => {
        if (cancelPull === cancel) cancelPull = undefined;
        if (canceled || disposed || signal?.aborted) { if (!result.done) result.value.close(); if (!canceled) cancel(); return; }
        resolve(result);
      }, (error) => { if (cancelPull === cancel) cancelPull = undefined; reject(error); });
    });
  }
  async function restart(frame: number, rate: number) {
    stopCursor(); chunks = []; done = false; lastDecodedEnd = -Infinity;
    cursorStart = Math.max(0, frame);
    cursor = sink.samples(Math.max(0, frame / rate)); cursorResets++;
  }
  async function ensure(low: number, high: number, rate: number, channels: number) {
    chunks = chunks.filter((chunk) => chunk.start + chunk.frames > low);
    if (!cursor && !done) await restart(low, rate);
    while (!done && lastDecodedEnd < high) {
      if (!cursor) await restart(low, rate);
      const next = await pull(); check();
      if (next.done) { done = true; break; }
      const sample = next.value;
      try {
        if (sample.sampleRate !== rate || sample.numberOfChannels !== channels) throw new Error('Audio format changed while decoding a source');
        const start = Math.round(sample.timestamp * rate), end = start + sample.numberOfFrames;
        if (!Number.isFinite(start) || !Number.isInteger(sample.numberOfFrames) || sample.numberOfFrames <= 0) throw new Error('Decoded audio has invalid timing');
        lastDecodedEnd = Math.max(lastDecodedEnd, end); decodedFrames += sample.numberOfFrames;
        if (end <= low) continue;
        // Normally a decoder packet is a few ms. A giant decoded sample is
        // cropped before copying; a later window reopens the cursor as needed.
        const first = Math.max(0, low - start);
        const last = sample.numberOfFrames <= Math.ceil(rate / 2) ? sample.numberOfFrames : Math.min(sample.numberOfFrames, Math.max(first, high - start));
        const frames = Math.max(0, last - first);
        if (frames) {
          const raw = new Float32Array(frames * channels);
          sample.copyTo(raw, { planeIndex: 0, format: 'f32', frameOffset: first, frameCount: frames });
          const data = channels === 2 ? raw : new Float32Array(frames * 2);
          if (channels === 1) for (let i = 0; i < frames; i++) data[i * 2] = data[i * 2 + 1] = raw[i];
          chunks.push({ start: start + first, frames, data });
          peakBufferedFrames = Math.max(peakBufferedFrames, bufferedFrames());
        }
        if (last < sample.numberOfFrames) {
          // We deliberately did not retain the unrequested tail of this sample.
          // Restart from the next window instead of silently replacing it by zero.
          lastDecodedEnd = high; stopCursor();
          break;
        }
      } finally { sample.close(); }
    }
  }

  async function read(startSeconds: number, frameCount: number, sampleRate: number): Promise<Float32Array> {
    check();
    if (busy) throw new Error('PCM reader cannot read concurrent windows');
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isInteger(frameCount) || frameCount < 0 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid PCM read window');
    if (frameCount * 8 > limit) throw new Error(`Requested PCM exceeds the ${Math.floor(limit / 1024 / 1024)} MiB read limit`);
    const result = new Float32Array(frameCount * 2);
    if (!frameCount) return result;
    busy = true;
    try {
      const { channels, rate } = await info(); check();
      const step = rate / sampleRate, cutoff = Math.min(1, sampleRate / rate), radius = Math.ceil(16 / cutoff);
      const kernels = new Map<number, Float64Array>();
      const exact = rate === sampleRate && Math.abs(startSeconds * rate - Math.round(startSeconds * rate)) < 1e-6;
      const firstSource = exact ? Math.round(startSeconds * rate) : startSeconds * rate;
      if (firstSource < lastRead - 1e-6 || firstSource < cursorStart || Number.isFinite(lastDecodedEnd) && firstSource > lastDecodedEnd + rate || !cursor && done && firstSource < lastDecodedEnd) await restart(Math.floor(firstSource) - radius, rate);
      // Only a quarter second of source PCM plus sinc guards is staged at once,
      // even if the caller requests a long (explicitly capped) tempo input.
      const blockFrames = Math.max(1, Math.floor(sampleRate / 4));
      for (let output = 0; output < frameCount; output += blockFrames) {
        check();
        const count = Math.min(blockFrames, frameCount - output);
        const firstPosition = firstSource + output * step, lastPosition = firstSource + (output + count - 1) * step;
        const low = Math.floor(firstPosition) - (exact ? 0 : radius - 1), high = Math.floor(lastPosition) + (exact ? 1 : radius + 1);
        // If a previous read/packet deliberately dropped an unread tail, reopen
        // at this window with the guards, keeping memory independent of duration.
        if (!cursor && !done && lastDecodedEnd < high) await restart(low, rate);
        await ensure(Math.max(0, low), high, rate, channels);
        const window = new Float32Array((high - low) * 2);
        for (const chunk of chunks) {
          const from = Math.max(low, chunk.start), end = Math.min(high, chunk.start + chunk.frames);
          if (end > from) window.set(chunk.data.subarray((from - chunk.start) * 2, (end - chunk.start) * 2), (from - low) * 2);
        }
        resampleInto(window, low, firstPosition, count, rate, sampleRate, result, output, kernels);
        chunks = chunks.filter((chunk) => chunk.start + chunk.frames > Math.floor(lastPosition) - radius);
      }
      lastRead = firstSource + frameCount * step;
      return result;
    } finally { busy = false; }
  }
  return { read, dispose, get stats() { return { bufferedFrames: bufferedFrames(), peakBufferedFrames, decodedFrames, cursorResets }; } };
}
