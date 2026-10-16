import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/lib/store';
import type { Project } from '../src/lib/types';

const fixture = (speed = 1): Project => ({
  version: 1, name: 'state fixture', width: 640, height: 360, fps: 30,
  media: [{ id: 'a', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 40, color: '#111' }],
  clips: [
    { id: 'c1', mediaId: 'a', trackId: 'v1', name: 'one', start: 0, duration: 4, offset: 1, color: '#111', speed },
    { id: 'c2', mediaId: 'a', trackId: 'v1', name: 'two', start: 4, duration: 4, offset: 10, color: '#222' },
  ],
  transitions: [], subtitles: [], customTransitions: [],
});

beforeEach(() => {
  useStore.setState({ past: [], future: [], selectedClipId: null, selectedTransitionId: null, playhead: 0 });
  useStore.getState().setProject(fixture(), true);
});

describe('editor state invariants', () => {
  it.each([0.5, 1, 2])('split keeps source continuity at %sx speed', (speed) => {
    useStore.getState().setProject(fixture(speed), true);
    useStore.getState().splitClipAt('c1', 2);
    const clips = useStore.getState().project.clips.slice().sort((a, b) => a.start - b.start);
    // offset 1 + (2s timeline * speed) = source frame at the cut
    expect(clips[1].offset).toBeCloseTo(1 + 2 * speed);
    expect(clips[0].duration).toBe(2);
    expect(clips[1].duration).toBe(2);
  });

  it('transition follows its anchor clip when the clip moves', () => {
    const s = useStore.getState();
    s.applyTransition('cross-dissolve', 4);
    expect(useStore.getState().project.transitions[0].anchorClipId).toBe('c2');
    s.moveClip('c2', 6);
    expect(useStore.getState().project.transitions[0].at).toBe(6);
  });

  it('ripple-deleting the first clip drops the now-anchorless transition', () => {
    const s = useStore.getState();
    s.applyTransition('cross-dissolve', 4);
    s.selectClip('c1');
    s.deleteSelectedRipple();
    const p = useStore.getState().project;
    expect(p.clips.map((c) => c.name)).toEqual(['two']);
    expect(p.clips[0].start).toBe(0);
    expect(p.transitions.length).toBe(0); // was at 4, anchor is now first clip
  });

  it('legacy project: anchors migrate on open, ripple delete drops stale transition, undo restores', () => {
    const legacy = fixture();
    legacy.transitions = [{ id: 'lt', defId: 'cross-dissolve', at: 4, duration: 0.6 }]; // no anchorClipId
    useStore.getState().setProject(legacy, true);
    expect(useStore.getState().project.transitions[0].anchorClipId).toBe('c2');
    const s = useStore.getState();
    s.selectClip('c1');
    s.deleteSelectedRipple();
    expect(useStore.getState().project.transitions.length).toBe(0);
    s.undo();
    expect(useStore.getState().project.transitions.length).toBe(1);
    expect(useStore.getState().project.clips.length).toBe(2);
  });

  it('entrance transition survives on the first clip and follows edits', () => {
    const p = fixture();
    p.transitions = [{ id: 'ent', defId: 'blur-inout', at: 0, duration: 2, anchorClipId: 'c1', entrance: true }];
    useStore.getState().setProject(p, true);
    const s = useStore.getState();
    s.commit(); // drag/agent callers commit before mutating, like the UI does
    s.moveClip('c1', 1);
    const t = useStore.getState().project.transitions[0];
    expect(t).toBeDefined();
    expect(t.at).toBe(1); // entrance follows its anchored first clip
    s.undo();
    expect(useStore.getState().project.transitions[0].at).toBe(0);
  });

  it('agent-style batch via setProject is exactly one undo/redo step with state restoration', () => {
    const before = JSON.parse(JSON.stringify(useStore.getState().project)) as Project;
    const edited = JSON.parse(JSON.stringify(before)) as Project;
    edited.clips[0].volume = 3;
    edited.clips[0].saturation = 0.4;
    edited.trackOrder = ['v1', 'a1'];
    edited.subtitleStyle = { fontSize: 30, color: '#FFD44B' };
    useStore.getState().setProject(edited); // agent path commits once
    expect(useStore.getState().project.clips[0].volume).toBe(3);
    useStore.getState().undo();
    expect(useStore.getState().project).toEqual(before); // full state restored
    useStore.getState().redo();
    expect(useStore.getState().project.clips[0].volume).toBe(3);
    expect(useStore.getState().project.subtitleStyle?.fontSize).toBe(30);
  });

  it('deleting the anchor clip drops its transition; undo restores both', () => {
    const s = useStore.getState();
    s.applyTransition('fade-to-black', 4);
    s.selectClip('c2');
    s.deleteSelected();
    expect(useStore.getState().project.transitions.length).toBe(0);
    s.undo();
    const p = useStore.getState().project;
    expect(p.clips.length).toBe(2);
    expect(p.transitions.length).toBe(1);
    s.redo();
    expect(useStore.getState().project.transitions.length).toBe(0);
  });
  it('split uses the selected overlay instead of a base clip at the same time', () => {
    const p = fixture();
    p.clips.push({ ...p.clips[0], id: 'overlay', trackId: 'v2', name: 'Overlay', offset: 5, speed: 2 });
    useStore.getState().setProject(p, true);
    useStore.getState().selectClip('overlay');
    useStore.getState().setPlayhead(2);
    useStore.getState().splitAtPlayhead();
    const clips = useStore.getState().project.clips;
    expect(clips.find((c) => c.id === 'c1')?.duration).toBe(4);
    expect(clips.filter((c) => c.trackId === 'v2')).toHaveLength(2);
    expect(clips.find((c) => c.trackId === 'v2' && c.start === 2)?.offset).toBe(9);
  });
  it('removing an empty track removes its explicit order entry, and undo restores it', () => {
    useStore.getState().setProject({ ...fixture(), trackOrder: ['v3', 'v1'], trackSettings: { v3: {} } }, true);
    useStore.getState().removeTrack('v3');
    expect(useStore.getState().project.trackOrder).toEqual(['v1']);
    useStore.getState().undo();
    expect(useStore.getState().project.trackOrder).toEqual(['v3', 'v1']);
  });
  it('reuses a native media template above the base at the playhead', () => {
    const p = fixture();
    const overlay = { kind: 'arrow' as const, x1: 10, y1: 10, x2: 100, y2: 100, color: '#FFFF00', width: 5, head: true };
    p.media.push({ id: 'arrow', name: 'Arrow', kind: 'image', src: '', duration: 3, color: '#FFFF00', overlay });
    p.trackOrder = ['v2', 'v1'];
    useStore.getState().setProject(p, true);
    useStore.getState().setPlayhead(2);
    useStore.getState().addClipFromMedia('arrow');
    const edited = useStore.getState().project;
    const added = edited.clips.at(-1)!;
    expect(added.start).toBe(2);
    expect(edited.trackOrder?.[0]).toBe(added.trackId);
    expect(added.overlay).toEqual(overlay);
    expect(added.overlay).not.toBe(edited.media.at(-1)?.overlay);
  });
  it('keeps complete reusable credit animation and branches history after undo', () => {
    const s = useStore.getState();
    s.addOverlay('Credits', { kind: 'title', text: 'Names', fontFamily: 'Arial', fontSize: 30, fontWeight: 400, color: '#FFFFFF', x: 10, y: 10, blockWidth: 300, lineHeight: 40, align: 'left', scroll: { fromY: 0, toY: -1000, duration: 8.885 } });
    const clip = useStore.getState().project.clips.at(-1)!;
    expect(clip.duration).toBe(8.885);
    s.updateClip(clip.id, { name: 'B' });
    s.undo();
    s.updateClip(clip.id, { name: 'C' }, false);
    s.redo();
    expect(useStore.getState().project.clips.at(-1)?.name).toBe('C');
    s.undo();
    expect(useStore.getState().project.clips.at(-1)?.name).toBe('Credits');
  });
  it('anchors coincident track transitions independently and creates gap entrances', () => {
    const p = fixture();
    p.clips.push({ ...p.clips[0], id: 'overlay', trackId: 'v2', start: 4, duration: 2 });
    useStore.getState().setProject(p, true);
    useStore.getState().applyTransition('cross-dissolve', 4, .6, 'c2');
    useStore.getState().applyTransition('fade-to-black', 4, .8, 'overlay');
    const ts = useStore.getState().project.transitions;
    expect(ts).toHaveLength(2);
    expect(ts.find((t) => t.anchorClipId === 'overlay')?.entrance).toBe(true);
    expect(ts.find((t) => t.anchorClipId === 'c2')?.entrance).toBeUndefined();
    useStore.getState().undo();
    expect(useStore.getState().project.transitions).toHaveLength(1);
  });
  it('first Add Track on an empty project creates a new visible track', () => {
    useStore.getState().setProject({ ...fixture(), media: [], clips: [], trackSettings: {} }, true);
    useStore.getState().addTrack('video');
    useStore.getState().addTrack('audio');
    expect(Object.keys(useStore.getState().project.trackSettings ?? {})).toEqual(['v2', 'a2']);
  });
  it('faded split is one undo/redo and inherited profiles survive project serialization', () => {
    const p = fixture(); p.clips[0].fadeIn = 2; p.clips[0].fadeOut = 2;
    useStore.getState().setProject(p, true);
    const before = JSON.stringify(useStore.getState().project);
    useStore.getState().splitClipAt('c1', 2);
    const after = JSON.stringify(useStore.getState().project);
    expect(useStore.getState().project.clips[1].audioEnvelope).toMatchObject({ offset: 2, duration: 4, fadeIn: 2, fadeOut: 2 });
    useStore.getState().undo(); expect(JSON.stringify(useStore.getState().project)).toBe(before);
    useStore.getState().redo(); expect(JSON.stringify(useStore.getState().project)).toBe(after);
    useStore.getState().setProject(JSON.parse(after), true);
    expect(JSON.stringify(useStore.getState().project)).toBe(after);
  });
});
