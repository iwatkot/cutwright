import { describe, expect, it } from 'vitest';
import { defaultCanvasSettings, resolveGuideDrag } from '../src/lib/canvasGeometry';
import type { CanvasSettings } from '../src/lib/types';

const grid = (): CanvasSettings['grid'] => ({ visible: false, snap: false, spacingX: 25, spacingY: 60, originX: 7.5, originY: -10 });

describe('guide pointer resolution', () => {
  it('uses whole pixels without Shift, independently of grid origin and interval', () => {
    expect(resolveGuideDrag(175.4, 'x', 320, grid(), false)).toEqual({ position: 175, outside: false });
    expect(resolveGuideDrag(175.5, 'y', 640, grid(), false)).toEqual({ position: 176, outside: false });
  });

  it('uses the matching axis interval and nonzero or negative origin with Shift', () => {
    expect(resolveGuideDrag(41, 'x', 320, grid(), true)).toEqual({ position: 32.5, outside: false });
    expect(resolveGuideDrag(41, 'y', 640, grid(), true)).toEqual({ position: 50, outside: false });
    expect(resolveGuideDrag(171, 'x', 320, grid(), true)).toEqual({ position: 182.5, outside: false });
    expect(resolveGuideDrag(171, 'y', 640, grid(), true)).toEqual({ position: 170, outside: false });
  });

  it('chooses the lower grid coordinate at exact half intervals', () => {
    expect(resolveGuideDrag(45, 'x', 320, grid(), true)).toEqual({ position: 32.5, outside: false });
    expect(resolveGuideDrag(80, 'y', 640, grid(), true)).toEqual({ position: 50, outside: false });
    expect(resolveGuideDrag(150, 'x', 320, defaultCanvasSettings().grid, true)).toEqual({ position: 100, outside: false });
    expect(resolveGuideDrag(150 + .001, 'x', 320, defaultCanvasSettings().grid, true)).toEqual({ position: 200, outside: false });
  });

  it('stabilizes fractional intervals and decimal half ties', () => {
    const fractional = { ...grid(), spacingX: .1, originX: .2, spacingY: .25, originY: -.125 };
    expect(resolveGuideDrag(.35, 'x', 320, fractional, true)).toEqual({ position: .3, outside: false });
    expect(resolveGuideDrag(.31, 'x', 320, fractional, true)).toEqual({ position: .3, outside: false });
    expect(resolveGuideDrag(.5, 'y', 640, fractional, true)).toEqual({ position: .375, outside: false });
    const tiny = { ...fractional, spacingX: 1e-10, originX: 0 };
    expect(resolveGuideDrag(3.1e-10, 'x', 320, tiny, true).position).toBe(3e-10);
  });

  it('uses Shift intervals while the grid is hidden and every snap setting is disabled', () => {
    const config = { ...defaultCanvasSettings(), snap: false, guidesVisible: false, grid: grid() };
    expect(config.grid.visible).toBe(false);
    expect(config.grid.snap).toBe(false);
    expect(resolveGuideDrag(83, 'x', 320, config.grid, true)).toEqual({ position: 82.5, outside: false });
    expect(resolveGuideDrag(83, 'x', 320, config.grid, false)).toEqual({ position: 83, outside: false });
  });

  it('defaults to100 pixel intervals and zero origin for missing or invalid grid values', () => {
    expect(resolveGuideDrag(151, 'x', 320, defaultCanvasSettings().grid, true)).toEqual({ position: 200, outside: false });
    for (const missing of [undefined, null, {}]) {
      expect(resolveGuideDrag(149, 'x', 320, missing as CanvasSettings['grid'], true)).toEqual({ position: 100, outside: false });
    }
    for (const invalid of [0, -5, NaN, Infinity]) {
      const settings = { ...grid(), spacingX: invalid, spacingY: invalid, originX: NaN, originY: Infinity };
      expect(resolveGuideDrag(151, 'x', 320, settings, true)).toEqual({ position: 200, outside: false });
      expect(resolveGuideDrag(149, 'y', 640, settings, true)).toEqual({ position: 100, outside: false });
    }
  });

  it('keeps exact frame edges inside and clamps the final rounded or snapped position', () => {
    const settings = defaultCanvasSettings().grid;
    expect(resolveGuideDrag(0, 'x', 320, settings, false)).toEqual({ position: 0, outside: false });
    expect(resolveGuideDrag(320, 'x', 320, settings, false)).toEqual({ position: 320, outside: false });
    expect(resolveGuideDrag(0, 'y', 640, settings, true)).toEqual({ position: 0, outside: false });
    expect(resolveGuideDrag(640, 'y', 640, settings, true)).toEqual({ position: 600, outside: false });
    expect(resolveGuideDrag(179.8, 'x', 179.8, settings, false)).toEqual({ position: 179.8, outside: false });
    expect(resolveGuideDrag(179.8, 'x', 179.8, settings, true)).toEqual({ position: 179.8, outside: false });
    expect(resolveGuideDrag(0, 'x', 320, { ...settings, spacingX: 100, originX: -10 }, true)).toEqual({ position: 0, outside: false });
  });

  it.each([false, true])('marks raw positions outside by epsilon for removal even when snapping returns inside (Shift=%s)', (shift) => {
    const settings = defaultCanvasSettings().grid;
    expect(resolveGuideDrag(-1e-9, 'x', 320, settings, shift)).toEqual({ position: 0, outside: true });
    const result = resolveGuideDrag(320 + 1e-9, 'x', 320, settings, shift);
    expect(result).toEqual({ position: shift ? 300 : 320, outside: true });
    expect(resolveGuideDrag(1e-9, 'y', 640, settings, shift).outside).toBe(false);
    expect(resolveGuideDrag(640 - 1e-9, 'y', 640, settings, shift).outside).toBe(false);
  });

  it('produces bounded finite positions for invalid extents and nonfinite pointers', () => {
    for (const extent of [0, -1, NaN, Infinity]) {
      expect(resolveGuideDrag(12, 'x', extent, grid(), true)).toEqual({ position: 0, outside: true });
      expect(resolveGuideDrag(0, 'x', extent, grid(), false)).toEqual({ position: 0, outside: false });
    }
    for (const shift of [false, true]) {
      expect(resolveGuideDrag(Infinity, 'x', 320, grid(), shift)).toEqual({ position: 0, outside: true });
      expect(resolveGuideDrag(-Infinity, 'y', 640, grid(), shift)).toEqual({ position: 0, outside: true });
      expect(resolveGuideDrag(NaN, 'x', 320, grid(), shift)).toEqual({ position: 0, outside: false });
    }
  });

  it('does not mutate a frozen grid across ordinary and Shift resolutions', () => {
    const settings = Object.freeze(grid()), before = JSON.stringify(settings);
    resolveGuideDrag(123, 'x', 320, settings, true);
    resolveGuideDrag(-10, 'y', 640, settings, false);
    expect(JSON.stringify(settings)).toBe(before);
  });
});
