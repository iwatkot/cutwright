import type { Clip, Project } from './types';

export function findTransitionAnchor(project: Project, at: number, preferredId?: string | null): Clip | undefined {
  const candidates = project.clips.filter((c) => c.trackId.startsWith('v') && Math.abs(c.start - at) < .26);
  return candidates.find((c) => c.id === preferredId) ?? candidates.find((c) => c.trackId === 'v1') ?? candidates[0];
}

export function isEntrance(project: Project, clip: Clip): boolean {
  return !project.clips.some((c) => c.id !== clip.id && c.trackId === clip.trackId && c.start < clip.start
    && Math.abs(c.start + c.duration - clip.start) < Math.max(.01, 1 / project.fps));
}
