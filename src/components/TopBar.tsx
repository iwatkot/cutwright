import { t as uiText } from '../i18n/core';
import { useEffect, useRef, useState } from 'react';
import LocaleControl from './LocaleControl';
import { localizedDiagnostic } from '../i18n/presentation';
import { useStore, emptyProject, uid } from '../lib/store';
import { exportJobs } from '../lib/exportJobs';
import { validateProject } from '../lib/validate';
import { isBrowserMediaSource, restoreBrowserMedia, storeBrowserFile } from '../lib/browserMedia';
import type { Project } from '../lib/types';
import { IconButton, IconExport, IconFilePlus, IconFolderOpen, IconKeyboard, IconImport, IconSave } from './icons';
import { useShortcutLabel } from '../lib/shortcutPreferences';
import { SelectControl } from './ui/Controls';
import { ThemeControl } from './ui/theme';
import { exportDimensions } from '../lib/outputDimensions';
import BrandLogo from './BrandLogo';
import { projectDownloadBasename } from '../lib/projectFileName';

export function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = localizedDiagnostic(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// Thumbnail/waveform caches and current file availability are derived data,
// so preparing previews after Open must not look like an unsaved edit.
function projectFingerprint(project: Project): string {
  return JSON.stringify({ ...project, media: project.media.map((m) => ({ ...m, thumb: undefined, peaks: undefined, offline: undefined })) });
}

export default function TopBar({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const exportShortcut = useShortcutLabel('export');
  const importShortcut = useShortcutLabel('importMedia');
  const project = useStore((s) => s.project);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef('');
  const projectSession = useRef(0);
  useEffect(() => {
    savedRef.current = projectFingerprint(useStore.getState().project);
    const unsub = useStore.subscribe((s) => setDirty(projectFingerprint(s.project) !== savedRef.current));
    const clean = () => { projectSession.current++; savedRef.current = projectFingerprint(useStore.getState().project); setDirty(false); };
    const invalidate = () => { projectSession.current++; };
    window.addEventListener('cw-project-loaded', clean);
    window.addEventListener('cw-project-will-load', invalidate);
    return () => { unsub(); window.removeEventListener('cw-project-loaded', clean); window.removeEventListener('cw-project-will-load', invalidate); };
  }, []);
  const setProject = useStore((s) => s.setProject);
  const addMedia = useStore((s) => s.addMedia);
  const [job, setJob] = useState(exportJobs.latest());
  const exporting = !!job && ['queued', 'running'].includes(job.status);
  const progress = Math.round((job?.progress ?? 0) * 100);
  const exportStage = job?.stage ?? '';
  const visibleExportStage = localizedDiagnostic(exportStage);
  const [preset, setPreset] = useState<'source' | '1080' | '720' | '480'>('source');
  const inElectron = typeof window !== 'undefined' && !!window.cutwright;
  useEffect(() => {
    const offJobs = exportJobs.subscribe(() => {
      const current = exportJobs.latest(); setJob(current);
      if (!current || current.id === notified.current) return;
      if (current.status === 'completed') { notified.current = current.id; toast(uiText("Rendered {0} {1}", { 0: inElectron ? '→' : uiText("locally →"), 1: current.outputPath || current.fileName })); }
      if (current.status === 'cancelled' || current.status === 'failed') { notified.current = current.id; toast(current.status === 'cancelled' ? uiText("Export cancelled") : uiText("Export failed: {0}", { 0: localizedDiagnostic(current.error) })); }
    });
    return () => { offJobs(); };
  }, []);
  const notified = useRef('');

  useEffect(() => {
    const onSave = () => void saveProject();
    const onOpen = () => void openProject();
    window.addEventListener('cw-save', onSave);
    window.addEventListener('cw-open', onOpen);
    return () => { window.removeEventListener('cw-save', onSave); window.removeEventListener('cw-open', onOpen); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const saveProject = async () => {
    const validation = validateProject(useStore.getState().project);
    if (!validation.ok) { toast(uiText("Cannot save this project: {0}", { 0: localizedDiagnostic(validation.errors[0]) })); return; }
    const session = projectSession.current;
    const saving = project;
    const content = JSON.stringify(project, null, 2);
    try {
      if (window.cutwright) {
        const r = await window.cutwright.saveProjectFile(project.name, content);
        if (!r.ok) { if ('error' in r && r.error) toast(uiText("Save failed: {0}", { 0: localizedDiagnostic(String(r.error)) })); return; }
        toast(uiText("Project saved{0}", { 0: r.path ? ` → ${r.path}` : '' }));
      } else {
        download(`${projectDownloadBasename(project.name)}.cutwright.json`, content, 'application/json');
      }
      if (session !== projectSession.current) return;
      savedRef.current = projectFingerprint(saving);
      setDirty(projectFingerprint(useStore.getState().project) !== savedRef.current);
    } catch (err) {
      toast(uiText("Save failed: {0}", { 0: localizedDiagnostic(err) }));
    }
  };

  const loadProject = async (next: Project, name: string, session: number) => {
    const restored = window.cutwright
      ? { project: { ...next, media: next.media.map((m) => isBrowserMediaSource(m.src) ? { ...m, offline: true } : m) }, missing: [], errors: [] }
      : await restoreBrowserMedia(next);
    if (session !== projectSession.current) return;
    setProject(restored.project);
    useStore.getState().setPlaying(false);
    useStore.getState().setPlayhead(0);
    savedRef.current = projectFingerprint(useStore.getState().project);
    setDirty(false);
    window.dispatchEvent(new Event('cw-project-loaded'));
    toast(uiText("Opened {0}{1}", { 0: name, 1: restored.missing.length ? uiText(" · {0} missing file(s). Use Import to relink.", { 0: restored.missing.length }) : '' }));
    if (restored.errors.length) toast(uiText("Local media could not be restored: {0}", { 0: localizedDiagnostic(restored.errors[0]) }));
  };
  const openProject = async () => {
    const session = ++projectSession.current;
    if (window.cutwright) {
      try {
        const r = await window.cutwright.openProjectFile();
        if (r.ok && r.content) {
          const v = validateProject(JSON.parse(r.content));
          if (v.ok && v.project) await loadProject(v.project, r.name ?? 'project', session);
          else toast(uiText("Invalid project: {0}", { 0: v.errors.map(localizedDiagnostic).join('; ') }));
        } else if ('error' in r && r.error) toast(uiText("Open failed: {0}", { 0: localizedDiagnostic(String(r.error)) }));
      } catch (err) { toast(uiText("Open failed: {0}", { 0: localizedDiagnostic(err) })); }
    } else {
      pickFile('.json,application/json', async (f) => {
        try {
          const v = validateProject(JSON.parse(await f.text()));
          if (v.ok && v.project) await loadProject(v.project, f.name, session);
          else toast(uiText("Invalid project: {0}", { 0: v.errors.map(localizedDiagnostic).join('; ') }));
        } catch { toast(uiText("That file is not a valid CutWright project.")); }
      });
    }
  };

  const importMedia = async () => {
    const session = projectSession.current;
    try {
    if (window.cutwright) {
      const picked = await window.cutwright.pickMedia();
      if (session !== projectSession.current) return;
      for (const p of picked) {
        const existing = useStore.getState().project.media.find((m) => m.name.toLowerCase() === p.name.toLowerCase() && (!m.src || m.offline) && !m.overlay);
        const relinked = useStore.getState().relinkMedia(p.name, p.path, 0);
        const itemId = relinked ? existing?.id ?? useStore.getState().project.media.find((m) => m.name === p.name && m.src === p.path)?.id : uid();
        if (!relinked) {
          const kind = /\.(mp3|wav|m4a)$/i.test(p.name) ? 'audio' as const : /\.(png|jpe?g)$/i.test(p.name) ? 'image' as const : 'video' as const;
          addMedia({ id: itemId!, name: p.name, kind, src: p.path, duration: 10, color: '#60a5fa' });
        } else toast(uiText("Relinked {0} to the project copy", { 0: p.name }));
        // Real metadata: probe duration/dimensions, thumbnail, waveform.
        void (async () => {
          const item = useStore.getState().project.media.find((m) => m.id === itemId);
          if (!item || !window.cutwright) return;
          const update = (patch: Partial<typeof item>) => {
            const current = useStore.getState();
            if (session === projectSession.current && current.project.media.some((m) => m.id === item.id && m.src === p.path)) current.updateMedia(item.id, patch);
          };
          const probe = await window.cutwright.probeMedia(p.path).catch(() => null);
          if (probe?.ok) update({ duration: probe.duration || item.duration, width: probe.width || undefined, height: probe.height || undefined, hasAudio: probe.hasAudio });
          if (item.kind === 'video' || item.kind === 'image') {
            const th = await window.cutwright.mediaThumb(p.path).catch(() => null);
            if (th?.ok && th.url) update({ thumb: th.url });
          }
          if (item.kind !== 'image') {
            const pk = await window.cutwright.mediaPeaks(p.path).catch(() => null);
            if (pk?.ok && pk.peaks.length) update({ peaks: pk.peaks });
          }
        })();
      }
      if (picked.length) toast(uiText("Imported {0} file(s). Click a file to add it to the timeline.", { 0: picked.length }));
    } else {
      pickFile('video/*,audio/*,image/*', async (f) => {
        if (session !== projectSession.current) return;
        const stored = await storeBrowserFile(f);
        if (session !== projectSession.current) return;
        const kind = f.type.startsWith('audio') ? 'audio' as const : f.type.startsWith('image') ? 'image' as const : 'video' as const;
        const d = kind === 'image' ? 10 : await probeDuration(stored.url, kind);
        if (session !== projectSession.current) return;
        // Same filename as missing media relinks its existing timeline edits.
        if (useStore.getState().relinkMedia(f.name, stored.source, d || 0)) toast(uiText("Relinked {0} to the project copy", { 0: f.name }));
        else addMedia({ id: uid(), name: f.name, kind, src: stored.source, duration: d || 10, color: '#60a5fa' });
        if (!stored.persisted) toast(uiText("{0} is available in this tab only. Local saving failed: {1}", { 0: f.name, 1: localizedDiagnostic(stored.error) }));
      }, true);
    }
    } catch (err) { toast(uiText("Import failed: {0}", { 0: localizedDiagnostic(err) })); }
  };

  const newProject = () => { projectSession.current++; setProject(emptyProject()); useStore.getState().setPlaying(false); useStore.getState().setPlayhead(0); window.dispatchEvent(new Event('cw-project-loaded')); };
  useEffect(() => {
    const create = () => newProject(), importFiles = () => { void importMedia(); };
    window.addEventListener('cw-new', create); window.addEventListener('cw-import', importFiles);
    return () => { window.removeEventListener('cw-new', create); window.removeEventListener('cw-import', importFiles); };
  }, [project]);
  const exportMp4 = async () => {
    try { await exportJobs.start({ preset }); }
    catch (error) { toast(uiText("Export failed: {0}", { 0: localizedDiagnostic(error) })); }
  };

  return (
    <div className={`topbar${inElectron ? '' : ' browser-topbar'}`}>
      <BrandLogo />
      <div className="project-commands" role="group" aria-label={uiText("Project commands")}>
        <IconButton label={uiText("New")} action="newProject" onClick={newProject}><IconFilePlus /></IconButton>
        <IconButton label={uiText("Open")} action="openProject" onClick={openProject}><IconFolderOpen /></IconButton>
        <IconButton label={uiText("Save")} action="saveProject" onClick={saveProject}><IconSave /></IconButton>
      </div>
      <div className="tbsep" />
      <div className="project-title">
        <input className="projname" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value }, true)} aria-label={uiText("Project name")} data-tooltip={project.name} />
        <span className={`save-state ${dirty ? 'dirty' : ''}`} role="status" data-tooltip={dirty ? uiText("Unsaved changes · local recovery enabled") : uiText("No unsaved changes")}><i />{dirty ? uiText("Unsaved") : uiText("Saved")}</span>
      </div>
      <div className="spacer" />
      <button className="import-button" onClick={importMedia} data-tooltip={uiText("Import video, audio or images{0}", { 0: importShortcut ? ` (${importShortcut})` : '' })}><IconImport /><span>{uiText("Import")}</span></button>
      <SelectControl label={uiText("Export preset")} className="export-preset" value={preset} onChange={v => setPreset(v as typeof preset)} options={['source','1080','720','480'].map(value=>{ const size=exportDimensions(project,value==='source'?undefined:Number(value)); return {value,label:value==='source'?uiText("Source"):uiText("{0}p", { 0: value }),description:`${size.width} × ${size.height}${value==='source'?uiText(" · Project size"):''}`}; })} />
      {exporting ? (
        <button className="primary export-running" id="export-btn" data-tooltip={uiText("{0} · click to cancel", { 0: exportStage && exportStage !== 'Rendering composition' ? visibleExportStage : uiText("Rendering {0}%", { 0: progress }) })} aria-label={uiText("Cancel export · {0}%", { 0: progress })} onClick={() => { if (job) void exportJobs.cancel(job.id); }}><span>{exportStage && exportStage !== 'Rendering composition' ? visibleExportStage : uiText("Rendering {0}%", { 0: progress })}</span>{" "}{uiText("· Cancel")}</button>
      ) : (
        <button className="primary" id="export-btn" onClick={exportMp4} data-tooltip={uiText("Export video{0}", { 0: exportShortcut ? ` (${exportShortcut})` : '' })}><IconExport />{uiText("Export")}</button>
      )}
      <div className="tbsep" />
      <ThemeControl />
      <LocaleControl />
      <IconButton label={uiText("Keyboard shortcuts")} action="shortcuts" onClick={onOpenShortcuts}><IconKeyboard /></IconButton>
    </div>
  );
}

export function download(name: string, content: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function pickFile(accept: string, cb: (f: File) => void | Promise<void>, multiple = false): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    // Finish each asynchronous import before starting the next, preserving
    // selection order and keeping simultaneous large media writes bounded.
    void (async () => {
      for (const file of files) {
        try { await cb(file); }
        catch (error) { toast(uiText("Could not read {0}: {1}", { 0: file.name, 1: localizedDiagnostic(error) })); }
      }
    })();
  };
  input.click();
}

function probeDuration(url: string, kind: string): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => resolve(0);
    el.src = url;
  });
}
