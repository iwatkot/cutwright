import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/lib/validate';

const good = {
  version: 1, name: 'ok', width: 640, height: 360, fps: 30,
  media: [{ id: 'a', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 5, color: '#111' }],
  clips: [{ id: 'c', mediaId: 'a', trackId: 'v1', name: 'c', start: 0, duration: 5, offset: 0, color: '#111' }],
  transitions: [], subtitles: [], customTransitions: [],
};

describe('validateProject', () => {
  it('accepts a well-formed project', () => {
    expect(validateProject(good).ok).toBe(true);
  });
  it('rejects null entries inside arrays instead of crashing', () => {
    const bad = { ...good, clips: [null] };
    const r = validateProject(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('null or not an object');
  });
  it('rejects non-finite clip timing', () => {
    const bad = { ...good, clips: [{ ...good.clips[0], duration: Number.POSITIVE_INFINITY }] };
    expect(validateProject(bad).ok).toBe(false);
  });
  it('rejects clips referencing missing media', () => {
    const bad = { ...good, clips: [{ ...good.clips[0], mediaId: 'ghost' }] };
    expect(validateProject(bad).errors.join(' ')).toContain('missing media');
  });
  it('rejects subtitles with end <= start', () => {
    const bad = { ...good, subtitles: [{ id: 's', start: 2, end: 2, text: 'x' }] };
    expect(validateProject(bad).ok).toBe(false);
  });
  it.each([
    { fps: 0 }, { width: -1920 }, { trackSettings: { v1: null } },
    { trackSettings: { v1: { volume: Infinity } } }, { trackOrder: ['v1', 'v1'] },
    { subtitleStyle: { fontSize: 22, color: '<script>' } },
    { clips: [{ ...good.clips[0], scale: NaN }] },
    { clips: [{ ...good.clips[0], id: 'c' }, { ...good.clips[0], id: 'c' }] },
    { media: [{ ...good.media[0], overlay: { kind: 'title', text: 'x' } }] },
  ])('rejects malformed rendering state %# without throwing', (patch) => {
    const r = validateProject({ ...good, ...patch });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
