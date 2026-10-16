import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('mediabunny', () => ({ CustomVideoDecoder: class {}, VideoSample: class { constructor(private frame: { close(): void }) {} close() { this.frame.close(); } }, registerDecoder: vi.fn() }));
import { registerDecoder } from 'mediabunny';
import { BrowserAvcDecoder, enableBrowserVideoDecoding, normalizeAvcDecoderConfig } from '../src/lib/browserVideoDecoder';

class NativeDecoder extends EventTarget {
  static instances: NativeDecoder[] = [];
  state = 'unconfigured'; decodeQueueSize = 0;
  configure = vi.fn(() => { this.state = 'configured'; });
  decode = vi.fn(() => { this.decodeQueueSize++; });
  flush = vi.fn(async () => { this.decodeQueueSize = 0; this.dispatchEvent(new Event('dequeue')); });
  close = vi.fn(() => { this.state = 'closed'; });
  constructor(public handlers: VideoDecoderInit) { super(); NativeDecoder.instances.push(this); }
  dequeue() { this.decodeQueueSize--; this.dispatchEvent(new Event('dequeue')); }
}
beforeEach(() => { NativeDecoder.instances = []; vi.stubGlobal('VideoDecoder', NativeDecoder); });
afterEach(() => vi.unstubAllGlobals());
const config = (): VideoDecoderConfig => ({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: new Uint8Array([1, 2, 3]), colorSpace: { fullRange: false } });
const adapter = (onSample = vi.fn(), onError = vi.fn()) => {
  const decoder = new BrowserAvcDecoder(); Object.assign(decoder, { config: config(), onSample, onError }); decoder.init(); return decoder;
};
const packet = { toEncodedVideoChunk: () => ({}) } as Parameters<BrowserAvcDecoder['decode']>[0];

describe('browser AVC matrix normalization', () => {
  it('fills only absent metadata and leaves declared601/709 configurations untouched', () => {
    const raw = config(), before = structuredClone(raw), normalized = normalizeAvcDecoderConfig(raw);
    expect(normalized.colorSpace).toEqual({ matrix: 'smpte170m', primaries: 'bt709', transfer: 'bt709', fullRange: false });
    expect(normalized.description).toBe(raw.description); expect(raw).toEqual(before);
    for (const matrix of ['bt709', 'smpte170m', 'bt470bg'] as const) {
      const tagged = { ...raw, colorSpace: { matrix, primaries: 'smpte170m' as const, transfer: 'smpte170m' as const, fullRange: true } };
      expect(normalizeAvcDecoderConfig(tagged)).toBe(tagged); expect(BrowserAvcDecoder.supports('avc', tagged)).toBe(false);
    }
    expect(normalizeAvcDecoderConfig({ ...raw, colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', fullRange: true } }).colorSpace).toEqual({ matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', fullRange: true });
  });

  it('registers once and only selects untagged AVC with native WebCodecs available', () => {
    enableBrowserVideoDecoding(); enableBrowserVideoDecoding(); expect(registerDecoder).toHaveBeenCalledOnce();
    expect(BrowserAvcDecoder.supports('avc', config())).toBe(true); expect(BrowserAvcDecoder.supports('hevc', config())).toBe(false);
    vi.stubGlobal('VideoDecoder', undefined); expect(BrowserAvcDecoder.supports('avc', config())).toBe(false);
  });

  it('bounds the native decode queue and unblocks waiting work when packets drain', async () => {
    const decoder = adapter(), native = NativeDecoder.instances[0];
    for (let i = 0; i < 3; i++) await decoder.decode(packet);
    let settled = false; const fourth = decoder.decode(packet).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); expect(native.decodeQueueSize).toBe(4);
    native.dequeue(); await fourth; expect(settled).toBe(true); await decoder.flush(); decoder.close();
    expect(native.configure).toHaveBeenCalledWith(expect.objectContaining({ colorSpace: expect.objectContaining({ matrix: 'smpte170m' }) }));
    expect(native.close).toHaveBeenCalledOnce();
  });

  it('rejects a pending decode when closed and closes late frames without transferring ownership', async () => {
    const onSample = vi.fn(), decoder = adapter(onSample), native = NativeDecoder.instances[0];
    for (let i = 0; i < 3; i++) await decoder.decode(packet);
    const pending = decoder.decode(packet); decoder.close(); decoder.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const close = vi.fn(); native.handlers.output({ close } as unknown as VideoFrame);
    expect(close).toHaveBeenCalledOnce(); expect(onSample).not.toHaveBeenCalled(); expect(native.close).toHaveBeenCalledOnce();
  });

  it('keeps direct concurrent callers inside the same four-packet bound', async () => {
    const decoder = adapter(), native = NativeDecoder.instances[0];
    const pending = Array.from({ length: 8 }, () => decoder.decode(packet));
    expect(native.decodeQueueSize).toBe(4);
    while (native.decode.mock.calls.length < 8) {
      native.dequeue(); await Promise.resolve(); await Promise.resolve();
      expect(native.decodeQueueSize).toBeLessThanOrEqual(4);
    }
    await decoder.flush(); await Promise.all(pending); decoder.close();
  });

  it('closes frames rejected by the consumer and forwards decoder errors to pending work', async () => {
    const onError = vi.fn(), decoder = adapter(() => { throw new Error('consumer failed'); }, onError), native = NativeDecoder.instances[0];
    const close = vi.fn(); native.handlers.output({ close } as unknown as VideoFrame);
    expect(close).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'consumer failed' }));
    await expect(decoder.decode(packet)).rejects.toThrow('consumer failed'); decoder.close();
    const other = adapter(), second = NativeDecoder.instances[1];
    for (let i = 0; i < 3; i++) await other.decode(packet);
    const pending = other.decode(packet); second.handlers.error(new DOMException('decode failed', 'EncodingError'));
    await expect(pending).rejects.toMatchObject({ message: 'decode failed' }); other.close();
  });
});
