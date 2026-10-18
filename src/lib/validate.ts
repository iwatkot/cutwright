import type { Project } from './types';
import { validProjectFonts } from './projectFonts';
import { validateOverlay } from './overlay';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTrack = (v: unknown): v is string => typeof v === 'string' && /^[va][1-9]\d*$/.test(v);
const between = (v: unknown, lo: number, hi: number): v is number => isFin(v) && v >= lo && v <= hi;

export function validateCanvasSettings(raw: unknown): string[] {
  if (!isObj(raw)) return ['Invalid canvas settings'];
  const errors: string[] = [];
  if (['rulers', 'guidesVisible', 'guidesLocked', 'snap'].some((key) => typeof raw[key] !== 'boolean')) errors.push('Invalid canvas visibility/snapping flags');
  const grid = raw.grid;
  if (!isObj(grid) || typeof grid.visible !== 'boolean' || typeof grid.snap !== 'boolean'
    || !between(grid.spacingX, 1, 16384) || !between(grid.spacingY, 1, 16384)
    || !between(grid.originX, -16384, 16384) || !between(grid.originY, -16384, 16384)) errors.push('Invalid grid (spacing 1..16384, origin ±16384 pixels)');
  if (!Array.isArray(raw.guides) || raw.guides.length > 200) errors.push('Canvas supports at most 200 guides');
  else {
    const ids = new Set<string>();
    for (const guide of raw.guides) {
      if (!isObj(guide) || !isId(guide.id) || ids.has(guide.id) || !['x', 'y'].includes(String(guide.axis)) || !between(guide.position, -16384, 32768)) errors.push('Invalid or duplicate canvas guide');
      else ids.add(guide.id);
    }
  }
  return errors;
}

export function validateProject(raw: unknown): { ok: boolean; project?: Project; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['Project file is not a JSON object'] };
  const p = raw as Partial<Project> & Record<string, unknown>;
  if (p.version !== 1) errors.push(`Unsupported project version: ${String(p.version)} (expected 1)`);
  if (typeof p.name !== 'string' || !p.name) errors.push('Missing project name');
  if (p.fonts !== undefined && !validProjectFonts(p.fonts)) errors.push('Invalid embedded project fonts.');
  if (!between(p.width, 2, 16384) || !Number.isInteger(p.width) || !between(p.height, 2, 16384) || !Number.isInteger(p.height) || !between(p.fps, 1, 240)) errors.push('Invalid width, height or fps (dimensions 2..16384, fps 1..240)');
  for (const key of ['media', 'clips', 'transitions', 'subtitles', 'customTransitions'] as const) {
    if (!Array.isArray(p[key])) { errors.push(`Missing or invalid "${key}" list`); continue; }
    (p[key] as unknown[]).forEach((entry, i) => {
      if (!isObj(entry)) errors.push(`"${key}" entry #${i + 1} is null or not an object`);
    });
  }
  if (errors.length) return { ok: false, errors };

  const media = p.media as Project['media'];
  const clips = p.clips as Project['clips'];
  const transitions = p.transitions as Project['transitions'];
  const subtitles = p.subtitles as Project['subtitles'];

  for (const key of ['media', 'clips', 'transitions', 'subtitles', 'customTransitions'] as const) {
    const ids = new Set<string>();
    for (const entry of p[key] as { id: string }[]) {
      if (!isId(entry.id)) errors.push(`A "${key}" entry is missing an id`);
      else if (ids.has(entry.id)) errors.push(`Duplicate id "${entry.id}" in "${key}"`);
      else ids.add(entry.id);
    }
  }

  for (const m of media) {
    if (m.overlay !== undefined) errors.push(...validateOverlay(m.overlay).map((e) => `${m.name}: ${e}`));
    if (typeof m.id !== 'string' || typeof m.name !== 'string') errors.push('A media entry is missing id/name');
    if (!['video', 'audio', 'image'].includes(m.kind) || typeof m.src !== 'string') errors.push(`Media "${String(m.name)}" has invalid kind/source`);
    if (!isFin(m.duration) || m.duration < 0) errors.push(`Media "${String(m.name)}" has invalid duration`);
    if (m.hasAudio !== undefined && typeof m.hasAudio !== 'boolean') errors.push(`Media "${String(m.name)}" has invalid audio metadata`);
    if (m.peaks !== undefined && (!Array.isArray(m.peaks) || m.peaks.some((n) => !between(n, 0, 1)))) errors.push(`Media "${String(m.name)}" has invalid waveform data`);
  }
  const mediaIds = new Set(media.map((m) => m.id));
  for (const clip of clips) {
    if (clip.overlay !== undefined) errors.push(...validateOverlay(clip.overlay).map((e) => `${clip.name}: ${e}`));
    if (!mediaIds.has(clip.mediaId)) errors.push(`Clip "${String(clip.name)}" references missing media ${String(clip.mediaId)}`);
    if (!isTrack(clip.trackId) || typeof clip.name !== 'string') errors.push(`Clip "${String(clip.name)}" has invalid track/name`);
    if (!isFin(clip.start) || clip.start < 0) errors.push(`Clip "${String(clip.name)}" has invalid start`);
    if (!isFin(clip.duration) || clip.duration <= 0) errors.push(`Clip "${String(clip.name)}" has invalid duration`);
    if (!isFin(clip.offset) || clip.offset < 0) errors.push(`Clip "${String(clip.name)}" has invalid offset`);
    if (clip.volume !== undefined && (!isFin(clip.volume) || clip.volume < 0 || clip.volume > 4)) errors.push(`Clip "${String(clip.name)}" has invalid volume (0..4)`);
    if (clip.speed !== undefined && (!isFin(clip.speed) || clip.speed < 0.1 || clip.speed > 8)) errors.push(`Clip "${String(clip.name)}" has invalid speed (0.1..8)`);
    if (clip.opacity !== undefined && (!isFin(clip.opacity) || clip.opacity < 0 || clip.opacity > 1)) errors.push(`Clip "${String(clip.name)}" has invalid opacity (0..1)`);
    const ranges = { scale: [0.1, 3], posX: [-50, 50], posY: [-50, 50], rotate: [-180, 180], brightness: [0, 2], contrast: [0, 2], saturation: [0, 3], fadeIn: [0, 86400], fadeOut: [0, 86400], fadeInCurve: [-1, 1], fadeOutCurve: [-1, 1], visualFadeIn: [0, 86400], visualFadeOut: [0, 86400], visualFadeInCurve: [-1, 1], visualFadeOutCurve: [-1, 1] };
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
      const value = clip[key];
      const [min, max] = ranges[key];
      if (value !== undefined && !between(value, min, max)) errors.push(`Clip "${String(clip.name)}" has invalid ${key} (${min}..${max})`);
    }
    if (clip.mutedAudio !== undefined && typeof clip.mutedAudio !== 'boolean') errors.push(`Clip "${String(clip.name)}" has invalid mutedAudio flag`);
    if (clip.linkGroup !== undefined && clip.linkGroup !== null && !isId(clip.linkGroup)) errors.push(`Clip "${String(clip.name)}" has invalid linked group`);
    for (const kind of ['audioEnvelope', 'visualEnvelope'] as const) {
      const e = clip[kind];
      if (e === undefined) continue;
      if (!isObj(e) || !between(e.offset, -86400, 86400) || !between(e.duration, .001, 86400) || !between(e.fadeIn, 0, 86400) || !between(e.fadeOut, 0, 86400)) { errors.push(`Clip "${String(clip.name)}" has invalid ${kind}`); continue; }
      for (const key of ['fadeInStart', 'fadeOutEnd'] as const) if (e[key] !== undefined && !between(e[key], -86400, 86400)) errors.push(`Clip "${String(clip.name)}" has invalid ${kind} ${key}`);
      for (const key of ['fadeInWindow', 'fadeOutWindow'] as const) if (e[key] !== undefined && !between(e[key], .001, 86400)) errors.push(`Clip "${String(clip.name)}" has invalid ${kind} ${key}`);
      for (const key of ['fadeInCurve', 'fadeOutCurve'] as const) if (e[key] !== undefined && !between(e[key], -1, 1)) errors.push(`Clip "${String(clip.name)}" has invalid ${kind} ${key}`);
    }
  }
  for (const t of transitions) {
    if (typeof t.defId !== 'string' || !isFin(t.at) || t.at < 0 || !isFin(t.duration) || t.duration <= 0) {
      errors.push('A transition has invalid defId/at/duration');
    }
  }
  for (const s of subtitles) {
    if (!isFin(s.start) || s.start < 0 || !isFin(s.end) || s.end <= s.start || typeof s.text !== 'string') {
      errors.push('A subtitle has invalid timing or text');
    }
  }
  if (p.trackOrder !== undefined && (!Array.isArray(p.trackOrder) || !p.trackOrder.every(isTrack) || new Set(p.trackOrder).size !== p.trackOrder.length)) errors.push('Invalid track order (unique video/audio track ids required)');
  if (p.trackSettings !== undefined) {
    if (!isObj(p.trackSettings)) errors.push('Invalid track settings');
    else for (const [id, settings] of Object.entries(p.trackSettings)) {
      if (!isTrack(id) || !isObj(settings)
        || (settings.volume !== undefined && !between(settings.volume, 0, 4))
        || (settings.muted !== undefined && typeof settings.muted !== 'boolean')
        || (settings.hidden !== undefined && typeof settings.hidden !== 'boolean')) errors.push(`Invalid settings for track "${id}"`);
    }
  }
  if (p.subtitleStyle !== undefined && (!isObj(p.subtitleStyle) || !between(p.subtitleStyle.fontSize, 8, 96) || typeof p.subtitleStyle.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.subtitleStyle.color))) errors.push('Invalid subtitle style (fontSize 8..96, color #RRGGBB)');
  if (p.editorCanvas !== undefined) errors.push(...validateCanvasSettings(p.editorCanvas));
  if (p.markers !== undefined) {
    if (!Array.isArray(p.markers) || p.markers.length > 1000) errors.push('Timeline supports at most 1000 markers');
    else {
      const ids = new Set<string>();
      for (const marker of p.markers) {
        if (!isObj(marker) || !isId(marker.id) || ids.has(marker.id) || !between(marker.time, 0, 86400)
          || typeof marker.label !== 'string' || marker.label.length > 200 || typeof marker.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(marker.color)) errors.push('Invalid or duplicate timeline marker');
        else ids.add(marker.id);
      }
    }
  }
  for (const def of p.customTransitions as Project['customTransitions']) {
    if (typeof def.name !== 'string' || typeof def.xfade !== 'string' || !['fade', 'dissolve', 'slide', 'zoom', 'wipe', 'blur'].includes(def.preview) || !between(def.duration, 0.01, 30)) errors.push(`Invalid transition definition "${String(def.id)}"`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, project: { trackSettings: {}, ...(p as unknown as Project) }, errors };
}
