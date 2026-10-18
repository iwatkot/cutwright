import type { CanvasSettings, NativeOverlay, Project } from './types';

/** Every project owns its mutable editor settings, including the nested grid. */
export function defaultCanvasSettings(): CanvasSettings {
  return {
    rulers: true,
    guidesVisible: true,
    guidesLocked: false,
    snap: true,
    grid: { visible: false, snap: false, spacingX: 100, spacingY: 100, originX: 0, originY: 0 },
    guides: [],
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Ties choose the lower coordinate, independently of target ordering. */
function nearest(value: number, points: readonly number[], tolerance: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isFinite(tolerance) || tolerance < 0) return undefined;
  let target: number | undefined;
  let distance = Infinity;
  for (const point of points) {
    if (!Number.isFinite(point)) continue;
    const delta = Math.abs(value - point);
    if (delta > tolerance) continue;
    const epsilon = Number.EPSILON * 8 * Math.max(1, Math.abs(value), Math.abs(point), distance === Infinity ? 0 : distance);
    if (target === undefined || delta < distance - epsilon || (Math.abs(delta - distance) <= epsilon && point < target)) {
      target = point;
      distance = delta;
    }
  }
  return target;
}

/** A guide follows whole project pixels, or grid intervals while Shift is
 * held. Removal follows the raw pointer, independently of the snapped/clamped
 * position, so snapping cannot pull an outside gesture back into the frame. */
export function resolveGuideDrag(
  raw: number,
  axis: 'x' | 'y',
  extent: number,
  grid: CanvasSettings['grid'],
  shift: boolean,
): { position: number; outside: boolean } {
  const limit = Number.isFinite(extent) && extent > 0 ? extent : 0;
  const outside = raw < 0 || raw > limit;
  if (!Number.isFinite(raw)) return { position: 0, outside };
  const value = raw;
  let position = Math.round(value);
  if (shift) {
    const configuredSpacing = axis === 'x' ? grid?.spacingX : grid?.spacingY;
    const configuredOrigin = axis === 'x' ? grid?.originX : grid?.originY;
    const spacing = Number.isFinite(configuredSpacing) && configuredSpacing > 0 ? configuredSpacing : 100;
    const origin = Number.isFinite(configuredOrigin) ? configuredOrigin : 0;
    const cell = (value - origin) / spacing;
    const points = [origin + Math.floor(cell) * spacing, origin + Math.ceil(cell) * spacing];
    const tolerance = Math.max(...points.map((point) => Math.abs(value - point)));
    const snapped = nearest(value, points, tolerance);
    // Normalize arithmetic residue such as .2 + .1 without discarding small
    // fractional grid intervals or changing exact frame-edge clamping.
    if (snapped !== undefined) position = Number(snapped.toPrecision(15));
  }
  return { position: clamp(position, 0, limit), outside };
}

/** Project pixels in, project pixels out. The caller converts screen tolerance
 * by the fitted preview scale so zoom never changes the visual snap distance. */
export function snapCanvasPoint(
  x: number,
  y: number,
  projectWidth: number,
  projectHeight: number,
  settings: CanvasSettings = defaultCanvasSettings(),
  tolerancePx = 6,
): { x: number; y: number; snappedX?: number; snappedY?: number } {
  if (!settings.snap) return { x, y };
  const targetsX = Number.isFinite(projectWidth) && projectWidth > 0 ? [0, projectWidth / 2, projectWidth] : [];
  const targetsY = Number.isFinite(projectHeight) && projectHeight > 0 ? [0, projectHeight / 2, projectHeight] : [];
  if (settings.guidesVisible) {
    for (const guide of settings.guides) (guide.axis === 'x' ? targetsX : targetsY).push(guide.position);
  }
  if (settings.grid.snap) {
    // Visibility is presentation only; the explicit grid snapping setting is
    // retained when the grid is hidden. Locked guides remain snap targets.
    const gridTargets = (value: number, spacing: number, origin: number): number[] => {
      if (!Number.isFinite(value) || !Number.isFinite(spacing) || spacing <= 0 || !Number.isFinite(origin)) return [];
      const cell = (value - origin) / spacing;
      return [origin + Math.floor(cell) * spacing, origin + Math.ceil(cell) * spacing];
    };
    targetsX.push(...gridTargets(x, settings.grid.spacingX, settings.grid.originX));
    targetsY.push(...gridTargets(y, settings.grid.spacingY, settings.grid.originY));
  }
  const snappedX = nearest(x, targetsX, tolerancePx);
  const snappedY = nearest(y, targetsY, tolerancePx);
  return {
    x: snappedX ?? x,
    y: snappedY ?? y,
    ...(snappedX === undefined ? {} : { snappedX }),
    ...(snappedY === undefined ? {} : { snappedY }),
  };
}

/** Seconds in and out; invalid snap targets cannot poison a timeline gesture. */
export function snapTimelineTime(value: number, points: readonly number[], tolerance: number): number {
  return nearest(value, points.filter((point) => point >= 0), tolerance) ?? value;
}

/** Resize native composition geometry without rewriting original source media
 * or percentage-based clip transforms. Bounds match project validation so a
 * valid project stays saveable even after an extreme resolution change. */
export function resizeProject(project: Project, width: number, height: number): Project {
  if (![width, height].every((value) => Number.isInteger(value) && value >= 2 && value <= 16384)) {
    throw new RangeError('Project dimensions must be integers from 2 to 16384 pixels');
  }
  if (project.width === width && project.height === height) return project;
  const ratioX = width / project.width;
  const ratioY = height / project.height;
  // A composition's shorter edge is an absolute reference for visual size.
  // Taking the smaller axis ratio would shrink content on every orientation
  // change, even when changing back to the original project dimensions.
  const ratio = Math.min(width, height) / Math.min(project.width, project.height);
  const coordinate = (value: number, scale: number) => clamp(value * scale, -100000, 100000);
  const overlay = (item: NativeOverlay): NativeOverlay => item.kind === 'arrow'
    ? {
      ...item,
      x1: coordinate(item.x1, ratioX), y1: coordinate(item.y1, ratioY),
      x2: coordinate(item.x2, ratioX), y2: coordinate(item.y2, ratioY),
      width: clamp(item.width * ratio, .1, 2000),
    }
    : {
      ...item,
      x: coordinate(item.x, ratioX), y: coordinate(item.y, ratioY),
      fontSize: clamp(item.fontSize * ratio, 1, 2000),
      ...(item.outlineWidth !== undefined ? { outlineWidth: clamp(item.outlineWidth * ratio, 0, 50) } : {}),
      blockWidth: clamp(item.blockWidth * ratioX, 0, 100000),
      lineHeight: clamp(item.lineHeight * ratio, 1, 10000),
      ...(item.scroll ? { scroll: { ...item.scroll, fromY: item.scroll.fromY * ratioY, toY: item.scroll.toY * ratioY } } : {}),
    };
  const canvas = project.editorCanvas;
  return {
    ...project,
    width,
    height,
    media: project.media.map((item) => item.overlay ? { ...item, width, height, overlay: overlay(item.overlay) } : item),
    clips: project.clips.map((clip) => clip.overlay ? { ...clip, overlay: overlay(clip.overlay) } : clip),
    ...(canvas ? {
      editorCanvas: {
        ...canvas,
        grid: {
          ...canvas.grid,
          spacingX: clamp(canvas.grid.spacingX * ratioX, 1, 16384),
          spacingY: clamp(canvas.grid.spacingY * ratioY, 1, 16384),
          originX: clamp(canvas.grid.originX * ratioX, -16384, 16384),
          originY: clamp(canvas.grid.originY * ratioY, -16384, 16384),
        },
        guides: canvas.guides.map((guide) => ({ ...guide, position: clamp(guide.position * (guide.axis === 'x' ? ratioX : ratioY), -16384, 32768) })),
      },
    } : {}),
  };
}
