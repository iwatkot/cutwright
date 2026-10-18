import type { Project, TransitionDef } from './types';
import { synthesizeTransition } from './transitions';
import { fmtTime } from './srt';
import { validateCanvasSettings, validateProject } from './validate';
import { validateOverlay } from './overlay';
import type { CanvasSettings, NativeOverlay } from './types';
import { deleteLinkedClips, patchLinkedClips, splitLinkedClips, unlinkClipGroup } from './clipEdits';
import { findTransitionAnchor, isEntrance } from './transitionAnchor';
import { resizeProject } from './canvasGeometry';
import { addLinkedAudio } from './linkedAudio';

export interface ClipPropsPatch {
  volume?: number; speed?: number; opacity?: number; scale?: number;
  posX?: number; posY?: number; rotate?: number;
  brightness?: number; contrast?: number; saturation?: number;
  fadeIn?: number; fadeOut?: number; offset?: number;
  fadeInCurve?: number; fadeOutCurve?: number;
  visualFadeIn?: number; visualFadeOut?: number;
  visualFadeInCurve?: number; visualFadeOutCurve?: number;
}

export type AgentOp =
  | { type: 'setProjectInfo'; name?: string; fps?: number }
  | { type: 'addTrack'; trackId: string }
  | { type: 'addClip'; clipId?: string; mediaId: string; trackId: string; start: number; duration: number; offset?: number; mutedAudio?: boolean; volume?: number }
  | { type: 'addOverlay'; clipId?: string; name: string; trackId: string; start: number; duration: number; overlay: NativeOverlay }
  | { type: 'setProjectSize'; width: number; height: number }
  | { type: 'addMarker'; time: number; label: string; color: string }
  | { type: 'updateMarker'; markerId: string; time?: number; label?: string; color?: string }
  | { type: 'removeMarker'; markerId: string }
  | { type: 'setCanvasSettings'; settings: CanvasSettings }
  | { type: 'split'; at: number }
  | { type: 'applyTransition'; defId?: string; transitionName?: string; at: number; duration?: number; clipId?: string }
  | { type: 'applyTransitionAll'; defId?: string; transitionName?: string; duration?: number }
  | { type: 'createTransition'; request: string }
  | { type: 'addSubtitle'; start: number; end?: number; text: string }
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  | { type: 'deleteClip'; clipId: string }
  | { type: 'unlinkClip'; clipId: string }
  | { type: 'setTransitionDuration'; at: number; duration: number }
  | { type: 'removeTransition'; at: number }
  | { type: 'setClipProps'; clipId: string; props: ClipPropsPatch }
  | { type: 'trimClip'; clipId: string; start?: number; duration?: number; offset?: number }
  | { type: 'setTrack'; trackId: string; muted?: boolean; hidden?: boolean; volume?: number }
  | { type: 'reorderTracks'; order: string[] }
  | { type: 'updateSubtitle'; subtitleId: string; text?: string; start?: number; end?: number }
  | { type: 'removeSubtitle'; subtitleId: string }
  | { type: 'setSubtitleStyle'; fontSize?: number; color?: string }
  | { type: 'setOverlay'; clipId: string; overlay: NativeOverlay };

const uid = () => Math.random().toString(36).slice(2, 9);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTime = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 24 * 3600;
const isDur = (v: unknown): v is number => isNum(v) && v > 0 && v <= 30;
const inRange = (v: unknown, min: number, max: number): v is number => isNum(v) && v >= min && v <= max;
const isDimension = (v: unknown): v is number => inRange(v, 2, 16384) && Number.isInteger(v);
const isMarkerId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const isMarkerLabel = (v: unknown): v is string => typeof v === 'string' && v.length <= 200;
const isMarkerColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

const PROP_RANGES: Record<keyof ClipPropsPatch, [number, number]> = {
  volume: [0, 4], speed: [0.1, 8], opacity: [0, 1], scale: [0.1, 3],
  posX: [-50, 50], posY: [-50, 50], rotate: [-180, 180],
  brightness: [0, 2], contrast: [0, 2], saturation: [0, 3],
  fadeIn: [0, 86400], fadeOut: [0, 86400], offset: [0, 24 * 3600],
  fadeInCurve: [-1, 1], fadeOutCurve: [-1, 1],
  visualFadeIn: [0, 86400], visualFadeOut: [0, 86400], visualFadeInCurve: [-1, 1], visualFadeOutCurve: [-1, 1],
};

function parseProps(o: Record<string, unknown>): { props: ClipPropsPatch; bad: string[] } {
  const props: ClipPropsPatch = {};
  const bad: string[] = [];
  for (const key of Object.keys(PROP_RANGES) as (keyof ClipPropsPatch)[]) {
    if (o[key] === undefined) continue;
    const [min, max] = PROP_RANGES[key];
    if (inRange(o[key], min, max)) props[key] = o[key] as number;
    else bad.push(`${key} must be ${min}..${max}`);
  }
  return { props, bad };
}

/** Extract and validate a {"ops":[...]} payload from free-form model text. */
export function parseAgentOps(text: string): { ops: AgentOp[]; errors: string[] } {
  const errors: string[] = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ops: [], errors: ['No JSON ops object found in provider reply'] };
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return { ops: [], errors: ['Provider reply was not valid JSON'] }; }
  const list = (raw as { ops?: unknown }).ops;
  if (!Array.isArray(list)) return { ops: [], errors: ['JSON has no "ops" array'] };
  const ops: AgentOp[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`Malformed op entry (not an object): ${JSON.stringify(item)?.slice(0, 40) ?? String(item)}`);
      continue;
    }
    const o = item as Record<string, unknown>;
    switch (o.type) {
      case 'setProjectInfo':
        if ((o.name === undefined || typeof o.name === 'string' && o.name.trim() && o.name.length <= 200) && (o.fps === undefined || inRange(o.fps, 1, 240)) && (o.name !== undefined || o.fps !== undefined)) ops.push(o as AgentOp);
        else errors.push('setProjectInfo: invalid name or fps');
        break;
      case 'addTrack':
        if (typeof o.trackId === 'string' && /^[va][1-9]\d*$/.test(o.trackId)) ops.push(o as AgentOp);
        else errors.push('addTrack: invalid trackId');
        break;
      case 'addClip':
      case 'addOverlay': {
        const common = typeof o.trackId === 'string' && /^[va][1-9]\d*$/.test(o.trackId) && isTime(o.start) && inRange(o.duration, .000001, 86400) && (o.clipId === undefined || isMarkerId(o.clipId));
        const valid = o.type === 'addClip' ? isMarkerId(o.mediaId) && (o.offset === undefined || isTime(o.offset)) && (o.mutedAudio === undefined || typeof o.mutedAudio === 'boolean') && (o.volume === undefined || inRange(o.volume, 0, 4))
          : typeof o.name === 'string' && o.name.trim() && !validateOverlay(o.overlay).length;
        if (common && valid) ops.push(o as AgentOp); else errors.push(`${o.type}: invalid clip, track or content`);
        break;
      }
      case 'setProjectSize':
        if (isDimension(o.width) && isDimension(o.height)) ops.push({ type: 'setProjectSize', width: o.width, height: o.height });
        else errors.push('setProjectSize: width and height must be integers from 2 to 16384 pixels');
        break;
      case 'addMarker':
        if (isTime(o.time) && isMarkerLabel(o.label) && isMarkerColor(o.color)) ops.push({ type: 'addMarker', time: o.time, label: o.label, color: o.color });
        else errors.push('addMarker: needs time 0..86400, label up to 200 characters and color #RRGGBB');
        break;
      case 'updateMarker': {
        if (!isMarkerId(o.markerId)) { errors.push('updateMarker: missing or invalid markerId'); break; }
        if ((o.time !== undefined && !isTime(o.time)) || (o.label !== undefined && !isMarkerLabel(o.label)) || (o.color !== undefined && !isMarkerColor(o.color))) errors.push('updateMarker: invalid time, label or color');
        else if (o.time === undefined && o.label === undefined && o.color === undefined) errors.push('updateMarker: needs time, label or color');
        else ops.push({ type: 'updateMarker', markerId: o.markerId, ...(o.time !== undefined ? { time: o.time as number } : {}), ...(o.label !== undefined ? { label: o.label as string } : {}), ...(o.color !== undefined ? { color: o.color as string } : {}) });
        break;
      }
      case 'removeMarker':
        if (isMarkerId(o.markerId)) ops.push({ type: 'removeMarker', markerId: o.markerId });
        else errors.push('removeMarker: missing or invalid markerId');
        break;
      case 'setCanvasSettings': {
        const bad = validateCanvasSettings(o.settings);
        if (bad.length) errors.push(`setCanvasSettings: ${bad.join('; ')}`);
        else ops.push({ type: 'setCanvasSettings', settings: structuredClone(o.settings) as CanvasSettings });
        break;
      }
      case 'split':
        if (isTime(o.at)) ops.push({ type: 'split', at: o.at }); else errors.push('split: missing numeric "at"');
        break;
      case 'applyTransition':
        if (o.duration !== undefined && !isDur(o.duration)) errors.push('applyTransition: duration must be 0..30 seconds');
        else if (isTime(o.at)) ops.push({ type: 'applyTransition', defId: typeof o.defId === 'string' ? o.defId : undefined, transitionName: typeof o.transitionName === 'string' ? o.transitionName : undefined, at: o.at, duration: isDur(o.duration) ? o.duration : undefined, ...(typeof o.clipId === 'string' ? { clipId: o.clipId } : {}) });
        else errors.push('applyTransition: missing numeric "at"');
        break;
      case 'applyTransitionAll':
        if (o.duration !== undefined && !isDur(o.duration)) errors.push('applyTransitionAll: duration must be 0..30 seconds');
        else ops.push({ type: 'applyTransitionAll', defId: typeof o.defId === 'string' ? o.defId : undefined, transitionName: typeof o.transitionName === 'string' ? o.transitionName : undefined, duration: isDur(o.duration) ? o.duration : undefined });
        break;
      case 'createTransition':
        if (typeof o.request === 'string' && o.request.trim()) ops.push({ type: 'createTransition', request: o.request });
        else errors.push('createTransition: missing "request"');
        break;
      case 'addSubtitle':
        if (o.end !== undefined && (!isTime(o.end) || (isTime(o.start) && o.end <= o.start))) errors.push('addSubtitle: end must follow start');
        else if (isTime(o.start) && typeof o.text === 'string' && o.text.trim()) ops.push({ type: 'addSubtitle', start: o.start, end: isTime(o.end) ? o.end : undefined, text: o.text });
        else errors.push('addSubtitle: needs numeric "start" and non-empty "text"');
        break;
      case 'moveClip':
        if (o.trackId !== undefined && (typeof o.trackId !== 'string' || !/^[va][1-9]\d*$/.test(o.trackId))) errors.push('moveClip: invalid trackId');
        else if (typeof o.clipId === 'string' && isTime(o.start)) ops.push({ type: 'moveClip', clipId: o.clipId, start: o.start, trackId: typeof o.trackId === 'string' ? o.trackId : undefined });
        else errors.push('moveClip: needs "clipId" and numeric "start"');
        break;
      case 'removeTransition':
        if (isTime(o.at)) ops.push({ type: 'removeTransition', at: o.at });
        else errors.push('removeTransition: missing numeric "at"');
        break;
      case 'setClipProps': {
        const { props, bad } = parseProps(o);
        if (typeof o.clipId !== 'string') errors.push('setClipProps: missing "clipId"');
        else if (bad.length) errors.push(`setClipProps: ${bad.join('; ')}`);
        else if (Object.keys(props).length === 0) errors.push('setClipProps: no recognized properties (volume, speed, opacity, scale, posX, posY, rotate, brightness, contrast, saturation, fadeIn, fadeOut, offset)');
        else ops.push({ type: 'setClipProps', clipId: o.clipId, props });
        break;
      }
      case 'setOverlay': {
        const bad = validateOverlay(o.overlay);
        if (typeof o.clipId !== 'string') errors.push('setOverlay: missing clipId');
        else if (bad.length) errors.push(`setOverlay: ${bad.join('; ')}`);
        else ops.push({ type: 'setOverlay', clipId: o.clipId, overlay: o.overlay as NativeOverlay });
        break;
      }
      case 'trimClip': {
        const start = o.start === undefined ? undefined : (isTime(o.start) ? o.start : null);
        const duration = o.duration === undefined ? undefined : (inRange(o.duration, 0.2, 24 * 3600) ? o.duration : null);
        const offset = o.offset === undefined ? undefined : (inRange(o.offset, 0, 24 * 3600) ? o.offset : null);
        if (typeof o.clipId !== 'string') errors.push('trimClip: missing "clipId"');
        else if (start === null || duration === null || offset === null) errors.push('trimClip: start/duration/offset out of range');
        else if (start === undefined && duration === undefined && offset === undefined) errors.push('trimClip: needs start, duration or offset');
        else ops.push({ type: 'trimClip', clipId: o.clipId, start, duration, offset });
        break;
      }
      case 'setTrack': {
        if (typeof o.trackId !== 'string' || !/^[va]\d+$/.test(o.trackId)) { errors.push('setTrack: needs a trackId like "v2"/"a1"'); break; }
        const muted = typeof o.muted === 'boolean' ? o.muted : undefined;
        const hidden = typeof o.hidden === 'boolean' ? o.hidden : undefined;
        const volume = o.volume === undefined ? undefined : (inRange(o.volume, 0, 4) ? o.volume : null);
        if (volume === null) errors.push('setTrack: volume must be 0..4');
        else if (muted === undefined && hidden === undefined && volume === undefined) errors.push('setTrack: needs muted, hidden or volume');
        else ops.push({ type: 'setTrack', trackId: o.trackId, muted, hidden, volume });
        break;
      }
      case 'reorderTracks':
        if (Array.isArray(o.order) && o.order.length > 0 && o.order.every((x) => typeof x === 'string' && /^[va]\d+$/.test(x))) ops.push({ type: 'reorderTracks', order: o.order as string[] });
        else errors.push('reorderTracks: needs a non-empty "order" array of track ids (top-to-bottom)');
        break;
      case 'updateSubtitle': {
        if (typeof o.subtitleId !== 'string') { errors.push('updateSubtitle: missing "subtitleId"'); break; }
        const text = o.text === undefined ? undefined : (typeof o.text === 'string' && o.text.trim() ? o.text : null);
        const start = o.start === undefined ? undefined : (isTime(o.start) ? o.start : null);
        const end = o.end === undefined ? undefined : (isTime(o.end) ? o.end : null);
        if (text === null || start === null || end === null) errors.push('updateSubtitle: invalid text/start/end');
        else if (text === undefined && start === undefined && end === undefined) errors.push('updateSubtitle: needs text, start or end');
        else ops.push({ type: 'updateSubtitle', subtitleId: o.subtitleId, text, start, end });
        break;
      }
      case 'removeSubtitle':
        if (typeof o.subtitleId === 'string') ops.push({ type: 'removeSubtitle', subtitleId: o.subtitleId });
        else errors.push('removeSubtitle: missing "subtitleId"');
        break;
      case 'setSubtitleStyle': {
        const fontSize = o.fontSize === undefined ? undefined : (inRange(o.fontSize, 8, 96) ? o.fontSize : null);
        const color = o.color === undefined ? undefined : (typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toUpperCase() : null);
        if (fontSize === null || color === null) errors.push('setSubtitleStyle: fontSize 8..96, color #RRGGBB');
        else if (fontSize === undefined && color === undefined) errors.push('setSubtitleStyle: needs fontSize or color');
        else ops.push({ type: 'setSubtitleStyle', fontSize, color });
        break;
      }
      case 'unlinkClip':
      case 'deleteClip':
        if (typeof o.clipId === 'string') ops.push({ type: o.type, clipId: o.clipId });
        else errors.push('deleteClip: missing "clipId"');
        break;
      case 'setTransitionDuration':
        if (isTime(o.at) && isDur(o.duration)) ops.push({ type: 'setTransitionDuration', at: o.at, duration: o.duration });
        else errors.push('setTransitionDuration: needs numeric "at" and "duration"');
        break;
      default:
        errors.push(`Unknown op type: ${String(o.type)}`);
    }
  }
  return { ops, errors };
}

export interface OpsResult { project: Project; applied: string[]; rejected: string[] }

/** Apply validated ops to a project copy. Pure: caller commits once (one undo step). */
export function applyOpsToProject(projectIn: Project, allDefs: TransitionDef[], ops: AgentOp[]): OpsResult {
  const project: Project = JSON.parse(JSON.stringify(projectIn)) as Project;
  const applied: string[] = [];
  const rejected: string[] = [];
  const total = Math.max(0, ...project.clips.map((c) => c.start + c.duration), ...project.subtitles.map((s) => s.end));
  const defs = [...allDefs, ...project.customTransitions];
  const resolveDef = (op: { defId?: string; transitionName?: string }) =>
    defs.find((d) => d.id === op.defId) ?? defs.find((d) => d.name.toLowerCase() === (op.transitionName ?? '').toLowerCase())
    ?? defs.find((d) => d.name.toLowerCase().includes((op.transitionName ?? '').toLowerCase()) && !!op.transitionName);

  const placeTransition = (def: TransitionDef, at: number, duration?: number, clipId?: string) => {
    const anchor = findTransitionAnchor(project, at, clipId);
    if (!anchor || (clipId && anchor.id !== clipId)) { rejected.push(`applyTransition at ${fmtTime(at)}: no matching video clip starts there`); return null; }
    const existing = project.transitions.find((t) => t.anchorClipId === anchor.id || (!t.anchorClipId && Math.abs(t.at - at) < .26));
    const appliedT = { id: existing?.id ?? uid(), defId: def.id, at: anchor.start, duration: duration ?? def.duration ?? 0.6, anchorClipId: anchor.id, ...(isEntrance(project, anchor) ? { entrance: true } : {}) };
    project.transitions = existing
      ? project.transitions.map((t) => (t.id === existing.id ? appliedT : t))
      : [...project.transitions, appliedT];
    return appliedT;
  };

  for (const op of ops) {
    switch (op.type) {
      case 'setProjectInfo':
        if (op.name !== undefined) project.name = op.name;
        if (op.fps !== undefined) project.fps = op.fps;
        applied.push('Updated project name/frame rate');
        break;
      case 'addTrack':
        project.trackSettings = { ...project.trackSettings, [op.trackId]: project.trackSettings?.[op.trackId] ?? {} };
        applied.push(`Added track ${op.trackId}`);
        break;
      case 'addClip': {
        const media = project.media.find(m => m.id === op.mediaId);
        if (!media) { rejected.push(`addClip: unknown media ${op.mediaId}`); break; }
        if (op.clipId && project.clips.some(c => c.id === op.clipId)) { rejected.push(`addClip: duplicate clip ${op.clipId}`); break; }
        if ((op.trackId.startsWith('a') && media.kind === 'image') || (op.trackId.startsWith('v') && media.kind === 'audio')) { rejected.push('addClip: media is incompatible with track'); break; }
        if (media.kind !== 'image' && (op.offset ?? 0) + op.duration > media.duration + .1) { rejected.push('addClip: requested range exceeds source duration'); break; }
        const clip = { id: op.clipId ?? uid(), mediaId: media.id, trackId: op.trackId, name: media.name, start: op.start, duration: op.duration, offset: op.offset ?? 0, color: media.color, ...(op.mutedAudio !== undefined ? { mutedAudio: op.mutedAudio } : {}), ...(op.volume !== undefined ? { volume: op.volume } : {}), ...(media.overlay ? { overlay: structuredClone(media.overlay) } : {}) };
        project.clips.push(clip);
        Object.assign(project, addLinkedAudio(project, clip.id, uid));
        applied.push(`Added clip ${clip.id} on ${op.trackId}`);
        break;
      }
      case 'addOverlay': {
        if (!op.trackId.startsWith('v')) { rejected.push('addOverlay: needs a video track'); break; }
        if (op.clipId && project.clips.some(c => c.id === op.clipId)) { rejected.push(`addOverlay: duplicate clip ${op.clipId}`); break; }
        const mediaId = uid(), clipId = op.clipId ?? uid();
        project.media.push({ id: mediaId, name: op.name, kind: 'image', src: '', duration: op.duration, width: project.width, height: project.height, color: op.overlay.color.slice(0, 7), overlay: structuredClone(op.overlay) });
        project.clips.push({ id: clipId, mediaId, name: op.name, trackId: op.trackId, start: op.start, duration: op.duration, offset: 0, color: op.overlay.color.slice(0, 7), overlay: structuredClone(op.overlay) });
        if (!project.trackOrder?.includes(op.trackId)) project.trackOrder = [op.trackId, ...new Set([...(project.trackOrder ?? []), ...project.clips.map(c => c.trackId).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))])].filter((id,i,all)=>all.indexOf(id)===i);
        applied.push(`Added editable overlay ${clipId}`);
        break;
      }
      case 'setProjectSize':
        if (!isDimension(op.width) || !isDimension(op.height)) { rejected.push('setProjectSize: width and height must be integers from 2 to 16384 pixels'); break; }
        Object.assign(project, resizeProject(project, op.width, op.height));
        applied.push(`Set project size to ${op.width} × ${op.height} pixels`);
        break;
      case 'addMarker': {
        if ((project.markers?.length ?? 0) >= 1000) { rejected.push('addMarker: timeline supports at most 1000 markers'); break; }
        const id = globalThis.crypto?.randomUUID?.() ?? uid();
        project.markers = [...(project.markers ?? []), { id, time: op.time, label: op.label, color: op.color }].sort((a, b) => a.time - b.time);
        applied.push(`Added marker ${id} at ${fmtTime(op.time)}: "${op.label}"`);
        break;
      }
      case 'updateMarker': {
        const marker = project.markers?.find((item) => item.id === op.markerId);
        if (!marker) { rejected.push(`updateMarker: unknown marker ${op.markerId}`); break; }
        project.markers = project.markers!.map((item) => item.id === op.markerId ? {
          ...item,
          ...(op.time !== undefined ? { time: op.time } : {}),
          ...(op.label !== undefined ? { label: op.label } : {}),
          ...(op.color !== undefined ? { color: op.color } : {}),
        } : item).sort((a, b) => a.time - b.time);
        applied.push(`Updated marker ${op.markerId}`);
        break;
      }
      case 'removeMarker':
        if (!project.markers?.some((item) => item.id === op.markerId)) { rejected.push(`removeMarker: unknown marker ${op.markerId}`); break; }
        project.markers = project.markers.filter((item) => item.id !== op.markerId);
        applied.push(`Removed marker ${op.markerId}`);
        break;
      case 'setCanvasSettings': {
        const bad = validateCanvasSettings(op.settings);
        if (bad.length) { rejected.push(...bad.map((error) => `setCanvasSettings: ${error}`)); break; }
        project.editorCanvas = structuredClone(op.settings);
        applied.push(`Updated canvas rulers, grid and ${op.settings.guides.length} guide(s)`);
        break;
      }
      case 'createTransition': {
        const def = synthesizeTransition(op.request);
        project.customTransitions = [...project.customTransitions.filter((d) => d.id !== def.id), def];
        defs.push(def);
        applied.push(`Created reusable transition "${def.name}" (My Creations)`);
        break;
      }
      case 'split': {
        const at = Math.min(Math.max(op.at, 0), total);
        const clip = project.clips.find((c) => at > c.start + 0.05 && at < c.start + c.duration - 0.05);
        if (!clip) { rejected.push(`split at ${fmtTime(at)}: no clip covers that time`); break; }
        Object.assign(project, splitLinkedClips(project, clip.id, at, uid).project);
        applied.push(`Split "${clip.name}" at ${fmtTime(at)}`);
        break;
      }
      case 'applyTransition': {
        const def = resolveDef(op);
        if (!def) { rejected.push(`applyTransition at ${fmtTime(op.at)}: transition not found`); break; }
        if (!placeTransition(def, Math.max(op.at, 0), op.duration, op.clipId)) break;
        applied.push(`Applied "${def.name}" at ${fmtTime(op.at)}`);
        break;
      }
      case 'applyTransitionAll': {
        const def = resolveDef(op);
        if (!def) { rejected.push('applyTransitionAll: transition not found'); break; }
        const v1 = project.clips.filter((c) => c.trackId === 'v1').slice().sort((a, b) => a.start - b.start);
        v1.slice(1).forEach((c) => placeTransition(def, c.start, op.duration));
        applied.push(`Applied "${def.name}" at ${Math.max(0, v1.length - 1)} cut(s)`);
        break;
      }
      case 'addSubtitle': {
        const start = Math.max(op.start, 0);
        const end = Math.max(op.end ?? start + 3, start + 0.04);
        project.subtitles = [...project.subtitles, { id: uid(), start, end, text: op.text }].sort((a, b) => a.start - b.start);
        applied.push(`Added subtitle at ${fmtTime(start)}: "${op.text}"`);
        break;
      }
      case 'moveClip': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip) { rejected.push(`moveClip: unknown clip ${op.clipId}`); break; }
        if (op.trackId && op.trackId[0] !== clip.trackId[0]) {
          rejected.push(`moveClip: cannot move ${clip.trackId.startsWith('v') ? 'video' : 'audio'} clip "${clip.name}" to ${op.trackId.toUpperCase()}`);
          break;
        }
        Object.assign(project, patchLinkedClips(project, clip.id, { start: Math.max(op.start, 0), ...(op.trackId ? { trackId: op.trackId } : {}) }));
        applied.push(`Moved "${clip.name}"${clip.linkGroup ? ' and linked audio/video' : ''} to ${fmtTime(op.start)}${op.trackId ? ` on ${op.trackId.toUpperCase()}` : ''}`);
        break;
      }
      case 'removeTransition': {
        const tr = project.transitions.find((t) => Math.abs(t.at - op.at) < 0.26);
        if (!tr) { rejected.push(`removeTransition at ${fmtTime(op.at)}: no transition there`); break; }
        project.transitions = project.transitions.filter((t) => t.id !== tr.id);
        applied.push(`Removed transition at ${fmtTime(op.at)}`);
        break;
      }
      case 'setClipProps': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip) { rejected.push(`setClipProps: unknown clip ${op.clipId}`); break; }
        Object.assign(project, patchLinkedClips(project, clip.id, op.props));
        applied.push(`Set ${Object.entries(op.props).map(([k, v]) => `${k}=${v}`).join(', ')} on "${clip.name}"`);
        break;
      }
      case 'setOverlay': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip || !clip.trackId.startsWith('v')) { rejected.push(`setOverlay: unknown video clip ${op.clipId}`); break; }
        clip.overlay = structuredClone(op.overlay);
        applied.push(`Updated editable ${op.overlay.kind} on "${clip.name}"`);
        break;
      }
      case 'trimClip': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip) { rejected.push(`trimClip: unknown clip ${op.clipId}`); break; }
        Object.assign(project, patchLinkedClips(project, clip.id, {
          ...(op.start !== undefined ? { start: op.start } : {}), ...(op.duration !== undefined ? { duration: op.duration } : {}), ...(op.offset !== undefined ? { offset: op.offset } : {}),
        }));
        const next = project.clips.find((c) => c.id === clip.id)!;
        applied.push(`Trimmed "${clip.name}"${clip.linkGroup ? ' and linked audio/video' : ''} (start ${next.start.toFixed(2)}s, length ${next.duration.toFixed(2)}s, in-point ${next.offset.toFixed(2)}s)`);
        break;
      }
      case 'setTrack': {
        const known = project.clips.some((c) => c.trackId === op.trackId) || project.trackSettings?.[op.trackId] !== undefined || (project.trackOrder ?? []).includes(op.trackId);
        if (!known) { rejected.push(`setTrack: unknown track ${op.trackId}`); break; }
        project.trackSettings = {
          ...(project.trackSettings ?? {}),
          [op.trackId]: {
            ...(project.trackSettings?.[op.trackId] ?? {}),
            ...(op.muted !== undefined ? { muted: op.muted } : {}),
            ...(op.hidden !== undefined ? { hidden: op.hidden } : {}),
            ...(op.volume !== undefined ? { volume: op.volume } : {}),
          },
        };
        applied.push(`Track ${op.trackId.toUpperCase()}: ${[op.muted !== undefined ? `muted=${op.muted}` : '', op.hidden !== undefined ? `hidden=${op.hidden}` : '', op.volume !== undefined ? `volume=${op.volume}` : ''].filter(Boolean).join(', ')}`);
        break;
      }
      case 'reorderTracks': {
        const knownIds = new Set([...project.clips.map((c) => c.trackId), ...Object.keys(project.trackSettings ?? {}), ...(project.trackOrder ?? [])]);
        const order = [...new Set(op.order)].filter((id) => knownIds.has(id));
        if (!order.length) { rejected.push('reorderTracks: no known track ids in order'); break; }
        project.trackOrder = order;
        applied.push(`Reordered tracks (top-to-bottom): ${order.map((t) => t.toUpperCase()).join(' > ')}`);
        break;
      }
      case 'updateSubtitle': {
        const sub = project.subtitles.find((s) => s.id === op.subtitleId);
        if (!sub) { rejected.push(`updateSubtitle: unknown subtitle ${op.subtitleId}`); break; }
        if (op.text !== undefined) sub.text = op.text;
        if (op.start !== undefined) sub.start = op.start;
        if (op.end !== undefined) sub.end = op.end;
        if (sub.end <= sub.start) sub.end = sub.start + 0.4;
        project.subtitles.sort((a, b) => a.start - b.start);
        applied.push(`Updated subtitle at ${fmtTime(sub.start)}: "${sub.text}"`);
        break;
      }
      case 'removeSubtitle': {
        const sub = project.subtitles.find((s) => s.id === op.subtitleId);
        if (!sub) { rejected.push(`removeSubtitle: unknown subtitle ${op.subtitleId}`); break; }
        project.subtitles = project.subtitles.filter((s) => s.id !== op.subtitleId);
        applied.push(`Removed subtitle at ${fmtTime(sub.start)}: "${sub.text}"`);
        break;
      }
      case 'setSubtitleStyle': {
        project.subtitleStyle = {
          fontSize: 22, color: '#FFFFFF', ...(project.subtitleStyle ?? {}),
          ...(op.fontSize !== undefined ? { fontSize: op.fontSize } : {}),
          ...(op.color !== undefined ? { color: op.color } : {}),
        };
        applied.push(`Subtitle style: ${op.fontSize !== undefined ? `${op.fontSize}px` : ''}${op.fontSize !== undefined && op.color !== undefined ? ', ' : ''}${op.color ?? ''}`.trim());
        break;
      }
      case 'deleteClip': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip) { rejected.push(`deleteClip: unknown clip ${op.clipId}`); break; }
        Object.assign(project, deleteLinkedClips(project, clip.id));
        applied.push(`Deleted "${clip.name}"`);
        break;
      }
      case 'unlinkClip': {
        const clip = project.clips.find((c) => c.id === op.clipId);
        if (!clip?.linkGroup) { rejected.push(`unlinkClip: no linked group for ${op.clipId}`); break; }
        Object.assign(project, unlinkClipGroup(project, clip.id));
        applied.push(`Unlinked picture and audio for "${clip.name}"`);
        break;
      }
      case 'setTransitionDuration': {
        const tr = project.transitions.find((t) => Math.abs(t.at - op.at) < 0.26);
        if (!tr) { rejected.push(`setTransitionDuration at ${fmtTime(op.at)}: no transition there`); break; }
        tr.duration = Math.min(4, Math.max(0.1, op.duration));
        applied.push(`Set transition at ${fmtTime(op.at)} to ${tr.duration.toFixed(1)}s`);
        break;
      }
      default:
        rejected.push('Unsupported op');
    }
  }
  // Enforce the same anchoring invariant as manual edits: transitions follow
  // their anchor clip; anchors that vanished or became first-on-track drop.
  const byTrack = new Map<string, typeof project.clips>();
  project.clips.slice().sort((a, b) => a.start - b.start).forEach((c) => byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]));
  project.transitions = project.transitions.flatMap((t) => {
    if (!t.anchorClipId) return [t];
    const clip = project.clips.find((c) => c.id === t.anchorClipId);
    if (!clip) return [];
    if ((byTrack.get(clip.trackId) ?? [])[0]?.id === clip.id && !t.entrance) return [];
    return [{ ...t, at: clip.start }];
  });
  // A request is a transaction. A rejected member must not leave the valid
  // members behind as an incomplete finishing pass.
  if (rejected.length) return { project: projectIn, applied: [], rejected };
  const validation = validateProject(project);
  if (!validation.ok) return { project: projectIn, applied: [], rejected: validation.errors };
  return { project, applied, rejected };
}

