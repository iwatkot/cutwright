import { loadBrowserMedia, isBrowserMediaSource } from './browserMedia';
import { useStore } from './store';
import type { Clip, MediaItem } from './types';

export type Artwork = Pick<MediaItem, 'thumb' | 'filmstrip' | 'peaks'>;
const observers = new Set<() => void>();
let busy = 0;
export const browserArtworkStatus = { get active() { return busy; }, subscribe(fn: () => void) { observers.add(fn); return () => { observers.delete(fn); }; } };
const notify = (count: number) => { busy = count; observers.forEach(fn => fn()); };

/** Original source coordinates: trims and speed select the appropriate stills. */
export function filmstripFrames(media: MediaItem, clip: Clip, count: number): string[] {
  const frames = Array.isArray(media.filmstrip) ? media.filmstrip.filter(frame => frame && Number.isFinite(frame.time) && typeof frame.url === 'string') : [];
  if (!frames.length) return [];
  const length = Math.max(1, Math.min(64, Math.ceil(count)));
  return Array.from({ length }, (_, i) => {
    const time = clip.offset + clip.duration * (i + .5) / length * (clip.speed ?? 1);
    return frames.reduce((best, frame) => Math.abs(frame.time - time) < Math.abs(best.time - time) ? frame : best).url;
  });
}

/** Small, bounded decoded samples, never media replacement or export inputs. */
export async function prepareBrowserArtwork(media: MediaItem, signal: AbortSignal): Promise<Artwork> {
  const blob = await loadBrowserMedia(media.src); signal.throwIfAborted();
  if (!blob) return {};
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = Math.max(1, Math.round(160 * (media.height || 9) / (media.width || 16)));
  canvas.height = Math.min(320, canvas.height);
  const context = canvas.getContext('2d')!;
  const snapshot = (source: CanvasImageSource) => { context.drawImage(source, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/jpeg', .72); };
  if (media.kind === 'image') {
    const image = await createImageBitmap(blob);
    canvas.height = Math.min(320, Math.max(1, Math.round(160 * image.height / image.width)));
    try { signal.throwIfAborted(); return { thumb: snapshot(image) }; } finally { image.close(); }
  }
  const { Input, ALL_FORMATS, BlobSource, CanvasSink, AudioSampleSink } = await import('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob, { maxCacheSize: 1024 * 1024 }) });
  const abort = () => input.dispose(); signal.addEventListener('abort', abort, { once: true });
  try {
    const artwork: Artwork = {};
    const video = media.kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    if (video) {
      const first = Math.min(.1, media.duration / 4), last = Math.max(first, media.duration - .05);
      const times = Array.from({ length: 8 }, (_, i) => first + (last - first) * i / 7);
      const sink = new CanvasSink(video, { width: canvas.width, height: canvas.height, fit: 'contain', poolSize: 1 });
      const frames: NonNullable<MediaItem['filmstrip']> = [];
      let index = 0;
      for await (const frame of sink.canvasesAtTimestamps(times)) {
        signal.throwIfAborted();
        if (frame) frames.push({ time: times[index], url: snapshot(frame.canvas) });
        index++;
      }
      if (frames.length) { artwork.thumb = frames[0].url; artwork.filmstrip = frames; }
    }
    const audio = media.hasAudio !== false ? await input.getPrimaryAudioTrack() : null;
    if (audio) {
      const sink = new AudioSampleSink(audio), peaks: number[] = [];
      for (let i = 0; i < 128; i++) {
        signal.throwIfAborted();
        const sample = await sink.getSample(Math.max(0, media.duration - .05) * i / 127);
        let peak = 0;
        if (sample) try {
          const count = Math.min(sample.numberOfFrames, 8192), pcm = new Float32Array(count * sample.numberOfChannels);
          sample.copyTo(pcm, { planeIndex: 0, format: 'f32', frameOffset: 0, frameCount: count });
          for (let j = 0; j < pcm.length; j += 4) peak = Math.max(peak, Math.abs(pcm[j]));
        } finally { sample.close(); }
        peaks.push(Math.min(1, peak));
      }
      artwork.peaks = peaks;
    }
    return artwork;
  } finally { signal.removeEventListener('abort', abort); input.dispose(); canvas.width = canvas.height = 1; }
}

const needed = (media: MediaItem) => !media.overlay && !media.offline && isBrowserMediaSource(media.src) && (
  media.kind === 'video' ? !media.thumb || !media.filmstrip?.length || media.hasAudio !== false && !media.peaks?.length
    : media.kind === 'image' ? !media.thumb : !media.peaks?.length);

/** One shared browser queue for manual/MCP import, relink, Open and recovery. */
export function startBrowserArtwork(options: { store?: Pick<typeof useStore, 'getState' | 'subscribe'>; prepare?: typeof prepareBrowserArtwork } = {}) {
  const store = options.store ?? useStore, prepare = options.prepare ?? prepareBrowserArtwork;
  const attempted = new Set<string>(), cache = new Map<string, Artwork>(), abort = new AbortController();
  let active = 0, alive = true, scheduled = false;
  const apply = (item: MediaItem, patch: Artwork) => {
    const current = store.getState();
    if (alive && current.project.media.some(m => m.id === item.id && m.src === item.src && !m.offline)) current.updateMedia(item.id, patch);
  };
  const schedule = () => {
    if (!alive || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false; if (!alive || active) return;
      for (const item of store.getState().project.media.filter(needed)) {
        const key = `${item.id}:${item.src}`;
        const cached = cache.get(item.src);
        if (cached && (Object.keys(cached) as (keyof Artwork)[]).some(field => cached[field] !== item[field])) { attempted.add(key); apply(item, cached); continue; }
        if (attempted.has(key)) continue;
        attempted.add(key); active++; notify(active);
        void prepare(item, abort.signal).then(result => {
          if (!alive) return;
          cache.set(item.src, result); if (cache.size > 64) cache.delete(cache.keys().next().value!);
          apply(item, result);
        }).catch(() => { /* Keep the original usable if a codec cannot prepare artwork. */ }).finally(() => { active--; if (alive) { notify(active); schedule(); } });
        break;
      }
    });
  };
  const loaded = () => { attempted.clear(); schedule(); };
  const unsubscribe = store.subscribe(schedule);
  if (typeof window !== 'undefined') window.addEventListener('cw-project-loaded', loaded);
  schedule();
  return () => { alive = false; abort.abort(); unsubscribe(); notify(0); if (typeof window !== 'undefined') window.removeEventListener('cw-project-loaded', loaded); };
}
