export interface PreviewView { zoom: number; x: number; y: number }
export interface PreviewArea { width: number; height: number; fitWidth: number; fitHeight: number }
export const FIT_PREVIEW: PreviewView = { zoom: 1, x: 0, y: 0 };
export const MIN_PREVIEW_ZOOM = .25;
export const MAX_PREVIEW_ZOOM = 8;

/** Keep a reachable part of the frame in the editor viewport. Units are screen pixels. */
export function clampPreviewView(view: PreviewView, area: PreviewArea): PreviewView {
  const zoom = Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, view.zoom));
  const limit = (viewport: number, fitted: number) => Math.max(0, (viewport + fitted * zoom) / 2 - Math.min(64, fitted * zoom / 2));
  const xLimit = limit(area.width, area.fitWidth), yLimit = limit(area.height, area.fitHeight);
  return { zoom, x: Math.max(-xLimit, Math.min(xLimit, view.x)), y: Math.max(-yLimit, Math.min(yLimit, view.y)) };
}

/** Preserve the project point beneath an anchor measured from the viewport center. */
export function zoomPreviewAt(view: PreviewView, zoom: number, anchor: { x: number; y: number }, area: PreviewArea): PreviewView {
  const nextZoom = Math.max(MIN_PREVIEW_ZOOM, Math.min(MAX_PREVIEW_ZOOM, zoom));
  const ratio = nextZoom / view.zoom;
  return clampPreviewView({ zoom: nextZoom, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio }, area);
}
