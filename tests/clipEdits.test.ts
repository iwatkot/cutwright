import { describe, expect, it } from 'vitest';
import { deleteLinkedClips, migrateLinkedAudio, patchLinkedClips, splitLinkedClips, unlinkClipGroup } from '../src/lib/clipEdits';
import type { Project } from '../src/lib/types';
import { clipFadeEnvelope } from '../src/lib/audioEnv';

const fixture = (): Project => ({ version: 1, name: 'linked edit', width: 640, height: 360, fps: 30,
  media: [{ id: 'source', name: 'Voice.mp4', kind: 'video', src: 'voice.mp4', duration: 30, color: '#222' }],
  clips: [
    { id: 'v', mediaId: 'source', name: 'Picture', trackId: 'v1', start: 0, duration: 4, offset: 1, speed: 2, color: '#222', mutedAudio: true },
    { id: 'a', mediaId: 'source', name: 'Voice', trackId: 'a1', start: 0, duration: 4, offset: 1, speed: 2, color: '#222', volume: 3 },
    { id: 'v2', mediaId: 'source', name: 'Picture 2', trackId: 'v1', start: 4, duration: 4, offset: 12, color: '#222', mutedAudio: true },
    { id: 'a2', mediaId: 'source', name: 'Voice 2', trackId: 'a1', start: 4, duration: 4, offset: 12, color: '#222' },
  ], transitions: [], subtitles: [], customTransitions: [] });

describe('linked picture and voice', () => {
  it('resets inherited audio fades on both linked members without changing timing', () => {
    const p = migrateLinkedAudio(fixture());
    for (const c of p.clips.slice(0, 2)) { c.fadeIn = 1; c.fadeOut = 1; c.audioEnvelope = {offset: 2,duration: 8,fadeIn: 1,fadeOut: 1}; }
    const reset = patchLinkedClips(p, 'v', {volume: 1,fadeIn: 0,fadeOut: 0,audioEnvelope: undefined});
    for (const c of reset.clips.slice(0,2)) {
      expect(c.audioEnvelope).toBeUndefined(); expect(c.volume).toBe(1);
      expect(c.fadeIn).toBe(0); expect(c.fadeOut).toBe(0);
      expect([c.start,c.duration,c.offset,c.speed]).toEqual([0,4,1,2]);
    }
    expect(p.clips[0].audioEnvelope?.offset).toBe(2);
  });
  it('migrates exact old converted pairs and moves them without affecting color or other tracks', () => {
    const p = migrateLinkedAudio(fixture());
    expect(p.clips[0].linkGroup).toBe(p.clips[1].linkGroup);
    const moved = patchLinkedClips(p, 'v', { start: 2, trackId: 'v3', saturation: 1.2 });
    expect(moved.clips.slice(0, 2).map((c) => c.start)).toEqual([2, 2]);
    expect(moved.clips[1].trackId).toBe('a1');
    expect(moved.clips[1].saturation).toBeUndefined();
    expect(moved.clips[1].volume).toBe(3);
    expect(moved.clips[2].start).toBe(4);
    expect(p.clips[0].start).toBe(0);
  });
  it('trims source offsets and speed on both linked members', () => {
    const p = patchLinkedClips(migrateLinkedAudio(fixture()), 'v', { start: 1, duration: 3, offset: 3, speed: 1.5 });
    expect(p.clips.slice(0, 2).map((c) => [c.start, c.duration, c.offset, c.speed])).toEqual([[1, 3, 3, 1.5], [1, 3, 3, 1.5]]);
  });
  it('splits both tracks at speed-aware source time and links each half independently', () => {
    let serial = 0;
    const result = splitLinkedClips(migrateLinkedAudio(fixture()), 'v', 2, () => `new-${serial++}`);
    expect(result.count).toBe(2);
    const right = result.project.clips.filter((c) => c.start === 2);
    expect(right.map((c) => c.offset)).toEqual([5, 5]);
    expect(right[0].linkGroup).toBe(right[1].linkGroup);
    expect(right[0].linkGroup).not.toBe(result.project.clips[0].linkGroup);
    const moved = patchLinkedClips(result.project, result.rightId!, { start: 3 });
    expect(moved.clips.filter((c) => c.linkGroup === right[0].linkGroup).map((c) => c.start)).toEqual([3, 3]);
    expect(moved.clips[0].start).toBe(0);
  });
  it('ripple deletion removes picture/voice and closes the same gap on both tracks', () => {
    const p = deleteLinkedClips(migrateLinkedAudio(fixture()), 'v', true);
    expect(p.clips.map((c) => c.id)).toEqual(['v2', 'a2']);
    expect(p.clips.map((c) => c.start)).toEqual([0, 0]);
    expect(p.clips.map((c) => c.offset)).toEqual([12, 12]);
  });
  it('explicit unlink persists through migration and allows an independent voice edit', () => {
    const unlinked = migrateLinkedAudio(JSON.parse(JSON.stringify(unlinkClipGroup(migrateLinkedAudio(fixture()), 'v'))));
    const moved = patchLinkedClips(unlinked, 'a', { start: 1 });
    expect(moved.clips[0].start).toBe(0);
    expect(moved.clips[1].start).toBe(1);
    expect(moved.clips[0].linkGroup).toBeNull();
  });
  it('speed preserves the source out-point and clamps an oversized trim on both tracks', () => {
    const sped = patchLinkedClips(migrateLinkedAudio(fixture()), 'v', { speed: 4 });
    expect(sped.clips.slice(0, 2).map((c) => [c.duration, c.speed])).toEqual([[2, 4], [2, 4]]);
    expect(sped.clips[0].offset + sped.clips[0].duration * 4).toBe(9);
    const trimmed = patchLinkedClips(sped, 'v', { duration: 100 });
    expect(trimmed.clips.slice(0, 2).map((c) => c.duration)).toEqual([7.25, 7.25]);
  });
  it.each([.5, 2, 3.5])('a split at %ss preserves every sample of the original fades', (at) => {
    const p = migrateLinkedAudio(fixture());
    p.clips[0].fadeIn = 2; p.clips[0].fadeOut = 2;
    p.clips[1].fadeIn = 2; p.clips[1].fadeOut = 2;
    let serial = 0;
    const split = splitLinkedClips(p, 'v', at, () => `n-${serial++}`).project;
    for (let time = 0; time < 4; time += .013) {
      for (const track of ['v1', 'a1']) {
        const c = split.clips.find((x) => x.trackId === track && x.start <= time && x.start + x.duration > time)!;
        expect(clipFadeEnvelope(c, time - c.start)).toBeCloseTo(clipFadeEnvelope(p.clips.find((x) => x.trackId === track)!, time), 10);
      }
    }
    const reopened = JSON.parse(JSON.stringify(split)) as Project;
    expect(reopened.clips.find((c) => c.start === at)?.audioEnvelope?.offset).toBe(at);
  });
  it('a speed edit has the same fade lengths before and after a split', () => {
    const p = fixture(); p.clips = [{ ...p.clips[0], duration: 10, speed: 1, fadeIn: 2, fadeOut: 2 }];
    let serial = 0;
    const split = splitLinkedClips(p, 'v', 5, () => `s${serial++}`).project;
    const whole = patchLinkedClips(p, 'v', { speed: 2 });
    const half = patchLinkedClips(split, 'v', { speed: 2 });
    expect(clipFadeEnvelope(whole.clips[0], .5)).toBe(.25);
    expect(clipFadeEnvelope(half.clips[0], .5)).toBe(.25);
  });
  it('extending a split left preserves negative envelope phase', () => {
    const p = fixture(); p.clips = [{ ...p.clips[0], offset: 10, duration: 10, speed: 1, fadeIn: 2, fadeOut: 2 }];
    let serial = 0;
    const split = splitLinkedClips(p, 'v', 5, () => `s${serial++}`);
    const extended = patchLinkedClips(split.project, split.rightId!, { offset: 5, duration: 15 });
    const c = extended.clips.find((x) => x.id === split.rightId)!;
    expect(c.audioEnvelope?.offset).toBe(-5);
    expect(clipFadeEnvelope(c, 12)).toBe(1);
    expect(clipFadeEnvelope(c, 14)).toBe(.5);
  });
  it('editing the release on a split right half preserves its inherited attack', () => {
    const p = fixture(); p.clips = [{ ...p.clips[0], speed: 1, fadeIn: 2, fadeOut: 2 }];
    let serial = 0;
    const split = splitLinkedClips(p, 'v', .5, () => `s${serial++}`);
    const changed = patchLinkedClips(split.project, split.rightId!, { fadeOut: .5 });
    const c = changed.clips.find((x) => x.id === split.rightId)!;
    for (const t of [0, .2, .5, 1]) expect(clipFadeEnvelope(c, t)).toBeCloseTo(clipFadeEnvelope(p.clips[0], t + .5), 10);
    expect(clipFadeEnvelope(c, 3.25)).toBeCloseTo(.5);
    expect(c.audioEnvelope?.fadeOutEnd).toBe(4);
  });
  it('editing one edge in a short split does not clamp the other to the shorter clip', () => {
    const p = fixture(); p.clips = [{ ...p.clips[0], speed: 1, fadeIn: 2, fadeOut: 2 }];
    let serial = 0;
    const split = splitLinkedClips(p, 'v', 1.5, () => `s${serial++}`).project;
    const changed = patchLinkedClips(split, 'v', { fadeOut: .25 });
    const c = changed.clips[0];
    expect(clipFadeEnvelope(c, .5)).toBe(.25);
    expect(clipFadeEnvelope(c, 1)).toBe(.5);
    expect(clipFadeEnvelope(c, 1.4)).toBeCloseTo(.4);
    const cutAgain = splitLinkedClips(changed, 'v', .6, () => `s${serial++}`).project;
    for (let time = 0; time < 1.5; time += .013) {
      const part = cutAgain.clips.find((x) => x.start <= time && x.start + x.duration > time)!;
      expect(clipFadeEnvelope(part, time - part.start)).toBeCloseTo(clipFadeEnvelope(c, time), 10);
    }
    const reopened = JSON.parse(JSON.stringify(cutAgain)) as Project;
    expect(reopened.clips[0].audioEnvelope).toEqual(c.audioEnvelope);
  });
  it('editing an inherited attack preserves release and scales its anchors with speed', () => {
    const p = fixture(); p.clips = [{ ...p.clips[0], speed: 1, fadeIn: 2, fadeOut: 2 }];
    let serial = 0;
    const split = splitLinkedClips(p, 'v', .5, () => `s${serial++}`);
    const changed = patchLinkedClips(split.project, split.rightId!, { fadeIn: .5 });
    const c = changed.clips.find((x) => x.id === split.rightId)!;
    expect(clipFadeEnvelope(c, .25)).toBe(.5);
    expect(clipFadeEnvelope(c, 3)).toBe(.25);
    const faster = patchLinkedClips(changed, c.id, { speed: 2 }).clips.find((x) => x.id === c.id)!;
    expect(faster.audioEnvelope?.fadeInStart).toBe(.25);
    expect(faster.audioEnvelope?.fadeInWindow).toBe(1.75);
    expect(clipFadeEnvelope(faster, .25)).toBe(.5);
  });
});
