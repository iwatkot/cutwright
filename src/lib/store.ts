import { create } from 'zustand';
import { t as uiText } from '../i18n/core';
import type { AgentSettings, CanvasSettings, ChatMessage, Clip, MediaItem, NativeOverlay, Project, Subtitle, TimelineMarker, TransitionDef } from './types';
import { defaultCanvasSettings, resizeProject } from './canvasGeometry';
import { validateCanvasSettings } from './validate';
import { BUILTIN_TRANSITIONS } from './transitions';
import { deleteLinkedClips, migrateLinkedAudio, patchLinkedClips, splitLinkedClips, unlinkClipGroup } from './clipEdits';
import { addLinkedAudio, canDetachAudio, detachClipAudio, materializeLinkedAudio } from './linkedAudio';
import { findTransitionAnchor, isEntrance } from './transitionAnchor';

const uid = () => Math.random().toString(36).slice(2, 9);
const CLIP_COLORS = ['#2dd4bf', '#f59e0b', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#facc15', '#38bdf8'];

export function emptyProject(): Project {
  return {
    version: 1, name: uiText("Untitled project"), width: 1920, height: 1080, fps: 30,
    media: [], clips: [], transitions: [], subtitles: [], customTransitions: [],
  };
}

export function demoProject(): Project {
  const media: MediaItem[] = [
    { id: 'm-intro', name: 'intro_hook.mp4', kind: 'video', src: '', duration: 6, color: '#2dd4bf' },
    { id: 'm-game', name: 'gameplay_main.mp4', kind: 'video', src: '', duration: 24, color: '#60a5fa' },
    { id: 'm-cam', name: 'facecam_reaction.mp4', kind: 'video', src: '', duration: 12, color: '#f472b6' },
    { id: 'm-outro', name: 'outro_cta.mp4', kind: 'video', src: '', duration: 8, color: '#f59e0b' },
    { id: 'm-music', name: 'background_music.mp3', kind: 'audio', src: '', duration: 50, color: '#a3e635' },
  ];
  const clips: Clip[] = [
    { id: uid(), mediaId: 'm-intro', trackId: 'v1', name: 'intro_hook', start: 0, duration: 6, offset: 0, color: '#2dd4bf' },
    { id: uid(), mediaId: 'm-game', trackId: 'v1', name: 'gameplay_main', start: 6, duration: 24, offset: 4, color: '#60a5fa' },
    { id: uid(), mediaId: 'm-cam', trackId: 'v1', name: 'facecam_reaction', start: 30, duration: 12, offset: 2, color: '#f472b6' },
    { id: uid(), mediaId: 'm-outro', trackId: 'v1', name: 'outro_cta', start: 42, duration: 8, offset: 0, color: '#f59e0b' },
    { id: uid(), mediaId: 'm-music', trackId: 'a1', name: 'background_music', start: 0, duration: 50, offset: 0, color: '#a3e635' },
  ];
  return {
    version: 1,
    name: 'MAPTOPLAY — Episode 14 (demo)',
    width: 1920, height: 1080, fps: 30,
    media, clips,
    transitions: [
      { id: uid(), defId: 'cross-dissolve', at: 6, duration: 0.6 },
      { id: uid(), defId: 'fade-to-black', at: 42, duration: 0.8 },
    ],
    subtitles: [
      { id: uid(), start: 0.4, end: 3.2, text: 'Welcome back to MAPTOPLAY!' },
      { id: uid(), start: 6.5, end: 10.0, text: 'Today we finally beat the water temple.' },
      { id: uid(), start: 30.5, end: 34.0, text: 'No way — did you see that glitch?' },
      { id: uid(), start: 42.5, end: 46.0, text: 'Subscribe for episode 15 tomorrow!' },
    ],
    customTransitions: [],
  };
}

interface EditorState {
  setProjectSize: (width: number, height: number) => void;
  addMarker: (time: number) => string;
  updateMarker: (id: string, patch: Partial<Omit<TimelineMarker, 'id'>>, record?: boolean) => void;
  removeMarker: (id: string) => void;
  setCanvasSettings: (settings: CanvasSettings, record?: boolean) => void;
  project: Project;
  playhead: number;
  playing: boolean;
  selectedClipId: string | null;
  selectedSubId: string | null;
  selectedTransitionId: string | null;
  previewDefId: string | null;
  pxPerSec: number;
  chat: ChatMessage[];
  settings: AgentSettings;
  chatOpen: boolean;
  past: Project[];
  future: Project[];
  allDefs: () => TransitionDef[];
  totalDuration: () => number;
  commit: () => void;
  setProject: (p: Project, keepHistory?: boolean) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (b: boolean) => void;
  selectClip: (id: string | null) => void;
  selectSub: (id: string | null) => void;
  selectTransition: (id: string | null) => void;
  setPreviewDef: (id: string | null) => void;
  updateTransition: (id: string, duration: number, applyToAll?: boolean, record?: boolean) => void;
  setZoom: (n: number) => void;
  setChatOpen: (b: boolean) => void;
  setSettings: (s: Partial<AgentSettings>) => void;
  pushChat: (m: ChatMessage) => void;
  addMedia: (m: MediaItem) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  relinkMedia: (name: string, src: string, duration: number) => boolean;
  addClipFromMedia: (mediaId: string) => void;
  addOverlay: (name: string, overlay: NativeOverlay) => void;
  splitAtPlayhead: () => string | null;
  splitClipAt: (clipId: string, at: number) => void;
  deleteSelected: () => void;
  moveClip: (id: string, start: number) => void;
  trimClip: (id: string, patch: Partial<Pick<Clip, 'start' | 'duration' | 'offset'>>) => void;
  applyTransition: (defId: string, at: number, duration?: number, anchorClipId?: string) => void;
  unlinkClip: (clipId: string) => void;
  detachAudio: (clipId: string) => void;
  removeTransition: (id: string) => void;
  addCustomTransition: (def: TransitionDef) => void;
  addSubtitle: (start: number, end: number, text: string) => void;
  updateSubtitle: (id: string, patch: Partial<Subtitle>, record?: boolean) => void;
  removeSubtitle: (id: string) => void;
  undo: () => void;
  redo: () => void;
  snapEnabled: boolean;
  rippleEnabled: boolean;
  setSnap: (b: boolean) => void;
  setRipple: (b: boolean) => void;
  setTrackSettings: (trackId: string, patch: Partial<import('./types').TrackSettings>) => void;
  addTrack: (kind: 'video' | 'audio') => void;
  removeTrack: (trackId: string) => void;
  updateClip: (id: string, patch: Partial<Clip>, record?: boolean) => void;
  deleteSelectedRipple: () => void;
  setTrackOrder: (order: string[]) => void;
  setSubtitleStyle: (patch: Partial<import('./types').SubtitleStyle>, record?: boolean) => void;
}

const clone = (p: Project): Project => JSON.parse(JSON.stringify(p)) as Project;
const trackIds = (p: Project) => [...new Set([...p.clips.map((c) => c.trackId), ...Object.keys(p.trackSettings ?? {}), ...(p.trackOrder ?? [])])];
const overlayTrack = (p: Project) => `v${Math.max(1, ...trackIds(p).filter((id) => id.startsWith('v')).map((id) => Number(id.slice(1)))) + 1}`;
const withTopTrack = (p: Project, id: string) => [id, ...new Set([...(p.trackOrder ?? []), ...trackIds(p).filter((t) => t.startsWith('v')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })), ...trackIds(p).filter((t) => t.startsWith('a'))])].filter((t, i, all) => all.indexOf(t) === i);

/**
 * Transition anchoring invariant: a transition lives at the start of its
 * anchor clip. After any clip edit, anchored transitions follow their clip;
 * if the anchor clip is gone or became the first clip on its track (no
 * incoming cut), the transition is dropped instead of dangling stale.
 */
export function reanchorTransitions(project: Project): Project {
  const byTrack = new Map<string, typeof project.clips>();
  project.clips.slice().sort((a, b) => a.start - b.start).forEach((c) => {
    byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
  });
  const transitions = project.transitions.flatMap((t) => {
    if (!t.anchorClipId) {
      // Legacy transition (saved before anchors existed): it survives only
      // while a real incoming cut still exists at its position.
      const hasCut = project.clips.some((c) => {
        if (!c.trackId.startsWith('v')) return false;
        const trackClips = byTrack.get(c.trackId) ?? [];
        return trackClips[0]?.id !== c.id && Math.abs(c.start - t.at) < 0.26;
      });
      return hasCut ? [t] : [];
    }
    const clip = project.clips.find((c) => c.id === t.anchorClipId);
    if (!clip) return [];
    const trackClips = byTrack.get(clip.trackId) ?? [];
    // First clip has no incoming cut — only entrance transitions survive there.
    if (trackClips[0]?.id === clip.id && !t.entrance) return [];
    return [{ ...t, at: clip.start }];
  });
  return { ...project, transitions };
}

/** Assign anchors to legacy transitions by matching real clip boundaries. */
export function migrateTransitionAnchors(project: Project): Project {
  const incoming = project.clips
    .filter((c) => c.trackId.startsWith('v'))
    .slice()
    .sort((a, b) => a.start - b.start);
  const firstIds = new Set<string>();
  const seenTracks = new Set<string>();
  for (const c of incoming) {
    if (!seenTracks.has(c.trackId)) { firstIds.add(c.id); seenTracks.add(c.trackId); }
  }
  return {
    ...project,
    transitions: project.transitions.map((t) => {
      if (t.anchorClipId) return t;
      const anchor = incoming.find((c) => !firstIds.has(c.id) && Math.abs(c.start - t.at) < 0.26);
      return anchor ? { ...t, anchorClipId: anchor.id } : t;
    }),
  };
}

export const useStore = create<EditorState>((set, get) => ({
  setProjectSize: (width, height) => {
    if (![width, height].every((n) => Number.isInteger(n) && n >= 2 && n <= 16384)) return;
    const s = get();
    if (s.project.width === width && s.project.height === height) return;
    s.commit(); set({ project: resizeProject(s.project, width, height) });
  },
  addMarker: (time) => {
    const s = get();
    if (!Number.isFinite(time) || time < 0 || time > 86400 || (s.project.markers?.length ?? 0) >= 1000) return '';
    const id = uid(); s.commit();
    set({ project: { ...s.project, markers: [...(s.project.markers ?? []), { id, time, label: uiText("Marker {0}", { 0: (s.project.markers?.length ?? 0) + 1 }), color: '#fbbf24' }].sort((a, b) => a.time - b.time) } });
    return id;
  },
  updateMarker: (id, patch, record = true) => {
    const s = get(), current = s.project.markers?.find((m) => m.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (!Number.isFinite(next.time) || next.time < 0 || next.time > 86400 || next.label.length > 200 || !/^#[0-9a-f]{6}$/i.test(next.color) || JSON.stringify(current) === JSON.stringify(next)) return;
    if (record || s.future.length) s.commit();
    set({ project: { ...s.project, markers: s.project.markers!.map((m) => m.id === id ? next : m).sort((a,b) => a.time - b.time) } });
  },
  removeMarker: (id) => { const s = get(); if (!s.project.markers?.some((m) => m.id === id)) return; s.commit(); set({ project: { ...s.project, markers: s.project.markers.filter((m) => m.id !== id) } }); },
  setCanvasSettings: (settings, record = true) => {
    if (validateCanvasSettings(settings).length) return;
    const s = get(); if (JSON.stringify(s.project.editorCanvas ?? defaultCanvasSettings()) === JSON.stringify(settings)) return;
    if (record || s.future.length) s.commit();
    set({ project: { ...s.project, editorCanvas: structuredClone(settings) } });
  },
  project: emptyProject(),
  playhead: 0,
  playing: false,
  selectedClipId: null,
  selectedSubId: null,
  selectedTransitionId: null,
  previewDefId: null,
  pxPerSec: 14,
  chatOpen: true,
  settings: { provider: 'local', model: '', apiKey: '' },
  chat: [
    {
      id: uid(), role: 'agent',
      text: 'Hey — I\u2019m your CutWright agent. I can cut, caption and create transitions right on your timeline. Try: “create a fade to black transition”, “add subtitle at 0:05 Hello”, “cut at 0:12”, or “apply cross dissolve at 0:06”. Connect Codex, Claude or Muse in Settings when you want a full LLM driving.',
    },
  ],
  past: [],
  future: [],
  snapEnabled: true,
  rippleEnabled: false,

  allDefs: () => [...BUILTIN_TRANSITIONS, ...get().project.customTransitions],
  totalDuration: () => Math.max(0, ...get().project.clips.map((c) => c.start + c.duration), ...get().project.subtitles.map((s) => s.end)),

  commit: () => set((s) => ({ past: [...s.past.slice(-40), clone(s.project)], future: [] })),
  setProject: (p, keepHistory) => {
    if (!keepHistory) get().commit();
    else if (get().future.length) get().commit();
    // Opening/creating a project: migrate legacy transition anchors and
    // merge the persisted cross-project transition library (My Creations
    // must survive New/Open and restarts, not live only in one project).
    let merged = migrateTransitionAnchors(materializeLinkedAudio(migrateLinkedAudio(p), uid));
    try {
      const raw = localStorage.getItem('cutwright.customTransitions');
      if (raw) {
        const library = JSON.parse(raw) as TransitionDef[];
        const have = new Set(merged.customTransitions.map((d) => d.id));
        merged = { ...merged, customTransitions: [...merged.customTransitions, ...library.filter((d) => !have.has(d.id))] };
      }
    } catch { /* storage unavailable */ }
    try { localStorage.setItem('cutwright.customTransitions', JSON.stringify(merged.customTransitions)); } catch { /* storage unavailable */ }
    set({ project: merged, selectedClipId: null, selectedSubId: null, selectedTransitionId: null, previewDefId: null });
  },
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (b) => set({ playing: b }),
  selectClip: (id) => set({ selectedClipId: id, selectedSubId: null, selectedTransitionId: null }),
  selectSub: (id) => set({ selectedSubId: id, selectedClipId: null, selectedTransitionId: null }),
  selectTransition: (id) => set({ selectedTransitionId: id, selectedClipId: null, selectedSubId: null }),
  setPreviewDef: (id) => set({ previewDefId: id }),
  updateTransition: (id, duration, applyToAll, record = true) => {
    // Live slider drags pass record=false so one drag = at most one undo step
    // (committed by the caller on release), not sixty.
    if (record) get().commit();
    set((s) => ({
      project: {
        ...s.project,
        transitions: s.project.transitions.map((t) => (applyToAll || t.id === id ? { ...t, duration: Math.min(4, Math.max(0.1, duration)) } : t)),
      },
    }));
  },
  setZoom: (n) => set({ pxPerSec: Math.min(80, Math.max(4, n)) }),
  setChatOpen: (b) => set({ chatOpen: b }),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  pushChat: (m) => set((s) => ({ chat: [...s.chat.slice(-80), m] })),

  addMedia: (m) => { get().commit(); set((s) => ({ project: { ...s.project, media: [...s.project.media, m] } })); },
  updateMedia: (id, patch) => set((s) => ({ project: { ...s.project, media: s.project.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) } })),
  relinkMedia: (name, src, duration) => {
    const s = get();
    const target = s.project.media.find((m) => m.name.toLowerCase() === name.toLowerCase() && (!m.src || m.offline) && !m.overlay);
    if (!target) return false;
    s.commit();
    set({
      project: {
        ...s.project,
        media: s.project.media.map((m) => (m.id === target.id ? { ...m, src, offline: false, thumb: undefined, peaks: undefined, duration: duration > 0 ? duration : m.duration } : m)),
      },
    });
    return true;
  },
  addClipFromMedia: (mediaId) => {
    const s = get();
    const media = s.project.media.find((m) => m.id === mediaId);
    if (!media) return;
    s.commit();
    const trackId = media.kind === 'audio' ? 'a1' : media.overlay ? overlayTrack(s.project) : 'v1';
    const end = Math.max(0, ...s.project.clips.filter((c) => c.trackId === trackId).map((c) => c.start + c.duration));
    const clip: Clip = {
      id: uid(), mediaId, trackId, name: media.name.replace(/\.[^.]+$/, ''),
      start: media.overlay ? s.playhead : end, duration: media.duration || 5, offset: 0,
      color: media.color || CLIP_COLORS[s.project.clips.length % CLIP_COLORS.length],
      ...(media.overlay ? { overlay: structuredClone(media.overlay) } : {}),
    };
    const project = { ...s.project, clips: [...s.project.clips, clip], ...(media.overlay ? { trackOrder: withTopTrack(s.project, trackId) } : {}) };
    set({ project: addLinkedAudio(project, clip.id, uid), selectedClipId: clip.id, selectedSubId: null, selectedTransitionId: null });
  },
  addOverlay: (name, overlay) => {
    const s = get();
    const trackId = overlayTrack(s.project);
    const animationDuration = overlay.animationDuration ?? (overlay.kind === 'title' ? overlay.scroll?.duration : undefined) ?? 5;
    const duration = Math.max(.2, animationDuration - (overlay.animationOffset ?? 0));
    const media: MediaItem = { id: uid(), name, kind: 'image', src: '', duration, color: overlay.color.slice(0, 7), width: s.project.width, height: s.project.height, overlay: structuredClone(overlay) };
    const clip: Clip = { id: uid(), mediaId: media.id, name, trackId, start: s.playhead, duration, offset: 0, color: media.color, overlay: structuredClone(overlay) };
    s.commit();
    set({ project: { ...s.project, media: [...s.project.media, media], clips: [...s.project.clips, clip], trackOrder: withTopTrack(s.project, trackId) }, selectedClipId: clip.id, selectedSubId: null, selectedTransitionId: null });
  },

  splitClipAt: (clipId, at) => {
    const s = get();
    const clip = s.project.clips.find((c) => c.id === clipId);
    if (!clip || at <= clip.start + 0.05 || at >= clip.start + clip.duration - 0.05) return;
    s.commit();
    // Source frames advance at speed× timeline rate: the right half starts
    // (at - start) * speed into the source, not (at - start).
    const result = splitLinkedClips(s.project, clipId, at, uid);
    set({ project: reanchorTransitions(result.project), selectedClipId: result.rightId });
  },
  splitAtPlayhead: () => {
    const s = get();
    const at = s.playhead;
    const selected = s.project.clips.find((c) => c.id === s.selectedClipId && at > c.start + 0.05 && at < c.start + c.duration - 0.05);
    const clip = selected ?? s.project.clips.find((c) => c.trackId === 'v1' && at > c.start + 0.05 && at < c.start + c.duration - 0.05)
      ?? s.project.clips.find((c) => at > c.start + 0.05 && at < c.start + c.duration - 0.05);
    if (!clip) return 'No clip under the playhead — move it inside a clip first.';
    s.splitClipAt(clip.id, at);
    return null;
  },
  deleteSelected: () => {
    const s = get();
    if (s.selectedSubId) { s.removeSubtitle(s.selectedSubId); return; }
    if (!s.selectedClipId) return;
    s.commit();
    set({ project: reanchorTransitions(deleteLinkedClips(s.project, s.selectedClipId)), selectedClipId: null });
  },
  moveClip: (id, start) => set((s) => ({ project: reanchorTransitions(patchLinkedClips(s.project, id, { start: Math.max(0, start) })) })),
  trimClip: (id, patch) => set((s) => ({
    project: reanchorTransitions(patchLinkedClips(s.project, id, {
      ...(patch.start !== undefined ? { start: Math.max(0, patch.start) } : {}),
      ...(patch.duration !== undefined ? { duration: Math.max(.2, patch.duration) } : {}),
      ...(patch.offset !== undefined ? { offset: Math.max(0, patch.offset) } : {}),
    })),
  })),

  unlinkClip: (clipId) => { get().commit(); set((s) => ({ project: unlinkClipGroup(s.project, clipId) })); },
  detachAudio: (clipId) => {
    const s = get();
    if (!canDetachAudio(s.project, clipId)) return;
    s.commit();
    set({project:detachClipAudio(s.project, clipId, uid)});
  },
  applyTransition: (defId, at, duration, anchorClipId) => {
    const s = get();
    const def = s.allDefs().find((d) => d.id === defId);
    const anchor = findTransitionAnchor(s.project, at, anchorClipId ?? s.selectedClipId);
    if (!def || !anchor) return;
    s.commit();
    const existing = s.project.transitions.find((t) => t.anchorClipId === anchor.id || (!t.anchorClipId && Math.abs(t.at - at) < .26));
    const applied = { id: existing?.id ?? uid(), defId, at: anchor.start, duration: duration ?? def.duration ?? 0.6, anchorClipId: anchor.id, ...(isEntrance(s.project, anchor) ? { entrance: true } : {}) };
    set({
      selectedTransitionId: applied.id,
      project: {
        ...s.project,
        transitions: existing
          ? s.project.transitions.map((t) => (t.id === existing.id ? applied : t))
          : [...s.project.transitions, applied],
      },
    });
  },
  removeTransition: (id) => { get().commit(); set((s) => ({ project: { ...s.project, transitions: s.project.transitions.filter((t) => t.id !== id) } })); },
  addCustomTransition: (def) => {
    get().commit();
    set((s) => ({ project: { ...s.project, customTransitions: [...s.project.customTransitions.filter((d) => d.id !== def.id), def] } }));
    try {
      const raw = localStorage.getItem('cutwright.customTransitions');
      const list: TransitionDef[] = raw ? (JSON.parse(raw) as TransitionDef[]) : [];
      localStorage.setItem('cutwright.customTransitions', JSON.stringify([...list.filter((d) => d.id !== def.id), def]));
    } catch { /* storage unavailable */ }
  },

  addSubtitle: (start, end, text) => {
    get().commit();
    const sub: Subtitle = { id: uid(), start, end: Math.max(end, start + 0.4), text };
    set((s) => ({ project: { ...s.project, subtitles: [...s.project.subtitles, sub].sort((a, b) => a.start - b.start) }, selectedSubId: sub.id }));
  },
  updateSubtitle: (id, patch, record = true) => {
    const s = get();
    const current = s.project.subtitles.find((x) => x.id === id);
    if (!current || (patch.start !== undefined && !Number.isFinite(patch.start)) || (patch.end !== undefined && !Number.isFinite(patch.end))) return;
    const next = { ...current, ...patch };
    next.start = Math.max(0, next.start); next.end = Math.max(next.start + 1 / s.project.fps, next.end);
    if (record || s.future.length) s.commit();
    set({ project: { ...s.project, subtitles: s.project.subtitles.map((x) => x.id === id ? next : x).sort((a, b) => a.start - b.start) } });
  },
  removeSubtitle: (id) => { get().commit(); set((s) => ({ project: { ...s.project, subtitles: s.project.subtitles.filter((x) => x.id !== id) }, selectedSubId: null })); },

  setSnap: (b) => set({ snapEnabled: b }),
  setRipple: (b) => set({ rippleEnabled: b }),
  setTrackSettings: (trackId, patch) => {
    get().commit();
    set((s) => ({
      project: {
        ...s.project,
        trackSettings: { ...(s.project.trackSettings ?? {}), [trackId]: { ...(s.project.trackSettings?.[trackId] ?? {}), ...patch } },
      },
    }));
  },
  addTrack: (kind) => {
    const s = get();
    s.commit();
    const prefix = kind === 'video' ? 'v' : 'a';
    const used = new Set(trackIds(s.project));
    used.add('v1'); used.add('a1'); // standard empty tracks are already visible
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    set({ project: { ...s.project, trackSettings: { ...(s.project.trackSettings ?? {}), [id]: {} } } });
  },
  removeTrack: (trackId) => {
    const s = get();
    if (s.project.clips.some((c) => c.trackId === trackId)) return; // only empty tracks
    s.commit();
    const settings = { ...(s.project.trackSettings ?? {}) };
    delete settings[trackId];
    set({ project: { ...s.project, trackSettings: settings, ...(s.project.trackOrder ? { trackOrder: s.project.trackOrder.filter((id) => id !== trackId) } : {}) } });
  },
  updateClip: (id, patch, record = true) => {
    if (record || get().future.length) get().commit();
    set((s) => ({ project: reanchorTransitions(patchLinkedClips(s.project, id, patch)) }));
  },
  deleteSelectedRipple: () => {
    const s = get();
    const clip = s.project.clips.find((c) => c.id === s.selectedClipId);
    if (!clip) { s.deleteSelected(); return; }
    s.commit();
    set({
      selectedClipId: null,
      project: reanchorTransitions(deleteLinkedClips(s.project, clip.id, true)),
    });
  },

  setTrackOrder: (order) => { get().commit(); set((s) => ({ project: { ...s.project, trackOrder: order } })); },
  setSubtitleStyle: (patch, record = true) => {
    if (record || get().future.length) get().commit();
    set((s) => ({ project: { ...s.project, subtitleStyle: { fontSize: 22, color: '#FFFFFF', ...(s.project.subtitleStyle ?? {}), ...patch } } }));
  },

  undo: () => set((s) => {
    const prev = s.past[s.past.length - 1];
    if (!prev) return s;
    return { past: s.past.slice(0, -1), future: [clone(s.project), ...s.future].slice(0, 40), project: prev };
  }),
  redo: () => set((s) => {
    const next = s.future[0];
    if (!next) return s;
    return { future: s.future.slice(1), past: [...s.past, clone(s.project)], project: next };
  }),
}));

export function loadPersistedTransitions(): void {
  try {
    const raw = localStorage.getItem('cutwright.customTransitions');
    if (!raw) return;
    const list = JSON.parse(raw) as TransitionDef[];
    useStore.setState((s) => ({
      project: {
        ...s.project,
        customTransitions: [...s.project.customTransitions, ...list.filter((d) => !s.project.customTransitions.some((x) => x.id === d.id))],
      },
    }));
  } catch { /* ignore */ }
}

export { uid };

// Test/automation hook: lets desktop E2E seek and assert real editor state
// through the same store the UI uses (no parallel state path).
if (typeof window !== 'undefined') {
  (window as unknown as { cutwrightStore?: typeof useStore }).cutwrightStore = useStore;
}
