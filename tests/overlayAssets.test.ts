import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOverlayAssets, overlayPreviewTime, saveOverlayAsset, scaleOverlay } from '../src/lib/overlayAssets';
import { overlayFrame, validateOverlay } from '../src/lib/overlay';
import type { ArrowOverlay, TitleOverlay } from '../src/lib/types';
import { setLocale } from '../src/i18n/core';

const canvas = { width: 1920, height: 1080 };
const arrow: ArrowOverlay = { kind: 'arrow', x1: 300, y1: 600, x2: 1200, y2: 200, width: 20, color: '#D44B47', head: true, drawDuration: .5, animationDuration: 3, animationOffset: -1.755 };
const credits: TitleOverlay = { kind: 'title', text: 'First name\nSecond name\nLast name', fontFamily: 'Cygre Black', fontSize: 40, fontWeight: 400, color: '#FFFFFF', x: 100, y: 160, blockWidth: 800, lineHeight: 50, align: 'center', scroll: { fromY: 1080, toY: -2000, duration: 9 }, animationDuration: 9 };
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});
afterEach(() => { setLocale('en'); vi.unstubAllGlobals(); });

describe('reusable native overlay assets', () => {
  it('retains contrast styling in saved assets and scales its project-pixel width with typography', () => {
    const styled = { ...credits, outlineWidth: 3, outlineColor: '#142332' };
    expect(saveOverlayAsset('Outlined credits', styled, canvas)).toBe(true);
    const saved = loadOverlayAssets()[0];
    expect(saved.overlay).toEqual(styled);
    expect(scaleOverlay(saved.overlay, canvas, { width: 960, height: 540 })).toMatchObject({ outlineWidth: 1.5, outlineColor: '#142332' });
  });
  it('names new unnamed assets in the current language without renaming saved or authored names', () => {
    setLocale('de');
    expect(saveOverlayAsset('', arrow, canvas)).toBe(true);
    expect(saveOverlayAsset('   ', arrow, canvas)).toBe(true);
    expect(saveOverlayAsset('Arrow', arrow, canvas)).toBe(true);
    setLocale('cs');
    expect(loadOverlayAssets().map(asset => asset.name)).toEqual(['Pfeil', 'Pfeil (2)', 'Arrow']);
    expect(saveOverlayAsset('', arrow, canvas)).toBe(true);
    expect(loadOverlayAssets().map(asset => asset.name)).toEqual(['Pfeil', 'Pfeil (2)', 'Arrow', 'Šipka']);
  });
  it('preserves different same-name arrows and updates only an explicit asset id', () => {
    expect(saveOverlayAsset('ArrowShaped4', arrow, canvas)).toBe(true);
    expect(saveOverlayAsset('ArrowShaped4', { ...arrow, x2: 1500 }, canvas)).toBe(true);
    let saved = loadOverlayAssets();
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map((a) => a.id)).size).toBe(2);
    expect(saved.map((a) => a.name)).toEqual(['ArrowShaped4', 'ArrowShaped4 (2)']);
    expect(saved[0].overlay).toEqual(arrow);
    const firstId = saved[0].id;
    expect(saveOverlayAsset('Edited arrow', { ...arrow, x1: 200 }, canvas, firstId)).toBe(true);
    saved = loadOverlayAssets();
    expect(saved).toHaveLength(2);
    expect(saved.find((a) => a.id === firstId)?.name).toBe('Edited arrow');
    expect(saved.find((a) => a.name === 'ArrowShaped4 (2)')?.overlay).toMatchObject({ x2: 1500 });
  });

  it('persists source dimensions and migrates a legacy 1080p asset without dropping it', () => {
    storage.set('cutwright.overlayAssets', JSON.stringify([{ id: 'legacy', name: 'Old arrow', overlay: arrow }]));
    expect(loadOverlayAssets()[0]).toMatchObject({ id: 'legacy', width: 1920, height: 1080 });
    expect(saveOverlayAsset('4K title', credits, { width: 3840, height: 2160 })).toBe(true);
    expect(loadOverlayAssets().find((a) => a.name === '4K title')).toMatchObject({ width: 3840, height: 2160 });
    expect(saveOverlayAsset('Broken', arrow, { width: 0, height: 1080 })).toBe(false);
    expect(loadOverlayAssets()).toHaveLength(2);
  });

  it('scales arrow geometry and title/scroll metrics into a lower-resolution canvas without mutating the template', () => {
    const from = { width: 3840, height: 2160 }, to = { width: 1280, height: 720 };
    const smallerArrow = scaleOverlay(arrow, from, to);
    expect(smallerArrow).toMatchObject({ x1: 100, y1: 200, x2: 400, animationOffset: -1.755, drawDuration: .5 });
    if (smallerArrow.kind !== 'arrow') throw new Error('Expected arrow');
    expect(smallerArrow.width).toBeCloseTo(20 / 3);
    const smallerCredits = scaleOverlay(credits, from, to);
    expect(smallerCredits.kind).toBe('title');
    if (smallerCredits.kind !== 'title') throw new Error('Expected title');
    expect(smallerCredits.fontSize).toBeCloseTo(40 / 3);
    expect(smallerCredits.lineHeight).toBeCloseTo(50 / 3);
    expect(smallerCredits.scroll).toMatchObject({ fromY: 360, duration: 9 });
    expect(smallerCredits.scroll?.toY).toBeCloseTo(-2000 / 3);
    expect(validateOverlay(smallerCredits)).toEqual([]);
    smallerCredits.scroll!.fromY = 999;
    expect(credits.scroll?.fromY).toBe(1080);
    expect(arrow.x1).toBe(300);
  });

  it('fits a landscape overlay into a portrait canvas without stretching text', () => {
    const fitted = scaleOverlay(credits, canvas, { width: 1080, height: 1920 });
    if (fitted.kind !== 'title') throw new Error('Expected title');
    const factor = 1080 / 1920;
    const padY = (1920 - 1080 * factor) / 2;
    expect(fitted.x).toBeCloseTo(credits.x * factor);
    expect(fitted.y).toBeCloseTo(credits.y * factor + padY);
    expect(fitted.fontSize).toBeCloseTo(credits.fontSize * factor);
    expect(fitted.blockWidth).toBeCloseTo(credits.blockWidth * factor);
  });

  it('samples a visible arrow after negative preset pre-roll and centers a moving credit heading', () => {
    const at = overlayPreviewTime(arrow, canvas);
    expect(at).toBeGreaterThan(1.755);
    expect(overlayFrame(arrow, at)).toMatchObject({ opacity: 1, drawProgress: 1 });
    const heading = { ...credits, text: 'Thanks to supporters', y: 86 };
    const frame = overlayFrame(heading, overlayPreviewTime(heading, canvas));
    expect(frame.opacity).toBe(1);
    expect(heading.y + heading.lineHeight / 2 + frame.scrollY).toBeCloseTo(canvas.height / 2);
  });

  it('keeps tiny source typography and strokes valid after a resolution reduction', () => {
    const target = { width: 960, height: 540 };
    expect(validateOverlay(scaleOverlay({ ...credits, fontSize: 1, lineHeight: 1 }, canvas, target))).toEqual([]);
    expect(validateOverlay(scaleOverlay({ ...arrow, width: .1 }, canvas, target))).toEqual([]);
  });
});
