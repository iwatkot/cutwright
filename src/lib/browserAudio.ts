import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack } from 'mediabunny';
import { audioEnvelopeGain, resolveAudioEnvelope } from './audioEnv';
import { createPcmReader, resamplePcmWindow } from './browserPcm';
import { createAudioTempoProcessor, DEFAULT_MAX_PCM_BYTES } from './browserTempo';
import type { Clip, MediaItem, Project } from './types';

export const BROWSER_AUDIO_SAMPLE_RATE = 48000;
export interface BrowserAudioOptions {
  loadMedia(media: MediaItem): Promise<Blob>;
  signal?: AbortSignal;
  onPrepare?(stage: string): void;
  maxPCMBytes?: number;
}
type Reader = ReturnType<typeof createPcmReader>;
interface AudioSource { input: Input; track: InputAudioTrack | null; sampleRate: number; channels: 1 | 2 }
interface AudioClip { clip: Clip; media: MediaItem; reader?: Reader; prepared?: Float32Array; sampleRate?: number; silent?: boolean; sourceChannels?: 1 | 2 }
const abortError = () => new DOMException('Audio rendering cancelled', 'AbortError');

/** Audio follows the timeline sample clock, independently of video decoders.
 * Returned blocks are planar at 48 kHz; channels follows desktop amix's
 * first eligible clip layout (mono or stereo), with stereo silence fallback. */
export async function createBrowserAudioMixer(project: Project, options: BrowserAudioOptions) {
  const maxPCMBytes = options.maxPCMBytes ?? DEFAULT_MAX_PCM_BYTES;
  const sources = new Map<string, Promise<AudioSource>>();
  const inputs = new Set<Input>();
  const tempo = createAudioTempoProcessor({ maxPCMBytes });
  const mediaById = new Map(project.media.map((media) => [media.id, media]));
  const settings = project.trackSettings ?? {};
  const clips: AudioClip[] = project.clips.flatMap((clip) => {
    const media = mediaById.get(clip.mediaId);
    if (!media || !(clip.trackId.startsWith('a') || clip.trackId.startsWith('v'))
      || media.kind === 'image' || media.kind === 'video' && media.hasAudio === false
      || clip.mutedAudio || settings[clip.trackId]?.hidden || settings[clip.trackId]?.muted) return [];
    return [{ clip, media }];
  }).sort((a, b) => a.clip.start - b.clip.start);
  let channels: 1 | 2 = 2;
  let disposed = false;
  let rendering = false;
  let retainedTempoBytes = 0;
  const check = () => { if (disposed || options.signal?.aborted) throw abortError(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    tempo.dispose();
    for (const state of clips) { state.reader?.dispose(); state.reader = undefined; state.prepared = undefined; }
    for (const input of inputs) input.dispose();
    inputs.clear(); sources.clear(); retainedTempoBytes = 0;
    options.signal?.removeEventListener('abort', dispose);
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  check();

  const sourceFor = (media: MediaItem) => {
    let source = sources.get(media.id);
    if (!source) {
      source = (async () => {
        check();
        if (media.offline) throw new Error(`Relink "${media.name}" with Import before exporting audio.`);
        options.onPrepare?.(`Opening audio: ${media.name}`);
        const blob = await options.loadMedia(media);
        check();
        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { maxCacheSize: 1024 * 1024 }) });
        inputs.add(input);
        try {
          const track = await input.getPrimaryAudioTrack();
          check();
          if (!track) return { input, track: null, sampleRate: BROWSER_AUDIO_SAMPLE_RATE, channels: 2 as const };
          if (!await track.canDecode()) throw new Error(`This browser cannot decode audio in "${media.name}".`);
          const sampleRate = await track.getSampleRate();
          const count = await track.getNumberOfChannels();
          if (count !== 1 && count !== 2) throw new Error(`Audio in "${media.name}" has ${count} channels. Browser export supports mono and stereo sources.`);
          check();
          return { input, track, sampleRate, channels: count as 1 | 2 };
        } catch (error) {
          input.dispose(); inputs.delete(input);
          if (disposed || options.signal?.aborted) throw abortError();
          throw error;
        }
      })();
      sources.set(media.id, source);
    }
    return source;
  };
  const pcmFor = async (state: AudioClip, local: number, count: number) => {
    const source = await sourceFor(state.media);
    check();
    if (!source.track || state.silent) { state.silent = true; return null; }
    state.sourceChannels = source.channels;
    const speed = state.clip.speed ?? 1;
    if (speed === 1) {
      state.reader ??= createPcmReader(source.track, options.signal);
      return state.reader.read(state.clip.offset + local, count, BROWSER_AUDIO_SAMPLE_RATE);
    }
    if (!state.prepared) {
      const inputFrames = Math.round(state.clip.duration * speed * source.sampleRate);
      const outputFrames = Math.round(state.clip.duration * source.sampleRate);
      const workspace = (inputFrames + outputFrames) * 2 * Float32Array.BYTES_PER_ELEMENT;
      if (retainedTempoBytes + workspace > maxPCMBytes) {
        throw new Error(`The speed change on "${state.clip.name}" exceeds the ${Math.floor(maxPCMBytes / 1048576)} MiB decoded audio limit. Split it into shorter clips before exporting.`);
      }
      options.onPrepare?.(`Preparing audio speed: ${state.clip.name}`);
      const reader = createPcmReader(source.track, options.signal);
      try {
        // atempo runs at the source rate, as in desktop export. Resample only
        // afterward; never implement tempo by changing the PCM sample rate.
        const pcm = await reader.read(state.clip.offset, inputFrames, source.sampleRate);
        check();
        state.prepared = await tempo.process({ pcm, sampleRate: source.sampleRate, channels: 2,
          speed, targetFrames: outputFrames, signal: options.signal });
        check();
        state.sampleRate = source.sampleRate;
        retainedTempoBytes += state.prepared.byteLength;
      } finally { reader.dispose(); }
    }
    return resamplePcmWindow(state.prepared, state.sampleRate!, local, count, BROWSER_AUDIO_SAMPLE_RATE);
  };
  const renderBlock = async (startFrame: number, frameCount: number): Promise<Float32Array> => {
    check();
    if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frameCount) || frameCount < 0
      || frameCount * channels * 4 > maxPCMBytes) throw new Error('Invalid or oversized audio render block.');
    if (rendering) throw new Error('Audio render blocks must be requested sequentially.');
    rendering = true;
    try {
      const result = new Float32Array(frameCount * channels);
      const endFrame = startFrame + frameCount;
      for (const state of clips) {
        const clip = state.clip;
        const first = Math.max(startFrame, Math.ceil(clip.start * BROWSER_AUDIO_SAMPLE_RATE - 1e-8));
        const last = Math.min(endFrame, Math.ceil((clip.start + clip.duration) * BROWSER_AUDIO_SAMPLE_RATE - 1e-8));
        if (last <= first) continue;
        const local = first / BROWSER_AUDIO_SAMPLE_RATE - clip.start;
        const samples = await pcmFor(state, local, last - first);
        check();
        if (!samples) continue;
        const profile = resolveAudioEnvelope(clip);
        const volume = (clip.volume ?? 1) * (settings[clip.trackId]?.volume ?? 1);
        for (let i = 0; i < last - first; i++) {
          const gain = volume * audioEnvelopeGain(profile, local + i / BROWSER_AUDIO_SAMPLE_RATE);
          const offset = first - startFrame + i;
          // Sum all tracks without normalization or clipping. The AAC encoder
          // receives the same gains, including values greater than one.
          const left = samples[i * 2], right = samples[i * 2 + 1];
          if (channels === 1) result[offset] += (state.sourceChannels === 1 ? left : (left + right) * Math.SQRT1_2) * gain;
          else {
            const channelGain = gain * (state.sourceChannels === 1 ? Math.SQRT1_2 : 1);
            result[offset] += left * channelGain;
            result[frameCount + offset] += right * channelGain;
          }
        }
      }
      // Export requests are monotonic. Retire full speed windows promptly;
      // a later backward request can recreate its bounded decoder/cache.
      for (const state of clips) if (state.clip.start + state.clip.duration <= endFrame / BROWSER_AUDIO_SAMPLE_RATE) {
        state.reader?.dispose(); state.reader = undefined;
        if (state.prepared) { retainedTempoBytes -= state.prepared.byteLength; state.prepared = undefined; }
      }
      return result;
    } catch (error) {
      if (disposed || options.signal?.aborted) throw abortError();
      throw error;
    } finally { rendering = false; }
  };
  try {
    for (const state of clips) {
      const source = await sourceFor(state.media);
      if (source.track) { channels = source.channels; break; }
    }
    check();
    return { channels, renderBlock, dispose };
  } catch (error) {
    const cancelled = disposed || options.signal?.aborted;
    dispose();
    throw cancelled ? abortError() : error;
  }
}
