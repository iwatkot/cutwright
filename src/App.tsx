import { useEffect, useRef, useState } from 'react';
import { validateProject } from './lib/validate';
import type { Project } from './lib/types';
import TopBar, { toast } from './components/TopBar';
import Library from './components/Library';
import Preview from './components/Preview';
import Timeline, { SelectionInspector } from './components/Timeline';
import { isEditorShortcut } from './lib/keyboardScope';
import Tooltips from './components/ui/Tooltips';
import AgentConnection from './components/AgentConnection';
import { ShortcutsModal } from './components/Modals';
import { startAgentConnections } from './lib/agentConnection';
import { sweepBrowserExportScratch } from './lib/browserExportStorage';
import { useStore } from './lib/store';
import { fmtTime } from './lib/srt';
import { readBrowserRecovery, restoreBrowserMedia, writeBrowserRecovery, type BrowserRecovery } from './lib/browserMedia';

export default function App() {
  useEffect(startAgentConnections, []);
  useEffect(() => {
    if (!window.cutwright) void sweepBrowserExportScratch().catch((error) => console.warn('Temporary export cleanup could not complete:', error));
  }, []);
  const [layout, setLayout] = useState(() => {
    try {
      const raw = localStorage.getItem('cutwright.layout');
      if (raw) return JSON.parse(raw) as { lib: number; tl: number };
    } catch { /* fresh */ }
    return { lib: 256, tl: 260 };
  });
  const dragSplitter = (kind: 'lib' | 'tl') => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...layout };
    const move = (ev: MouseEvent) => {
      const next = { ...start };
      if (kind === 'lib') next.lib = Math.min(420, window.innerWidth * .28, Math.max(210, start.lib + (ev.clientX - startX)));
      if (kind === 'tl') next.tl = Math.min(560, window.innerHeight - 290, Math.max(190, start.tl - (ev.clientY - startY)));
      setLayout(next);
      try { localStorage.setItem('cutwright.layout', JSON.stringify(next)); } catch { /* ignore */ }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const resizeWithKey = (kind: 'lib' | 'tl') => (e: React.KeyboardEvent) => {
    const direction = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    const next = { ...layout };
    if (kind === 'lib') next.lib = Math.max(210, Math.min(420, layout.lib + direction * 16));
    if (kind === 'tl') next.tl = Math.max(190, Math.min(560, window.innerHeight - 290, layout.tl - direction * 16));
    setLayout(next);
    try { localStorage.setItem('cutwright.layout', JSON.stringify(next)); } catch { /* ignore */ }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [recovery, setRecovery] = useState<{ project: Project; at: number } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const loadedRef = useRef(false);

  // Initial project (desktop test hook / CLI) + autosave recovery offer.
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      if (window.cutwright?.initialProject) {
        try {
          const r = await window.cutwright.initialProject();
          if (r?.ok && r.content) {
            const v = validateProject(JSON.parse(r.content));
            if (v.ok && v.project) { useStore.getState().setProject(v.project, true); window.dispatchEvent(new Event('cw-project-loaded')); toast(`Loaded ${r.name}`); return; }
            toast(`Project failed validation: ${v.errors.join('; ')}`);
          }
        } catch (err) { toast(`Could not load project: ${err instanceof Error ? err.message : String(err)}`); }
      }
      let parsed: BrowserRecovery | null = null;
      try { parsed = recoveryCandidate(JSON.parse(localStorage.getItem('cutwright.autosave') ?? 'null')); }
      catch { /* A corrupt/blocked legacy store must not hide database recovery. */ }
      if (!window.cutwright) {
        try {
          const local = recoveryCandidate(await readBrowserRecovery());
          if (local && (!parsed || local.at >= parsed.at)) parsed = local;
        } catch (error) { toast(`Local recovery could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const current = useStore.getState().project;
      if (parsed && JSON.stringify(parsed.project) !== JSON.stringify(current)) setRecovery(parsed);
    })();
  }, []);

  const restoreRecovery = async () => {
    if (!recovery || restoring) return;
    const current = useStore.getState().project;
    setRestoring(true);
    try {
      const restored = window.cutwright ? { project: recovery.project, missing: [], errors: [] } : await restoreBrowserMedia(recovery.project);
      if (useStore.getState().project !== current) { toast('The project changed while recovery was loading. Restore again when ready.'); return; }
      window.dispatchEvent(new Event('cw-project-will-load'));
      const store = useStore.getState();
      store.setPlaying(false);
      store.setPlayhead(0);
      store.setProject(restored.project, true);
      setRecovery(null);
      toast(`Restored ${restored.project.name}${restored.missing.length ? ` · ${restored.missing.length} missing file(s). Use Import to relink.` : ''}`);
      if (restored.errors.length) toast(`Local media could not be restored: ${restored.errors[0]}`);
    } catch (error) {
      toast(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setRestoring(false); }
  };

  // Autosave (debounced) for crash recovery.
  useEffect(() => {
    let timer = 0;
    let active = true;
    let saveErrorShown = false;
    let writes = Promise.resolve();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.project === prev.project) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const recovery = { at: Date.now(), project: s.project };
        // Serialize writes so an older large snapshot cannot replace a
        // newer one if another autosave starts while disk IO is pending.
        writes = writes.then(async () => {
          if (window.cutwright) localStorage.setItem('cutwright.autosave', JSON.stringify(recovery));
          else {
            await writeBrowserRecovery(recovery);
            try { localStorage.removeItem('cutwright.autosave'); } catch { /* Legacy migration is best effort. */ }
          }
          saveErrorShown = false;
        }).catch((error) => {
          if (active && !saveErrorShown) toast(`Recovery could not be saved. Save your project file: ${error instanceof Error ? error.message : String(error)}`);
          saveErrorShown = true;
        });
      }, 700);
    });
    return () => { active = false; unsub(); window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[role="dialog"], .modal, .ui-popover')) return;
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (target.closest?.('.modal')) return;
      const s = useStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); window.dispatchEvent(new Event('cw-save')); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); window.dispatchEvent(new Event('cw-open')); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); document.getElementById('export-btn')?.focus(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === '/') {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (!isEditorShortcut(e)) return;
      // Text fields keep native undo/redo: Ctrl+Z inside an input undoes text.
      // Timeline focus returns after clicking the timeline/preview (they blur
      // text fields), where Ctrl+Z is timeline history. This respects focus
      // both ways instead of stealing the key from whichever field has it.
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && ['b', 'k'].includes(e.key.toLowerCase())) { e.preventDefault(); splitWithToast(); return; }
      if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_'].includes(e.key)) { e.preventDefault(); s.setZoom(s.pxPerSec * (e.key === '-' || e.key === '_' ? 1 / 1.25 : 1.25)); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const frame = 1 / s.project.fps;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          s.setPlaying(!s.playing);
          break;
        case 'k': case 'K':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); splitWithToast(); }
          else s.setPlaying(!s.playing);
          break;
        case 'c': case 'C':
          if (!(e.ctrlKey || e.metaKey)) splitWithToast();
          break;
        case 'j': case 'J': s.setPlayhead(Math.max(0, s.playhead - 2)); break;
        case 'l': case 'L': s.setPlayhead(Math.min(s.totalDuration(), s.playhead + 2)); break;
        case 'ArrowLeft': e.preventDefault(); s.setPlayhead(Math.max(0, s.playhead - (e.shiftKey ? 1 : frame))); break;
        case 'ArrowRight': e.preventDefault(); s.setPlayhead(Math.min(s.totalDuration(), s.playhead + (e.shiftKey ? 1 : frame))); break;
        case 'ArrowUp': case 'ArrowDown': {
          e.preventDefault();
          const times = [...new Set(s.project.clips.flatMap(c => [c.start,c.start+c.duration]))].sort((a,b)=>a-b);
          const next = e.key === 'ArrowUp' ? times.filter(t=>t<s.playhead-frame/2).at(-1) : times.find(t=>t>s.playhead+frame/2);
          if (next !== undefined) s.setPlayhead(next);
          break;
        }
        case 'Delete': case 'Backspace':
          if (s.selectedTransitionId) { const id = s.selectedTransitionId; s.selectTransition(null); s.removeTransition(id); }
          else if (s.rippleEnabled) s.deleteSelectedRipple();
          else s.deleteSelected();
          break;
        case 'i': case 'I': case 'Home': s.setPlayhead(0); break;
        case 'o': case 'O': case 'End': s.setPlayhead(s.totalDuration()); break;
        case '+': case '=': s.setZoom(s.pxPerSec * 1.25); break;
        case '-': case '_': s.setZoom(s.pxPerSec / 1.25); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app" style={{ '--libw': `${layout.lib}px`, '--tlh': `${layout.tl}px` } as React.CSSProperties}>
      <TopBar onOpenSettings={() => setSettingsOpen(true)} onOpenShortcuts={() => setShortcutsOpen(true)} />
      {recovery && (
        <div className="recoverybar">
          <span>Recovered autosave of “{recovery.project.name}” from {new Date(recovery.at).toLocaleTimeString()}.</span>
          <button className="primary" disabled={restoring} onClick={() => void restoreRecovery()}>{restoring ? 'Restoring…' : 'Restore'}</button>
          <button disabled={restoring} onClick={() => setRecovery(null)}>Dismiss</button>
        </div>
      )}
      <div className="main">
        <Library onOpenSettings={() => setSettingsOpen(true)} />
        <div className="splitter-v" role="separator" tabIndex={0} aria-label="Resize media panel" aria-orientation="vertical" aria-valuenow={layout.lib} aria-valuemin={210} aria-valuemax={420} onMouseDown={dragSplitter('lib')} onKeyDown={resizeWithKey('lib')} data-tooltip="Resize media panel · drag or use arrow keys" />
        <div className="center">
          <Preview />
        </div>
        <SelectionInspector />
      </div>
      <div className="splitter-h" role="separator" tabIndex={0} aria-label="Resize timeline" aria-orientation="horizontal" aria-valuenow={layout.tl} aria-valuemin={190} aria-valuemax={560} onMouseDown={dragSplitter('tl')} onKeyDown={resizeWithKey('tl')} data-tooltip="Resize timeline · drag or use arrow keys" />
      <Timeline />
      <Tooltips />
      {settingsOpen && <AgentConnection onClose={() => setSettingsOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function splitWithToast(): void {
  const err = useStore.getState().splitAtPlayhead();
  toast(err ?? `Split at ${fmtTime(useStore.getState().playhead)}`);
}

function recoveryCandidate(value: unknown): BrowserRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { at?: unknown; project?: unknown };
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null;
  const validation = validateProject(candidate.project);
  return validation.ok && validation.project ? { at: candidate.at, project: validation.project } : null;
}
