import { exportDimensions } from './outputDimensions';
import {
  ALL_FORMATS, AudioSample, AudioSampleSource, BlobSource, CanvasSource,
  Input, Mp4OutputFormat, Output, Quality, StreamTarget, VideoSampleSink,
  type VideoSample,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { loadBrowserMedia } from './browserMedia';
import { browserCompositionDiagnostics, browserFramePlan, createBrowserCompositor, type BrowserFrameSource } from './browserComposition';
import { createBrowserAudioMixer } from './browserAudio';
import { validateProject } from './validate';
import { resolveOverlay } from './overlay';
import { drawCaption } from './captions';
import { enableBrowserVideoDecoding } from './browserVideoDecoder';
import { createBrowserExportScratch } from './browserExportStorage';
import type { MediaItem, Project, TransitionDef } from './types';
import { browserVideoBitrate, type ExportQuality } from './exportQuality';

const SAMPLE_RATE = 48000;
let aacRegistered = false;
let exporting = false;
export interface BrowserExportProgress { stage: string; progress: number; frame: number; frames: number; elapsedSeconds: number }
export interface BrowserExportOptions {
  maxHeight?: number;
  quality?: ExportQuality;
  bitrate?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BrowserExportProgress) => void;
  /** Local test/embedding adapter; production defaults to IndexedDB bytes. */
  loadMedia?: (media: MediaItem) => Promise<Blob>;
}
export interface BrowserExportReport {
  width: number; height: number; fps: number; frames: number; duration: number;
  audioFrames: number; sampleRate: number; bytes: number; elapsedSeconds: number;
  audioChannels: 1 | 2; peakVideoDecoders: number; userAgent: string; videoBitrate: number;
  quality: ExportQuality;
}
export interface BrowserExportResult { file: File; url: string; report: BrowserExportReport; dispose(): Promise<void> }

function abortError() { return new DOMException('Export cancelled', 'AbortError'); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
async function localMedia(media: MediaItem): Promise<Blob> {
  const file = await loadBrowserMedia(media.src);
  if (file) return file;
  // Old projects must relink local files. Export never fetches a remote URL.
  throw new Error(`Relink "${media.name}" with Import before exporting.`);
}

/** Only timestamp schedules are retained, never decoded project-sized frame arrays. */
export interface BrowserVideoSchedule { sourceOffset: number; sourceSpan: number; speed: number; localFrames: number[] }
export function browserVideoSchedules(project: Project, defs: TransitionDef[], frames: number): Map<string, BrowserVideoSchedule> {
  const schedules = new Map<string, BrowserVideoSchedule>();
  const media = new Map(project.media.map((m) => [m.id, m]));
  for (let frame = 0; frame < frames; frame++) for (const request of browserFramePlan(project, defs, frame / project.fps).requests) {
    if (media.get(request.mediaId)?.kind !== 'video') continue;
    let schedule = schedules.get(request.clipId);
    if (!schedule) { schedule = { sourceOffset: request.sourceOffset, sourceSpan: request.sourceWindowEnd - request.sourceOffset, speed: request.speed, localFrames: [] }; schedules.set(request.clipId, schedule); }
    schedule.localFrames.push(request.localOutputFrame);
  }
  return schedules;
}

async function firstDecodedTimestamp(sink: VideoSampleSink, offset: number, signal?: AbortSignal): Promise<number> {
  const iterator = sink.samples(offset);
  try {
    for await (const sample of iterator) {
      try { checkAbort(signal); if (sample.timestamp >= offset - 1e-10) return sample.timestamp; }
      finally { sample.close(); }
    }
    throw new Error(`No video frame at or after source offset ${offset.toFixed(3)}s.`);
  } finally { await iterator.return(); }
}

/** Complete local composition export. Disk-backed output, bounded active decoders,
 * awaited encoder backpressure and integer frame/sample clocks avoid a render server. */
export async function exportBrowserProject(sourceProject: Project, defs: TransitionDef[], options: BrowserExportOptions = {}): Promise<BrowserExportResult> {
  if (exporting) throw new Error('Another browser export is already running.');
  if (!isSecureContext || typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new Error('Local video export needs a current Chrome or Edge browser on HTTPS or localhost.');
  if (!navigator.storage?.getDirectory) throw new Error('This browser cannot create the local export file. Use current Chrome or Edge with local storage enabled.');
  const validation = validateProject(sourceProject);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const project = structuredClone(sourceProject);
  const diagnostics = browserCompositionDiagnostics(project, defs);
  if (diagnostics.length) throw new Error(diagnostics.join('; '));
  const duration = Math.max(0, ...project.clips.map((c) => c.start + c.duration), ...project.subtitles.map((s) => s.end));
  if (!(duration > 0)) throw new Error('Timeline is empty — add media or captions before exporting.');
  const frames = Math.max(1, Math.round(duration * project.fps));
  const audioFrames = Math.round(duration * SAMPLE_RATE);
  const {width, height} = exportDimensions(project, options.maxHeight);
  const quality = options.quality ?? 'high';
  const bitrate = options.bitrate ?? browserVideoBitrate(width, height, project.fps, quality);
  const started = performance.now();
  const progress = (stage: string, frame = 0) => options.onProgress?.({ stage, progress: Math.min(99, Math.floor(frame / frames * 100)), frame, frames, elapsedSeconds: (performance.now() - started) / 1000 });
  const blobs = new Map<string, Promise<Blob>>();
  const inputs = new Map<string, Input>();
  const images = new Map<string, ImageBitmap>();
  const cursors = new Map<string, { iterator: AsyncGenerator<VideoSample | null, void, unknown>; remaining: number }>();
  const samples = new Set<VideoSample>();
  const canvas = new OffscreenCanvas(project.width, project.height);
  const context = canvas.getContext('2d', { alpha: false });
  const encodedCanvas = width === project.width && height === project.height ? canvas : new OffscreenCanvas(width, height);
  const encodedContext = encodedCanvas === canvas ? context : encodedCanvas.getContext('2d', { alpha: false });
  const compositor = createBrowserCompositor({ width: project.width, height: project.height, drawCaptions: drawCaption });
  let output: Output | undefined;
  let mixer: Awaited<ReturnType<typeof createBrowserAudioMixer>> | undefined;
  let scratch: Awaited<ReturnType<typeof createBrowserExportScratch>> | undefined;
  let peakVideoDecoders = 0, succeeded = false;
  const disposeInputs = () => { for (const input of inputs.values()) input.dispose(); inputs.clear(); };
  const cancel = () => { mixer?.dispose(); disposeInputs(); void output?.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  exporting = true;
  try {
    checkAbort(options.signal);
    if (!context || !encodedContext) throw new Error('Canvas2D is unavailable for local composition.');
    progress('Opening local media');
    const load = (media: MediaItem) => {
      let pending = blobs.get(media.id);
      if (!pending) { pending = (options.loadMedia ?? localMedia)(media); blobs.set(media.id, pending); }
      return pending;
    };
    const media = new Map(project.media.map((m) => [m.id, m]));
    // Resolve every required local source before allocating an output or codec.
    for (const id of new Set(project.clips.filter((c) => {
      const item = media.get(c.mediaId);
      if (!item || resolveOverlay(c, item) || project.trackSettings?.[c.trackId]?.hidden) return false;
      const visual = c.trackId.startsWith('v') && item.kind !== 'audio';
      const audible = !project.trackSettings?.[c.trackId]?.muted && !c.mutedAudio && item.kind !== 'image' && (item.kind !== 'video' || item.hasAudio !== false);
      return visual || audible;
    }).map((c) => c.mediaId))) {
      checkAbort(options.signal);
      const item = media.get(id)!; await load(item);
    }
    await document.fonts.ready;
    enableBrowserVideoDecoding();
    const schedules = browserVideoSchedules(project, defs, frames);
    checkAbort(options.signal);
    mixer = await createBrowserAudioMixer(project, { loadMedia: load, signal: options.signal, onPrepare: (stage) => progress(stage) });
    if (!aacRegistered) { registerAacEncoder(); aacRegistered = true; }
    scratch = await createBrowserExportScratch({ signal: options.signal });
    const handle = scratch.handle;
    const writable = await handle.createWritable();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }) });
    const video = new CanvasSource(encodedCanvas, { codec: 'avc', quality: new Quality({ bitrate }), latencyMode: 'quality', keyFrameInterval: 2 });
    const audio = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 192000 }) });
    output.addVideoTrack(video, { frameRate: project.fps }); output.addAudioTrack(audio);
    await output.start();
    let audioCursor = 0, lastYield = performance.now();
    for (let frame = 0; frame < frames; frame++) {
      checkAbort(options.signal);
      // Keep the two muxed tracks within one second, so neither writer queues
      // a complete encoded stream while waiting for its counterpart.
      const audioUntil = Math.min(audioFrames, Math.round((frame / project.fps + 1) * SAMPLE_RATE));
      while (audioCursor < audioUntil) {
        const count = Math.min(4096, audioUntil - audioCursor);
        const pcm = await mixer.renderBlock(audioCursor, count);
        const sample = new AudioSample({ data: pcm, format: 'f32-planar', numberOfChannels: mixer.channels, sampleRate: SAMPLE_RATE, timestamp: audioCursor / SAMPLE_RATE });
        try { await audio.add(sample); } finally { sample.close(); }
        audioCursor += count;
      }
      const time = frame / project.fps;
      const plan = browserFramePlan(project, defs, time);
      const sources = new Map<string, BrowserFrameSource>();
      try {
        for (const request of plan.requests) {
          const item = media.get(request.mediaId)!;
          if (item.kind === 'image') {
            let image = images.get(item.id);
            if (!image) { image = await createImageBitmap(await load(item)); images.set(item.id, image); }
            sources.set(request.clipId, image);
          } else if (item.kind === 'video') {
            let cursor = cursors.get(request.clipId);
            if (!cursor) {
              let input = inputs.get(item.id);
              if (!input) { input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await load(item), { maxCacheSize: 1024 * 1024 }) }); inputs.set(item.id, input); }
              const track = await input.getPrimaryVideoTrack();
              if (!track || !(await track.canDecode())) throw new Error(`This browser cannot decode "${item.name}". Convert or relink that source.`);
              const schedule = schedules.get(request.clipId)!;
              const sink = new VideoSampleSink(track);
              const first = await firstDecodedTimestamp(sink, schedule.sourceOffset, options.signal);
              // fps EOF rounding can end the normalized body one frame before
              // its quantized placement. Native tpad repeats that final frame.
              // Cap the normalized frame index, rather than a source timestamp.
              const tail = await sink.getSample(first + schedule.sourceSpan - 1e-7);
              if (!tail) throw new Error(`No final decoded frame for "${item.name}".`);
              let lastFrame: number;
              try { lastFrame = Math.max(0, Math.round((tail.timestamp + tail.duration - first) * project.fps / schedule.speed) - 1); }
              finally { tail.close(); }
              checkAbort(options.signal);
              // FFmpeg resets PTS at the first decoded frame after -ss, then
              // fps(round=near) chooses the last source frame in each window.
              const times = schedule.localFrames.map((n) => first + (Math.min(n, lastFrame) + .5) * schedule.speed / project.fps - 1e-7);
              cursor = { iterator: sink.samplesAtTimestamps(times), remaining: times.length }; cursors.set(request.clipId, cursor);
              peakVideoDecoders = Math.max(peakVideoDecoders, cursors.size);
            }
            const { value: sample } = await cursor.iterator.next();
            if (!sample) throw new Error(`No decoded frame for "${item.name}" at ${request.sourceTime.toFixed(3)}s. Check the clip's source range.`);
            samples.add(sample); sources.set(request.clipId, sample); cursor.remaining--;
          }
        }
        checkAbort(options.signal);
        await compositor.renderFrame(project, defs, time, sources, context);
        if (encodedCanvas !== canvas) { encodedContext.drawImage(canvas, 0, 0, width, height); }
        await video.add(time, 1 / project.fps);
      } finally {
        for (const sample of samples) sample.close(); samples.clear();
        for (const [id, cursor] of cursors) if (!cursor.remaining) { await cursor.iterator.return(); cursors.delete(id); }
        const activeImages = new Set(plan.requests.map((r) => r.mediaId));
        for (const [id, image] of images) if (!activeImages.has(id)) { image.close(); images.delete(id); }
      }
      progress('Rendering composition', frame + 1);
      if (performance.now() - lastYield > 16) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
    }
    video.close(); audio.close(); checkAbort(options.signal); progress('Finalizing local file', frames);
    await output.finalize(); checkAbort(options.signal);
    const stored = await handle.getFile();
    checkAbort(options.signal);
    const name = `${project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'CutWright'}.mp4`;
    const file = new File([stored], name, { type: 'video/mp4', lastModified: Date.now() });
    const url = URL.createObjectURL(file);
    const report: BrowserExportReport = { width, height, fps: project.fps, frames, duration, audioFrames, sampleRate: SAMPLE_RATE, audioChannels: mixer.channels, bytes: file.size, elapsedSeconds: (performance.now() - started) / 1000, peakVideoDecoders, userAgent: navigator.userAgent, videoBitrate: bitrate, quality };
    succeeded = true;
    let disposed = false;
    return { file, url, report, async dispose() { if (disposed) return; disposed = true; URL.revokeObjectURL(url); await scratch?.dispose(); } };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    for (const sample of samples) sample.close();
    disposeInputs();
    for (const cursor of cursors.values()) void cursor.iterator.return().catch(() => undefined);
    images.forEach((image) => image.close()); mixer?.dispose(); compositor.dispose();
    canvas.width = canvas.height = encodedCanvas.width = encodedCanvas.height = 1;
    if (!succeeded) { await output?.cancel().catch(() => undefined); await scratch?.dispose().catch(() => undefined); }
    exporting = false;
  }
}
