import { t as uiText } from '../../i18n/core';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

export interface ControlOption { value: string; label: string; description?: string; disabled?: boolean; icon?: ReactNode }
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="ui-field"><div className="ui-field-label">{label}</div>{children}{hint && <small>{hint}</small>}</div>;
}
export function InspectorSection({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return <details className="ui-section" open={defaultOpen}><summary onKeyDown={e=>{if(e.key===' '||e.key==='Enter')e.stopPropagation();}}>{title}<span aria-hidden="true">⌄</span></summary><div className="ui-section-body">{children}</div></details>;
}

function usePopover(open: boolean, close: () => void, anchor: React.RefObject<HTMLElement>, popup: React.RefObject<HTMLElement>, minimumWidth = 196) {
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const height = Math.min(popup.current?.scrollHeight ?? 280, 300, window.innerHeight - 24);
      const width = Math.min(Math.max(a.width, minimumWidth), window.innerWidth - 24);
      const below = window.innerHeight - a.bottom - 8;
      setPosition({ position: 'fixed', width, maxHeight: Math.max(80, Math.min(300, below >= height ? below - 8 : a.top - 16)), left: Math.max(12, Math.min(a.left, window.innerWidth - width - 12)), ...(below >= height ? { top: a.bottom + 5 } : { bottom: window.innerHeight - a.top + 5 }) });
    };
    place();
    const dismiss = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) close(); };
    const scroll = (e: Event) => { if (!popup.current?.contains(e.target as Node)) place(); };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', place); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  return position;
}

/** Bounded contextual settings; closed content reserves no editor space. */
export function PopoverControl({ label, summary, hint, className = '', children }: { label: string; summary: string; hint?: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); anchor.current?.focus(); };
  const position = usePopover(open, close, anchor, popup, 288);
  useEffect(() => { if (open) (popup.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? popup.current)?.focus(); }, [open]);
  return <>
    <button type="button" ref={anchor} className={`ui-select ${className}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={hint ?? label} onClick={() => open ? close() : setOpen(true)}><span>{summary}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
    {open && createPortal(<div id={id} ref={popup} className="ui-popover ui-settings-popover" role="dialog" aria-label={label} tabIndex={-1} data-shortcut-scope="control" style={position} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const targets = [...(popup.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])];
        const first = targets[0], last = targets.at(-1);
        if (first && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) { e.preventDefault(); (e.shiftKey ? last : first)?.focus(); }
      }
    }}><div className="ui-popover-heading"><strong>{label}</strong><button type="button" aria-label={uiText("Close")} onClick={close}>×</button></div>{children}</div>, document.body)}
  </>;
}

export function SelectControl({ label, value, options, onChange, disabled, className = '', onGestureStart }: { label: string; value: string; options: ControlOption[]; onChange: (value: string) => void; disabled?: boolean; className?: string; onGestureStart?: () => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId(), search = useRef(''), searchAt = useRef(0);
  const close = (restore = false) => { setOpen(false); if (restore) anchor.current?.focus(); };
  const position = usePopover(open, () => close(), anchor, popup);
  const choose = (index: number) => { const option = options[index]; if (option && !option.disabled) { if (option.value !== value) { onGestureStart?.(); onChange(option.value); } close(true); } };
  const show = (direction = 0) => { const index = options.findIndex(o => o.value === value && !o.disabled); setActive(index < 0 ? Math.max(0, options.findIndex(o => !o.disabled)) : index); setOpen(true); if (direction) requestAnimationFrame(() => popup.current?.focus()); };
  useEffect(() => { if (open) { popup.current?.focus(); popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); } }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const keys = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'Escape') { close(true); return; }
    if (e.key === 'Tab') { close(true); return; }
    if (e.key === 'Enter' || e.key === ' ') { if (open) choose(active); else show(1); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      if (!open) { show(1); return; }
      const direction = e.key === 'ArrowUp' || e.key === 'End' ? -1 : 1;
      let i = e.key === 'Home' ? -1 : e.key === 'End' ? options.length : active;
      for (let count = 0; count < options.length; count++) { i = (i + direction + options.length) % options.length; if (!options[i].disabled) break; }
      setActive(i); return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.stopPropagation();
      search.current = Date.now() - searchAt.current > 600 ? e.key : search.current + e.key; searchAt.current = Date.now();
      const i = options.findIndex(o => !o.disabled && o.label.toLowerCase().startsWith(search.current.toLowerCase()));
      if (i >= 0) { if (!open) setOpen(true); setActive(i); }
    }
  };
  return <><button ref={anchor} type="button" className={`ui-select ${className}`} role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="listbox" disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={keys}><span>{options.find(o => o.value === value)?.label ?? value}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>{open && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} aria-activedescendant={`${id}-${active}`} tabIndex={-1} className="ui-popover ui-options" style={position} onKeyDown={keys} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== anchor.current) close(); }}>{options.map((o, i) => <div id={`${id}-${i}`} key={o.value} role="option" aria-selected={value === o.value} aria-disabled={o.disabled || undefined} className={`ui-option ${active === i ? 'active' : ''}`} onPointerMove={() => !o.disabled && setActive(i)} onClick={() => choose(i)}><span>{o.label}{o.description && <small>{o.description}</small>}</span>{value === o.value && <span aria-hidden="true">✓</span>}</div>)}</div>, document.body)}</>;
}

interface NumericProps { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string; disabled?: boolean; className?: string; onGestureStart?: () => void; onFocus?: () => void; onBlur?: () => void }
const decimal = (n: number) => Number(n.toFixed(5));
export function NumberControl({ label, value, onChange, min = -100000, max = 100000, step = 1, unit, disabled, className = '', onGestureStart, onFocus, onBlur }: NumericProps) {
  const [draft, setDraft] = useState(String(decimal(value)));
  const editing = useRef(false), cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(decimal(value))); }, [value]);
  const clamp = (n: number) => decimal(Math.max(min, Math.min(max, n)));
  const change = (n: number) => { const next = clamp(n); setDraft(String(next)); if (next !== value) onChange(next); };
  return <div className={`ui-number ${className}${disabled ? ' disabled' : ''}`}><input type="text" inputMode="decimal" role="spinbutton" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} value={draft} disabled={disabled} onFocus={() => { editing.current = true; cancelled.current = false; onGestureStart?.(); onFocus?.(); }} onBlur={() => { editing.current = false; if (cancelled.current) { cancelled.current = false; setDraft(String(decimal(value))); onBlur?.(); return; } const n = Number(draft.replace(',', '.')); if (draft.trim() && Number.isFinite(n)) change(n); else setDraft(String(decimal(value))); onBlur?.(); }} onChange={(e) => { const text = e.target.value; setDraft(text); if (text.trim() && /^-?(?:\d+[.,]?\d*|[.,]\d+)$/.test(text)) { const n = Number(text.replace(',', '.')); if (Number.isFinite(n) && n >= min && n <= max && n !== value) onChange(n); } }} onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') { cancelled.current = true; setDraft(String(decimal(value))); e.currentTarget.blur(); } else if (e.key === 'Enter') e.currentTarget.blur(); else change(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)); } }} />{unit && <span className="ui-unit">{unit}</span>}<span className="ui-number-steps"><button type="button" tabIndex={-1} disabled={disabled || value >= max} aria-label={uiText("Increase {0}", { 0: label })} onClick={() => { onGestureStart?.(); change(value + step); }}>+</button><button type="button" tabIndex={-1} disabled={disabled || value <= min} aria-label={uiText("Decrease {0}", { 0: label })} onClick={() => { onGestureStart?.(); change(value - step); }}>−</button></span></div>;
}

export function RangeControl({ label, value, onChange, min, max, step = 1, disabled, className = '', onGestureStart }: NumericProps & { min: number; max: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const change = (n: number) => { const next = decimal(Math.max(min, Math.min(max, min + Math.round((n - min) / step) * step))); if (next !== value) onChange(next); };
  const pointer = (e: React.PointerEvent) => { const r = ref.current?.getBoundingClientRect(); if (r) change(min + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (max - min)); };
  return <div ref={ref} role="slider" tabIndex={disabled ? -1 : 0} aria-label={label} aria-valuenow={decimal(value)} aria-valuemin={min} aria-valuemax={max} aria-disabled={disabled || undefined} className={`ui-range ${className}`} style={{ '--progress': `${Math.max(0, Math.min(100, (value - min) / (max - min) * 100))}%` } as CSSProperties} onPointerDown={(e) => { if (disabled) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); onGestureStart?.(); pointer(e); }} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pointer(e); }} onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onKeyDown={(e) => { const directions: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -step * 10, PageUp: step * 10 }; if (e.key in directions || e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); if (disabled) return; if (!e.repeat) onGestureStart?.(); change(e.key === 'Home' ? min : e.key === 'End' ? max : value + directions[e.key]); } }}><span className="ui-range-track" /><span className="ui-range-thumb" /></div>;
}

export function ToggleGroup({ label, value, options, onChange }: { label: string; value: string; options: ControlOption[]; onChange: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div className="ui-toggle-group" role="group" aria-label={label} ref={ref} onKeyDown={(e) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); const enabled = options.filter(o => !o.disabled); const i = enabled.findIndex(o => o.value === value); const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length; if (enabled[next]) { onChange(enabled[next].value); (ref.current?.querySelectorAll('button:not(:disabled)')[next] as HTMLElement)?.focus(); } }}>{options.map(o => <button type="button" key={o.value} disabled={o.disabled} aria-label={o.label} aria-pressed={o.value === value} data-tooltip={o.label} onClick={() => onChange(o.value)}>{o.icon ?? o.label}</button>)}</div>;
}

const COLORS = ['#FFFFFF', '#DDE4EB', '#121820', '#000000', '#FFCF63', '#FFA45B', '#F5758C', '#D89AFF', '#9AA5FF', '#6DBFFF', '#65DDD3', '#9CE49F'];
export function ColorControl({ label, value, onChange, onGestureStart }: { label: string; value: string; onChange: (value: string) => void; onGestureStart?: () => void }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(value);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) anchor.current?.focus(); };
  const position = usePopover(open, () => close(), anchor, popup);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { if (open) popup.current?.querySelector('button')?.focus(); }, [open]);
  const update = (next: string) => { if (next !== value) onChange(next); };
  return <><button type="button" ref={anchor} className="ui-color" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" onClick={() => setOpen(!open)}><i style={{ background: value }} /><span>{value.toUpperCase()}</span></button>{open && createPortal(<div id={id} ref={popup} role="dialog" aria-label={label} className="ui-popover ui-color-picker" style={position} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } if (e.key === 'Tab') { const targets = popup.current!.querySelectorAll<HTMLElement>('button,input'); const first = targets[0], last = targets[targets.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } }}><div className="ui-palette">{COLORS.map(c => <button key={c} type="button" aria-label={`${label} ${c}`} aria-pressed={value.slice(0, 7).toUpperCase() === c} style={{ background: c }} onClick={() => { onGestureStart?.(); update(c + value.slice(7)); }} />)}</div><label className="ui-field-label">{uiText("Hex color")}<input aria-label={uiText("{0} hex", { 0: label })} aria-invalid={!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(draft)} value={draft} spellCheck={false} onFocus={onGestureStart} onChange={(e) => { setDraft(e.target.value); if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(e.target.value)) update(e.target.value); }} onBlur={() => setDraft(value)} /></label><button type="button" onClick={() => close(true)}>{uiText("Done")}</button></div>, document.body)}</>;
}

export function useDialogFocus(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const targets = () => [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter(el => el.offsetParent !== null);
    (targets()[0] ?? root)?.focus();
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('.ui-popover')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key === 'Tab') { const all = targets(), first = all[0], last = all[all.length - 1]; if (!first) { e.preventDefault(); return; } if (e.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
}
