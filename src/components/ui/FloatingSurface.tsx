import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './floating.css';

export interface SurfaceAnchor { x: number; y: number; bottom?: number }

/** A bounded portal shared by contextual editors and pointer/keyboard menus. */
export function FloatingSurface({ anchor, label, role = 'dialog', className = '', onClose, children }: {
  anchor: SurfaceAnchor; label: string; role?: 'dialog' | 'menu'; className?: string;
  onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState<CSSProperties>({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const place = () => {
      const r = node.getBoundingClientRect(), gap = 8;
      const below = anchor.bottom ?? anchor.y;
      const top = below + r.height <= window.innerHeight - gap ? below : anchor.y - r.height;
      setPosition({ left: Math.max(gap, Math.min(anchor.x, window.innerWidth - r.width - gap)), top: Math.max(gap, Math.min(top, window.innerHeight - r.height - gap)) });
    };
    place();
    (node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>('button:not(:disabled),input') ?? node).focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const target = e.target as Element;
      // Shared color/select controls use their own portal above this editor.
      if (!node.contains(target) && !target.closest('.ui-popover')) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (!node.contains(e.target as Node)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key === 'Tab' && role === 'menu') close.current();
    };
    const scroll = (e: Event) => {
      if (node.contains(e.target as Node) || e.target instanceof Element && e.target.closest('.ui-popover')) return;
      if (role === 'menu') close.current(); else place();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', scroll, true);
    const observer = new ResizeObserver(place); observer.observe(node);
    return () => {
      const restore = node.contains(document.activeElement) || document.activeElement === document.body;
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true);
      observer.disconnect();
      if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [anchor, role]);
  return createPortal(<div ref={ref} role={role} aria-label={label} tabIndex={-1} data-shortcut-scope="control" className={`cw-floating ${className}`} style={position}>{children}</div>, document.body);
}
