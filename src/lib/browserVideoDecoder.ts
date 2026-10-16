import { CustomVideoDecoder, VideoSample, registerDecoder, type EncodedPacket, type VideoCodec } from 'mediabunny';

/** Untagged AVC is interpreted as BT.601 by the native export's swscale path.
 * Mediabunny's Chromium fallback uses BT.709 instead. Supply a complete
 * colorSpace so Chromium retains the matrix, preserving every declared field.
 * Tagged streams continue through Mediabunny's regular decoder unchanged. */
export function normalizeAvcDecoderConfig(config: VideoDecoderConfig): VideoDecoderConfig {
  if (config.colorSpace?.matrix != null) return config;
  return { ...config, colorSpace: {
    primaries: config.colorSpace?.primaries ?? 'bt709',
    transfer: config.colorSpace?.transfer ?? 'bt709',
    matrix: 'smpte170m',
    fullRange: config.colorSpace?.fullRange ?? false,
  } };
}

const MAX_DECODE_QUEUE = 4;
const closedError = () => new DOMException('Local video decoder was closed', 'AbortError');

/** Narrow native-WebCodecs adapter for missing AVC matrix metadata. No pixel
 * readbacks, media uploads, or changes to already tagged601/709 streams. */
export class BrowserAvcDecoder extends CustomVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private closed = false;
  private error: unknown;
  private waiters = new Set<{ resolve(): void; reject(error: unknown): void }>();

  static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
    return codec === 'avc' && config.colorSpace?.matrix == null && typeof VideoDecoder !== 'undefined';
  }
  private check() {
    if (this.closed) throw closedError();
    if (this.error) throw this.error;
    if (!this.decoder || this.decoder.state !== 'configured') throw new Error('Local AVC decoder is not configured');
  }
  private dequeue = () => {
    if (!this.decoder || this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE) return;
    this.waiters.forEach((waiter) => waiter.resolve()); this.waiters.clear();
  };
  private fail(error: unknown) {
    if (this.closed) return;
    this.error = error;
    this.waiters.forEach((waiter) => waiter.reject(error)); this.waiters.clear();
    this.onError(error);
  }
  init(): void {
    if (this.closed) throw closedError();
    if (this.decoder) throw new Error('Local AVC decoder was initialized twice');
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.closed || this.error) { frame.close(); return; }
        let sample: VideoSample | undefined;
        try { sample = new VideoSample(frame); this.onSample(sample); }
        catch (error) { if (sample) sample.close(); else frame.close(); this.fail(error); }
      },
      error: (error) => this.fail(error),
    });
    this.decoder = decoder;
    decoder.addEventListener('dequeue', this.dequeue);
    try { decoder.configure(normalizeAvcDecoderConfig(this.config)); }
    catch (error) { this.close(); throw error; }
  }
  async decode(packet: EncodedPacket): Promise<void> {
    this.check();
    // Mediabunny serializes decode calls. Also guard direct concurrent callers,
    // so none can enqueue beyond the native bound while another call waits.
    while (this.decoder!.decodeQueueSize >= MAX_DECODE_QUEUE) {
      await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
      this.check();
    }
    this.decoder!.decode(packet.toEncodedVideoChunk());
    if (this.decoder!.decodeQueueSize >= MAX_DECODE_QUEUE) await new Promise<void>((resolve, reject) => this.waiters.add({ resolve, reject }));
    this.check();
  }
  async flush(): Promise<void> { this.check(); await this.decoder!.flush(); this.check(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waiters.forEach((waiter) => waiter.reject(closedError())); this.waiters.clear();
    if (this.decoder) {
      this.decoder.removeEventListener('dequeue', this.dequeue);
      if (this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = null;
    }
  }
}

let registered = false;
/** Call before opening export VideoSampleSinks. Registration is local/idempotent. */
export function enableBrowserVideoDecoding(): void {
  if (registered) return;
  registerDecoder(BrowserAvcDecoder); registered = true;
}
