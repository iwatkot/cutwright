import { localizedDiagnostic } from './i18n/presentation';
import { t as uiText } from './i18n/core';
import { useEffect, useRef, useState } from 'react';
import { useLocale } from './i18n/react';
import { validateProject } from './lib/validate';
import type { Project } from './lib/types';
import TopBar, { toast } from './components/TopBar';
import Library from './components/Library';
import Preview from './components/Preview';
import Timeline, { SelectionInspector } from './components/Timeline';
import { isEditorShortcut } from './lib/keyboardScope';
import Tooltips from './components/ui/Tooltips';
import AgentConnection from './components/AgentConnection';
import ShortcutSettings from './components/ShortcutSettings';
import { matchConfiguredShortcut } from './lib/shortcutPreferences';
import { cycleTheme } from './components/ui/theme';
import { startAgentConnections } from './lib/agentConnection';
import { sweepBrowserExportScratch } from './lib/browserExportStorage';
import { useStore } from './lib/store';
import { fmtTime } from './lib/srt';
import { readBrowserRecovery, restoreBrowserMedia, writeBrowserRecovery, type BrowserRecovery } from './lib/browserMedia';

export default function App() {
  const locale = useLocale();
  useEffect(() => { void window.cutwright?.setLocale?.(locale).catch(error => console.warn('Native language preference could not be applied:', error)); }, [locale]);
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
            if (v.ok && v.project) { useStore.getState().setProject(v.project, true); window.dispatchEvent(new Event('cw-project-loaded')); toast(uiText("Loaded {0}", { 0: r.name })); return; }
            toast(uiText("Project failed validation: {0}", { 0: v.errors.map(localizedDiagnostic).join('; ') }));
          }
        } catch (err) { toast(uiText("Could not load project: {0}", { 0: localizedDiagnostic(err) })); }
      }
      let parsed: BrowserRecovery | null = null;
      try { parsed = recoveryCandidate(JSON.parse(localStorage.getItem('cutwright.autosave') ?? 'null')); }
      catch { /* A corrupt/blocked legacy store must not hide database recovery. */ }
      if (!window.cutwright) {
        try {
          const local = recoveryCandidate(await readBrowserRecovery());
          if (local && (!parsed || local.at >= parsed.at)) parsed = local;
        } catch (error) { toast(uiText("Local recovery could not be read: {0}", { 0: localizedDiagnostic(error) })); }
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
      if (useStore.getState().project !== current) { toast(uiText("The project changed while recovery was loading. Restore again when ready.")); return; }
      window.dispatchEvent(new Event('cw-project-will-load'));
      const store = useStore.getState();
      store.setPlaying(false);
      store.setPlayhead(0);
      store.setProject(restored.project, true);
      setRecovery(null);
      toast(uiText("Restored {0}{1}", { 0: restored.project.name, 1: restored.missing.length ? uiText(" · {0} missing file(s). Use Import to relink.", { 0: restored.missing.length }) : '' }));
      if (restored.errors.length) toast(uiText("Local media could not be restored: {0}", { 0: localizedDiagnostic(restored.errors[0]) }));
    } catch (error) {
      toast(uiText("Recovery failed: {0}", { 0: localizedDiagnostic(error) }));
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
          if (active && !saveErrorShown) toast(uiText("Recovery could not be saved. Save your project file: {0}", { 0: localizedDiagnostic(error) }));
          saveErrorShown = true;
        });
      }, 700);
    });
    return () => { active = false; unsub(); window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .modal, .ui-popover')) return;
      const action = matchConfiguredShortcut(e);
      if (!action) return;
      const target = e.target instanceof Element ? e.target : null;
      const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
      const fieldCommand = typing && (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.code)) && ['saveProject', 'openProject', 'export', 'agent', 'shortcuts'].includes(action);
      if (!isEditorShortcut(e) && !fieldCommand) return;
      e.preventDefault();
      if (e.repeat && ['newProject','openProject','saveProject','importMedia','export','agent','shortcuts','theme','play','split','addMarker','snapping','panToggle'].includes(action)) return;
      const s = useStore.getState(), frame = 1 / s.project.fps;
      switch (action) {
        case 'newProject': window.dispatchEvent(new Event('cw-new')); break;
        case 'openProject': window.dispatchEvent(new Event('cw-open')); break;
        case 'saveProject': window.dispatchEvent(new Event('cw-save')); break;
        case 'importMedia': window.dispatchEvent(new Event('cw-import')); break;
        case 'export': document.getElementById('export-btn')?.focus(); break;
        case 'agent': setSettingsOpen(true); break;
        case 'shortcuts': setShortcutsOpen(true); break;
        case 'theme': cycleTheme(); break;
        case 'play': s.setPlaying(!s.playing); break;
        case 'seekBack': s.setPlayhead(Math.max(0, s.playhead - 2)); break;
        case 'seekForward': s.setPlayhead(Math.min(s.totalDuration(), s.playhead + 2)); break;
        case 'frameBack': case 'frameForward': s.setPlayhead(Math.max(0, Math.min(s.totalDuration(), s.playhead + (action === 'frameBack' ? -frame : frame)))); break;
        case 'secondBack': case 'secondForward': s.setPlayhead(Math.max(0, Math.min(s.totalDuration(), s.playhead + (action === 'secondBack' ? -1 : 1)))); break;
        case 'boundaryBack': case 'boundaryForward': {
          const times = [...new Set(s.project.clips.flatMap(c => [c.start, c.start + c.duration]))].sort((a,b) => a-b);
          const next = action === 'boundaryBack' ? times.filter(t => t < s.playhead - frame / 2).at(-1) : times.find(t => t > s.playhead + frame / 2);
          if (next !== undefined) s.setPlayhead(next);
          break;
        }
        case 'split': splitWithToast(); break;
        case 'delete':
          if (s.selectedTransitionId) { const id = s.selectedTransitionId; s.selectTransition(null); s.removeTransition(id); }
          else if (s.rippleEnabled) s.deleteSelectedRipple(); else s.deleteSelected();
          break;
        case 'undo': s.undo(); break;
        case 'redo': s.redo(); break;
        case 'start': s.setPlayhead(0); break;
        case 'end': s.setPlayhead(s.totalDuration()); break;
        case 'zoomIn': s.setZoom(s.pxPerSec * 1.25); break;
        case 'zoomOut': s.setZoom(s.pxPerSec / 1.25); break;
        case 'snapping': s.setSnap(!s.snapEnabled); break;
        case 'addMarker': { const id = s.addMarker(s.playhead); if (id) window.dispatchEvent(new CustomEvent('cw-edit-marker', { detail: id })); break; }
        case 'previousMarker': case 'nextMarker': {
          const markers = (s.project.markers ?? []).slice().sort((a,b) => a.time-b.time);
          const next = action === 'previousMarker' ? markers.filter(m => m.time < s.playhead - 1e-6).at(-1) : markers.find(m => m.time > s.playhead + 1e-6);
          if (next) { s.setPlaying(false); s.setPlayhead(next.time); }
          break;
        }
        case 'previewFit': window.dispatchEvent(new Event('cw-preview-fit')); break;
        case 'previewZoomIn': window.dispatchEvent(new Event('cw-preview-zoom-in')); break;
        case 'previewZoomOut': window.dispatchEvent(new Event('cw-preview-zoom-out')); break;
        case 'panToggle': window.dispatchEvent(new Event('cw-preview-pan-toggle')); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app" style={{ '--libw': `${layout.lib}px`, '--tlh': `${layout.tl}px` } as React.CSSProperties}>
      <TopBar onOpenShortcuts={() => setShortcutsOpen(true)} />
      {recovery && (
        <div className="recoverybar">
          <span>{uiText("Recovered autosave of “")}{recovery.project.name}{uiText("” from")}{" "}{new Date(recovery.at).toLocaleTimeString(locale)}.</span>
          <button className="primary" disabled={restoring} onClick={() => void restoreRecovery()}>{restoring ? uiText("Restoring…") : uiText("Restore")}</button>
          <button disabled={restoring} onClick={() => setRecovery(null)}>{uiText("Dismiss")}</button>
        </div>
      )}
      <div className="main">
        <Library onOpenSettings={() => setSettingsOpen(true)} />
        <div className="splitter-v" role="separator" tabIndex={0} aria-label={uiText("Resize media panel")} aria-orientation="vertical" aria-valuenow={layout.lib} aria-valuemin={210} aria-valuemax={420} onMouseDown={dragSplitter('lib')} onKeyDown={resizeWithKey('lib')} data-tooltip={uiText("Resize media panel · drag or use arrow keys")} />
        <div className="center">
          <Preview />
        </div>
        <SelectionInspector />
      </div>
      <div className="splitter-h" role="separator" tabIndex={0} aria-label={uiText("Resize timeline")} aria-orientation="horizontal" aria-valuenow={layout.tl} aria-valuemin={190} aria-valuemax={560} onMouseDown={dragSplitter('tl')} onKeyDown={resizeWithKey('tl')} data-tooltip={uiText("Resize timeline · drag or use arrow keys")} />
      <Timeline />
      <Tooltips />
      {settingsOpen && <AgentConnection onClose={() => setSettingsOpen(false)} />}
      {shortcutsOpen && <ShortcutSettings onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function splitWithToast(): void {
  const err = useStore.getState().splitAtPlayhead();
  toast(err ?? uiText("Split at {0}", { 0: fmtTime(useStore.getState().playhead) }));
}

function recoveryCandidate(value: unknown): BrowserRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { at?: unknown; project?: unknown };
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null;
  const validation = validateProject(candidate.project);
  return validation.ok && validation.project ? { at: candidate.at, project: validation.project } : null;
}
