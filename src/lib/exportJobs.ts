import { useStore } from './store';
import { buildExportArgs } from './ffmpegPlan';
import { subtitlesToAss } from './captions';
import { isBrowserMediaSource } from './browserMedia';
import { validateProject } from './validate';
import type { EditorExportJobSnapshot, EditorExportJobs } from './editorTools';
import { exportQualitySettings } from './exportQuality';

type Job = { snapshot: EditorExportJobSnapshot; abort: AbortController; dispose?: () => Promise<void> };
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let activeId: string | null = null;
let latest: EditorExportJobSnapshot | null = null;
const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* Observers do not own jobs. */ } } };
const terminal = (status: EditorExportJobSnapshot['status']) => ['completed', 'cancelled', 'failed'].includes(status);

function update(job: Job, patch: Partial<EditorExportJobSnapshot>): void {
  job.snapshot = { ...job.snapshot, ...patch };
  latest = job.snapshot;
  emit();
}

/** One export owner for buttons and external agents, in either edition. */
export const exportJobs: EditorExportJobs & {
  subscribe(listener: () => void): () => void;
  latest(): EditorExportJobSnapshot | null;
} = {
  start({ preset, quality = 'high', outputPath }) {
    if (activeId) throw new Error('An export is already running. Cancel it or wait for completion.');
    const qualitySettings = exportQualitySettings(quality);
    const state = useStore.getState();
    const validation = validateProject(state.project);
    if (!validation.ok) throw new Error(`Cannot export this project: ${validation.errors[0]}`);
    const project = structuredClone(state.project);
    const defs = structuredClone(state.allDefs());
    const id = crypto.randomUUID();
    const job: Job = { snapshot: { id, status: 'queued', progress: 0, stage: 'Opening local media', preset, quality }, abort: new AbortController() };
    jobs.set(id, job); activeId = id; latest = job.snapshot;
    state.setPlaying(false);
    // Keep a small number of retrievable results; release retired local files.
    while (jobs.size > 5) {
      const oldest = jobs.entries().next().value as [string, Job];
      jobs.delete(oldest[0]); void oldest[1].dispose?.().catch(() => {});
    }
    emit();
    void Promise.resolve().then(async () => {
      let unsubscribe = () => {};
      try {
        job.abort.signal.throwIfAborted();
        update(job, { status: 'running' });
        const maxHeight = preset === 'source' ? undefined : Number(preset);
        if (window.cutwright) {
          const missing = project.clips.filter((clip) => {
            const media = project.media.find((item) => item.id === clip.mediaId);
            return !clip.overlay && !media?.overlay && (!media?.src || media.src.startsWith('blob:') || isBrowserMediaSource(media.src) || media.offline);
          });
          if (missing.length) throw new Error(`${missing.length} timeline clip(s) need media. Use Import to relink their files before exporting.`);
          const plan = buildExportArgs(project, defs, project.subtitles.length ? 'CWSRTTOKEN' : null, '__OUT__', { maxHeight, crf: qualitySettings.crf });
          unsubscribe = window.cutwright.onExportProgress(({ seconds, total, stage }) => {
            if (!terminal(job.snapshot.status)) update(job, { progress: total > 0 ? Math.min(.99, seconds / total) : 0, stage: stage || 'Rendering composition' });
          });
          update(job, { stage: 'Preparing composition', warnings: plan.warnings });
          job.abort.signal.throwIfAborted();
          const result = await window.cutwright.exportVideo({ args: plan.args, srt: project.subtitles.length ? subtitlesToAss(project) : null, durationSec: plan.duration, outputPath });
          if (!result.ok) {
            if (result.log) console.error(result.log);
            if (job.abort.signal.aborted || /cancel/i.test(result.error ?? '')) throw new DOMException('Export cancelled', 'AbortError');
            throw new Error(result.error || 'Export failed');
          }
          update(job, { status: 'completed', progress: 1, stage: 'Complete', outputPath: result.path });
        } else {
          if (outputPath) throw new Error('Browser exports are downloaded locally; outputPath is available in the desktop edition.');
          const { exportBrowserProject } = await import('./browserExport');
          const result = await exportBrowserProject(project, defs, {
            maxHeight, quality, signal: job.abort.signal,
            onProgress: ({ progress, stage }) => update(job, { progress: progress / 100, stage }),
          });
          job.dispose = result.dispose;
          if (job.abort.signal.aborted) { await result.dispose(); throw new DOMException('Export cancelled', 'AbortError'); }
          const link = document.createElement('a'); link.href = result.url; link.download = result.file.name; link.click();
          update(job, { status: 'completed', progress: 1, stage: 'Complete', downloadUrl: result.url, fileName: result.file.name, report: result.report });
          window.dispatchEvent(new CustomEvent('cw-browser-export-complete', { detail: { fileName: result.file.name, report: result.report } }));
        }
      } catch (error) {
        const cancelled = job.abort.signal.aborted || error instanceof Error && error.name === 'AbortError';
        update(job, { status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'Cancelled' : 'Failed', error: cancelled ? undefined : error instanceof Error ? error.message : String(error) });
      } finally {
        unsubscribe();
        activeId = null;
        emit();
      }
    });
    return job.snapshot;
  },
  get(id) { return jobs.get(id)?.snapshot; },
  async cancel(id) {
    const job = jobs.get(id);
    if (!job || terminal(job.snapshot.status)) return false;
    job.abort.abort();
    update(job, { stage: 'Cancelling' });
    if (window.cutwright) await window.cutwright.cancelExport();
    return true;
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  latest() { return latest; },
};
