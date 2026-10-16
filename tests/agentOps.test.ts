import { describe, expect, it } from 'vitest';
import { applyOpsToProject, parseAgentOps } from '../src/lib/agentOps';
import { BUILTIN_TRANSITIONS } from '../src/lib/transitions';
import type { Project } from '../src/lib/types';

const project: Project = {
  version: 1, name: 'ops fixture', width: 640, height: 360, fps: 30,
  media: [{ id: 'a', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 20, color: '#111' }],
  clips: [
    { id: 'c1', mediaId: 'a', trackId: 'v1', name: 'one', start: 0, duration: 6, offset: 0, color: '#111' },
    { id: 'c2', mediaId: 'a', trackId: 'v1', name: 'two', start: 6, duration: 6, offset: 6, color: '#222' },
  ],
  transitions: [], subtitles: [], customTransitions: [],
};

describe('agent structured ops', () => {
  it('parses ops out of noisy provider text', () => {
    const { ops, errors } = parseAgentOps('muse: workspace notice\n{"ops":[{"type":"split","at":3},{"type":"bogus"}]}');
    expect(ops).toEqual([{ type: 'split', at: 3 }]);
    expect(errors[0]).toContain('Unknown op');
  });

  it('malformed entries (null, primitives, arrays) are rejected, never thrown', () => {
    const r = parseAgentOps('{"ops":[null,42,"x",[],{"type":"split","at":-3},{"type":"split","at":2}]}');
    expect(r.ops).toEqual([{ type: 'split', at: 2 }]);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
    const applied = applyOpsToProject(project, BUILTIN_TRANSITIONS, r.ops);
    expect(applied.rejected.length).toBe(0);
    expect(applied.project.clips.length).toBe(3);
  });

  it('rejects ops that do not validate against the project', () => {
    const { ops } = parseAgentOps('{"ops":[{"type":"deleteClip","clipId":"nope"},{"type":"split","at":99}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, ops);
    expect(r.applied.length).toBe(0);
    expect(r.rejected.length).toBe(2);
  });

  it('applies split + transition + subtitle atomically', () => {
    const { ops } = parseAgentOps('{"ops":[{"type":"split","at":3},{"type":"applyTransition","transitionName":"Fade to Black","at":6},{"type":"addSubtitle","start":1,"text":"Hi"}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, ops);
    expect(r.applied.length).toBe(3);
    expect(r.project.clips.length).toBe(3);
    expect(r.project.transitions[0].defId).toBe('fade-to-black');
    expect(r.project.subtitles[0].text).toBe('Hi');
    // input project untouched (purity = single undo step for caller)
    expect(project.clips.length).toBe(2);
  });

  it('applies the expanded command surface: props, trim, tracks, style, subtitle edit', () => {
    const withSub: Project = { ...project, subtitles: [{ id: 's1', start: 1, end: 3, text: 'Old' }], trackSettings: {}, trackOrder: ['v1', 'a1'] };
    const { ops, errors } = parseAgentOps(JSON.stringify({
      ops: [
        { type: 'setClipProps', clipId: 'c1', volume: 3, speed: 6, saturation: 0.5, scale: 0.8, posX: -10, fadeIn: 1.5 },
        { type: 'trimClip', clipId: 'c2', duration: 4, offset: 8 },
        { type: 'moveClip', clipId: 'c2', start: 6, trackId: 'v2' },
        { type: 'setTrack', trackId: 'a1', muted: true, volume: 0.5 },
        { type: 'reorderTracks', order: ['v2', 'v1', 'a1'] },
        { type: 'updateSubtitle', subtitleId: 's1', text: 'New caption', end: 4 },
        { type: 'setSubtitleStyle', fontSize: 30, color: '#ffd44b' },
      ],
    }));
    expect(errors).toEqual([]);
    const r = applyOpsToProject(withSub, BUILTIN_TRANSITIONS, ops);
    expect(r.rejected).toEqual([]);
    expect(r.applied.length).toBe(7);
    const c1 = r.project.clips.find((c) => c.id === 'c1')!;
    expect(c1).toMatchObject({ volume: 3, speed: 6, saturation: 0.5, scale: 0.8, posX: -10, fadeIn: 1.5 });
    const c2 = r.project.clips.find((c) => c.id === 'c2')!;
    expect(c2).toMatchObject({ duration: 4, offset: 8, trackId: 'v2' });
    expect(r.project.trackSettings?.a1).toMatchObject({ muted: true, volume: 0.5 });
    expect(r.project.trackOrder).toEqual(['v2', 'v1', 'a1']);
    expect(r.project.subtitles[0]).toMatchObject({ text: 'New caption', end: 4 });
    expect(r.project.subtitleStyle).toEqual({ fontSize: 30, color: '#FFD44B' });
    // purity: input untouched
    expect(withSub.clips[0].volume).toBeUndefined();
  });

  it('rejects out-of-range props, cross-kind track moves and unknown ids without edits', () => {
    const { ops, errors } = parseAgentOps(JSON.stringify({
      ops: [
        { type: 'setClipProps', clipId: 'c1', volume: 99 },
        { type: 'setClipProps', clipId: 'c1' },
        { type: 'setSubtitleStyle', color: 'red' },
        { type: 'trimClip', clipId: 'c1', duration: 0.01 },
      ],
    }));
    expect(ops).toEqual([]);
    expect(errors.length).toBe(4);
    const bad = parseAgentOps('{"ops":[{"type":"moveClip","clipId":"c1","start":2,"trackId":"a1"},{"type":"setTrack","trackId":"v9","muted":true},{"type":"updateSubtitle","subtitleId":"nope","text":"x"}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, bad.ops);
    expect(r.applied).toEqual([]);
    expect(r.rejected.length).toBe(3);
    expect(r.project).toEqual(project);
  });

  it('createTransition then applyTransitionAll reuses the new def', () => {
    const { ops } = parseAgentOps('{"ops":[{"type":"createTransition","request":"slow fade to black"},{"type":"applyTransitionAll","transitionName":"slow fade to black"}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, ops);
    expect(r.project.customTransitions.length).toBe(1);
    expect(r.project.transitions.length).toBe(1);
    expect(r.applied.length).toBe(2);
  });
  it('rolls back a valid edit if another op refers to a missing clip', () => {
    const { ops } = parseAgentOps('{"ops":[{"type":"setClipProps","clipId":"c1","saturation":1.2},{"type":"deleteClip","clipId":"missing"}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, ops);
    expect(r.project).toEqual(project);
    expect(r.applied).toEqual([]);
    expect(r.rejected.join(' ')).toContain('unknown clip');
  });
  it('honors moves and subtitle timing beyond the previous end', () => {
    const { ops } = parseAgentOps('{"ops":[{"type":"moveClip","clipId":"c2","start":20},{"type":"addSubtitle","start":30,"end":35,"text":"End card"}]}');
    const r = applyOpsToProject(project, BUILTIN_TRANSITIONS, ops);
    expect(r.project.clips.find((c) => c.id === 'c2')?.start).toBe(20);
    expect(r.project.subtitles[0]).toMatchObject({ start: 30, end: 35 });
  });
});
