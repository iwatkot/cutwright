import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampPreviewView, FIT_PREVIEW, zoomPreviewAt, type PreviewArea, type PreviewView } from '../lib/previewNavigation';
import { matchConfiguredShortcut } from '../lib/shortcutPreferences';

const editable = 'input,textarea,select,[contenteditable="true"],[role="textbox"],[role="spinbutton"],[role="slider"],[role="combobox"],[role="listbox"],[data-shortcut-scope="control"],.guide-editor';
const hasPopup = () => !!document.querySelector('[role="dialog"],[role="menu"],[role="listbox"],.modal,.ui-popover');

/** Editor view state deliberately lives outside the project store and history. */
export function usePreviewNavigation(width: number, height: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PreviewView>(FIT_PREVIEW);
  const [area, setArea] = useState<PreviewArea>({ width: 1, height: 1, fitWidth: 1, fitHeight: 1 });
  const viewRef = useRef(view), areaRef = useRef(area);
  const hovered = useRef(false), space = useRef(false), finishPan = useRef<() => void>();
  const suppressClick = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false), [panning, setPanning] = useState(false);
  const [handTool, setHandTool] = useState(false);
  const handRef = useRef(false), heldCode = useRef('');
  const toggleHand = () => { handRef.current = !handRef.current; setHandTool(handRef.current); };
  const update = (next: PreviewView) => { viewRef.current = next; setView(next); };
  const fit = () => update({ ...FIT_PREVIEW });
  const zoom = (factor: number, anchor = { x: 0, y: 0 }) => update(zoomPreviewAt(viewRef.current, viewRef.current.zoom * factor, anchor, areaRef.current));

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const css = getComputedStyle(viewport);
      const availableWidth = Math.max(1, viewport.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
      const availableHeight = Math.max(1, viewport.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom));
      const fitWidth = Math.min(availableWidth, availableHeight * width / height);
      const next = { width: availableWidth, height: availableHeight, fitWidth, fitHeight: fitWidth * height / width };
      areaRef.current = next; setArea(next); update(clampPreviewView(viewRef.current, next));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const releaseSpace = () => { space.current = false; heldCode.current = ''; setSpaceHeld(false); finishPan.current?.(); };
    const reset = () => { releaseSpace(); fit(); };
    const enter = () => { hovered.current = true; };
    const leave = () => { hovered.current = false; };
    const keydown = (event: KeyboardEvent) => {
      if (!matchConfiguredShortcut(event, 'panHold') || event.defaultPrevented || event.isComposing || event.repeat || hasPopup()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(editable)) return;
      const inViewport = !!target && viewport.contains(target);
      if (!hovered.current && !inViewport) return;
      if (target?.closest('button,a[href],summary')) return;
      event.preventDefault(); event.stopPropagation();
      heldCode.current = event.code; space.current = true; setSpaceHeld(true);
    };
    const keyup = (event: KeyboardEvent) => { if (space.current && (event.code === heldCode.current || ['Control','Meta','Alt','Shift'].includes(event.key))) releaseSpace(); };
    const zoomIn = () => zoom(1.25), zoomOut = () => zoom(1 / 1.25);
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || !event.deltaY || hasPopup() || event.target instanceof Element && event.target.closest(editable)) return;
      event.preventDefault(); event.stopPropagation();
      const rect = viewport.getBoundingClientRect(), css = getComputedStyle(viewport);
      const centerX = rect.left + parseFloat(css.paddingLeft) + areaRef.current.width / 2;
      const centerY = rect.top + parseFloat(css.paddingTop) + areaRef.current.height / 2;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      zoom(Math.exp(-Math.max(-600, Math.min(600, event.deltaY * unit)) * .0015), { x: event.clientX - centerX, y: event.clientY - centerY });
    };
    const auxiliary = (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); };
    viewport.addEventListener('pointerenter', enter); viewport.addEventListener('pointerleave', leave);
    viewport.addEventListener('wheel', wheel, { passive: false }); viewport.addEventListener('auxclick', auxiliary);
    window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', releaseSpace); window.addEventListener('cw-project-will-load', reset);
    window.addEventListener('cw-shortcuts-changed', releaseSpace);
    window.addEventListener('cw-preview-fit', fit); window.addEventListener('cw-preview-zoom-in', zoomIn); window.addEventListener('cw-preview-zoom-out', zoomOut); window.addEventListener('cw-preview-pan-toggle', toggleHand);
    return () => {
      finishPan.current?.();
      viewport.removeEventListener('pointerenter', enter); viewport.removeEventListener('pointerleave', leave);
      viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('auxclick', auxiliary);
      window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', releaseSpace); window.removeEventListener('cw-project-will-load', reset);
      window.removeEventListener('cw-shortcuts-changed', releaseSpace);
      window.removeEventListener('cw-preview-fit', fit); window.removeEventListener('cw-preview-zoom-in', zoomIn); window.removeEventListener('cw-preview-zoom-out', zoomOut); window.removeEventListener('cw-preview-pan-toggle', toggleHand);
    };
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || hasPopup() || !(event.button === 1 || event.button === 2 || event.button === 0 && (space.current || handRef.current))) return;
    if (event.target instanceof Element && event.target.closest(editable)) return;
    event.preventDefault(); event.stopPropagation(); finishPan.current?.();
    const viewport = event.currentTarget, id = event.pointerId, startX = event.clientX, startY = event.clientY, start = viewRef.current;
    suppressClick.current = true; viewport.focus({ preventScroll: true }); setPanning(true);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== id) return;
      next.preventDefault();
      update(clampPreviewView({ ...start, x: start.x + next.clientX - startX, y: start.y + next.clientY - startY }, areaRef.current));
    };
    const stop = (next: PointerEvent) => { if (next.pointerId === id) finish(); };
    const finish = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop);
      viewport.removeEventListener('lostpointercapture', stop);
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
      finishPan.current = undefined; setPanning(false);
      // Suppress only the click synthesized by this gesture, not the next edit.
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    finishPan.current = finish;
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
    viewport.addEventListener('lostpointercapture', stop); viewport.setPointerCapture(id);
  };
  return { viewportRef, view, area, spaceHeld, handTool, toggleHand, panning, fit, zoom, pointerDown, suppressClick };
}
