import { t as uiText } from '../i18n/core';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../lib/store';
import { defaultCanvasSettings } from '../lib/canvasGeometry';
import { Field, NumberControl, ToggleGroup } from './ui/Controls';
import { IconButton, IconClose, IconGrid, IconGridSnap, IconGuides, IconGuideHorizontalPlus, IconGuideVerticalPlus, IconLock, IconRuler, IconSettings, IconSnap } from './icons';
import './canvas.css';

export default function ProjectSettings({ viewControls }: { viewControls?: ReactNode }) {
  const project = useStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(project.width), [height, setHeight] = useState(project.height);
  const [position, setPosition] = useState<CSSProperties>({});
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const config = project.editorCanvas ?? defaultCanvasSettings();
  const changed = useRef(false);
  const begin = () => { changed.current = false; };
  const apply = (patch: Partial<typeof config>, gesture = false) => {
    const store = useStore.getState(), current = store.project.editorCanvas ?? defaultCanvasSettings();
    const next = { ...current, ...patch };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    if (gesture && !changed.current) { store.commit(); changed.current = true; }
    store.setCanvasSettings(next, !gesture);
  };
  const close = (restore = false) => { setOpen(false); if (restore) anchor.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds) return;
      const panelWidth = Math.min(320, window.innerWidth - 16);
      const below = Math.max(0, window.innerHeight - bounds.bottom - 14), above = Math.max(0, bounds.top - 14);
      const downward = below >= above;
      const maxHeight = Math.min(460, window.innerHeight - 16, downward ? below : above);
      setPosition({ position: 'fixed', width: panelWidth, maxHeight, left: Math.max(8, Math.min(bounds.left, window.innerWidth - panelWidth - 8)), ...(downward ? { top: bounds.bottom + 6 } : { bottom: window.innerHeight - bounds.top + 6 }) });
    };
    place();
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) place(); };
    const observer = new ResizeObserver(place);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener('resize', place); document.addEventListener('scroll', scroll, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>('[data-project-close]')?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="tooltip"]')) return;
      if (target instanceof Node && !popup.current?.contains(target) && !anchor.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      // Let a focused numeric control discard its unfinished draft first.
      queueMicrotask(() => close(true));
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  const format = project.width === project.height ? '1:1' : project.width * 9 === project.height * 16 ? '16:9' : project.width * 16 === project.height * 9 ? '9:16' : uiText("Custom");
  const validSize = Number.isInteger(width) && Number.isInteger(height) && width % 2 === 0 && height % 2 === 0;
  return <>
    <div className="canvas-toolbar" role="toolbar" aria-label={uiText("Canvas tools")}>
      <button ref={anchor} className="canvas-format" aria-label={uiText("Project settings")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={uiText("Project and canvas settings")} onClick={() => { setWidth(project.width); setHeight(project.height); setOpen(!open); }}><IconSettings /><span>{format} · {project.width} × {project.height}</span></button>
      <div className="spacer" />
      <div className="canvas-aid-actions" role="group" aria-label={uiText("Canvas aids")}>
        <IconButton label={uiText("Rulers")} title={uiText("Pixel rulers")} aria-pressed={config.rulers} onClick={() => apply({ rulers: !config.rulers })}><IconRuler /></IconButton>
        <IconButton label={uiText("Guides")} title={uiText("Canvas guides")} aria-pressed={config.guidesVisible} onClick={() => apply({ guidesVisible: !config.guidesVisible })}><IconGuides /></IconButton>
        <IconButton label={uiText("Grid")} title={uiText("Canvas grid")} aria-pressed={config.grid.visible} onClick={() => apply({ grid: { ...config.grid, visible: !config.grid.visible } })}><IconGrid /></IconButton>
        <IconButton label={uiText("Snap")} title={uiText("Snap objects to guides and frame")} aria-pressed={config.snap} onClick={() => apply({ snap: !config.snap })}><IconSnap /></IconButton>
      </div>
      {viewControls}
    </div>
    {open && createPortal(<div ref={popup} id={id} className="canvas-settings" style={position} role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1} data-shortcut-scope="control" onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = [...(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])].filter(element => element.tabIndex >= 0 && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="canvas-settings-heading"><strong id={`${id}-title`}>{uiText("Project & canvas")}</strong><IconButton data-project-close label={uiText("Close project settings")} onClick={() => close(true)}><IconClose /></IconButton></div>
      <div className="canvas-settings-body">
        <section className="canvas-settings-section" aria-label={uiText("Frame size")}>
          <div className="canvas-settings-section-heading"><h3>{uiText("Frame")}</h3><button className="canvas-size-apply" disabled={!validSize || width === project.width && height === project.height} onClick={() => useStore.getState().setProjectSize(width,height)}>{uiText("Apply size")}</button></div>
          <ToggleGroup label={uiText("Project aspect ratio")} value={format} options={[{value:'16:9',label:uiText("Landscape 16:9"),icon:<span>16:9</span>},{value:'9:16',label:uiText("Portrait 9:16"),icon:<span>9:16</span>},{value:'1:1',label:uiText("Square 1:1"),icon:<span>1:1</span>}]} onChange={(v) => { const [w,h] = v === '16:9' ? [1920,1080] : v === '9:16' ? [1080,1920] : [1080,1080]; useStore.getState().setProjectSize(w,h); setWidth(w); setHeight(h); }} />
          <div className="canvas-fields"><Field label={uiText("Width")}><NumberControl label={uiText("Project width")} value={width} onChange={setWidth} min={2} max={16384} step={2} unit="px" /></Field><Field label={uiText("Height")}><NumberControl label={uiText("Project height")} value={height} onChange={setHeight} min={2} max={16384} step={2} unit="px" /></Field></div>
          <p className="canvas-settings-hint" role={validSize ? undefined : 'status'}>{validSize ? uiText("Text and guides keep their relative position.") : uiText("Width and height must be even pixel values.")}</p>
        </section>
        <section className="canvas-settings-section" aria-label={uiText("Grid settings")}>
          <h3>{uiText("Grid")}</h3>
          <div className="canvas-fields"><Field label={uiText("Horizontal spacing")}><NumberControl label={uiText("Grid horizontal spacing")} value={config.grid.spacingX} min={1} max={16384} unit="px" onGestureStart={begin} onChange={(v) => apply({grid:{...config.grid,spacingX:v}},true)} /></Field><Field label={uiText("Vertical spacing")}><NumberControl label={uiText("Grid vertical spacing")} value={config.grid.spacingY} min={1} max={16384} unit="px" onGestureStart={begin} onChange={(v) => apply({grid:{...config.grid,spacingY:v}},true)} /></Field><Field label={uiText("Origin X")}><NumberControl label={uiText("Grid origin X")} value={config.grid.originX} min={-16384} max={16384} unit="px" onGestureStart={begin} onChange={(v) => apply({grid:{...config.grid,originX:v}},true)} /></Field><Field label={uiText("Origin Y")}><NumberControl label={uiText("Grid origin Y")} value={config.grid.originY} min={-16384} max={16384} unit="px" onGestureStart={begin} onChange={(v) => apply({grid:{...config.grid,originY:v}},true)} /></Field></div>
        </section>
        <section className="canvas-settings-section canvas-guide-settings" aria-label={uiText("Guide and snapping actions")}>
          <h3>{uiText("Guides & snapping")}</h3>
          <div className="canvas-guide-actions" role="group" aria-label={uiText("Guide and snapping actions")}>
            <IconButton label={uiText("Snap to grid")} aria-pressed={config.grid.snap} onClick={() => apply({grid:{...config.grid,snap:!config.grid.snap}})}><IconGridSnap /></IconButton>
            <IconButton label={uiText("Lock guides")} aria-pressed={config.guidesLocked} onClick={() => apply({guidesLocked:!config.guidesLocked})}><IconLock /></IconButton>
            <span className="canvas-action-divider" />
            <IconButton label={uiText("Add vertical guide")} onClick={() => apply({guides:[...config.guides,{id:crypto.randomUUID(),axis:'x',position:project.width/2}]})} disabled={config.guides.length >= 200}><IconGuideVerticalPlus /></IconButton>
            <IconButton label={uiText("Add horizontal guide")} onClick={() => apply({guides:[...config.guides,{id:crypto.randomUUID(),axis:'y',position:project.height/2}]})} disabled={config.guides.length >= 200}><IconGuideHorizontalPlus /></IconButton>
          </div>
          <p className="canvas-settings-hint">{uiText("Canvas aids stay out of exports.")}</p>
        </section>
      </div>
    </div>,document.body)}
  </>;
}
