import type { Clip, Project } from './types';
import { resolveAudioEnvelope } from './audioEnv';
import { resolveVisualEnvelope, visualLastFrame } from './clipFades';

export function linkedClipIds(project: Project, clipId: string): Set<string> {
  const clip = project.clips.find((c) => c.id === clipId);
  return new Set(project.clips.filter((c) => c.id === clipId || (!!clip?.linkGroup && c.linkGroup === clip.linkGroup)).map((c) => c.id));
}

/** Migrate older converted projects where only the muted embedded audio
 * recorded the relationship. Exact source/timing matches are required. */
export function migrateLinkedAudio(project: Project): Project {
  const clips = project.clips.map((c) => ({ ...c }));
  for (const video of clips.filter((c) => c.mutedAudio && c.trackId.startsWith('v') && c.linkGroup === undefined)) {
    const audio = clips.find((c) => c.linkGroup === undefined && c.trackId.startsWith('a') && c.mediaId === video.mediaId
      && Math.abs(c.start - video.start) < .01 && Math.abs(c.duration - video.duration) < .01
      && Math.abs(c.offset - video.offset) < .01 && Math.abs((c.speed ?? 1) - (video.speed ?? 1)) < .001);
    if (audio) { video.linkGroup = `linked-${video.id}`; audio.linkGroup = video.linkGroup; }
  }
  return { ...project, clips };
}

/** Geometry/color belong to the selected clip. Timing and audible settings
 * belong to its linked group; relative source and timeline offsets survive. */
export function patchLinkedClips(project: Project, clipId: string, patch: Partial<Clip>): Project {
  const original = project.clips.find((c) => c.id === clipId);
  if (!original) return project;
  patch = { ...patch };
  // Speed changes preserve the chosen source range. Trimming or changing
  // the in-point cannot request frames beyond a finite audio/video source.
  if (patch.speed !== undefined && patch.duration === undefined) patch.duration = original.duration * (original.speed ?? 1) / patch.speed;
  if (patch.duration !== undefined || patch.offset !== undefined || patch.speed !== undefined) {
    const media = project.media.find((m) => m.id === original.mediaId);
    if (media && media.kind !== 'image' && media.duration > 0) {
      const speed = patch.speed ?? original.speed ?? 1;
      const sourceFrame = Math.min(media.duration, speed / project.fps);
      const offset = Math.min(Math.max(0, patch.offset ?? original.offset), Math.max(0, media.duration - sourceFrame));
      if (patch.offset !== undefined || offset !== original.offset) patch.offset = offset;
      patch.duration = Math.min(patch.duration ?? original.duration, (media.duration - offset) / speed);
    }
  }
  const ids = linkedClipIds(project, clipId);
  const envelope = (c: Clip, next: Clip) => {
    for (const kind of ['audioEnvelope', 'visualEnvelope'] as const) {
      const editable = kind === 'audioEnvelope' || c.id === clipId;
      if (editable && Object.prototype.hasOwnProperty.call(patch, kind)) {
        next[kind] = patch[kind] ? { ...patch[kind] } : undefined;
        continue;
      }
      const inherited = c[kind];
      if (!inherited) continue;
      const ratio = (c.speed ?? 1) / (next.speed ?? 1);
      const phase = (next.offset - c.offset) / (c.speed ?? 1);
      // Fade lengths are timeline seconds, just like unsplit clip fades.
      // Only the inherited source phase/lifetime follows a speed change.
      const e = { ...inherited, offset: (inherited.offset + phase) * ratio, duration: inherited.duration * ratio };
      for (const key of ['fadeInStart', 'fadeInWindow', 'fadeOutEnd', 'fadeOutWindow'] as const) {
        if (e[key] !== undefined) e[key] *= ratio;
      }
      const fi = kind === 'audioEnvelope' ? patch.fadeIn : editable ? patch.visualFadeIn : undefined;
      const fo = kind === 'audioEnvelope' ? patch.fadeOut : editable ? patch.visualFadeOut : undefined;
      const ci = kind === 'audioEnvelope' ? patch.fadeInCurve : editable ? patch.visualFadeInCurve : undefined;
      const co = kind === 'audioEnvelope' ? patch.fadeOutCurve : editable ? patch.visualFadeOutCurve : undefined;
      if (fi !== undefined) { e.fadeIn = fi; e.fadeInStart = e.offset; e.fadeInWindow = next.duration; }
      if (fo !== undefined) { e.fadeOut = fo; e.fadeOutEnd = e.offset + (kind === 'visualEnvelope' ? visualLastFrame(next, project.fps) : next.duration); e.fadeOutWindow = next.duration; }
      if (ci !== undefined) e.fadeInCurve = ci;
      if (co !== undefined) e.fadeOutCurve = co;
      next[kind] = e;
    }
    return next;
  };
  return { ...project, clips: project.clips.map((c) => {
    if (c.id === clipId) return envelope(c, { ...c, ...patch });
    if (!ids.has(c.id)) return c;
    const next = { ...c };
    if (patch.start !== undefined) next.start = Math.max(0, c.start + patch.start - original.start);
    if (patch.duration !== undefined) next.duration = Math.max(.04, c.duration + patch.duration - original.duration);
    if (patch.offset !== undefined) next.offset = Math.max(0, c.offset + patch.offset - original.offset);
    for (const key of ['speed', 'volume', 'fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve'] as const) if (patch[key] !== undefined) next[key] = patch[key];
    return envelope(c, next);
  }) };
}

export function splitLinkedClips(project: Project, clipId: string, at: number, uid: () => string): { project: Project; rightId: string | null; count: number } {
  const ids = linkedClipIds(project, clipId);
  const rightGroup = uid();
  let rightId: string | null = null;
  let count = 0;
  const clips = project.clips.flatMap((c) => {
    if (!ids.has(c.id) || at <= c.start + .05 || at >= c.start + c.duration - .05) return [c];
    const id = uid();
    if (c.id === clipId) rightId = id;
    count++;
    const e = c.audioEnvelope || c.fadeIn || c.fadeOut ? resolveAudioEnvelope(c) : undefined;
    const v = c.visualEnvelope || c.visualFadeIn || c.visualFadeOut ? resolveVisualEnvelope(c, project.fps) : undefined;
    return [{ ...c, duration: at - c.start, ...(e ? { audioEnvelope: { ...e } } : {}), ...(v ? { visualEnvelope: { ...v } } : {}) }, {
      ...c, id, name: c.name + ' (2)', start: at, duration: c.start + c.duration - at,
      offset: c.offset + (at - c.start) * (c.speed ?? 1), ...(c.linkGroup ? { linkGroup: rightGroup } : {}),
      ...(e ? { audioEnvelope: { ...e, offset: e.offset + at - c.start } } : {}),
      ...(v ? { visualEnvelope: { ...v, offset: v.offset + at - c.start } } : {}),
    }];
  });
  return { project: { ...project, clips }, rightId, count };
}

export function deleteLinkedClips(project: Project, clipId: string, ripple = false): Project {
  const ids = linkedClipIds(project, clipId);
  const removed = project.clips.filter((c) => ids.has(c.id));
  return { ...project, clips: project.clips.filter((c) => !ids.has(c.id)).map((c) => {
    if (!ripple) return c;
    const shift = removed.filter((r) => r.trackId === c.trackId && r.start + r.duration <= c.start + .001).reduce((n, r) => n + r.duration, 0);
    return shift ? { ...c, start: Math.max(0, c.start - shift) } : c;
  }) };
}

export function unlinkClipGroup(project: Project, clipId: string): Project {
  const ids = linkedClipIds(project, clipId);
  return { ...project, clips: project.clips.map((c) => ids.has(c.id) ? { ...c, linkGroup: null } : c) };
}
