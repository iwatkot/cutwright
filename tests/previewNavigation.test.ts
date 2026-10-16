import { describe, expect, it } from 'vitest';
import {
  clampPreviewView, FIT_PREVIEW, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM, zoomPreviewAt,
  type PreviewArea, type PreviewView,
} from '../src/lib/previewNavigation';

// Independent screen/content coordinate model. The helpers under test do not
// provide either transform, so anchor tests compare actual geometric meaning.
const contentAt = (screen: { x: number; y: number }, view: PreviewView) => ({
  x: (screen.x - view.x) / view.zoom,
  y: (screen.y - view.y) / view.zoom,
});
const screenAt = (point: { x: number; y: number }, view: PreviewView) => ({
  x: point.x * view.zoom + view.x,
  y: point.y * view.zoom + view.y,
});
const expectPoint = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};
const areas: (PreviewArea & { name: string })[] = [
  { name: 'landscape', width: 800, height: 480, fitWidth: 800, fitHeight: 450 },
  { name: 'portrait', width: 600, height: 480, fitWidth: 270, fitHeight: 480 },
  { name: 'small portrait', width: 280, height: 220, fitWidth: 123.75, fitHeight: 220 },
];

// Intersect physical screen rectangles instead of reproducing the clamp formula.
const visibleFrame = (view: PreviewView, area: PreviewArea) => {
  const frameWidth = area.fitWidth * view.zoom, frameHeight = area.fitHeight * view.zoom;
  const left = area.width / 2 + view.x - frameWidth / 2;
  const top = area.height / 2 + view.y - frameHeight / 2;
  return {
    width: Math.max(0, Math.min(area.width, left + frameWidth) - Math.max(0, left)),
    height: Math.max(0, Math.min(area.height, top + frameHeight) - Math.max(0, top)),
    frameWidth, frameHeight,
  };
};

describe('preview zoom anchored in screen pixels', () => {
  it.each(areas)('keeps the same content point under an off-center cursor in $name', area => {
    for (const start of [{ zoom: .5, x: 10, y: -12 }, { zoom: 1, x: 0, y: 0 }, { zoom: 2, x: -15, y: 18 }]) {
      for (const anchor of [{ x: -35, y: 21 }, { x: 0, y: 0 }, { x: 27, y: -32 }]) {
        const point = contentAt(anchor, start);
        const next = zoomPreviewAt(start, start.zoom * 1.5, anchor, area);
        expectPoint(contentAt(anchor, next), point);
        expectPoint(screenAt(point, next), anchor);
        expect(next.zoom).toBe(start.zoom * 1.5);
      }
    }
  });

  it.each(areas)('inverts a zoom gesture exactly without accumulating pan in $name', area => {
    const original = { zoom: 1.5, x: 20, y: -18 }, anchor = { x: -55, y: 36 };
    let view = { ...original };
    for (let n = 0; n < 100; n++) {
      const enlarged = zoomPreviewAt(view, 2.5, anchor, area);
      const returned = zoomPreviewAt(enlarged, original.zoom, anchor, area);
      expectPoint(contentAt(anchor, enlarged), contentAt(anchor, original));
      expectPoint(returned, original);
      view = returned;
    }
    expect(view.zoom).toBe(original.zoom);
  });

  it('uses the clamped zoom ratio when a gesture crosses a limit', () => {
    const area = areas[0], anchor = { x: 24, y: -17 };
    for (const [start, request, expectedZoom] of [
      [{ zoom: 6, x: 32, y: -20 }, 800, MAX_PREVIEW_ZOOM],
      [{ zoom: .5, x: -12, y: 14 }, .001, MIN_PREVIEW_ZOOM],
    ] as const) {
      const next = zoomPreviewAt(start, request, anchor, area);
      expect(next.zoom).toBe(expectedZoom);
      expectPoint(contentAt(anchor, next), contentAt(anchor, start));
    }
  });

  it.each([MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM])('repeated wheel gestures at limit %s never drift the anchor', zoom => {
    const area = areas[1], original = { zoom, x: 40, y: -70 };
    let view = { ...original };
    for (let n = 0; n < 100; n++) {
      const anchor = { x: Math.sin(n) * 95, y: Math.cos(n) * 130 };
      const point = contentAt(anchor, view);
      view = zoomPreviewAt(view, zoom === MAX_PREVIEW_ZOOM ? zoom * 1.5 : zoom / 1.5, anchor, area);
      expect(view.zoom).toBe(original.zoom);
      expectPoint(view, original);
      expectPoint(contentAt(anchor, view), point);
    }
  });
});

describe('reachable preview pan bounds', () => {
  it.each(areas)('keeps a reachable frame area after extreme panning in $name', area => {
    for (const zoom of [MIN_PREVIEW_ZOOM, .75, 1, MAX_PREVIEW_ZOOM]) {
      for (const x of [-1e9, 1e9]) for (const y of [-1e9, 1e9]) {
        const view = clampPreviewView({ zoom, x, y }, area), visible = visibleFrame(view, area);
        expect(visible.width).toBeGreaterThanOrEqual(Math.min(64, visible.frameWidth / 2) - 1e-8);
        expect(visible.height).toBeGreaterThanOrEqual(Math.min(64, visible.frameHeight / 2) - 1e-8);
        expect(Math.sign(view.x)).toBe(Math.sign(x));
        expect(Math.sign(view.y)).toBe(Math.sign(y));
        expect(view.zoom).toBe(zoom);
        expect(clampPreviewView(view, area)).toEqual(view);
      }
    }
  });

  it('reclamps an existing zoom and pan after a smaller viewport while keeping the frame reachable', () => {
    const large = areas[0], small = areas[2];
    const original = clampPreviewView({ zoom: 4, x: 1e6, y: -1e6 }, large);
    const resized = clampPreviewView(original, small), visible = visibleFrame(resized, small);
    expect(resized.zoom).toBe(original.zoom);
    expect(Math.abs(resized.x)).toBeLessThan(Math.abs(original.x));
    expect(Math.abs(resized.y)).toBeLessThan(Math.abs(original.y));
    expect(visible.width).toBeGreaterThanOrEqual(64 - 1e-8);
    expect(visible.height).toBeGreaterThanOrEqual(64 - 1e-8);
  });

  it('prioritizes a reachable frame when preserving an extreme cursor point would move it offscreen', () => {
    const area = areas[2], original = { zoom: 1, x: 0, y: 0 }, anchor = { x: 1e6, y: -1e6 };
    const next = zoomPreviewAt(original, MAX_PREVIEW_ZOOM, anchor, area), visible = visibleFrame(next, area);
    expect(visible.width).toBeGreaterThanOrEqual(64 - 1e-8);
    expect(visible.height).toBeGreaterThanOrEqual(64 - 1e-8);
    expect(contentAt(anchor, next).x).not.toBeCloseTo(contentAt(anchor, original).x, 4);
    expect(clampPreviewView(next, area)).toEqual(next);
  });

  it('clamps only excessive zoom and leaves valid views intact without mutating inputs', () => {
    const area = Object.freeze({ ...areas[0] });
    const original = Object.freeze({ zoom: 2, x: 35, y: -28 });
    const snapshot = JSON.stringify({ area, original, fit: FIT_PREVIEW });
    expect(clampPreviewView(original, area)).toEqual(original);
    expect(clampPreviewView({ ...original, zoom: -1 }, area).zoom).toBe(MIN_PREVIEW_ZOOM);
    expect(clampPreviewView({ ...original, zoom: 100 }, area).zoom).toBe(MAX_PREVIEW_ZOOM);
    zoomPreviewAt(original, 3, { x: 50, y: 25 }, area);
    expect(JSON.stringify({ area, original, fit: FIT_PREVIEW })).toBe(snapshot);
  });
});
