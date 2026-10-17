import type { Clip, Project } from './types';

/** Reuse an available audio lane without covering existing sound or changing its mix. */
function audioLane(project: Project, video: Clip): string {
  const preferred = `a${video.trackId.slice(1)}`;
  const ids = new Set(['a1', ...project.clips.map(c => c.trackId), ...Object.keys(project.trackSettings ?? {}), ...(project.trackOrder ?? [])]);
  const mix = project.trackSettings?.[video.trackId];
  const needsOwnMix = !!(mix?.muted || mix?.hidden || (mix?.volume ?? 1) !== 1);
  const available = (id: string) => {
    const settings = project.trackSettings?.[id];
    return !settings?.muted && !settings?.hidden && (settings?.volume ?? 1) === 1
      && !project.clips.some(c => c.trackId === id && c.start < video.start + video.duration - 1e-6 && c.start + c.duration > video.start + 1e-6);
  };
  if (!needsOwnMix && available(preferred)) return preferred;
  if (!needsOwnMix) for (const id of [...ids].filter(id => id.startsWith('a')).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}))) if (available(id)) return id;
  let n = 1;
  while (ids.has(`a${n}`)) n++;
  return `a${n}`;
}

export function canDetachAudio(project: Project, clipId: string): boolean {
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip) return false;
  if (clip.linkGroup) return project.clips.some(c => c.linkGroup === clip.linkGroup && c.trackId.startsWith('a'));
  const media = project.media.find(m => m.id === clip.mediaId);
  return clip.trackId.startsWith('v') && media?.kind === 'video' && media.hasAudio !== false && !clip.mutedAudio;
}

/** Existing detached clips are explicit: never recreate deleted or independent sound on reopen. */
export function addLinkedAudio(project: Project, clipId: string, id: () => string): Project {
  const video = project.clips.find(c => c.id === clipId);
  if (!video || video.mutedAudio || video.linkGroup !== undefined || !video.trackId.startsWith('v')) return project;
  const media = project.media.find(m => m.id === video.mediaId);
  if (media?.kind !== 'video' || media.hasAudio !== true) return project;
  const group = id(), audioId = id();
  const audio: Clip = {
    id: audioId, mediaId: video.mediaId, name: video.name, trackId: audioLane(project, video),
    start: video.start, duration: video.duration, offset: video.offset, color: video.color,
    speed: video.speed, volume: video.volume, fadeIn: video.fadeIn, fadeOut: video.fadeOut,
    ...(video.audioEnvelope ? {audioEnvelope: {...video.audioEnvelope}} : {}), linkGroup: group,
  };
  // Preserve the previous audible mix when the picture lane has a gain or mute setting.
  const mix = project.trackSettings?.[video.trackId];
  const ownMix = !!(mix?.muted || mix?.hidden || (mix?.volume ?? 1) !== 1);
  return {...project, ...(ownMix ? {trackSettings:{...project.trackSettings,[audio.trackId]:{...mix}}} : {}), clips: [...project.clips.map(c => c.id === video.id ? {...c, mutedAudio:true, linkGroup:group} : c), audio]};
}

export function materializeLinkedAudio(project: Project, id: () => string): Project {
  for (const clip of project.clips) project = addLinkedAudio(project, clip.id, id);
  return project;
}

export function detachClipAudio(project: Project, clipId: string, id: () => string): Project {
  if (!canDetachAudio(project, clipId)) return project;
  let clip = project.clips.find(c => c.id === clipId)!;
  if (!clip.linkGroup) {
    // Older projects can still keep sound inside the picture clip.
    const media = project.media.find(m => m.id === clip.mediaId)!;
    project = addLinkedAudio({...project, media:project.media.map(m => m === media ? {...m, hasAudio:true} : m), clips:project.clips.map(c => c.id === clipId ? {...c, linkGroup:undefined} : c)}, clipId, id);
    clip = project.clips.find(c => c.id === clipId)!;
  }
  const group = clip.linkGroup;
  return {...project, clips:project.clips.map(c => c.linkGroup === group ? {...c, linkGroup:null} : c)};
}
