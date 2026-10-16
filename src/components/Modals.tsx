import { useRef } from 'react';
import { useDialogFocus } from './ui/Controls';

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const rows: [string, string][] = [
    ['Space / K', 'Play · pause'],
    ['J / L', 'Seek back / forward 2 seconds'],
    ['← →', 'Step 1 frame · Shift = 1 second'],
    ['C / Ctrl+B / Ctrl+K', 'Cut (split) at playhead'],
    ['↑ / ↓', 'Previous / next clip boundary'],
    ['Ctrl+M', 'Add a timeline marker'],
    ['Ctrl+Shift+← / →', 'Previous / next marker'],
    ['S', 'Toggle snapping'],
    ['Delete', 'Delete selected clip / subtitle'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
    ['Ctrl+S / Ctrl+O', 'Save / open project'],
    ['Ctrl+E', 'Focus export (top bar)'],
    ['Ctrl+/', 'Agent connection'],
    ['I / O', 'Jump playhead to start / end'],
    ['+ / − or Ctrl+ + / −', 'Timeline zoom'],
    ['Home / End', 'Playhead to start / end'],
  ];
  return (
    <div className="modalback" onClick={onClose}>
      <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <table className="keys"><tbody>
          {rows.map(([k, v]) => <tr key={k}><td><span className="kbd">{k}</span></td><td>{v}</td></tr>)}
        </tbody></table>
        <div className="row mt"><div className="spacer" /><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
