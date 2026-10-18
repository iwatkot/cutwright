import { describe, expect, it, vi } from 'vitest';
import { browserCompositionDiagnostics, browserFramePlan, createBrowserCompositor, transitionRgba, type BrowserCanvas, type BrowserCanvasContext } from '../src/lib/browserComposition';
import { BUILTIN_TRANSITIONS } from '../src/lib/transitions';
import type { Clip, Project } from '../src/lib/types';

const clip = (id: string, trackId: string, start: number, duration: number, patch: Partial<Clip> = {}): Clip => ({ id, mediaId: id, name: id, trackId, start, duration, offset: 0, color: '#FFFFFF', ...patch });
const fixture = (patch: Partial<Project> = {}): Project => ({ version: 1, name: 'Browser composition', width: 8, height: 4, fps: 30, media: [], clips: [], transitions: [], subtitles: [], customTransitions: [], ...patch });
const pixels = (width: number, height: number, rgba: number[]) => new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat());
const at = (data: Uint8ClampedArray, width: number, x: number, y = 0) => Array.from(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4));

describe('browser frame planning', () => {
  it('requests separate source clocks for simultaneous uses and frozen handles, in composition order', () => {
    const project = fixture({ clips: [clip('lower', 'v1', 0, 8), clip('a', 'v2', 0, 4, { mediaId: 'shared', offset: 1, speed: 2 }), clip('b', 'v2', 4, 4, { mediaId: 'shared', offset: 7 })], trackOrder: ['v2', 'v1'], transitions: [{ id: 'cut', defId: 'cross-dissolve', anchorClipId: 'b', at: 4, duration: 2 }] });
    const plan = browserFramePlan(project, BUILTIN_TRANSITIONS, 3.5);
    expect(plan.tracks.map((t) => t.id)).toEqual(['v1', 'v2']);
    expect(plan.requests.map(({ clipId, mediaId, sourceTime, frozen }) => ({ clipId, mediaId, sourceTime, frozen }))).toEqual([
      { clipId: 'lower', mediaId: 'lower', sourceTime: 3.5, frozen: false },
      { clipId: 'a', mediaId: 'shared', sourceTime: 8, frozen: false },
      { clipId: 'b', mediaId: 'shared', sourceTime: 7, frozen: true },
    ]);
    const tail = browserFramePlan(project, BUILTIN_TRANSITIONS, 4.5).requests.find((r) => r.clipId === 'a')!;
    expect(tail.frozen).toBe(true); expect(tail.sourceTime).toBeCloseTo(1 + (4 - 1 / 30) * 2);
    expect(tail).toMatchObject({ sourceOffset: 1, speed: 2, localOutputFrame: 119, outputFrameCount: 120, hold: 'after' });
  });

  it('places fractional clip boundaries on global output frames without changing source or duration', () => {
    const original = clip('late', 'v1', .123456789, .916666667, { offset: .123456789, speed: 6 });
    const project = fixture({ clips: [original] });
    expect(browserFramePlan(project, BUILTIN_TRANSITIONS, 3 / 30).requests).toEqual([]);
    const first = browserFramePlan(project, BUILTIN_TRANSITIONS, 4 / 30);
    expect(first.requests[0]).toMatchObject({ localOutputFrame: 0, outputFrameCount: 27, sourceOffset: .123456789, sourceTime: .123456789, speed: 6, hold: null });
    expect(first.tracks[0].layers[0].clip).toBe(original);
    expect(browserFramePlan(project, BUILTIN_TRANSITIONS, 30 / 30).requests[0]).toMatchObject({ localOutputFrame: 26, outputFrameCount: 27 });
    expect(browserFramePlan(project, BUILTIN_TRANSITIONS, 31 / 30).requests).toEqual([]);
  });

  it('quantizes a cut position while preserving original transition duration clamps', () => {
    const a = clip('a', 'v1', 0, .123456789), b = clip('b', 'v1', .123456789, .916666667);
    const project = fixture({ clips: [a, b], transitions: [{ id: 'x', defId: 'cross-dissolve', at: b.start, duration: .1, anchorClipId: 'b' }] });
    const plan = browserFramePlan(project, BUILTIN_TRANSITIONS, 4 / 30);
    const duration = Math.min(.1, a.duration / 2, b.duration / 2);
    const offset = Number((4 / 30 - duration / 2).toFixed(3));
    expect(plan.tracks[0].transition?.progress).toBeCloseTo((4 / 30 - offset) / Number(duration.toFixed(3)));
    expect(plan.requests.find((r) => r.clipId === 'a')).toMatchObject({ localOutputFrame: 3, outputFrameCount: 4, hold: 'after' });
    expect(plan.requests.find((r) => r.clipId === 'b')).toMatchObject({ localOutputFrame: 0, outputFrameCount: 27, hold: null });
    expect(plan.tracks[0].layers.map((l) => l.clip)).toEqual([a, b]);
  });

  it('renders native templates without requesting their PNG and omits hidden media', () => {
    const overlay = { kind: 'arrow' as const, x1: 1, y1: 1, x2: 6, y2: 3, width: 1, head: true, color: '#FFFFFF', animationOffset: -.5 };
    const project = fixture({ clips: [clip('native', 'v2', 0, 4, { mediaId: 'template', offset: 1, speed: 2 }), clip('hidden', 'v1', 0, 4)], media: [{ id: 'template', name: 'arrow', kind: 'image', src: '', duration: 4, color: '#FFFFFF', overlay }], trackSettings: { v1: { hidden: true } } });
    const plan = browserFramePlan(project, BUILTIN_TRANSITIONS, 1);
    expect(plan.requests).toEqual([]); expect(plan.tracks[0].layers[0].sourceTime).toBe(3);
  });

  it('identifies an unsupported effect before rendering instead of substituting a dissolve', () => {
    const project = fixture({ transitions: [{ id: 'x', defId: 'unknown', at: 0, duration: 1 }] });
    expect(browserCompositionDiagnostics(project, BUILTIN_TRANSITIONS)).toEqual(['Unknown transition: unknown']);
    expect(browserCompositionDiagnostics(project, [{ ...BUILTIN_TRANSITIONS[1], id: 'unknown', xfade: 'future-effect' }])).toEqual(['Unsupported browser transition: future-effect']);
  });

  it('keeps an audio-only visual track empty and excludes it from transition neighbors', () => {
    const project = fixture({ clips: [clip('voice', 'v1', 0, 8), clip('picture', 'v2', 0, 8)], media: [{ id: 'voice', name: 'voice', kind: 'audio', src: 'voice.wav', duration: 8, color: '#FFFFFF' }], trackOrder: ['v2', 'v1'] });
    const plan = browserFramePlan(project, BUILTIN_TRANSITIONS, 2);
    expect(plan.tracks.map((t) => ({ id: t.id, base: t.base, layers: t.layers.map((l) => l.clip.id) }))).toEqual([{ id: 'v1', base: true, layers: [] }, { id: 'v2', base: false, layers: ['picture'] }]);
    expect(plan.requests.map((r) => r.clipId)).toEqual(['picture']);
    project.clips = [clip('voice', 'v1', 0, 4), clip('picture', 'v1', 4, 4)];
    project.transitions = [{ id: 'after-voice', defId: 'cross-dissolve', at: 4, duration: 2, anchorClipId: 'picture' }];
    expect(browserFramePlan(project, BUILTIN_TRANSITIONS, 3.5).requests).toEqual([]);
    expect(browserFramePlan(project, BUILTIN_TRANSITIONS, 4).tracks[0].transition).toBeUndefined();
  });
});

describe('browser export transitions', () => {
  it('preserves both endpoints and caller buffers for every built-in export effect', () => {
    const a = pixels(8, 4, [200, 20, 10, 64]), b = pixels(8, 4, [10, 30, 240, 192]);
    const copyA = a.slice(), copyB = b.slice();
    for (const name of [...BUILTIN_TRANSITIONS.map((d) => d.xfade), 'slideright', 'slidedown', 'wiperight', 'wipeup', 'wipedown', 'circleclose', 'smoothright', 'dissolve', 'radial', 'fadegrays', 'zoomin']) {
      expect(transitionRgba(a, b, 8, 4, name, 0)).toEqual(a);
      expect(transitionRgba(a, b, 8, 4, name, 1)).toEqual(b);
    }
    expect(a).toEqual(copyA); expect(b).toEqual(copyB);
    expect(at(transitionRgba(a, b, 8, 4, 'fade', .5), 8, 3)).toEqual([105, 25, 125, 128]);
    expect(() => transitionRgba(a, b, 8, 4, 'fade', .5, a)).toThrow(/alias/);
  });

  it('uses a shrinking forward horizontal average and leaves neighboring rows independent', () => {
    const a = new Uint8ClampedArray([0, 60, 120, 180, 40, 80, 120, 160].flatMap((value) => [value, 0, 0, 255]));
    const b = pixels(4, 2, [0, 0, 0, 255]);
    const out = transitionRgba(a, b, 4, 2, 'hblur', .5);
    expect([0, 1, 2, 3].map((x) => at(out, 4, x)[0])).toEqual([30, 60, 75, 90]);
    expect([0, 1, 2, 3].map((x) => at(out, 4, x, 1)[0])).toEqual([40, 60, 70, 80]);
    expect(at(out, 4, 3, 1)[3]).toBe(255);
  });

  it('keeps the integer half-width for odd hblur canvases at non-quarter progress', () => {
    const a = new Uint8ClampedArray(Array.from({ length: 31 }, (_, x) => [x * 8, x * 4, 0, x * 8]).flat());
    const b = pixels(31, 1, [0, 0, 0, 0]);
    // At 3/7 the 31px native window is13px, rather than14px. Its
    // forward average starts at48 and uses an outgoing weight of4/7.
    expect(at(transitionRgba(a, b, 31, 1, 'hblur', 3 / 7), 31, 0)).toEqual([27, 13, 0, 27]);
    expect(at(transitionRgba(a, b, 31, 1, 'hblur', 4 / 7), 31, 0)).toEqual([20, 10, 0, 20]);
  });

  it('distinguishes spatial smooth wipes, push slides, hard wipes, and circular reveals from a uniform fade', () => {
    const a = pixels(8, 4, [255, 0, 0, 255]), b = pixels(8, 4, [0, 0, 255, 255]);
    const wipe = transitionRgba(a, b, 8, 4, 'wipeleft', .5);
    expect(at(wipe, 8, 1)).toEqual([255, 0, 0, 255]); expect(at(wipe, 8, 7)).toEqual([0, 0, 255, 255]);
    const slide = transitionRgba(a, b, 8, 4, 'slideup', .5);
    expect(at(slide, 8, 1, 0)).toEqual([255, 0, 0, 255]); expect(at(slide, 8, 1, 3)).toEqual([0, 0, 255, 255]);
    const smooth = transitionRgba(a, b, 8, 4, 'smoothleft', .5);
    expect(at(smooth, 8, 0)[0]).toBe(255); expect(at(smooth, 8, 7)[2]).toBeGreaterThan(240);
    const circle = transitionRgba(a, b, 8, 4, 'circleopen', .5);
    expect(at(circle, 8, 4, 2)).toEqual([0, 0, 255, 255]); expect(at(circle, 8, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('uses the export dip ramp rather than the approximate preview midpoint', () => {
    const a = pixels(8, 4, [255, 0, 0, 255]), b = pixels(8, 4, [0, 0, 255, 255]);
    expect(at(transitionRgba(a, b, 8, 4, 'fadeblack', .5), 8, 3)).toEqual([0, 0, 87, 255]);
    expect(at(transitionRgba(a, b, 8, 4, 'fadewhite', .5), 8, 3)).toEqual([167, 167, 255, 255]);
  });
});

function fakeCanvas(width: number, height: number): BrowserCanvas {
  const context = { resetTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }), createImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) };
  return { width, height, getContext: () => context } as unknown as BrowserCanvas;
}

describe('bounded browser compositor lifetime', () => {
  it('keeps exactly three surfaces and bounded native images, releasing only owned images', async () => {
    const canvasFactory = vi.fn(fakeCanvas), imageCloses = Array.from({ length: 3 }, () => vi.fn());
    let rasterizations = 0;
    const rasterizeSvg = vi.fn(async () => ({ width: 8, height: 4, close: imageCloses[rasterizations++] }) as unknown as ImageBitmap);
    const drawCaptions = vi.fn(), compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas: canvasFactory, rasterizeSvg, overlayCacheSize: 2, drawCaptions });
    const project = fixture({ clips: [clip('native', 'v2', 0, 4, { overlay: { kind: 'arrow', x1: 1, y1: 1, x2: 6, y2: 3, width: 1, color: '#FFFFFF', head: false, drawDuration: 4 } })] });
    const ctx = fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext;
    for (const time of [1, 2, 3, 3]) await compositor.renderFrame(project, BUILTIN_TRANSITIONS, time, new Map(), ctx);
    expect(canvasFactory).toHaveBeenCalledTimes(3); expect(rasterizeSvg).toHaveBeenCalledTimes(3);
    expect(compositor.overlayCacheEntries).toBe(2); expect(imageCloses[0]).toHaveBeenCalledOnce(); expect(drawCaptions).toHaveBeenCalledTimes(4);
    compositor.dispose(); compositor.dispose(); expect(compositor.overlayCacheEntries).toBe(0);
    imageCloses.forEach((close) => expect(close).toHaveBeenCalledOnce());
    await expect(compositor.renderFrame(project, BUILTIN_TRANSITIONS, 1, new Map(), ctx)).rejects.toThrow(/disposed/);
  });

  it('draws a decoded sample with its display dimensions but leaves closing to its caller', async () => {
    const compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas: fakeCanvas });
    const source = { displayWidth: 4, displayHeight: 4, draw: vi.fn(), close: vi.fn() };
    const project = fixture({ clips: [clip('video', 'v1', 0, 10)] });
    await compositor.renderFrame(project, BUILTIN_TRANSITIONS, 2, new Map([['video', source]]), fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext);
    expect(source.draw).toHaveBeenCalledWith(expect.anything(), 2, 0, 4, 4); expect(source.close).not.toHaveBeenCalled();
    compositor.dispose(); expect(source.close).not.toHaveBeenCalled();
  });

  it('rejects simultaneous frame writes and releases an overlay that finishes after disposal', async () => {
    let resolve!: (image: CanvasImageSource) => void;
    const rasterizeSvg = () => new Promise<CanvasImageSource>((r) => { resolve = r; });
    const compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas: fakeCanvas, rasterizeSvg });
    const project = fixture({ clips: [clip('native', 'v1', 0, 4, { overlay: { kind: 'arrow', x1: 1, y1: 1, x2: 6, y2: 3, width: 1, color: '#FFFFFF', head: false } })] });
    const ctx = fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext;
    const pending = compositor.renderFrame(project, BUILTIN_TRANSITIONS, 1, new Map(), ctx);
    await expect(compositor.renderFrame(project, BUILTIN_TRANSITIONS, 2, new Map(), ctx)).rejects.toThrow(/concurrent/);
    const close = vi.fn(); compositor.dispose(); resolve({ width: 8, height: 4, close } as unknown as ImageBitmap);
    await expect(pending).rejects.toThrow(/disposed/); expect(close).toHaveBeenCalledOnce(); expect(compositor.overlayCacheEntries).toBe(0);
  });
});


describe('bounded accelerated body rendering with precise fallback', () => {
  it('switches surfaces for an entrance and plain video without accumulating pools or closing source frames', async () => {
    const hints: boolean[] = [], canvases: BrowserCanvas[] = [];
    const createCanvas = (w: number, h: number) => { const c = fakeCanvas(w, h), get = c.getContext.bind(c); c.getContext = ((_kind: string, options: { willReadFrequently?: boolean }) => { hints.push(!!options?.willReadFrequently); return get('2d'); }) as typeof c.getContext; canvases.push(c); return c; };
    const project = fixture({ media: [{ id: 'video', name: 'video', kind: 'video', src: 'video.mp4', duration: 4, color: '#FFFFFF' }], clips: [clip('video', 'v1', 0, 4)], transitions: [{ id: 'entry', defId: 'fade-to-white', at: 0, duration: 1, anchorClipId: 'video', entrance: true }] });
    const compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas });
    const source = { displayWidth: 8, displayHeight: 4, draw: vi.fn(), close: vi.fn() };
    const context = fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext;
    for (const t of [0, .5, 1, 2, 3]) await compositor.renderFrame(project, BUILTIN_TRANSITIONS, t, new Map([['video', source]]), context);
    expect(hints).toEqual([true, true, true, false, false, false]);
    expect(canvases).toHaveLength(6); expect(source.close).not.toHaveBeenCalled();
    compositor.dispose(); expect(canvases.every(c => c.width === 1 && c.height === 1)).toBe(true);
  });

  it('retains the still website while two other title layers roll', async () => {
    const base = { kind: 'title' as const, fontFamily: 'Arial', fontSize: 2, fontWeight: 400, color: '#FFFFFF', x: 0, y: 0, blockWidth: 8, lineHeight: 3, align: 'left' as const };
    const rasterizeSvg = vi.fn(async () => ({ width: 8, height: 4, close: vi.fn() }) as unknown as ImageBitmap);
    const project = fixture({ clips: [clip('heading', 'v1', 0, 4, { overlay: { ...base, text: 'HEADING', scroll: { fromY: 2, toY: -5, duration: 4 } } }), clip('names', 'v2', 0, 4, { overlay: { ...base, text: 'NAMES', scroll: { fromY: 2, toY: -5, duration: 4 } } }), clip('site', 'v3', 0, 4, { overlay: { ...base, text: 'STATIC' } })] });
    const compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas: fakeCanvas, rasterizeSvg });
    for (const t of [1, 2, 3]) await compositor.renderFrame(project, BUILTIN_TRANSITIONS, t, new Map(), fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext);
    expect(rasterizeSvg.mock.calls.filter(([svg]) => svg.includes('STATIC'))).toHaveLength(1);
    expect(compositor.overlayCacheEntries).toBeLessThanOrEqual(4);
    compositor.dispose();
  });

  it('keeps implicit source fitting on the precise path', async () => {
    const hints: boolean[] = [];
    const createCanvas = (w: number, h: number) => { const c = fakeCanvas(w, h), get = c.getContext.bind(c); c.getContext = ((_kind: string, options: { willReadFrequently?: boolean }) => { hints.push(!!options?.willReadFrequently); return get('2d'); }) as typeof c.getContext; return c; };
    const project = fixture({ media: [{ id: 'video', name: 'video', kind: 'video', src: 'video.mp4', duration: 4, color: '#FFFFFF' }], clips: [clip('video', 'v1', 0, 4)] });
    const compositor = createBrowserCompositor({ width: 8, height: 4, createCanvas });
    const source = { displayWidth: 4, displayHeight: 4, draw: vi.fn() };
    await compositor.renderFrame(project, BUILTIN_TRANSITIONS, 2, new Map([['video', source]]), fakeCanvas(8, 4).getContext('2d') as BrowserCanvasContext);
    expect(hints).toEqual([true, true, true]);
    compositor.dispose();
  });
});
