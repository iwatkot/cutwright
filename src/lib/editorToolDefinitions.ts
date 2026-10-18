export interface EditorToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean } }

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
  op('setProjectInfo', { name: text(200), fps: number(1, 240) }, [], oneOfKeys('name', 'fps')),
  op('addTrack', { trackId: track }, ['trackId']),
  op('addClip', { clipId: id, mediaId: id, trackId: track, start: time, duration: number(.000001, 86400), offset: time, mutedAudio: boolean, volume: number(0, 4) }, ['mediaId', 'trackId', 'start', 'duration']),
  op('addOverlay', { clipId: id, name: text(200), trackId: track, start: time, duration: number(.000001, 86400), overlay }, ['name', 'trackId', 'start', 'duration', 'overlay']),
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
const stagedFile = object({ name: text(32768), url: text(32768), token: text(128) }, ['name', 'url', 'token']);
export const EDITOR_TOOL_DEFINITIONS: EditorToolDefinition[] = [
  { name: 'get_project', description: 'Read the live project, clip/media IDs, transition definitions, semantic revision and recent action history. Media thumbnails/waveforms and account settings are omitted.', inputSchema: object({}), annotations: { readOnlyHint: true } },
  { name: 'save_download', description: 'Save the exact browser-generated editable project or finished video to an absolute local outputPath through the paired connector. Pass downloadUrl returned by save_project or completed get_export. Never overwrites an existing file. Requires this browser tab and the matching retained result. destination is reserved for connector transfer.', inputSchema: { ...object({ ...revisionInput, downloadUrl: text(32768), outputPath: text(32768), destination: object({ url: text(32768), token: text(128) }, ['url', 'token']) }, ['expectedRevision', 'downloadUrl']), ...oneOfKeys('outputPath', 'destination') }, annotations: { readOnlyHint: false } },
  { name: 'seek_preview', description: 'Pause and seek the visible editor preview to timeline seconds. Only changes the viewing position, not project content or history. Wait for decoded preview readiness in the browser before visual inspection.', inputSchema: object({ ...revisionInput, time }, ['expectedRevision', 'time']), annotations: { readOnlyHint: false } },
  { name: 'import_media', description: 'Import original local files into the connected editor library without adding timeline clips. With the browser stdio connector supply absolute paths (up to 20 per call). Files stay on this computer and are stored in this browser origin for reload/recovery. Returns imported media IDs. Use addClip in apply_edits to assemble them. files is reserved for connector-staged local transfers.', inputSchema: { ...object({ ...revisionInput, paths: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: text(32768) }, files: { type: 'array', minItems: 1, maxItems: 20, items: stagedFile } }, ['expectedRevision']), ...oneOfKeys('paths', 'files') }, annotations: { readOnlyHint: false } },
  { name: 'save_project', description: 'Save the current validated editable project. Browser: starts a local .cutwright.json download and returns fileName/downloadUrl; retain original media and use the same browser origin/profile to reopen. Does not export video. Browser download clients choose the disk destination.', inputSchema: object(revisionInput, ['expectedRevision']), annotations: { readOnlyHint: false } },
  { name: 'open_project', description: 'Open an existing validated editable project from an absolute local path using the browser stdio connector. Replaces the current document; save it first. Restores local media from this browser origin and reports missing files. file is reserved for connector-staged transfer.', inputSchema: { ...object({ ...revisionInput, path: text(32768), file: stagedFile }, ['expectedRevision']), ...oneOfKeys('path', 'file') }, annotations: { readOnlyHint: false } },
  { name: 'apply_edits', description: 'Validate and apply all editing operations atomically as one undo step. Supply expectedRevision from get_project. Every operation requires a type field. Examples: {"type":"setClipProps","clipId":"id","volume":0.8}, {"type":"setProjectSize","width":1080,"height":1920}, {"type":"addMarker","time":2,"label":"Intro","color":"#FFD44B"}. Marker IDs are generated; read them with get_project to update/remove. setCanvasSettings requires a complete settings object. Native overlay and canvas coordinates are project pixels; canvas aids never enter exported video. Clip properties are flat fields in each operation.', inputSchema: object({ ...revisionInput, ops: { type: 'array', minItems: 1, maxItems: 100, items: EDITOR_OP_SCHEMA } }, ['expectedRevision', 'ops']), annotations: { readOnlyHint: false } },
  { name: 'undo', description: 'Undo one editing transaction if expectedRevision still matches the live project.', inputSchema: object(revisionInput, ['expectedRevision']), annotations: { readOnlyHint: false } },
  { name: 'redo', description: 'Redo one editing transaction if expectedRevision still matches the live project.', inputSchema: object(revisionInput, ['expectedRevision']), annotations: { readOnlyHint: false } },
  { name: 'export_video', description: 'Start a local video export and return a job ID. preset selects resolution; optional quality selects high (default), balanced or compact detail/file size independently of resolution. Completion is asynchronous; inspect get_export. No media upload or server rendering.', inputSchema: object({ ...revisionInput, preset: { enum: ['source', '1080', '720', '480'] }, quality: { enum: ['high', 'balanced', 'compact'] }, outputPath: text(32768) }, ['expectedRevision', 'preset']), annotations: { readOnlyHint: false } },
  { name: 'get_export', description: 'Read the status/progress/result of an export job by ID.', inputSchema: object({ id }, ['id']), annotations: { readOnlyHint: true } },
  { name: 'cancel_export', description: 'Cancel an export job by ID. Requires the current expectedRevision; does not undo edits or delete a completed export.', inputSchema: object({ ...revisionInput, id }, ['expectedRevision', 'id']), annotations: { readOnlyHint: false } },
];
