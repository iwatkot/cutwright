import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorToolController, type EditorExportJobSnapshot, type EditorToolController } from '../src/lib/editorTools';
import { useStore } from '../src/lib/store';
import type { Project } from '../src/lib/types';

const fixture = (): Project => ({
  version: 1, name: 'External tools', width: 640, height: 360, fps: 30,
  media: [{ id: 'm', name: 'Source.mp4', kind: 'video', src: 'local/source.mp4', duration: 20, color: '#111111', thumb: 'derived-thumb', peaks: [.5], offline: true }],
  clips: [{ id: 'c1', mediaId: 'm', trackId: 'v1', name: 'One', start: 0, duration: 6, offset: 0, color: '#111111' },
    { id: 'c2', mediaId: 'm', trackId: 'v1', name: 'Two', start: 6, duration: 6, offset: 6, color: '#222222' }],
  transitions: [], subtitles: [], customTransitions: [],
});
const controllers: EditorToolController[] = [];
function controller(options: Parameters<typeof createEditorToolController>[0] = {}) {
  const result = createEditorToolController({ enabled: true, ...options }); controllers.push(result); return result;
}
const initial = useStore.getState();
beforeEach(() => { useStore.setState({ ...initial, project: fixture(), past: [], future: [] }, true); });
afterEach(() => { controllers.splice(0).forEach((c) => c.dispose()); vi.unstubAllGlobals(); useStore.setState(initial, true); });

describe('external editor tool controller', () => {
  it('commits an entire batch through the actual store once and undoes/redoes one transaction', async () => {
    const c = controller(), before = c.status.revision;
    const changes: Project[] = [], unsubscribe = useStore.subscribe((state, previous) => { if (state.project !== previous.project) changes.push(state.project); });
    const result = await c.execute('apply_edits', { expectedRevision: before, ops: [
      { type: 'split', at: 3 }, { type: 'addSubtitle', start: 1, end: 2, text: 'External agent caption' },
    ] });
    unsubscribe();
    expect(result).toMatchObject({ ok: true, changed: true, operationCount: 2 });
    expect(changes).toHaveLength(1); expect(useStore.getState().past).toHaveLength(1);
    expect(useStore.getState().project.clips).toHaveLength(3); expect(useStore.getState().project.subtitles[0].text).toBe('External agent caption');
    const undo = await c.execute('undo', { expectedRevision: result.revision });
    expect(undo.ok).toBe(true); expect(useStore.getState().project).toEqual(fixture());
    const redo = await c.execute('redo', { expectedRevision: undo.revision });
    expect(redo.ok).toBe(true); expect(useStore.getState().project.clips).toHaveLength(3);
    expect(new Set([before, result.revision, undo.revision, redo.revision]).size).toBe(4);
  });

  it('rejects a mixed invalid batch without any project/history commit', async () => {
    const c = controller(), before = useStore.getState().project;
    const result = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [
      { type: 'setClipProps', clipId: 'c1', volume: .5 }, { type: 'deleteClip', clipId: 'missing' },
    ] });
    expect(result).toMatchObject({ ok: false, error: { code: 'REJECTED_EDITS' } });
    expect(useStore.getState().project).toBe(before); expect(useStore.getState().past).toEqual([]);
    expect(c.status.history[0]).toMatchObject({ outcome: 'rejected', revisionBefore: result.revision, revisionAfter: result.revision });
  });

  it.each([
    [{ type: 'setClipProps', clipId: 'c1', props: { volume: .5 } }],
    [{ type: 'setClipProps', clipId: 'c1', volume: 1, unexpected: true }],
    [{ type: 'setClipProps', clipId: 'c1' }],
    [{ type: 'split', at: NaN }],
    [{ type: 'reorderTracks', order: ['v1', 'v1'] }],
    [{ type: 'unknown' }],
    [],
  ])('validates the complete narrow operation schema before parsing: %j', async (ops) => {
    const c = controller(), revision = c.status.revision;
    expect(await c.execute('apply_edits', { expectedRevision: revision, ops })).toMatchObject({ ok: false, revision, error: { code: 'INVALID_ARGUMENTS' } });
    expect(useStore.getState().past).toEqual([]); expect(useStore.getState().project).toEqual(fixture());
  });

  it('requires current revision on every mutating tool and rejects stale writes after manual edits', async () => {
    const c = controller(), revision = c.status.revision;
    for (const [name, args] of [['apply_edits', { ops: [{ type: 'split', at: 2 }] }], ['undo', {}], ['redo', {}], ['export_video', { preset: '720' }], ['cancel_export', { id: 'job' }]] as const)
      expect(await c.execute(name, args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    useStore.getState().updateClip('c1', { volume: .25 });
    expect(c.status.revision).not.toBe(revision);
    expect(await c.execute('apply_edits', { expectedRevision: revision, ops: [{ type: 'split', at: 2 }] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(useStore.getState().project.clips).toHaveLength(2);
  });

  it('serializes concurrent clients at the synchronous revision check and commit', async () => {
    const first = controller(), second = controller(), a = first.status.revision, b = second.status.revision;
    const [accepted, stale] = await Promise.all([
      first.execute('apply_edits', { expectedRevision: a, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .25 }] }),
      second.execute('apply_edits', { expectedRevision: b, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .75 }] }),
    ]);
    expect(accepted).toMatchObject({ ok: true, changed: true });
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(useStore.getState().project.clips[0].volume).toBe(.25); expect(useStore.getState().past).toHaveLength(1);
    const fresh = second.status.revision;
    expect((await second.execute('apply_edits', { expectedRevision: fresh, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .75 }] })).ok).toBe(true);
    expect(useStore.getState().past).toHaveLength(2);
  });

  it('ignores derived media caches and playhead updates while exposing an immutable semantic snapshot', async () => {
    const c = controller(), revision = c.status.revision;
    useStore.setState((state) => ({ playhead: 5, project: { ...state.project, media: state.project.media.map((m) => ({ ...m, thumb: 'new', peaks: [.1, .8], offline: false })) } }));
    expect(c.status.revision).toBe(revision);
    const result = await c.execute('get_project', {}), project = result.project as Project;
    expect(project.media[0]).not.toHaveProperty('thumb'); expect(project.media[0]).not.toHaveProperty('peaks'); expect(project.media[0]).not.toHaveProperty('offline');
    expect(result).not.toHaveProperty('settings'); expect(result).not.toHaveProperty('chat');
    project.clips[0].name = 'Changed externally'; expect(useStore.getState().project.clips[0].name).toBe('One');
    useStore.setState((state) => ({ project: { ...state.project, media: state.project.media.map((m) => ({ ...m, src: 'relinked/source.mp4' })) } }));
    expect(c.status.revision).not.toBe(revision);
  });

  it('invalidates identical New/Open/recovery documents and a new connection lifetime', async () => {
    const c = controller();
    const apply = (expectedRevision: string) => c.execute('apply_edits', { expectedRevision, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .5 }] });
    const beforeReopen = c.status.revision;
    useStore.setState({ project: fixture() }); expect(c.status.revision).toBe(beforeReopen);
    c.invalidateRevision();
    expect(await apply(beforeReopen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const beforeNew = c.status.revision; c.invalidateRevision();
    expect(await apply(beforeNew)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    const beforeReconnect = c.status.revision; c.setEnabled(false); c.setEnabled(true);
    expect(await apply(beforeReconnect)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect((await apply(c.status.revision)).ok).toBe(true); expect(useStore.getState().past).toHaveLength(1);
  });

  it('branches after undo and preserves the redo stack for a semantic no-op', async () => {
    const c = controller();
    let result = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .25 }] });
    result = await c.execute('undo', { expectedRevision: result.revision });
    const noOp = await c.execute('apply_edits', { expectedRevision: result.revision, ops: [{ type: 'moveClip', clipId: 'c1', start: 0 }] });
    expect(noOp).toMatchObject({ ok: true, changed: false, revision: result.revision }); expect(useStore.getState().future).toHaveLength(1);
    const branch = await c.execute('apply_edits', { expectedRevision: noOp.revision, ops: [{ type: 'setClipProps', clipId: 'c1', volume: .75 }] });
    expect(branch.ok).toBe(true); expect(useStore.getState().future).toEqual([]); expect(useStore.getState().past).toHaveLength(1);
  });

  it('persists reusable transition definitions and bounds compact action history', async () => {
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { setItem });
    const c = controller({ historyLimit: 2 }); c.subscribe(() => { throw new Error('observer error'); });
    const created = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [{ type: 'createTransition', request: 'gentle fade to black' }] });
    expect(created.ok).toBe(true); expect(JSON.parse(setItem.mock.calls[0][1])).toHaveLength(1);
    expect(setItem.mock.calls[0][0]).toBe('cutwright.customTransitions');
    await c.execute('undo', { expectedRevision: c.status.revision }); await c.execute('redo', { expectedRevision: c.status.revision });
    expect(c.status.history.map((a) => a.tool)).toEqual(['undo', 'redo']);
  });

  it('injects asynchronous export jobs without changing project revisions', async () => {
    let job: EditorExportJobSnapshot = { id: 'job1', status: 'running', progress: 0 };
    const jobs = { start: vi.fn(() => job), get: vi.fn((id: string) => id === job.id ? job : undefined), cancel: vi.fn(async () => true) };
    const c = controller({ jobs }), revision = c.status.revision;
    const started = await c.execute('export_video', { expectedRevision: revision, preset: '720', outputPath: 'C:/export.mp4' });
    expect(started).toMatchObject({ ok: true, revision, job }); expect(jobs.start).toHaveBeenCalledWith({ preset: '720', outputPath: 'C:/export.mp4' });
    job = { ...job, progress: .7, stage: 'Encoding' };
    expect(await c.execute('get_export', { id: 'job1' })).toMatchObject({ ok: true, revision, job: { progress: .7 } });
    expect(await c.execute('get_export', { id: 'missing' })).toMatchObject({ ok: false, error: { code: 'EXPORT_NOT_FOUND' } });
    expect(await c.execute('cancel_export', { expectedRevision: revision, id: 'job1' })).toMatchObject({ ok: true, revision, cancelled: true });
    expect(jobs.cancel).toHaveBeenCalledWith('job1'); expect(useStore.getState().past).toEqual([]);
  });

  it('reports unavailable jobs and unavailable undo/redo without mutating state', async () => {
    const c = controller(), expectedRevision = c.status.revision;
    expect(await c.execute('export_video', { expectedRevision, preset: 'source' })).toMatchObject({ error: { code: 'EXPORT_UNAVAILABLE' } });
    expect(await c.execute('undo', { expectedRevision })).toMatchObject({ error: { code: 'NO_UNDO' } });
    expect(await c.execute('redo', { expectedRevision })).toMatchObject({ error: { code: 'NO_REDO' } });
  });

  it('defaults to disabled and permanently rejects saved handles after disposal', async () => {
    const c = controller({ enabled: false }); expect(c.listTools()).toEqual([]);
    expect(await c.execute('get_project', {})).toMatchObject({ error: { code: 'DISABLED' } });
    c.setEnabled(true); expect(c.listTools()).toHaveLength(7);
    const definitions = c.listTools(); definitions[0].name = 'modified'; expect(c.listTools()[0].name).toBe('get_project');
    c.dispose(); c.setEnabled(true); expect(c.enabled).toBe(false); expect(c.listTools()).toEqual([]);
    expect(await c.execute('get_project', {})).toMatchObject({ error: { code: 'DISPOSED' } });
  });
});
