import type { ReactNode } from 'react';
import { FloatingSurface, type SurfaceAnchor } from './FloatingSurface';

export interface ContextAction { label: string; hint?: string; icon?: ReactNode; disabled?: boolean; danger?: boolean; run: () => void }

export default function ContextMenu({ anchor, label, actions, onClose }: { anchor: SurfaceAnchor; label: string; actions: ContextAction[]; onClose: () => void }) {
  return <FloatingSurface anchor={anchor} label={label} role="menu" className="cw-context-menu" onClose={onClose}>
    <div onKeyDown={e => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {actions.map(action => <button key={action.label} type="button" role="menuitem" aria-label={action.label} disabled={action.disabled} className={action.danger ? 'danger' : ''} onClick={() => { onClose(); action.run(); }}><span className="context-icon">{action.icon}</span><span>{action.label}</span>{action.hint && <kbd>{action.hint}</kbd>}</button>)}
    </div>
  </FloatingSurface>;
}
