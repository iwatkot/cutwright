import { useEffect, useRef, useState } from 'react';
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

export function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
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
  const [preset, setPreset] = useState<'source' | '1080' | '720' | '480'>('source');
  const inElectron = typeof window !== 'undefined' && !!window.cutwright;
  useEffect(() => {
    const offJobs = exportJobs.subscribe(() => {
      const current = exportJobs.latest(); setJob(current);
      if (!current || current.id === notified.current) return;
      if (current.status === 'completed') { notified.current = current.id; toast(`Rendered ${inElectron ? '→' : 'locally →'} ${current.outputPath || current.fileName}`); }
      if (current.status === 'cancelled' || current.status === 'failed') { notified.current = current.id; toast(current.status === 'cancelled' ? 'Export cancelled' : `Export failed: ${current.error}`); }
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
    if (!validation.ok) { toast(`Cannot save this project: ${validation.errors[0]}`); return; }
    const session = projectSession.current;
    const saving = project;
    const content = JSON.stringify(project, null, 2);
    try {
      if (window.cutwright) {
        const r = await window.cutwright.saveProjectFile(project.name, content);
        if (!r.ok) { if ('error' in r && r.error) toast(`Save failed: ${String(r.error)}`); return; }
        toast(`Project saved${r.path ? ` → ${r.path}` : ''}`);
      } else {
        download(`${project.name.replace(/[^\w\- ]/g, '')}.cutwright.json`, content, 'application/json');
      }
      if (session !== projectSession.current) return;
      savedRef.current = projectFingerprint(saving);
      setDirty(projectFingerprint(useStore.getState().project) !== savedRef.current);
    } catch (err) {
      toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
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
    toast(`Opened ${name}${restored.missing.length ? ` · ${restored.missing.length} missing file(s). Use Import to relink.` : ''}`);
    if (restored.errors.length) toast(`Local media could not be restored: ${restored.errors[0]}`);
  };
  const openProject = async () => {
    const session = ++projectSession.current;
    if (window.cutwright) {
      try {
        const r = await window.cutwright.openProjectFile();
        if (r.ok && r.content) {
          const v = validateProject(JSON.parse(r.content));
          if (v.ok && v.project) await loadProject(v.project, r.name ?? 'project', session);
          else toast(`Invalid project: ${v.errors.join('; ')}`);
        } else if ('error' in r && r.error) toast(`Open failed: ${String(r.error)}`);
      } catch (err) { toast(`Open failed: ${err instanceof Error ? err.message : String(err)}`); }
    } else {
      pickFile('.json,application/json', async (f) => {
        try {
          const v = validateProject(JSON.parse(await f.text()));
          if (v.ok && v.project) await loadProject(v.project, f.name, session);
          else toast(`Invalid project: ${v.errors.join('; ')}`);
        } catch { toast('That file is not a valid CutWright project.'); }
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
        } else toast(`Relinked ${p.name} to the project copy`);
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
      if (picked.length) toast(`Imported ${picked.length} file(s). Click a file to add it to the timeline.`);
    } else {
      pickFile('video/*,audio/*,image/*', async (f) => {
        if (session !== projectSession.current) return;
        const stored = await storeBrowserFile(f);
        if (session !== projectSession.current) return;
        const kind = f.type.startsWith('audio') ? 'audio' as const : f.type.startsWith('image') ? 'image' as const : 'video' as const;
        const d = kind === 'image' ? 10 : await probeDuration(stored.url, kind);
        if (session !== projectSession.current) return;
        // Same filename as missing media relinks its existing timeline edits.
        if (useStore.getState().relinkMedia(f.name, stored.source, d || 0)) toast(`Relinked ${f.name} to the project copy`);
        else addMedia({ id: uid(), name: f.name, kind, src: stored.source, duration: d || 10, color: '#60a5fa' });
        if (!stored.persisted) toast(`${f.name} is available in this tab only. Local saving failed: ${stored.error}`);
      }, true);
    }
    } catch (err) { toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`); }
  };

  const newProject = () => { projectSession.current++; setProject(emptyProject()); useStore.getState().setPlaying(false); useStore.getState().setPlayhead(0); window.dispatchEvent(new Event('cw-project-loaded')); };
  useEffect(() => {
    const create = () => newProject(), importFiles = () => { void importMedia(); };
    window.addEventListener('cw-new', create); window.addEventListener('cw-import', importFiles);
    return () => { window.removeEventListener('cw-new', create); window.removeEventListener('cw-import', importFiles); };
  }, [project]);
  const exportMp4 = async () => {
    try { await exportJobs.start({ preset }); }
    catch (error) { toast(`Export failed: ${error instanceof Error ? error.message : String(error)}`); }
  };

  return (
    <div className={`topbar${inElectron ? '' : ' browser-topbar'}`}>
      <BrandLogo />
      <div className="project-commands" role="group" aria-label="Project commands">
        <IconButton label="New" action="newProject" onClick={newProject}><IconFilePlus /></IconButton>
        <IconButton label="Open" action="openProject" onClick={openProject}><IconFolderOpen /></IconButton>
        <IconButton label="Save" action="saveProject" onClick={saveProject}><IconSave /></IconButton>
      </div>
      <div className="tbsep" />
      <div className="project-title">
        <input className="projname" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value }, true)} aria-label="Project name" data-tooltip={project.name} />
        <span className={`save-state ${dirty ? 'dirty' : ''}`} role="status" data-tooltip={dirty ? 'Unsaved changes · local recovery enabled' : 'No unsaved changes'}><i />{dirty ? 'Unsaved' : 'Saved'}</span>
      </div>
      <div className="spacer" />
      <button className="import-button" onClick={importMedia} data-tooltip={`Import video, audio or images${importShortcut ? ` (${importShortcut})` : ''}`}><IconImport /><span>Import</span></button>
      <SelectControl label="Export preset" className="export-preset" value={preset} onChange={v => setPreset(v as typeof preset)} options={['source','1080','720','480'].map(value=>{ const size=exportDimensions(project,value==='source'?undefined:Number(value)); return {value,label:value==='source'?'Source':`${value}p`,description:`${size.width} × ${size.height}${value==='source'?' · Project size':''}`}; })} />
      {exporting ? (
        <button className="primary export-running" id="export-btn" data-tooltip={`${exportStage && exportStage !== 'Rendering composition' ? exportStage : `Rendering ${progress}%`} · click to cancel`} aria-label={`Cancel export · ${progress}%`} onClick={() => { if (job) void exportJobs.cancel(job.id); }}><span>{exportStage && exportStage !== 'Rendering composition' ? exportStage : `Rendering ${progress}%`}</span> · Cancel</button>
      ) : (
        <button className="primary" id="export-btn" onClick={exportMp4} data-tooltip={`Export video${exportShortcut ? ` (${exportShortcut})` : ''}`}><IconExport />Export</button>
      )}
      <div className="tbsep" />
      <ThemeControl />
      <IconButton label="Keyboard shortcuts" action="shortcuts" onClick={onOpenShortcuts}><IconKeyboard /></IconButton>
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
        catch (error) { toast(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
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
