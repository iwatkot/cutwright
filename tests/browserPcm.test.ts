import { describe, expect, it, vi } from 'vitest';
import { createPcmReader, resamplePcmWindow, type PcmSink, type PcmTrack } from '../src/lib/browserPcm';

function decodedFixture(pcm: Float32Array, rate: number, channels = 2, packetFrames = 1024) {
  const closed = vi.fn(), seeks: number[] = [];
  const track: PcmTrack = { getSampleRate: async () => rate, getNumberOfChannels: async () => channels };
  const sink: PcmSink = { async *samples(start = 0) {
    seeks.push(start);
    for (let first = 0; first < pcm.length / channels; first += packetFrames) {
      const frames = Math.min(packetFrames, pcm.length / channels - first);
      if ((first + frames) / rate <= start) continue;
      yield { timestamp: first / rate, sampleRate: rate, numberOfChannels: channels, numberOfFrames: frames,
        copyTo(destination, options) { destination.set(pcm.subarray((first + options.frameOffset) * channels, (first + options.frameOffset + options.frameCount) * channels)); }, close: closed };
    }
  } };
  return { track, sink, closed, seeks, reader: createPcmReader(track, undefined, { createSink: () => sink }) };
}
const sine = (frames: number, rate: number, frequency = 440) => new Float32Array(Array.from({ length: frames }, (_, i) => [Math.sin(i * frequency / rate * Math.PI * 2), Math.cos(i * frequency / rate * Math.PI * 2)]).flat());
const maximumDifference = (a: Float32Array, b: Float32Array) => a.reduce((max, value, i) => Math.max(max, Math.abs(value - b[i])), 0);

describe('bounded browser PCM decoding', () => {
  it('reads48k trim windows bit exactly while closing samples and keeping one monotonic cursor', async () => {
    const pcm = sine(96000, 48000), { reader, closed, seeks } = decodedFixture(pcm, 48000);
    const actual = await reader.read(.1, 48000, 48000);
    expect(actual).toEqual(pcm.slice(4800 * 2, 52800 * 2));
    const next = await reader.read(1.1, 9600, 48000);
    expect(next).toEqual(pcm.slice(52800 * 2, 62400 * 2));
    expect(seeks).toHaveLength(1); expect(closed).toHaveBeenCalled();
    expect(reader.stats.peakBufferedFrames).toBeLessThan(16000); expect(reader.stats.bufferedFrames).toBeLessThan(2200);
    reader.dispose(); expect(reader.stats.bufferedFrames).toBe(0);
  });

  it('matches full-buffer sinc resampling across arbitrary decoder and caller block boundaries', async () => {
    const pcm = sine(22050, 44100), { reader } = decodedFixture(pcm, 44100, 2, 257);
    const count = 17003, expected = resamplePcmWindow(pcm, 44100, .03, count, 48000), actual = new Float32Array(count * 2);
    for (let position = 0; position < count; position += 997) {
      const length = Math.min(997, count - position);
      actual.set(await reader.read(.03 + position / 48000, length, 48000), position * 2);
    }
    expect(maximumDifference(actual, expected)).toBeLessThan(2e-7); expect(actual.every(Number.isFinite)).toBe(true);
    expect(reader.stats.peakBufferedFrames).toBeLessThan(3000); reader.dispose();
  });

  it('duplicates mono, restarts for backward seeks, and pads source EOF with exact silence', async () => {
    const mono = new Float32Array(Array.from({ length: 4800 }, (_, i) => i / 4800));
    const { reader, seeks } = decodedFixture(mono, 48000, 1, 512);
    const end = await reader.read(.09, 960, 48000);
    for (let i = 0; i < 480; i++) expect(Array.from(end.subarray(i * 2, i * 2 + 2))).toEqual([mono[4320 + i], mono[4320 + i]]);
    expect(Array.from(end.subarray(480 * 2))).toEqual(Array(480 * 2).fill(0));
    const start = await reader.read(.001, 64, 48000);
    expect(start[0]).toBe(mono[48]); expect(start[1]).toBe(mono[48]); expect(seeks).toHaveLength(2); reader.dispose();
  });

  it('crops giant decoded samples before copying and still reads their later windows correctly', async () => {
    const pcm = sine(96000, 48000), { reader, seeks } = decodedFixture(pcm, 48000, 2, 96000);
    expect(await reader.read(.2, 48000, 48000)).toEqual(pcm.slice(9600 * 2, 57600 * 2));
    expect(reader.stats.peakBufferedFrames).toBeLessThanOrEqual(12000); expect(seeks.length).toBeGreaterThan(1); reader.dispose();
  });

  it('rejects surround and oversized reads explicitly', async () => {
    const fixture = decodedFixture(new Float32Array(6 * 1024), 48000, 6);
    await expect(fixture.reader.read(0, 100, 48000)).rejects.toThrow(/6 channels/); fixture.reader.dispose();
    const small = decodedFixture(new Float32Array(2048), 48000);
    await expect(small.reader.read(0, 9_000_000, 48000)).rejects.toThrow(/64 MiB/); small.reader.dispose();
  });

  it('preserves timestamp gaps rather than concatenating packets together', async () => {
    const track: PcmTrack = { getSampleRate: async () => 48000, getNumberOfChannels: async () => 2 };
    const close = vi.fn();
    const sink: PcmSink = { async *samples() {
      for (const [timestamp, value] of [[.01, .5], [.03, .25]]) yield { timestamp, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: 480,
        copyTo(data) { data.fill(value); }, close };
    } };
    const reader = createPcmReader(track, undefined, { createSink: () => sink });
    const output = await reader.read(0, 2400, 48000);
    for (const [index, expected] of [[0, 0], [479, 0], [480, .5], [959, .5], [960, 0], [1439, 0], [1440, .25], [1919, .25], [1920, 0], [2399, 0]]) expect(output[index * 2]).toBe(expected);
    expect(close).toHaveBeenCalledTimes(2); reader.dispose();
  });

  it('seeks over large forward gaps without decoding the intervening source', async () => {
    const pcm = sine(48000 * 4, 48000), { reader, seeks } = decodedFixture(pcm, 48000, 2, 1024);
    await reader.read(0, 1024, 48000);
    expect(await reader.read(3, 1024, 48000)).toEqual(pcm.slice(3 * 48000 * 2, (3 * 48000 + 1024) * 2));
    expect(seeks).toHaveLength(2); expect(reader.stats.decodedFrames).toBeLessThan(5000); reader.dispose();
  });

  it('aborts a pending decode immediately and closes a late-arriving sample', async () => {
    const controller = new AbortController(), close = vi.fn();
    let resolve: (value: IteratorResult<never>) => void;
    const next = new Promise<IteratorResult<never>>((r) => { resolve = r; });
    const track: PcmTrack = { getNumberOfChannels: async () => 2, getSampleRate: async () => 48000 };
    const sink: PcmSink = { samples: () => ({ next: () => next, return: async () => ({ done: true, value: undefined }), [Symbol.asyncIterator]() { return this; } }) as unknown as ReturnType<PcmSink['samples']> };
    const reader = createPcmReader(track, controller.signal, { createSink: () => sink });
    const pending = reader.read(0, 100, 48000);
    await vi.waitFor(() => expect(reader.stats.cursorResets).toBe(1));
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    resolve!({ done: false, value: { close } } as never); await Promise.resolve(); expect(close).toHaveBeenCalledOnce();
  });
});

describe('prepared PCM source-clock resampling', () => {
  it('suppresses frequencies above the target Nyquist limit while preserving passband amplitude', () => {
    const high = resamplePcmWindow(sine(48000, 48000, 12000), 48000, .1, 8000, 16000);
    const low = resamplePcmWindow(sine(48000, 48000, 1000), 48000, .1, 8000, 16000);
    const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    expect(rms(high)).toBeLessThan(.001); expect(rms(low)).toBeGreaterThan(.705); expect(rms(low)).toBeLessThan(.709);
  });

  it('keeps source channels independent and yields zeros outside prepared PCM', () => {
    const pcm = new Float32Array([1, -1, .5, -.5]);
    expect(resamplePcmWindow(pcm, 48000, 0, 4, 48000)).toEqual(new Float32Array([1, -1, .5, -.5, 0, 0, 0, 0]));
    expect(resamplePcmWindow(pcm, 48000, -1 / 48000, 3, 48000)).toEqual(new Float32Array([0, 0, 1, -1, .5, -.5]));
    expect(pcm).toEqual(new Float32Array([1, -1, .5, -.5]));
  });
});
