import type { PointerEvent as ReactPointerEvent } from 'react';

/** Vertical swipes on unselected clips remain native track scrolling. */
export function clipGestureReady(pointerType: string, selected: boolean, dx: number, dy: number): boolean {
  if (pointerType !== 'touch') return Math.abs(dx) >= 2 || Math.abs(dy) >= 2;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return false;
  return selected || Math.abs(dx) > Math.abs(dy);
}

/** Own one pointer until release, cancellation, blur or component teardown. */
export function trackPointer(event: ReactPointerEvent<HTMLElement>, move: (event: PointerEvent) => void, finish: () => void): () => void {
  const node = event.currentTarget, id = event.pointerId;
  const onMove = (next: PointerEvent) => { if (next.pointerId === id) move(next); };
  const onEnd = (next: PointerEvent) => { if (next.pointerId === id) cleanup(); };
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    window.removeEventListener('blur', cleanup);
    node.removeEventListener('lostpointercapture', onEnd);
    if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
    finish();
  };
  node.setPointerCapture(id);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
  window.addEventListener('blur', cleanup);
  node.addEventListener('lostpointercapture', onEnd);
  return cleanup;
}
