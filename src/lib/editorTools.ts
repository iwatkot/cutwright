import { EDITOR_TOOL_DEFINITIONS } from './editorToolDefinitions';
export { EDITOR_TOOL_DEFINITIONS } from './editorToolDefinitions';
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
export type { EditorToolDefinition } from './editorToolDefinitions';
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
