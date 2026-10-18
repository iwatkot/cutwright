import { overlaySvg, resolveOverlay } from './overlay';
import { clipVisualGain } from './clipFades';
import { defocusSigma, gaussianRgba } from './defocus';
import { drawCaption } from './captions';
import { type PreviewLayer, type PreviewTrack } from './previewComposition';
import type { AppliedTransition, Clip, Project, TransitionDef } from './types';

export type BrowserCanvas = HTMLCanvasElement | OffscreenCanvas;
export type BrowserCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Mediabunny VideoSample implements this shape, including source rotation. */
export interface BrowserDrawableSample {
  readonly displayWidth: number;
  readonly displayHeight: number;
  draw(context: BrowserCanvasContext, x: number, y: number, width: number, height: number): void;
}
export type BrowserFrameSource = CanvasImageSource | BrowserDrawableSample;
export interface BrowserFrameRequest {
  clipId: string; mediaId: string; sourceTime: number; frozen: boolean;
  /** Native normalization resets the first decoded frame at/after this in-point. */
  sourceOffset: number; sourceWindowEnd: number; speed: number;
  /** Clip-local frame after cumulative project-boundary quantization. */
  localOutputFrame: number; outputFrameCount: number;
  hold: 'before' | 'after' | null;
}
export interface BrowserFramePlan {
  time: number;
  tracks: PreviewTrack[];
  requests: BrowserFrameRequest[];
  diagnostics: string[];
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };
const SUPPORTED_XFADES = new Set(['fade', 'fadeblack', 'fadewhite', 'fadegrays', 'slideleft', 'slideright', 'slideup', 'slidedown', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'circleopen', 'circleclose', 'pixelize', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'dissolve', 'radial', 'hblur', 'gaussian', 'zoomin']);

/** Run before starting an expensive export. No unsupported effect is silently replaced. */
export function browserCompositionDiagnostics(project: Project, defs: TransitionDef[]): string[] {
  const lookup = new Map(defs.map((d) => [d.id, d]));
  const effects = project.transitions.flatMap((t) => {
    const d = lookup.get(t.defId);
    return !d ? [`Unknown transition: ${t.defId}`] : d.id !== 'cut' && !SUPPORTED_XFADES.has(d.xfade) ? [`Unsupported browser transition: ${d.xfade}`] : [];
  });
  const tracks = new Map<string, Clip[]>();
  for (const clip of project.clips) if (clip.trackId.startsWith('v') && !project.trackSettings?.[clip.trackId]?.hidden) tracks.set(clip.trackId, [...(tracks.get(clip.trackId) ?? []), clip]);
  for (const [id, clips] of tracks) {
    clips.sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) if (clips[i].start < clips[i - 1].start + clips[i - 1].duration - .001) effects.push(`Overlapping clips on ${id}: ${clips[i - 1].name} and ${clips[i].name}`);
  }
  return [...new Set(effects)];
}

/** Export placement follows the native planner's cumulative frame boundaries.
 * Original clips remain intact: source lifetimes and transition duration clamps
 * must never change just because their placement was quantized to frames. */
export function browserFramePlan(project: Project, defs: TransitionDef[], time: number): BrowserFramePlan {
  const media = new Map(project.media.map((m) => [m.id, m]));
  const frameAt = (seconds: number) => Math.round(seconds * project.fps);
  const frame = frameAt(time), frameTime = frame / project.fps;
  const range = (clip: Clip) => {
    const start = frameAt(clip.start);
    const count = Math.max(1, frameAt(clip.start + clip.duration) - start);
    return { start, count, end: start + count };
  };
  const ids = [...new Set(project.clips.filter((clip) => clip.trackId.startsWith('v')).map((clip) => clip.trackId))];
  const requested = (project.trackOrder ?? []).filter((id) => ids.includes(id));
  const defaultTop = ids.slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const top = [...requested, ...defaultTop.filter((id) => !requested.includes(id))].filter((id) => !project.trackSettings?.[id]?.hidden);
  const baseId = top.at(-1), defMap = new Map(defs.map((def) => [def.id, def]));
  const layer = (clip: Clip): PreviewLayer => {
    const { start, count, end } = range(clip);
    const localFrame = Math.max(0, Math.min(count - 1, frame - start));
    return { clip, sourceTime: clip.offset + localFrame / project.fps * (clip.speed ?? 1), frozen: frame < start || frame >= end, style: {} };
  };
  const tracks = top.slice().reverse().map((id): PreviewTrack => {
    // Keep an audio-only V track as an empty canvas, preserving the base.
    const clips = project.clips.filter((clip) => clip.trackId === id && media.get(clip.mediaId)?.kind !== 'audio').slice().sort((a, b) => a.start - b.start);
    for (const applied of project.transitions.filter((transition) => !transition.entrance)) {
      const index = clips.findIndex((clip) => applied.anchorClipId ? clip.id === applied.anchorClipId : id === baseId && Math.abs(clip.start - applied.at) < .26);
      if (index <= 0) continue;
      const incoming = clips[index], outgoing = clips[index - 1];
      if (range(outgoing).end !== range(incoming).start) continue;
      const def = defMap.get(applied.defId);
      if (!def || def.id === 'cut') continue;
      const duration = Math.min(applied.duration, outgoing.duration / 2, incoming.duration / 2);
      if (duration <= .001) continue;
      // The planner serializes xfade duration/offset to milliseconds.
      const encodedDuration = Number(duration.toFixed(3));
      const offset = Number((range(incoming).start / project.fps - duration / 2).toFixed(3));
      const progress = (frameTime - offset) / encodedDuration;
      if (progress <= 0 || progress >= 1) continue;
      return { id, base: id === baseId, layers: [layer(outgoing), layer(incoming)], transition: { applied, def, progress } };
    }
    return { id, base: id === baseId, layers: clips.filter((clip) => { const r = range(clip); return frame >= r.start && frame < r.end; }).map(layer) };
  });
  const requests = tracks.flatMap((track) => track.layers.filter((item) => !resolveOverlay(item.clip, media.get(item.clip.mediaId))).map((item): BrowserFrameRequest => {
    const r = range(item.clip), hold = frame < r.start ? 'before' : frame >= r.end ? 'after' : null;
    return { clipId: item.clip.id, mediaId: item.clip.mediaId, sourceTime: item.sourceTime, frozen: item.frozen,
      sourceOffset: item.clip.offset, sourceWindowEnd: item.clip.offset + item.clip.duration * (item.clip.speed ?? 1), speed: item.clip.speed ?? 1,
      localOutputFrame: Math.max(0, Math.min(r.count - 1, frame - r.start)), outputFrameCount: r.count, hold };
  }));
  return { time: frameTime, tracks, requests, diagnostics: browserCompositionDiagnostics(project, defs) };
}

/** RGBA, straight alpha transition math; progress is incoming coverage, 0..1.
 * The spatial definitions follow FFmpeg's xfade effects. This independent canvas
 * implementation also interpolates alpha, rather than source-over darkening a fade.
 * Reference: https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_xfade.c */
export function transitionRgba(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number, xfade: string, progress: number, out = new Uint8ClampedArray(a.length)): Uint8ClampedArray {
  if (!SUPPORTED_XFADES.has(xfade)) throw new Error(`Unsupported browser transition: ${xfade}`);
  if (a.length !== width * height * 4 || b.length !== a.length || out.length !== a.length) throw new Error('Transition frame dimensions do not match');
  if (out === a || out === b) throw new Error('Transition output must not alias its input');
  const p = clamp(progress), q = 1 - p;
  if (p === 0) { out.set(a); return out; }
  if (p === 1) { out.set(b); return out; }
  if (xfade === 'gaussian') {
    for (let i = 0; i < out.length; i++) out[i] = a[i] * q + b[i] * p;
    out.set(gaussianRgba(out, width, height, defocusSigma(p, width, height))); return out;
  }
  if (xfade === 'hblur') {
    // A forward box window shrinks at the right edge, with no wrap or black border.
    // FFmpeg halves the integer width before multiplying by its float progress.
    // Keeping that order matters for odd-width compositions and non-quarter cuts.
    const phase = Math.fround(q);
    const spread = phase <= .5 ? Math.fround(phase * 2) : Math.fround(Math.fround(1 - phase) * 2);
    const size = Math.min(width, Math.trunc(Math.fround(1 + Math.fround(Math.floor(width / 2) * spread))));
    for (let y = 0; y < height; y++) for (let c = 0; c < 4; c++) {
      const row = y * width * 4;
      let sa = 0, sb = 0;
      for (let x = 0; x < size; x++) { sa += a[row + x * 4 + c]; sb += b[row + x * 4 + c]; }
      for (let x = 0; x < width; x++) {
        const i = row + x * 4 + c;
        out[i] = Math.floor((sa * q + sb * p) / Math.min(size, width - x));
        sa -= a[i]; sb -= b[i];
        if (x + size < width) { sa += a[row + (x + size) * 4 + c]; sb += b[row + (x + size) * 4 + c]; }
      }
    }
    return out;
  }
  const circleRadius = Math.hypot(Math.floor(width / 2), Math.floor(height / 2));
  const f32 = Math.fround;
  const quantizedBlock = f32(Math.ceil(f32(Math.min(p, q) * 50)) / 50);
  const block = f32(f32(f32(2 * quantizedBlock) * Math.min(width, height)) / 20);
  const attack = smooth((q - .8) / .2), release = smooth((q - .2) / .8);
  const zoom = smooth((q - .5) / .5), zoomWeight = smooth(q / .5);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    let ai = i, bi = i, weight = p;
    if (xfade.startsWith('slide')) {
      const vertical = /up|down/.test(xfade), dim = vertical ? height : width;
      const direction = /left|up/.test(xfade) ? -1 : 1;
      const shifted = (vertical ? y : x) + Math.trunc(direction * q * dim);
      const wrapped = (shifted % dim + dim) % dim;
      ai = bi = ((vertical ? wrapped : y) * width + (vertical ? x : wrapped)) * 4;
      weight = shifted >= 0 && shifted < dim ? 1 : 0;
    } else if (xfade.startsWith('wipe')) {
      weight = xfade === 'wipeleft' ? +(x > Math.trunc(width * q)) : xfade === 'wiperight' ? +(x <= Math.trunc(width * p)) : xfade === 'wipeup' ? +(y > Math.trunc(height * q)) : +(y <= Math.trunc(height * p));
    } else if (xfade.startsWith('smooth')) {
      const axis = /up|down/.test(xfade) ? height : width;
      const coord = xfade === 'smoothleft' ? x : xfade === 'smoothright' ? width - 1 - x : xfade === 'smoothup' ? y : height - 1 - y;
      weight = smooth(1 + coord / axis - q * 2);
    } else if (xfade === 'circleopen' || xfade === 'circleclose') {
      const distance = Math.hypot(x - Math.floor(width / 2), y - Math.floor(height / 2)) / circleRadius;
      weight = xfade === 'circleopen' ? 1 - smooth(distance + (q - .5) * 3) : smooth(distance + (p - .5) * 3);
    } else if (xfade === 'radial') {
      weight = smooth(Math.atan2(x - Math.floor(width / 2), y - Math.floor(height / 2)) - (q - .5) * Math.PI * 2.5);
    } else if (xfade === 'dissolve') {
      const seed = f32(f32(x * f32(12.9898)) + f32(y * f32(78.233)));
      const random = f32(f32(Math.sin(seed)) * f32(43758.545));
      weight = +(random - Math.floor(random) < p);
    } else if (xfade === 'pixelize' && block > 0) {
      ai = bi = (Math.min(height - 1, Math.trunc(f32(f32(Math.floor(f32(y / block)) + .5) * block))) * width + Math.min(width - 1, Math.trunc(f32(f32(Math.floor(f32(x / block)) + .5) * block)))) * 4;
    } else if (xfade === 'zoomin') {
      ai = (Math.min(height - 1, Math.ceil((.5 + (y / height - .5) * zoom) * (height - 1))) * width + Math.min(width - 1, Math.ceil((.5 + (x / width - .5) * zoom) * (width - 1)))) * 4;
      weight = 1 - zoomWeight;
    }
    const grayA = .299 * a[ai] + .587 * a[ai + 1] + .114 * a[ai + 2];
    const grayB = .299 * b[bi] + .587 * b[bi + 1] + .114 * b[bi + 2];
    for (let c = 0; c < 4; c++) {
      if (xfade === 'fadeblack' || xfade === 'fadewhite' || xfade === 'fadegrays') {
        const bgA = xfade === 'fadegrays' ? c === 3 ? a[ai + c] : grayA : c === 3 || xfade === 'fadewhite' ? 255 : 0;
        const bgB = xfade === 'fadegrays' ? c === 3 ? b[bi + c] : grayB : bgA;
        out[i + c] = Math.floor((a[ai + c] * attack + bgA * (1 - attack)) * q + (bgB * release + b[bi + c] * (1 - release)) * p);
      } else out[i + c] = Math.floor(a[ai + c] * (1 - weight) + b[bi + c] * weight);
    }
  }
  return out;
}

export interface BrowserCompositorOptions {
  width: number;
  height: number;
  createCanvas?: (width: number, height: number) => BrowserCanvas;
  rasterizeSvg?: (svg: string) => Promise<CanvasImageSource>;
  /** Maximum retained full-resolution SVG images, independent of project length. */
  overlayCacheSize?: number;
  drawCaptions?: (context: BrowserCanvasContext, project: Project, time: number) => void;
}

function defaultCanvas(width: number, height: number): BrowserCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
async function defaultRasterize(svg: string): Promise<CanvasImageSource> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* Chromium may require an image element for SVG. */ }
  }
  if (typeof Image === 'undefined') throw new Error('This browser cannot rasterize native SVG overlays in a worker');
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; }
  finally { URL.revokeObjectURL(url); }
}
const releaseImage = (image: CanvasImageSource) => { if ('close' in image && typeof image.close === 'function') image.close(); };
function clear(context: BrowserCanvasContext, width: number, height: number, opaque = false) {
  context.resetTransform(); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.filter = 'none';
  context.clearRect(0, 0, width, height);
  if (opaque) { context.fillStyle = '#000000'; context.fillRect(0, 0, width, height); }
}
function sourceSize(source: BrowserFrameSource): [number, number] {
  if ('displayWidth' in source) return [source.displayWidth, source.displayHeight];
  if ('naturalWidth' in source) return [source.naturalWidth, source.naturalHeight];
  if ('videoWidth' in source) return [source.videoWidth, source.videoHeight];
  if (typeof source.width === 'object') return [source.width.baseVal.value, (source.height as SVGAnimatedLength).baseVal.value];
  return [Number(source.width), Number(source.height)];
}
function drawSource(context: BrowserCanvasContext, source: BrowserFrameSource, width: number, height: number) {
  const [sw, sh] = sourceSize(source);
  if (!(sw > 0 && sh > 0)) throw new Error('A browser composition source has no decoded dimensions');
  const ratio = Math.min(width / sw, height / sh), dw = sw * ratio, dh = sh * ratio;
  if ('draw' in source) source.draw(context, (width - dw) / 2, (height - dh) / 2, dw, dh);
  else context.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}

/** Lazily bounded surface pools; caller owns every decoded frame. Ordinary,
 * unmodified base video at project size uses GPU-friendly canvases. Overlays, captions, effects
 * and non-default transforms keep the established readback rendering path.
 * One compositor renders one frame at a time. Concurrent use is rejected so the
 * exporter cannot accidentally overwrite surfaces while native rasterization waits. */
export function createBrowserCompositor(options: BrowserCompositorOptions) {
  const { width: W, height: H } = options;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1) throw new Error('Invalid browser composition dimensions');
  const factory = options.createCanvas ?? defaultCanvas;
  const pools = new Map<boolean, { surfaces: BrowserCanvas[]; contexts: BrowserCanvasContext[] }>();
  function surfacesFor(readback: boolean) {
    let pool = pools.get(readback);
    if (!pool) {
      const surfaces = Array.from({ length: 3 }, () => factory(W, H));
      try {
        const contexts = surfaces.map((canvas) => {
          const context = canvas.getContext('2d', { willReadFrequently: readback }) as BrowserCanvasContext | null;
          if (!context) throw new Error('Canvas2D is unavailable');
          return context;
        });
        pool = { surfaces, contexts }; pools.set(readback, pool);
      } catch (error) { surfaces.forEach((s) => { s.width = s.height = 1; }); throw error; }
    }
    return pool;
  }
  const cache = new Map<string, CanvasImageSource>();
  const pad = Math.ceil(defocusSigma(.5, W, H) * 3);
  let focusSurface: BrowserCanvas | undefined;
  function focus(source: BrowserCanvas, destination: BrowserCanvasContext, sigma: number) {
    focusSurface ??= factory(W + 2 * pad, H + 2 * pad);
    const edges = focusSurface.getContext('2d') as BrowserCanvasContext;
    clear(edges, W + 2 * pad, H + 2 * pad);
    // Extend the edge pixels before filtering: uniform footage stays uniform,
    // including corners; no dark vignette or directional displacement.
    const xs = [[0, 1, 0, pad], [0, W, pad, W], [W - 1, 1, pad + W, pad]];
    const ys = [[0, 1, 0, pad], [0, H, pad, H], [H - 1, 1, pad + H, pad]];
    for (const [sx, sw, dx, dw] of xs) for (const [sy, sh, dy, dh] of ys) edges.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    clear(destination, W, H); destination.save(); destination.filter = `blur(${sigma}px)`;
    destination.drawImage(focusSurface, -pad, -pad); destination.restore();
  }
  // Two changing roll layers must not evict a third, still website on each frame.
  const cacheLimit = Number.isFinite(options.overlayCacheSize) ? Math.max(1, Math.min(8, Math.floor(options.overlayCacheSize!))) : 4;
  let disposed = false, busy = false;
  const rasterize = options.rasterizeSvg ?? defaultRasterize;
  async function native(svg: string) {
    let image = cache.get(svg);
    if (image) { cache.delete(svg); cache.set(svg, image); return image; }
    image = await rasterize(svg);
    if (disposed) { releaseImage(image); throw new Error('Browser compositor was disposed'); }
    cache.set(svg, image);
    while (cache.size > cacheLimit) { const key = cache.keys().next().value!; releaseImage(cache.get(key)!); cache.delete(key); }
    return image;
  }
  function entranceFor(project: Project, defs: TransitionDef[], clip: Clip, baseId?: string) {
    const applied = project.transitions.find((t) => t.entrance && (t.anchorClipId ? t.anchorClipId === clip.id : clip.trackId === baseId && Math.abs(t.at - clip.start) < .26));
    const def = applied ? defs.find((d) => d.id === applied.defId) : undefined;
    return applied && def && def.id !== 'cut' && Math.min(applied.duration, clip.duration) > .001 ? { applied, def } : undefined;
  }
  async function renderFrame(project: Project, defs: TransitionDef[], time: number, sources: ReadonlyMap<string, BrowserFrameSource>, context: BrowserCanvasContext): Promise<BrowserFramePlan> {
    if (disposed) throw new Error('Browser compositor was disposed');
    if (busy) throw new Error('Browser compositor cannot render concurrent frames');
    if (project.width !== W || project.height !== H) throw new Error('Project dimensions changed during browser export');
    busy = true;
    try {
      const plan = browserFramePlan(project, defs, time);
      if (plan.diagnostics.length) throw new Error(plan.diagnostics.join('; '));
      const mediaById = new Map(project.media.map((m) => [m.id, m]));
      clear(context, W, H, true);
      const baseId = plan.tracks.find((t) => t.base)?.id;
      const visible = plan.tracks.filter((t) => t.layers.length);
      const candidate = visible.length === 1 && visible[0].base && !visible[0].transition && visible[0].layers.length === 1 ? visible[0].layers[0] : undefined;
      let plainVideo = false;
      if (candidate) {
        const clip = candidate.clip, media = mediaById.get(clip.mediaId);
        const drawable = sources.get(clip.id);
        const [sourceWidth, sourceHeight] = drawable ? sourceSize(drawable) : [0, 0];
        const entry = entranceFor(project, defs, clip, baseId);
        const local = Math.max(0, (candidate.sourceTime - clip.offset) / (clip.speed ?? 1));
        plainVideo = media?.kind === 'video' && sourceWidth === W && sourceHeight === H && !resolveOverlay(clip, media)
          && (clip.scale ?? 1) === 1 && (clip.posX ?? 0) === 0 && (clip.posY ?? 0) === 0 && (clip.rotate ?? 0) === 0
          && (clip.brightness ?? 1) === 1 && (clip.contrast ?? 1) === 1 && (clip.saturation ?? 1) === 1 && (clip.opacity ?? 1) === 1
          && clipVisualGain(clip, local, project.fps) === 1
          && (!entry || local >= Math.min(entry.applied.duration, clip.duration))
          && !project.subtitles.some((s) => time >= s.start && time <= s.end);
      }
      const { surfaces, contexts } = surfacesFor(!plainVideo);
      for (const track of plan.tracks) {
        if (!track.layers.length) continue; // Output was already cleared to the opaque base.
        clear(contexts[2], W, H, track.base);
        for (let index = 0; index < track.layers.length; index++) {
          const layer = track.layers[index], clip = layer.clip, media = mediaById.get(clip.mediaId), overlay = resolveOverlay(clip, media);
          const source = overlay ? await native(overlaySvg(overlay, W, H, layer.sourceTime, project.fonts)) : sources.get(clip.id);
          if (!source) throw new Error(`Missing decoded frame for ${clip.name} (${clip.id}) at ${layer.sourceTime.toFixed(6)}s`);
          const dst = contexts[index];
          // Fit first, then transform/filter the full composition canvas, so
          // letterbox pixels receive the same color/position effects as desktop.
          clear(contexts[2], W, H, track.base);
          drawSource(contexts[2], source, W, H);
          clear(dst, W, H, track.base);
          dst.save();
          dst.translate(W / 2 + Math.round((clip.posX ?? 0) / 100 * W), H / 2 + Math.round((clip.posY ?? 0) / 100 * H));
          dst.scale(clip.scale ?? 1, clip.scale ?? 1); dst.rotate((clip.rotate ?? 0) * Math.PI / 180); dst.translate(-W / 2, -H / 2);
          dst.filter = `brightness(${clip.brightness ?? 1}) contrast(${clip.contrast ?? 1}) saturate(${clip.saturation ?? 1})${track.base ? ` brightness(${clip.opacity ?? 1})` : ''}`;
          dst.globalAlpha = track.base ? 1 : clip.opacity ?? 1;
          dst.drawImage(surfaces[2], 0, 0); dst.restore();
          const entry = entranceFor(project, defs, clip, baseId);
          const local = Math.max(0, Math.min(clip.duration, (layer.sourceTime - clip.offset) / (clip.speed ?? 1)));
          if (entry && local < Math.min(entry.applied.duration, clip.duration)) {
            if (entry.def.xfade === 'gaussian') {
              const p = clamp(local / Math.min(entry.applied.duration, clip.duration));
              focus(surfaces[index], contexts[2], defocusSigma(p, W, H)); clear(dst, W, H, track.base);
              dst.globalAlpha = p; dst.drawImage(surfaces[2], 0, 0); dst.globalAlpha = 1;
            } else applyEntrance(dst, contexts[2], surfaces[index], entry, local, clip, track.base, W, H);
          }
          const fade = clipVisualGain(clip, local, project.fps);
          if (fade < 1) {
            // Include entrance fills; base fades to black, other layers reveal below.
            dst.save(); dst.resetTransform(); dst.filter = 'none'; dst.globalAlpha = 1 - fade;
            dst.globalCompositeOperation = track.base ? 'source-over' : 'destination-out';
            dst.fillStyle = '#000000'; dst.fillRect(0, 0, W, H); dst.restore();
          }
        }
        if (track.transition && track.layers.length === 2) {
          const a = contexts[0].getImageData(0, 0, W, H), b = contexts[1].getImageData(0, 0, W, H), out = contexts[2].createImageData(W, H);
          const defocus = track.transition.def.xfade === 'gaussian';
          transitionRgba(a.data, b.data, W, H, defocus ? 'fade' : track.transition.def.xfade, track.transition.progress, out.data);
          contexts[2].putImageData(out, 0, 0);
          if (defocus) { focus(surfaces[2], contexts[0], defocusSigma(track.transition.progress, W, H)); clear(contexts[2], W, H); contexts[2].drawImage(surfaces[0], 0, 0); }
        } else if (track.layers.length) {
          clear(contexts[2], W, H, track.base); contexts[2].drawImage(surfaces[0], 0, 0);
        }
        context.drawImage(surfaces[2], 0, 0);
      }
      (options.drawCaptions ?? drawCaption)(context, project, time);
      return plan;
    } finally { busy = false; }
  }
  return { renderFrame, dispose() {
    if (disposed) return;
    disposed = true; cache.forEach(releaseImage); cache.clear();
    if (focusSurface) focusSurface.width = focusSurface.height = 1;
    for (const { surfaces } of pools.values()) surfaces.forEach((s) => { s.width = 1; s.height = 1; });
    pools.clear();
  }, get overlayCacheEntries() { return cache.size; } };
}

function applyEntrance(dst: BrowserCanvasContext, scratch: BrowserCanvasContext, source: BrowserCanvas, entry: { applied: AppliedTransition; def: TransitionDef }, local: number, clip: Clip, base: boolean, W: number, H: number) {
  const p = clamp(local / Math.min(entry.applied.duration, clip.duration));
  if (entry.def.preview === 'blur') {
    // Desktop uses a fixed blurred copy mixed into the sharp source, then a
    // separate fade. Reducing the blur radius alone has a different ramp.
    const sharp = dst.getImageData(0, 0, W, H);
    clear(scratch, W, H, base); scratch.filter = `blur(${base ? 16 : 14}px)`; scratch.drawImage(source, 0, 0); scratch.filter = 'none';
    const blur = scratch.getImageData(0, 0, W, H);
    for (let i = 0; i < sharp.data.length; i += 4) {
      for (let c = 0; c < 4; c++) {
        const mixed = sharp.data[i + c] * p + blur.data[i + c] * (1 - p);
        sharp.data[i + c] = base ? c === 3 ? 255 : Math.floor(mixed * p) : c === 3 ? Math.floor(mixed * p) : Math.floor(mixed);
      }
    }
    dst.putImageData(sharp, 0, 0);
  } else {
    const input = dst.getImageData(0, 0, W, H), blank = scratch.createImageData(W, H), result = scratch.createImageData(W, H);
    if (entry.def.xfade === 'fadewhite') blank.data.fill(255);
    else if (base) for (let i = 3; i < blank.data.length; i += 4) blank.data[i] = 255;
    const effect = entry.def.xfade === 'fadewhite' || entry.def.xfade === 'fadeblack' ? 'fade' : entry.def.xfade;
    transitionRgba(blank.data, input.data, W, H, effect, p, result.data); dst.putImageData(result, 0, 0);
  }
}
