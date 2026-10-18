import type { NativeOverlay } from './types';
import { titleBlockHeight, validateOverlay } from './overlay';
import { t as uiText } from '../i18n/core';

export interface OverlayCanvas { width: number; height: number }
export interface OverlayAsset extends OverlayCanvas { id: string; name: string; overlay: NativeOverlay }
const KEY = 'cutwright.overlayAssets';
const LEGACY_CANVAS: OverlayCanvas = { width: 1920, height: 1080 };
const validCanvas = (canvas: OverlayCanvas) => Number.isFinite(canvas.width) && canvas.width >= 2 && canvas.width <= 16384
  && Number.isFinite(canvas.height) && canvas.height >= 2 && canvas.height <= 16384;

export function loadOverlayAssets(): OverlayAsset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((a): OverlayAsset[] => {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || validateOverlay(a.overlay).length) return [];
      // Earlier asset libraries used a fixed 1080p preview and did not store
      // canvas dimensions. Retain those assets with that original baseline.
      const canvas = a.width === undefined && a.height === undefined ? LEGACY_CANVAS : { width: a.width, height: a.height };
      return validCanvas(canvas) ? [{ ...a, ...canvas }] : [];
    });
  } catch { return []; }
}

/** A save creates a new asset. Updating an asset requires its explicit id;
 * names are presentation only and can never overwrite another template. */
export function saveOverlayAsset(name: string, overlay: NativeOverlay, canvas: OverlayCanvas = LEGACY_CANVAS, assetId?: string): boolean {
  if (validateOverlay(overlay).length || !validCanvas(canvas)) return false;
  try {
    const assets = loadOverlayAssets();
    if (assetId !== undefined && !assets.some((a) => a.id === assetId)) return false;
    const usedNames = new Set(assets.filter((a) => a.id !== assetId).map((a) => a.name));
    const baseName = name.trim() || (overlay.kind === 'title' ? uiText('Title') : uiText('Arrow'));
    let displayName = baseName;
    for (let i = 2; usedNames.has(displayName); i++) displayName = `${baseName} (${i})`;
    const asset: OverlayAsset = { id: assetId ?? crypto.randomUUID(), name: displayName, overlay: structuredClone(overlay), width: canvas.width, height: canvas.height };
    localStorage.setItem(KEY, JSON.stringify([...assets.filter((a) => a.id !== asset.id), asset]));
    window.dispatchEvent(new Event('cw-overlay-assets'));
    return true;
  } catch { return false; }
}

/** Fit the source canvas inside the destination without distorting text or
 * stroke widths. The saved template stays independent of every instance. */
export function scaleOverlay(overlay: NativeOverlay, source: OverlayCanvas, target: OverlayCanvas): NativeOverlay {
  if (!validCanvas(source) || !validCanvas(target)) throw new Error('Overlay canvas dimensions are invalid');
  const next = structuredClone(overlay);
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const padX = (target.width - source.width * scale) / 2;
  const padY = (target.height - source.height * scale) / 2;
  const fit = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  if (next.kind === 'arrow') {
    next.x1 = fit(next.x1 * scale + padX, -100000, 100000); next.x2 = fit(next.x2 * scale + padX, -100000, 100000);
    next.y1 = fit(next.y1 * scale + padY, -100000, 100000); next.y2 = fit(next.y2 * scale + padY, -100000, 100000);
    next.width = fit(next.width * scale, .1, 2000);
  } else {
    next.x = fit(next.x * scale + padX, -100000, 100000); next.y = fit(next.y * scale + padY, -100000, 100000);
    next.fontSize = fit(next.fontSize * scale, 1, 2000);
    if (next.outlineWidth !== undefined) next.outlineWidth = fit(next.outlineWidth * scale, 0, 50);
    next.lineHeight = fit(next.lineHeight * scale, 1, 10000);
    next.blockWidth = fit(next.blockWidth * scale, 0, 100000);
    if (next.scroll) { next.scroll.fromY *= scale; next.scroll.toY *= scale; }
  }
  return next;
}

/** Pick a visible animation phase, rather than a fixed second that may be
 * transparent during signed preset pre-roll or after a credit heading. */
export function overlayPreviewTime(overlay: NativeOverlay, canvas: OverlayCanvas): number {
  let time = overlay.animationDuration ? overlay.animationDuration / 2 : overlay.kind === 'arrow' ? overlay.drawDuration ?? 1 : 1;
  if (overlay.kind === 'title' && overlay.scroll) {
    const textHeight = titleBlockHeight(overlay);
    const centerY = overlay.y + textHeight / 2;
    const distance = overlay.scroll.toY - overlay.scroll.fromY;
    const p = distance ? Math.min(1, Math.max(0, (canvas.height / 2 - centerY - overlay.scroll.fromY) / distance)) : 0;
    time = overlay.scroll.duration * p;
  }
  if (overlay.animationDuration !== undefined) {
    const duration = overlay.animationDuration;
    time = Math.min(duration - Math.min(overlay.fadeOut ?? 0, duration / 2), Math.max(Math.min(overlay.fadeIn ?? 0, duration / 2), time));
  }
  return Math.max(0, time - (overlay.animationOffset ?? 0));
}
