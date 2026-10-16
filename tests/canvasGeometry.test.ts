import { describe, expect, it } from 'vitest';
import { defaultCanvasSettings, resizeProject, snapCanvasPoint, snapTimelineTime } from '../src/lib/canvasGeometry';
import type { ArrowOverlay, Project, TitleOverlay } from '../src/lib/types';
import { validateProject } from '../src/lib/validate';
import { exportDimensions } from '../src/lib/outputDimensions';

const title = (): TitleOverlay => ({ kind: 'title', text: 'Portrait title', fontFamily: 'Arial', fontSize: 64,
  fontWeight: 700, color: '#ffffff', x: 480, y: 270, blockWidth: 960, lineHeight: 80, align: 'left',
  animationDuration: 5, scroll: { fromY: 1080, toY: -300, duration: 5 } });
const arrow = (): ArrowOverlay => ({ kind: 'arrow', x1: 192, y1: 108, x2: 1536, y2: 864,
  width: 20, color: '#ff0000', head: true, drawDuration: 2 });
const fixture = (): Project => ({ version: 1, name: 'Canvas geometry', width: 1920, height: 1080, fps: 30,
  media: [
    { id: 'title-media', name: 'Title', kind: 'image', src: 'original-title.png', duration: 5, color: '#111111', width: 1920, height: 1080, overlay: title() },
    { id: 'photo', name: 'Source photo', kind: 'image', src: 'original-photo.png', duration: 5, color: '#222222', width: 800, height: 600 },
  ],
  clips: [
    { id: 'title', name: 'Title override', mediaId: 'title-media', trackId: 'v2', start: 0, offset: 0, duration: 5, color: '#111111', overlay: title() },
    { id: 'arrow', name: 'Arrow', mediaId: 'title-media', trackId: 'v3', start: 0, offset: 0, duration: 5, color: '#111111', overlay: arrow() },
    { id: 'photo', name: 'Photo transform', mediaId: 'photo', trackId: 'v1', start: 0, offset: 0, duration: 5, color: '#222222', posX: 12, posY: -8, scale: 1.4, rotate: 15 },
  ], transitions: [], subtitles: [], customTransitions: [],
  markers: [{ id: 'beat', time: 2, label: 'Beat', color: '#ff0000' }],
  editorCanvas: { ...defaultCanvasSettings(), guides: [{ id: 'left', axis: 'x', position: 480 }, { id: 'top', axis: 'y', position: 270 }],
    grid: { visible: true, snap: true, spacingX: 160, spacingY: 90, originX: -16, originY: 9 } },
});

describe('canvas snapping in project pixels', () => {
  it('creates independent defaults that serialize without sharing nested state', () => {
    const first = defaultCanvasSettings(), second = defaultCanvasSettings();
    first.grid.spacingX = 25;
    first.guides.push({ id: 'guide', axis: 'x', position: 32 });
    expect(second.grid.spacingX).toBe(100);
    expect(second.guides).toEqual([]);
    const restored = JSON.parse(JSON.stringify(first));
    restored.guides[0].position = 64;
    expect(first.guides[0].position).toBe(32);
  });

  it('snaps portrait frame edges and centers exactly within the project-pixel tolerance', () => {
    const settings = defaultCanvasSettings();
    expect(snapCanvasPoint(538.25, 1917, 1080, 1920, settings, 3)).toEqual({ x: 540, y: 1920, snappedX: 540, snappedY: 1920 });
    expect(snapCanvasPoint(3, 963.01, 1080, 1920, settings, 3)).toEqual({ x: 0, y: 963.01, snappedX: 0 });
    expect(snapCanvasPoint(540, 960, 1080, 1920, settings, 0)).toEqual({ x: 540, y: 960, snappedX: 540, snappedY: 960 });
  });

  it('uses the nearest guide and resolves equal distances independently of guide order', () => {
    const settings = defaultCanvasSettings();
    settings.guides = [{ id: 'high', axis: 'x', position: 130 }, { id: 'low', axis: 'x', position: 110 }, { id: 'y', axis: 'y', position: 200.25 }];
    expect(snapCanvasPoint(120, 201, 1920, 1080, settings, 10)).toEqual({ x: 110, y: 200.25, snappedX: 110, snappedY: 200.25 });
    settings.guides.reverse();
    settings.guidesLocked = true;
    expect(snapCanvasPoint(120, 201, 1920, 1080, settings, 10).x).toBe(110);
    settings.guidesVisible = false;
    expect(snapCanvasPoint(120, 201, 1920, 1080, settings, 10)).toEqual({ x: 120, y: 201 });
  });

  it('uses each grid spacing and origin, even when presentation is hidden', () => {
    const settings = defaultCanvasSettings();
    settings.grid = { visible: false, snap: true, spacingX: 25, spacingY: 40, originX: 7.5, originY: -5 };
    expect(snapCanvasPoint(33.2, 34, 1920, 1080, settings, 2)).toEqual({ x: 32.5, y: 35, snappedX: 32.5, snappedY: 35 });
    expect(snapCanvasPoint(20, 15, 1920, 1080, settings, 20)).toEqual({ x: 7.5, y: 0, snappedX: 7.5, snappedY: 0 });
    settings.grid.snap = false;
    expect(snapCanvasPoint(33.2, 34, 1920, 1080, settings, 2)).toEqual({ x: 33.2, y: 34 });
  });

  it('honors the master switch and ignores invalid snap tolerances', () => {
    const settings = defaultCanvasSettings();
    settings.grid.snap = true;
    settings.snap = false;
    expect(snapCanvasPoint(1, 2, 1920, 1080, settings, 20)).toEqual({ x: 1, y: 2 });
    settings.snap = true;
    for (const tolerance of [-1, NaN, Infinity]) expect(snapCanvasPoint(1, 2, 1920, 1080, settings, tolerance)).toEqual({ x: 1, y: 2 });
  });

  it('snaps timeline movement, trim and scrub times to the nearest valid target', () => {
    expect(snapTimelineTime(4.94, [5, 4.9, 0, NaN, Infinity, -1], .1)).toBe(4.9);
    expect(snapTimelineTime(5, [6, 4], 1)).toBe(4);
    expect(snapTimelineTime(5, [4, 6], 1)).toBe(4);
    expect(snapTimelineTime(1 / 3 + .001, [1 / 3], .002)).toBe(1 / 3);
    expect(snapTimelineTime(4.89, [5], .1)).toBe(4.89);
    expect(snapTimelineTime(0, [0], 0)).toBe(0);
    expect(snapTimelineTime(1, [1], -1)).toBe(1);
  });
});

describe('project resolution geometry', () => {
  it('preserves normalized title and arrow positions when switching to portrait', () => {
    const original = fixture(), snapshot = JSON.stringify(original);
    const result = resizeProject(original, 1080, 1920);
    const resizedTitle = result.clips[0].overlay as TitleOverlay;
    const resizedArrow = result.clips[1].overlay as ArrowOverlay;
    expect([result.width, result.height]).toEqual([1080, 1920]);
    expect([resizedTitle.x / result.width, resizedTitle.y / result.height]).toEqual([.25, .25]);
    expect([resizedArrow.x1 / result.width, resizedArrow.y1 / result.height, resizedArrow.x2 / result.width, resizedArrow.y2 / result.height]).toEqual([.1, .1, .8, .8]);
    expect([resizedTitle.fontSize, resizedTitle.lineHeight, resizedTitle.blockWidth, resizedArrow.width]).toEqual([64, 80, 540, 20]);
    expect(resizedTitle.scroll?.fromY).toBe(1920);
    expect(resizedTitle.scroll?.toY).toBeCloseTo(-300 * 1920 / 1080);
    expect(resizedTitle.scroll?.duration).toBe(5);
    expect(resizedArrow.drawDuration).toBe(2);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(validateProject(result).errors).toEqual([]);
  });

  it('scales templates and clip overrides independently while retaining source paths and percent transforms', () => {
    const original = fixture();
    const result = resizeProject(original, 960, 540);
    expect(result.media[0]).toMatchObject({ width: 960, height: 540, src: 'original-title.png', overlay: { x: 240, y: 135, fontSize: 32 } });
    expect(result.media[1]).toEqual(original.media[1]);
    expect(result.clips[2]).toEqual(original.clips[2]);
    const mediaTitle = result.media[0].overlay as TitleOverlay;
    mediaTitle.scroll!.fromY = 1;
    expect((result.clips[0].overlay as TitleOverlay).scroll!.fromY).toBe(540);
    expect((original.media[0].overlay as TitleOverlay).scroll!.fromY).toBe(1080);
  });

  it.each(['center', 'right'] as const)('preserves the normalized %s title anchor from portrait to landscape', (align) => {
    const original = { ...fixture(), width: 180, height: 320 };
    const previous: TitleOverlay = { ...title(), align, x: 45, y: 80, blockWidth: 90, fontSize: 20, lineHeight: 24 };
    original.clips[0].overlay = previous;
    const resized = resizeProject(original, 320, 180);
    const next = resized.clips[0].overlay as TitleOverlay;
    const anchor = align === 'center' ? .5 : 1;
    expect((next.x + next.blockWidth * anchor) / resized.width).toBeCloseTo((previous.x + previous.blockWidth * anchor) / original.width, 12);
    expect(next.blockWidth).toBe(160);
    expect(next.fontSize).toBe(20);
    expect(next.lineHeight).toBe(24);
  });

  it('restores unclamped overlay sizes and geometry after repeated aspect-ratio round trips', () => {
    const original = fixture(), snapshot = JSON.stringify(original);
    // Axis ratios can leave sub-picopixel IEEE-754 residue in scroll offsets.
    const geometrySnapshot = (project: Project) => JSON.parse(JSON.stringify(project, (_key, value) => typeof value === 'number' ? Number(value.toFixed(10)) : value));
    let resized = original;
    for (const [width, height] of [[1080, 1920], [1080, 1080], [1920, 1080], [1080, 1920], [1920, 1080]]) {
      resized = resizeProject(resized, width, height);
      const currentTitle = resized.clips[0].overlay as TitleOverlay;
      const currentArrow = resized.clips[1].overlay as ArrowOverlay;
      expect(currentTitle.fontSize).toBe(64);
      expect(currentTitle.lineHeight).toBe(80);
      expect(currentArrow.width).toBe(20);
    }
    expect(geometrySnapshot(resized)).toEqual(original);
    expect(JSON.stringify(original)).toBe(snapshot);
    const smaller = resizeProject(original, 540, 960);
    expect((smaller.clips[0].overlay as TitleOverlay).fontSize).toBe(32);
    expect((smaller.clips[0].overlay as TitleOverlay).lineHeight).toBe(40);
    expect((smaller.clips[1].overlay as ArrowOverlay).width).toBe(10);
    expect(geometrySnapshot(resizeProject(smaller, 1920, 1080))).toEqual(original);
  });

  it('scales and serializes guides, grid and origins while leaving timeline times intact', () => {
    const original = fixture();
    const resized = resizeProject(original, 1080, 1920);
    const restored = JSON.parse(JSON.stringify(resized)) as Project;
    expect(restored.editorCanvas?.guides).toEqual([{ id: 'left', axis: 'x', position: 270 }, { id: 'top', axis: 'y', position: 480 }]);
    expect(restored.editorCanvas?.grid).toEqual({ visible: true, snap: true, spacingX: 90, spacingY: 160, originX: -9, originY: 16 });
    expect(restored.markers).toEqual(original.markers);
    expect(restored.clips.map(({ start, duration, offset }) => [start, duration, offset])).toEqual(original.clips.map(({ start, duration, offset }) => [start, duration, offset]));
    expect(original.editorCanvas!.guides[0].position).toBe(480);
    expect(restored.editorCanvas).not.toBe(original.editorCanvas);
    expect(validateProject(restored).ok).toBe(true);
  });

  it('keeps legacy projects optional, supports odd custom dimensions and treats unchanged resolution as a no-op', () => {
    const original = fixture();
    delete original.editorCanvas;
    expect(resizeProject(original, original.width, original.height)).toBe(original);
    const resized = resizeProject(original, 721, 1281);
    expect([resized.width, resized.height]).toEqual([721, 1281]);
    expect(resized).not.toHaveProperty('editorCanvas');
    expect(validateProject(resized).ok).toBe(true);
    for (const dimensions of [[1, 1080], [1920, 16385], [1920.5, 1080], [NaN, 1080], [1920, Infinity]]) {
      expect(() => resizeProject(original, dimensions[0], dimensions[1])).toThrow(RangeError);
    }
  });

  it('retains validated bounds after extreme size changes', () => {
    let original = resizeProject(fixture(), 2, 2);
    original = {
      ...original,
      editorCanvas: { ...defaultCanvasSettings(), guides: [{ id: 'outside', axis: 'x', position: 32768 }],
        grid: { visible: true, snap: true, spacingX: 16384, spacingY: 1, originX: -16384, originY: 16384 } },
    };
    const resized = resizeProject(original, 16384, 16384);
    expect(validateProject(resized).errors).toEqual([]);
    expect(resized.editorCanvas?.guides[0].position).toBe(32768);
    expect(resized.editorCanvas?.grid).toMatchObject({ spacingX: 16384, originX: -16384, originY: 16384 });
  });
});

describe('shared browser and desktop output dimensions', () => {
  it('fits landscape, portrait and square presets against the shorter edge', () => {
    expect(exportDimensions({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(exportDimensions({ width: 1080, height: 1920 }, 720)).toEqual({ width: 720, height: 1280 });
    expect(exportDimensions({ width: 1080, height: 1080 }, 720)).toEqual({ width: 720, height: 720 });
    expect(exportDimensions({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
  });

  it('never enlarges a smaller source for a preset and normalizes legacy odd dimensions consistently', () => {
    expect(exportDimensions({ width: 640, height: 360 }, 1080)).toEqual({ width: 640, height: 360 });
    expect(exportDimensions({ width: 360, height: 640 }, 1080)).toEqual({ width: 360, height: 640 });
    expect(exportDimensions({ width: 721, height: 1281 })).toEqual({ width: 722, height: 1282 });
    expect(exportDimensions({ width: 721, height: 1281 }, 480)).toEqual({ width: 480, height: 852 });
    expect(exportDimensions({ width: 2, height: 16384 }, 480)).toEqual({ width: 2, height: 16384 });
  });

  it('rejects invalid geometry and preset sizes without silently encoding a different project', () => {
    for (const project of [{ width: 0, height: 1080 }, { width: NaN, height: 1080 }, { width: 1080, height: Infinity }]) {
      expect(() => exportDimensions(project)).toThrow(RangeError);
    }
    for (const size of [0, 1, -480, NaN, Infinity]) expect(() => exportDimensions({ width: 1080, height: 1920 }, size)).toThrow(RangeError);
  });
});
