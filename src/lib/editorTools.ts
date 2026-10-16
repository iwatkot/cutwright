import { useStore } from './store';
import { parseAgentOps, applyOpsToProject } from './agentOps';
import { validateProject } from './validate';
import type { Project } from './types';

export type EditorExportPreset = 'source' | '1080' | '720' | '480';
export interface EditorExportJobSnapshot {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  progress: number;
  stage?: string; error?: string; outputPath?: string; downloadUrl?: string;
  [key: string]: unknown;
}
export interface EditorExportJobs {
  start(input: { preset: EditorExportPreset; outputPath?: string }): EditorExportJobSnapshot | Promise<EditorExportJobSnapshot>;
  get(id: string): EditorExportJobSnapshot | undefined | Promise<EditorExportJobSnapshot | undefined>;
  cancel(id: string): Promise<boolean>;
}
export interface EditorToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean } }
export interface EditorActionEntry {
  id: number; timestamp: string; tool: string; outcome: 'applied' | 'rejected';
  summary: string; revisionBefore: string; revisionAfter: string;
}
export interface EditorToolStatus { enabled: boolean; revision: string; canUndo: boolean; canRedo: boolean; history: EditorActionEntry[] }
export type EditorToolResult = { ok: boolean; revision: string; error?: { code: string; message: string; details?: string[] }; [key: string]: unknown };
export interface EditorToolOptions {
  jobs?: EditorExportJobs;
  enabled?: boolean;
  historyLimit?: number;
  store?: Pick<typeof useStore, 'getState' | 'setState' | 'subscribe'>;
}

type Schema = Record<string, unknown>;
const text = (maxLength = 1000): Schema => ({ type: 'string', minLength: 1, maxLength });
const number = (minimum: number, maximum: number): Schema => ({ type: 'number', minimum, maximum });
const time = number(0, 86400), duration = number(.000001, 30), id = text(256);
const track = { ...id, pattern: '^[va][1-9][0-9]*$' }, boolean = { type: 'boolean' };
const object = (properties: Schema, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const oneOfKeys = (...keys: string[]) => ({ anyOf: keys.map((key) => ({ required: [key] })) });
const animation = { animationOffset: number(-86400, 86400), animationDuration: number(.001, 86400), fadeIn: number(0, 86400), fadeOut: number(0, 86400) };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$' };
const markerColor = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const markerLabel = { type: 'string', maxLength: 200 };
const dimension = { type: 'integer', minimum: 2, maximum: 16384 };
const canvasSettings = object({
  rulers: boolean, guidesVisible: boolean, guidesLocked: boolean, snap: boolean,
  grid: object({ visible: boolean, snap: boolean, spacingX: number(1, 16384), spacingY: number(1, 16384), originX: number(-16384, 16384), originY: number(-16384, 16384) }, ['visible', 'snap', 'spacingX', 'spacingY', 'originX', 'originY']),
  guides: { type: 'array', maxItems: 200, items: object({ id, axis: { enum: ['x', 'y'] }, position: number(-16384, 32768) }, ['id', 'axis', 'position']) },
}, ['rulers', 'guidesVisible', 'guidesLocked', 'snap', 'grid', 'guides']);
const overlay = { oneOf: [
  object({ kind: { const: 'arrow' }, ...animation, x1: number(-100000, 100000), y1: number(-100000, 100000), x2: number(-100000, 100000), y2: number(-100000, 100000), color, width: number(.1, 2000), head: boolean, drawDuration: number(0, 86400) }, ['kind', 'x1', 'y1', 'x2', 'y2', 'color', 'width', 'head']),
  object({ kind: { const: 'title' }, ...animation, text: { type: 'string', maxLength: 100000 }, fontFamily: text(200), fontSize: number(1, 2000), fontWeight: number(100, 1000), color, x: number(-100000, 100000), y: number(-100000, 100000), blockWidth: number(0, 100000), lineHeight: number(1, 10000), align: { enum: ['left', 'center', 'right'] }, scroll: object({ fromY: { type: 'number' }, toY: { type: 'number' }, duration: number(.000001, 86400) }, ['fromY', 'toY', 'duration']) }, ['kind', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'color', 'x', 'y', 'blockWidth', 'lineHeight', 'align']),
] };
const op = (type: string, properties: Schema, required: string[] = [], extra: Schema = {}) => ({ ...object({ type: { const: type }, ...properties }, ['type', ...required]), ...extra });
const choice = { defId: id, transitionName: text(200) };
const clipProperties = { volume: number(0, 4), speed: number(.1, 8), opacity: number(0, 1), scale: number(.1, 3), posX: number(-50, 50), posY: number(-50, 50), rotate: number(-180, 180), brightness: number(0, 2), contrast: number(0, 2), saturation: number(0, 3), fadeIn: number(0, 30), fadeOut: number(0, 30), offset: time };
export const EDITOR_OP_SCHEMA: Schema = { oneOf: [
  op('setProjectSize', { width: dimension, height: dimension }, ['width', 'height']),
  op('addMarker', { time, label: markerLabel, color: markerColor }, ['time', 'label', 'color']),
  op('updateMarker', { markerId: id, time, label: markerLabel, color: markerColor }, ['markerId'], oneOfKeys('time', 'label', 'color')),
  op('removeMarker', { markerId: id }, ['markerId']),
  op('setCanvasSettings', { settings: canvasSettings }, ['settings']),
  op('split', { at: time }, ['at']),
  op('applyTransition', { ...choice, at: time, duration, clipId: id }, ['at'], oneOfKeys('defId', 'transitionName')),
  op('applyTransitionAll', { ...choice, duration }, [], oneOfKeys('defId', 'transitionName')),
  op('createTransition', { request: text(2000) }, ['request']),
  op('addSubtitle', { start: time, end: time, text: text(100000) }, ['start', 'text']),
  op('moveClip', { clipId: id, start: time, trackId: track }, ['clipId', 'start']),
  op('deleteClip', { clipId: id }, ['clipId']), op('unlinkClip', { clipId: id }, ['clipId']),
  op('setTransitionDuration', { at: time, duration: number(.1, 4) }, ['at', 'duration']),
  op('removeTransition', { at: time }, ['at']),
  op('setClipProps', { clipId: id, ...clipProperties }, ['clipId'], oneOfKeys(...Object.keys(clipProperties))),
  op('trimClip', { clipId: id, start: time, duration: number(.2, 86400), offset: time }, ['clipId'], oneOfKeys('start', 'duration', 'offset')),
  op('setTrack', { trackId: track, muted: boolean, hidden: boolean, volume: number(0, 4) }, ['trackId'], oneOfKeys('muted', 'hidden', 'volume')),
  op('reorderTracks', { order: { type: 'array', items: track, minItems: 1, maxItems: 1000, uniqueItems: true } }, ['order']),
  op('updateSubtitle', { subtitleId: id, text: text(100000), start: time, end: time }, ['subtitleId'], oneOfKeys('text', 'start', 'end')),
  op('removeSubtitle', { subtitleId: id }, ['subtitleId']),
  op('setSubtitleStyle', { fontSize: number(8, 96), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, [], oneOfKeys('fontSize', 'color')),
  op('setOverlay', { clipId: id, overlay }, ['clipId', 'overlay']),
] };
const revisionInput = { expectedRevision: text(256) };
export const EDITOR_TOOL_DEFINITIONS: EditorToolDefinition[] = [
  { name: 'get_project', description: 'Read the live project, clip/media IDs, transition definitions, semantic revision and recent action history. Media thumbnails/waveforms and account settings are omitted.', inputSchema: object({}), annotations: { readOnlyHint: true } },
  { name: 'apply_edits', description: 'Validate and apply all editing operations atomically as one undo step. Supply expectedRevision from get_project. Every operation requires a type field. Examples: {"type":"setClipProps","clipId":"id","volume":0.8}, {"type":"setProjectSize","width":1080,"height":1920}, {"type":"addMarker","time":2,"label":"Intro","color":"#FFD44B"}. Marker IDs are generated; read them with get_project to update/remove. setCanvasSettings requires a complete settings object. Native overlay and canvas coordinates are project pixels; canvas aids never enter exported video. Clip properties are flat fields in each operation.', inputSchema: object({ ...revisionInput, ops: { type: 'array', minItems: 1, maxItems: 100, items: EDITOR_OP_SCHEMA } }, ['expectedRevision', 'ops']), annotations: { readOnlyHint: false } },
  { name: 'undo', description: 'Undo one editing transaction if expectedRevision still matches the live project.', inputSchema: object(revisionInput, ['expectedRevision']), annotations: { readOnlyHint: false } },
  { name: 'redo', description: 'Redo one editing transaction if expectedRevision still matches the live project.', inputSchema: object(revisionInput, ['expectedRevision']), annotations: { readOnlyHint: false } },
  { name: 'export_video', description: 'Start a local video export and return a job ID. Completion is asynchronous; inspect get_export. No media upload or server rendering.', inputSchema: object({ ...revisionInput, preset: { enum: ['source', '1080', '720', '480'] }, outputPath: text(32768) }, ['expectedRevision', 'preset']), annotations: { readOnlyHint: false } },
  { name: 'get_export', description: 'Read the status/progress/result of an export job by ID.', inputSchema: object({ id }, ['id']), annotations: { readOnlyHint: true } },
  { name: 'cancel_export', description: 'Cancel an export job by ID. Requires the current expectedRevision; does not undo edits or delete a completed export.', inputSchema: object({ ...revisionInput, id }, ['expectedRevision', 'id']), annotations: { readOnlyHint: false } },
];

function schemaErrors(value: unknown, schema: Schema, path = 'arguments'): string[] {
  if (Array.isArray(schema.oneOf)) { const matches = schema.oneOf.filter((s) => !schemaErrors(value, s as Schema, path).length); return matches.length === 1 ? [] : [`${path}: does not match one supported operation/descriptor schema`]; }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => !schemaErrors(value, s as Schema, path).length)) return [`${path}: needs one of the supported fields`];
  if (schema.const !== undefined && value !== schema.const || Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: unsupported value`];
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return [`${path}: must be an object`];
  if (schema.type === 'array' && !Array.isArray(value)) return [`${path}: must be an array`];
  if (schema.type === 'string' && typeof value !== 'string') return [`${path}: must be a string`];
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${path}: must be a finite number`];
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return [`${path}: must be an integer`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path}: must be a boolean`];
  const errors: string[] = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) errors.push(`${path}.${key}: required`);
    for (const key of Object.keys(obj)) {
      if (schema.additionalProperties === false && !Object.hasOwn(properties, key)) errors.push(`${path}.${key}: unexpected field`);
      if (Object.hasOwn(properties, key)) errors.push(...schemaErrors(obj[key], properties[key], `${path}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: invalid item count`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items as Schema, `${path}[${index}]`)));
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength || typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: invalid text length`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid format`);
  }
  if (typeof value === 'number' && (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum)) errors.push(`${path}: outside allowed range`);
  return errors;
}

/** Derived media availability/preview caches never invalidate an agent's edit. */
export function semanticProject(project: Project): Project {
  return { ...project, media: project.media.map(({ thumb: _thumb, peaks: _peaks, offline: _offline, ...media }) => media) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createEditorToolController(options: EditorToolOptions = {}) {
  const store = options.store ?? useStore, listeners = new Set<(status: EditorToolStatus) => void>();
  const session = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  let enabled = options.enabled ?? false, disposed = false, generation = 0, actionId = 0;
  let semantic = canonical(semanticProject(store.getState().project));
  let history: EditorActionEntry[] = [];
  const historyLimit = Number.isFinite(options.historyLimit) ? Math.max(1, Math.min(100, Math.floor(options.historyLimit!))) : 30;
  const revision = () => `cw-${session}-${generation}`;
  const status = (): EditorToolStatus => ({ enabled: enabled && !disposed, revision: revision(), canUndo: !!store.getState().past.length, canRedo: !!store.getState().future.length, history: history.map((item) => ({ ...item })) });
  const notify = () => { if (!disposed) listeners.forEach((listener) => { try { listener(status()); } catch { /* Observers cannot interrupt an editing transaction. */ } }); };
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.project !== previous.project) { const next = canonical(semanticProject(state.project)); if (next !== semantic) { semantic = next; generation++; } }
    if (state.project !== previous.project || state.past !== previous.past || state.future !== previous.future) notify();
  });
  const record = (tool: string, before: string, summary: string, outcome: EditorActionEntry['outcome'] = 'applied') => {
    history = [...history.slice(Math.max(0, history.length - historyLimit + 1)), { id: ++actionId, timestamp: new Date().toISOString(), tool, outcome, summary: summary.slice(0, 500), revisionBefore: before, revisionAfter: revision() }]; notify();
  };
  const failure = (code: string, message: string, details?: string[]): EditorToolResult => ({ ok: false, revision: revision(), error: { code, message, ...(details?.length ? { details } : {}) } });
  async function execute(name: string, raw: unknown = {}): Promise<EditorToolResult> {
    if (disposed) return failure('DISPOSED', 'The editor tool connection is closed.');
    if (!enabled) return failure('DISABLED', 'Editor tools are disabled. Enable them in Connections.');
    const definition = EDITOR_TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) return failure('UNKNOWN_TOOL', `Unknown editor tool: ${name}`);
    const errors = schemaErrors(raw, definition.inputSchema);
    if (errors.length) return failure('INVALID_ARGUMENTS', 'Tool arguments were rejected.', errors);
    const args = raw as Record<string, unknown>, before = revision();
    if (!definition.annotations.readOnlyHint && args.expectedRevision !== before) return failure('STALE_REVISION', 'The project changed. Read get_project and retry with its revision.');
    try {
      if (name === 'get_project') return { ok: true, revision: revision(), project: clone(semanticProject(store.getState().project)), definitions: clone(store.getState().allDefs()), canUndo: status().canUndo, canRedo: status().canRedo, history: status().history };
      if (name === 'apply_edits') {
        const text = JSON.stringify({ ops: args.ops });
        if (text.length > 2 * 1024 * 1024) return failure('INVALID_ARGUMENTS', 'Editing transaction exceeds the 2 MiB input limit.');
        const parsed = parseAgentOps(text);
        if (parsed.errors.length) return failure('INVALID_ARGUMENTS', 'Editing transaction was rejected.', parsed.errors);
        const current = store.getState(), result = applyOpsToProject(current.project, current.allDefs(), parsed.ops);
        const validation = validateProject(result.project);
        const rejected = [...result.rejected, ...validation.errors];
        if (rejected.length) { record(name, before, rejected.join('; '), 'rejected'); return failure('REJECTED_EDITS', 'No edits were applied.', rejected); }
        const changed = canonical(semanticProject(result.project)) !== semantic;
        if (changed) {
          store.setState({ project: result.project, past: [...current.past.slice(-40), clone(current.project)], future: [], selectedClipId: null, selectedSubId: null, selectedTransitionId: null, previewDefId: null });
          // Reusable definitions share the same persistence key as manual edits.
          try { localStorage.setItem('cutwright.customTransitions', JSON.stringify(result.project.customTransitions)); } catch { /* local persistence unavailable */ }
          record(name, before, `${parsed.ops.length} operation(s): ${result.applied.join('; ')}`);
        }
        return { ok: true, revision: revision(), changed, applied: result.applied, operationCount: parsed.ops.length };
      }
      if (name === 'undo' || name === 'redo') {
        const current = store.getState(), available = name === 'undo' ? current.past.length : current.future.length;
        if (!available) return failure(name === 'undo' ? 'NO_UNDO' : 'NO_REDO', `Nothing to ${name}.`);
        current[name](); record(name, before, name === 'undo' ? 'Undid one editing transaction.' : 'Redid one editing transaction.');
        return { ok: true, revision: revision(), canUndo: status().canUndo, canRedo: status().canRedo };
      }
      if (!options.jobs) return failure('EXPORT_UNAVAILABLE', 'Export jobs are unavailable in this editor session.');
      if (name === 'export_video') {
        const job = await options.jobs.start({ preset: args.preset as EditorExportPreset, ...(typeof args.outputPath === 'string' ? { outputPath: args.outputPath } : {}) });
        record(name, before, `Started local export (${String(args.preset)}).`); return { ok: true, revision: revision(), job: clone(job) };
      }
      const jobId = args.id as string;
      if (name === 'get_export') { const job = await options.jobs.get(jobId); return job ? { ok: true, revision: revision(), job: clone(job) } : failure('EXPORT_NOT_FOUND', `Unknown export job: ${jobId}`); }
      const cancelled = await options.jobs.cancel(jobId); record(name, before, cancelled ? 'Requested export cancellation.' : 'Export was already finished or unavailable.', cancelled ? 'applied' : 'rejected');
      return { ok: true, revision: revision(), cancelled };
    } catch (error) { const message = error instanceof Error ? error.message : String(error); if (!definition.annotations.readOnlyHint) record(name, before, message, 'rejected'); return failure('TOOL_ERROR', message); }
  }
  return { execute, listTools: () => enabled && !disposed ? clone(EDITOR_TOOL_DEFINITIONS) : [], setEnabled(value: boolean) { if (disposed || enabled === value) return; enabled = value; generation++; notify(); },
    /** Explicit New/Open/recovery boundaries also invalidate identical content. */
    invalidateRevision() { if (!disposed) { generation++; notify(); } },
    get enabled() { return enabled && !disposed; }, get status() { return status(); }, subscribe(listener: (status: EditorToolStatus) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { if (disposed) return; enabled = false; notify(); disposed = true; unsubscribe(); listeners.clear(); },
  };
}
export type EditorToolController = ReturnType<typeof createEditorToolController>;
