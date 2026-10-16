import { describe, expect, it } from 'vitest';
import { audioTempoFilters, createAudioTempoProcessor, type TempoWorker } from '../src/lib/browserTempo';

function fakeWorker() {
  const calls: string[][] = [];
  let bytes = new Uint8Array();
  let loads = 0, terminated = 0;
  const worker: TempoWorker = {
    async load() { loads++; },
    async writeFile(_path, input) { bytes = input; },
    async exec(args) { calls.push(args); return 0; },
    async readFile() { return bytes; },
    async deleteFile() {},
    terminate() { terminated++; },
  };
  return { worker, calls, get loads() { return loads; }, get terminated() { return terminated; } };
}
describe('bounded browser audio tempo', () => {
  it('uses the native chained atempo factors, including extreme speeds', () => {
    expect(audioTempoFilters(.25)).toEqual(['atempo=0.500', 'atempo=0.500']);
    expect(audioTempoFilters(6)).toEqual(['atempo=2.000', 'atempo=2.000', 'atempo=1.500']);
    expect(() => audioTempoFilters(0)).toThrow();
  });
  it('bypasses DSP at normal speed and preserves/crops/pads samples exactly', async () => {
    let constructions = 0;
    const tempo = createAudioTempoProcessor({ createWorker: async () => { constructions++; return fakeWorker().worker; } });
    const pcm = new Float32Array([.5, -.5, 1.5, -1.5]);
    expect(await tempo.process({ pcm, sampleRate: 48000, channels: 2, speed: 1, targetFrames: 3 })).toEqual(new Float32Array([.5, -.5, 1.5, -1.5, 0, 0]));
    expect(constructions).toBe(0);
    tempo.dispose();
  });
  it('rejects oversized PCM before loading or copying the worker', async () => {
    let constructions = 0;
    const tempo = createAudioTempoProcessor({ maxPCMBytes: 31, createWorker: async () => { constructions++; return fakeWorker().worker; } });
    await expect(tempo.process({ pcm: new Float32Array(4), sampleRate: 48000, channels: 2, speed: 2, targetFrames: 2 })).rejects.toThrow(/Split the clip/);
    expect(constructions).toBe(0);
  });
  it('keeps caller PCM intact, loads once and commands an exact output length', async () => {
    const fake = fakeWorker();
    const tempo = createAudioTempoProcessor({ createWorker: async () => fake.worker });
    const pcm = new Float32Array([.2, -.3, .4, -.5]);
    const request = { pcm, sampleRate: 48000, channels: 2 as const, speed: 2, targetFrames: 2 };
    expect(await tempo.process(request)).toEqual(pcm);
    expect(await tempo.process(request)).toEqual(pcm);
    expect(pcm.byteLength).toBe(16);
    expect(fake.loads).toBe(1);
    expect(fake.calls[0]).toContain('atempo=2.000,apad,atrim=end_sample=2');
    tempo.dispose(); expect(fake.terminated).toBe(1);
  });
  it('terminates actual work on abort and can load a new worker for retry', async () => {
    let rejectRunning!: (error: Error) => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const first = fakeWorker(), retry = fakeWorker();
    first.worker.exec = async () => { began(); return new Promise((_resolve, reject) => { rejectRunning = reject; }); };
    first.worker.terminate = () => rejectRunning?.(new Error('terminated'));
    let constructions = 0;
    const tempo = createAudioTempoProcessor({ createWorker: async () => (++constructions === 1 ? first.worker : retry.worker) });
    const controller = new AbortController();
    const request = { pcm: new Float32Array(4), sampleRate: 48000, channels: 2 as const, speed: .5, targetFrames: 2 };
    const pending = tempo.process({ ...request, signal: controller.signal });
    await started; controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await tempo.process(request)).toHaveLength(4);
    expect(constructions).toBe(2); tempo.dispose();
  });
});
