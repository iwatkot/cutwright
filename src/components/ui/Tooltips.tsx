import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

/** One tooltip surface for the editor, including elements inside portals.
 * data-tooltip supplies help text; accessible names stay on their controls. */
export default function Tooltips() {
  const id = useId();
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let blocked: HTMLElement | null = null;
    let activeText = '';
    let showTimer = 0, hideTimer = 0;
    const removeDescription = () => {
      if (!active) return;
      const tokens = (active.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(token => token && token !== id);
      if (tokens.length) active.setAttribute('aria-describedby', tokens.join(' '));
      else active.removeAttribute('aria-describedby');
      active = null; activeText = '';
    };
    const hide = () => {
      window.clearTimeout(showTimer); window.clearTimeout(hideTimer);
      pending = null; removeDescription(); setTip(null);
    };
    const show = (anchor: HTMLElement, delay: number) => {
      window.clearTimeout(hideTimer);
      if (anchor === blocked) return;
      if (anchor === active || anchor === pending) return;
      hide(); pending = anchor;
      showTimer = window.setTimeout(() => {
        pending = null;
        const text = anchor.dataset.tooltip?.trim();
        if (!text || !anchor.isConnected || !anchor.getClientRects().length) return;
        active = anchor; activeText = text;
        const tokens = new Set((anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        tokens.add(id); anchor.setAttribute('aria-describedby', [...tokens].join(' '));
        setTip({ anchor, text });
      }, delay);
    };
    const target = (value: EventTarget | null) => value instanceof Element ? value.closest<HTMLElement>('[data-tooltip]') : null;
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (popup.current?.contains(event.target as Node)) { window.clearTimeout(hideTimer); return; }
      const anchor = target(event.target);
      if (anchor) show(anchor, 350);
    };
    const out = (event: PointerEvent) => {
      const anchor = target(event.target);
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (blocked && target(event.target) === blocked && !blocked.contains(next)) blocked = null;
      if (anchor?.contains(next) || popup.current?.contains(next)) return;
      if (active || pending) hideTimer = window.setTimeout(hide, 100);
    };
    const focus = (event: FocusEvent) => { const anchor = target(event.target); if (anchor) show(anchor, 120); else hide(); };
    const blur = (event: FocusEvent) => { if (target(event.target) !== target(event.relatedTarget)) { blocked = null; hide(); } };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { blocked = active ?? pending; hide(); } };
    const dismiss = (event: Event) => { if (event.target instanceof Node && popup.current?.contains(event.target)) return; blocked = active ?? pending ?? target(event.target); hide(); };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) dismiss(event); };
    document.addEventListener('pointerover', over); document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus); document.addEventListener('focusout', blur);
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true); window.addEventListener('resize', dismiss);
    const observer = new MutationObserver(() => {
      if (!active) return;
      const text = active.dataset.tooltip?.trim();
      if (!active.isConnected || !active.getClientRects().length || !text) hide();
      else if (text !== activeText) { activeText = text; setTip({ anchor: active, text }); }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tooltip'] });
    return () => {
      hide(); observer.disconnect();
      document.removeEventListener('pointerover', over); document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', dismiss);
    };
  }, [id]);
  useLayoutEffect(() => {
    if (!tip || !popup.current) return;
    const anchor = tip.anchor.getBoundingClientRect(), bounds = popup.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8));
    const below = anchor.bottom + 7;
    const top = below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - bounds.height - 7);
    setPosition({ left, top });
  }, [tip]);
  return tip && createPortal(<div ref={popup} id={id} role="tooltip" className="ui-tooltip" style={position}>{tip.text}</div>, document.body);
}
