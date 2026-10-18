import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOpsToProject, parseAgentOps } from '../src/lib/agentOps';
import { defaultCanvasSettings } from '../src/lib/canvasGeometry';
import { createEditorToolController, type EditorToolController } from '../src/lib/editorTools';
import { useStore } from '../src/lib/store';
import type { CanvasSettings, Project, TitleOverlay } from '../src/lib/types';
import { validateProject } from '../src/lib/validate';

const canvas = (): CanvasSettings => ({
  ...defaultCanvasSettings(),
  grid: { visible: true, snap: true, spacingX: 80, spacingY: 45, originX: -20, originY: 10 },
  guides: [{ id: 'guide-x', axis: 'x', position: 160 }, { id: 'guide-y', axis: 'y', position: 90 }],
});
const title = (): TitleOverlay => ({ kind: 'title', text: 'Project pixels', fontFamily: 'Arial', fontSize: 40, fontWeight: 600, color: '#FFFFFF', x: 320, y: 180, blockWidth: 400, lineHeight: 48, align: 'center' });
const fixture = (): Project => ({
  version: 1, name: 'RC commands', width: 640, height: 360, fps: 30,
  media: [
    { id: 'source', name: 'Original.mp4', kind: 'video', src: 'cutwright-local:original', duration: 8, width: 640, height: 360, color: '#222222' },
    { id: 'template', name: 'Title', kind: 'image', src: '', duration: 4, width: 640, height: 360, color: '#FFFFFF', overlay: title() },
  ],
  clips: [
    { id: 'video', mediaId: 'source', trackId: 'v1', name: 'Original', start: 0, duration: 8, offset: 0, color: '#222222' },
    { id: 'title', mediaId: 'template', trackId: 'v2', name: 'Title', start: 0, duration: 4, offset: 0, color: '#FFFFFF', overlay: title() },
  ],
  transitions: [], subtitles: [], customTransitions: [], trackSettings: {},
  markers: [{ id: 'existing', time: 3, label: 'Old marker', color: '#22AAFF' }], editorCanvas: canvas(),
});
const initial = useStore.getState();
const controllers: EditorToolController[] = [];
function controller() {
  const result = createEditorToolController({ enabled: true });
  controllers.push(result);
  return result;
}
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
  useStore.setState({ ...initial, project: fixture(), past: [], future: [] }, true);
});
afterEach(() => {
  controllers.splice(0).forEach((item) => item.dispose());
  vi.unstubAllGlobals();
  useStore.setState(initial, true);
});

describe('RC project, marker and canvas agent commands', () => {
  it('parses all five additions with bounded complete canvas settings and empty marker labels', () => {
    const ops = [
      { type: 'setProjectSize', width: 360, height: 640 },
      { type: 'addMarker', time: 0, label: '', color: '#aAbBcc' },
      { type: 'updateMarker', markerId: 'existing', time: 2.25, label: 'Beat', color: '#FFD44B' },
      { type: 'removeMarker', markerId: 'existing' },
      { type: 'setCanvasSettings', settings: canvas() },
    ];
    expect(parseAgentOps(JSON.stringify({ ops }))).toEqual({ ops, errors: [] });
  });

  it.each([
    { type: 'setProjectSize', width: 0, height: 1920 },
    { type: 'setProjectSize', width: 1080.5, height: 1920 },
    { type: 'setProjectSize', width: 1080, height: 16385 },
    { type: 'addMarker', time: -1, label: 'Beat', color: '#FFD44B' },
    { type: 'addMarker', time: 86401, label: 'Beat', color: '#FFD44B' },
    { type: 'addMarker', time: 1, label: 'x'.repeat(201), color: '#FFD44B' },
    { type: 'addMarker', time: 1, label: 'Beat', color: '#FFD44BFF' },
    { type: 'updateMarker', markerId: 'existing' },
    { type: 'updateMarker', markerId: '', label: 'Beat' },
    { type: 'updateMarker', markerId: 'existing', time: '2' },
    { type: 'updateMarker', markerId: 'existing', label: null },
    { type: 'removeMarker', markerId: 1 },
    { type: 'setCanvasSettings', settings: { rulers: true } },
    { type: 'setCanvasSettings', settings: { ...canvas(), grid: { ...canvas().grid, spacingX: 0 } } },
    { type: 'setCanvasSettings', settings: { ...canvas(), guides: [{ id: 'bad', axis: 'z', position: 1 }] } },
    { type: 'setCanvasSettings', settings: { ...canvas(), guides: [{ id: 'same', axis: 'x', position: 1 }, { id: 'same', axis: 'y', position: 2 }] } },
  ])('rejects invalid command input in the parser: %j', (op) => {
    const result = parseAgentOps(JSON.stringify({ ops: [op] }));
    expect(result.ops).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('resizes landscape to portrait using project geometry and preserves originals and marker times', () => {
    const project = fixture(), before = structuredClone(project);
    const result = applyOpsToProject(project, [], [{ type: 'setProjectSize', width: 360, height: 640 }]);
    expect(result.rejected).toEqual([]);
    expect(result.project).toMatchObject({ width: 360, height: 640 });
    expect(result.project.clips[1].overlay).toMatchObject({ x: 180, y: 320, fontSize: 40, blockWidth: 225, lineHeight: 48 });
    expect(result.project.media[1].overlay).toEqual(result.project.clips[1].overlay);
    expect(result.project.media[0]).toEqual(before.media[0]);
    expect(result.project.markers).toEqual(before.markers);
    expect(result.project.editorCanvas?.guides.map((guide) => guide.position)).toEqual([90, 160]);
    expect(project).toEqual(before);
    expect(validateProject(result.project).ok).toBe(true);
  });

  it('adds optional marker/canvas fields to legacy projects without changing media or timing', () => {
    const project = fixture();
    delete project.markers;
    delete project.editorCanvas;
    const settings = canvas();
    const result = applyOpsToProject(project, [], [
      { type: 'addMarker', time: 8, label: 'End', color: '#123456' },
      { type: 'setCanvasSettings', settings },
    ]);
    expect(result.rejected).toEqual([]);
    expect(validateProject(JSON.parse(JSON.stringify(result.project))).ok).toBe(true);
    expect(result.project.clips).toEqual(project.clips);
    expect(result.project.media).toEqual(project.media);
    expect(result.project.markers).toHaveLength(1);
    settings.guides[0].position = 999;
    settings.grid.originX = 999;
    expect(result.project.editorCanvas?.guides[0].position).toBe(160);
    expect(result.project.editorCanvas?.grid.originX).toBe(-20);
    expect(project).not.toHaveProperty('markers');
    expect(project).not.toHaveProperty('editorCanvas');
  });

  it('rejects canvas guide counts above the shared validation bound before committing', async () => {
    const settings = { ...canvas(), guides: Array.from({ length: 201 }, (_, index) => ({ id: `guide-${index}`, axis: 'x' as const, position: index })) };
    expect(parseAgentOps(JSON.stringify({ ops: [{ type: 'setCanvasSettings', settings }] })).errors.join(' ')).toContain('200 guides');
    const c = controller(), before = useStore.getState().project;
    expect(await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [{ type: 'setCanvasSettings', settings }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS' } });
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toEqual([]);
  });

  it('keeps seven tools and applies the new commands as one exact undo/redo transaction', async () => {
    const c = controller(), before = structuredClone(useStore.getState().project), revision = c.status.revision;
    expect(c.listTools()).toHaveLength(13);
    const changes: Project[] = [];
    const unsubscribe = useStore.subscribe((state, previous) => { if (state.project !== previous.project) changes.push(state.project); });
    const result = await c.execute('apply_edits', { expectedRevision: revision, ops: [
      { type: 'setProjectSize', width: 360, height: 640 },
      { type: 'updateMarker', markerId: 'existing', time: 4, label: 'Updated', color: '#FF4400' },
      { type: 'addMarker', time: 1, label: 'Intro', color: '#FFD44B' },
      { type: 'setCanvasSettings', settings: canvas() },
    ] });
    unsubscribe();
    expect(result).toMatchObject({ ok: true, changed: true, operationCount: 4 });
    expect(changes).toHaveLength(1);
    expect(useStore.getState().past).toHaveLength(1);
    const edited = structuredClone(useStore.getState().project), generated = edited.markers![0];
    expect(generated).toMatchObject({ time: 1, label: 'Intro', color: '#FFD44B' });
    expect(generated.id).toBeTruthy();
    expect(generated.id).not.toBe('existing');
    expect(edited.markers![1]).toMatchObject({ id: 'existing', time: 4, label: 'Updated', color: '#FF4400' });
    expect(edited.editorCanvas).toEqual(canvas());
    expect((await c.execute('get_project')).project).toEqual(edited);
    const undo = await c.execute('undo', { expectedRevision: result.revision });
    expect(undo.ok).toBe(true);
    expect(useStore.getState().project).toEqual(before);
    const redo = await c.execute('redo', { expectedRevision: undo.revision });
    expect(redo.ok).toBe(true);
    expect(useStore.getState().project).toEqual(edited);
    expect(new Set([revision, result.revision, undo.revision, redo.revision]).size).toBe(4);
  });

  it('edits/removes generated marker IDs and retains markers, portrait settings and guides through save/open/recovery data', async () => {
    const c = controller();
    const created = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [
      { type: 'setProjectSize', width: 360, height: 640 }, { type: 'addMarker', time: 5, label: 'New', color: '#66AAFF' },
    ] });
    expect(created.ok).toBe(true);
    const markerId = useStore.getState().project.markers!.find((item) => item.id !== 'existing')!.id;
    const result = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [
      { type: 'updateMarker', markerId, time: 1.5, label: 'Saved beat', color: '#AA33FF' },
      { type: 'removeMarker', markerId: 'existing' }, { type: 'setCanvasSettings', settings: canvas() },
    ] });
    expect(result.ok).toBe(true);
    const edited = structuredClone(useStore.getState().project);
    const undone = await c.execute('undo', { expectedRevision: result.revision });
    expect(undone.ok).toBe(true);
    expect(useStore.getState().project.markers).toHaveLength(2);
    expect((await c.execute('redo', { expectedRevision: undone.revision })).ok).toBe(true);
    expect(useStore.getState().project).toEqual(edited);
    const saved = validateProject(JSON.parse(JSON.stringify(edited)));
    const recovered = validateProject(structuredClone({ at: 1000, project: edited }).project);
    expect(saved.ok).toBe(true);
    expect(recovered.ok).toBe(true);
    useStore.getState().setProject(saved.project!, true);
    expect(useStore.getState().project).toEqual(edited);
    useStore.getState().setProject(recovered.project!, true);
    expect(useStore.getState().project).toEqual(edited);
    expect(edited.markers).toEqual([{ id: markerId, time: 1.5, label: 'Saved beat', color: '#AA33FF' }]);
    // This checks serialized/recovered project data; real IndexedDB/UI recovery is a separate acceptance gate.
  });

  it.each([
    { type: 'setProjectSize', width: 360.5, height: 640 },
    { type: 'setProjectSize', width: 360, height: Infinity },
    { type: 'addMarker', time: 1, label: 'Beat', color: '#123456', markerId: 'caller-id' },
    { type: 'updateMarker', markerId: 'existing', color: '#123456', unexpected: true },
    { type: 'updateMarker', markerId: 'existing' },
    { type: 'removeMarker', markerId: 'existing', time: 0 },
    { type: 'setCanvasSettings', settings: { ...canvas(), extra: true } },
    { type: 'setCanvasSettings', settings: { ...canvas(), grid: { visible: true, snap: false } } },
  ])('rejects schema errors before any mixed-batch mutation: %j', async (op) => {
    const c = controller(), before = useStore.getState().project, revision = c.status.revision;
    const result = await c.execute('apply_edits', { expectedRevision: revision, ops: [{ type: 'updateMarker', markerId: 'existing', label: 'Must roll back' }, op] });
    expect(result).toMatchObject({ ok: false, revision, error: { code: 'INVALID_ARGUMENTS' } });
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toEqual([]);
    expect(c.status.history).toEqual([]);
  });

  it.each([
    { type: 'updateMarker', markerId: 'missing', time: 1 },
    { type: 'removeMarker', markerId: 'missing' },
    { type: 'setCanvasSettings', settings: { ...canvas(), guides: [{ id: 'same', axis: 'x', position: 1 }, { id: 'same', axis: 'y', position: 2 }] } },
  ])('rolls back semantic failures together with valid resize and marker edits: %j', async (op) => {
    const c = controller(), before = useStore.getState().project, revision = c.status.revision;
    const result = await c.execute('apply_edits', { expectedRevision: revision, ops: [
      { type: 'setProjectSize', width: 360, height: 640 }, { type: 'addMarker', time: 1, label: 'Must roll back', color: '#123456' }, op,
    ] });
    expect(result).toMatchObject({ ok: false, revision, error: { code: op.type === 'setCanvasSettings' ? 'INVALID_ARGUMENTS' : 'REJECTED_EDITS' } });
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toEqual([]);
    expect(useStore.getState().future).toEqual([]);
  });

  it('rejects a transaction that exceeds the persisted marker limit without losing earlier edits', async () => {
    useStore.setState((state) => ({ project: { ...state.project, markers: Array.from({ length: 999 }, (_, index) => ({ id: `m-${index}`, time: index, label: '', color: '#123456' })) } }));
    const c = controller(), before = useStore.getState().project, revision = c.status.revision;
    const result = await c.execute('apply_edits', { expectedRevision: revision, ops: [
      { type: 'addMarker', time: 1, label: '1000th', color: '#123456' }, { type: 'addMarker', time: 2, label: 'Too many', color: '#123456' },
    ] });
    expect(result).toMatchObject({ ok: false, revision, error: { code: 'REJECTED_EDITS' } });
    expect(useStore.getState().project).toBe(before);
    expect(useStore.getState().past).toEqual([]);
  });

  it('preserves redo/revision for equivalent commands and rejects stale edits after manual canvas changes', async () => {
    const c = controller();
    const resized = await c.execute('apply_edits', { expectedRevision: c.status.revision, ops: [{ type: 'setProjectSize', width: 360, height: 640 }] });
    const undone = await c.execute('undo', { expectedRevision: resized.revision });
    const noOp = await c.execute('apply_edits', { expectedRevision: undone.revision, ops: [
      { type: 'setProjectSize', width: 640, height: 360 }, { type: 'setCanvasSettings', settings: canvas() },
      { type: 'updateMarker', markerId: 'existing', time: 3, label: 'Old marker', color: '#22AAFF' },
    ] });
    expect(noOp).toMatchObject({ ok: true, changed: false, revision: undone.revision });
    expect(useStore.getState().future).toHaveLength(1);
    const oldRevision = c.status.revision;
    useStore.getState().setCanvasSettings({ ...canvas(), guidesLocked: true });
    const current = useStore.getState().project;
    expect(await c.execute('apply_edits', { expectedRevision: oldRevision, ops: [{ type: 'removeMarker', markerId: 'existing' }] })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    expect(useStore.getState().project).toBe(current);
    expect(useStore.getState().future).toEqual([]);
  });
});
