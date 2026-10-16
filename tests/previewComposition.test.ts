import { describe, expect, it } from 'vitest';
import { resolvePreviewComposition, transitionPreviewStyles } from '../src/lib/previewComposition';
import { BUILTIN_TRANSITIONS } from '../src/lib/transitions';
import type { Clip, Project } from '../src/lib/types';

const clip = (id: string, trackId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({ id, trackId, start, duration, offset: 0, mediaId: id, name: id, color: '#FFFFFF', ...extra });
const fixture = (): Project => ({ version: 1, name: 'Preview tracks', width: 1920, height: 1080, fps: 30,
  media: [], clips: [clip('base-a', 'v1', 0, 4, { opacity: .4 }), clip('base-b', 'v1', 4, 4), clip('overlay-a', 'v2', 0, 4, { offset: 1, speed: 2 }), clip('overlay-b', 'v2', 4, 4, { offset: 5 })],
  transitions: [{ id: 'overlay-fade', defId: 'cross-dissolve', anchorClipId: 'overlay-b', at: 4, duration: 2 }], subtitles: [], customTransitions: [], trackOrder: ['v2', 'v1'],
});

describe('all-track preview composition', () => {
  it('resolves the exact anchored track when multiple tracks have the same cut time', () => {
    const layers = resolvePreviewComposition(fixture(), BUILTIN_TRANSITIONS, 3.5);
    expect(layers.map((t) => t.id)).toEqual(['v1', 'v2']);
    expect(layers[0].transition).toBeUndefined();
    expect(layers[0].layers).toHaveLength(1);
    expect(layers[0].layers[0].style.opacity).toBe(.4);
    expect(layers[1].transition?.progress).toBeCloseTo(.25);
    expect(layers[1].layers.map((l) => l.clip.id)).toEqual(['overlay-a', 'overlay-b']);
  });

  it('freezes incoming/outgoing visual handles at their trimmed source boundaries', () => {
    const before = resolvePreviewComposition(fixture(), BUILTIN_TRANSITIONS, 3.5)[1];
    expect(before.layers[0]).toMatchObject({ sourceTime: 8, frozen: false });
    expect(before.layers[1]).toMatchObject({ sourceTime: 5, frozen: true });
    const after = resolvePreviewComposition(fixture(), BUILTIN_TRANSITIONS, 4.5)[1];
    expect(after.layers[0].sourceTime).toBeCloseTo(1 + (4 - 1 / 30) * 2);
    expect(after.layers[0].frozen).toBe(true);
    expect(after.layers[1]).toMatchObject({ sourceTime: 5.5, frozen: false });
  });

  it('clamps transition windows to short clips and preserves opacity during weighted blending', () => {
    const p = fixture(); p.clips[3].duration = 1; p.clips[2].opacity = .6;
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 3.5)[1].transition).toBeUndefined();
    const atCut = resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 4)[1];
    expect(atCut.transition?.progress).toBe(.5);
    expect(atCut.layers[0].style).toMatchObject({ opacity: .3, mixBlendMode: 'plus-lighter' });
    expect(atCut.layers[1].style.opacity).toBe(.5);
  });

  it('applies multiple entrances to their own tracks and stops them at the clip duration', () => {
    const p = fixture(); p.transitions = [
      { id: 'base-in', defId: 'blur-inout', anchorClipId: 'base-a', at: 0, duration: 2, entrance: true },
      { id: 'overlay-in', defId: 'blur-inout', anchorClipId: 'overlay-a', at: 0, duration: 20, entrance: true },
    ];
    const tracks = resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 1, .5);
    expect(tracks[0].layers[0].style).toMatchObject({ opacity: .2, filter: 'blur(3.5px)' });
    expect(tracks[1].layers[0].style).toMatchObject({ opacity: .25, filter: 'blur(5.25px)' });
  });

  it('does not bridge gaps, use another track for legacy fallback, or show hidden tracks', () => {
    const p = fixture(); p.clips[2].duration = 2;
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 3.5)[1].layers).toHaveLength(0);
    p.transitions[0].anchorClipId = undefined;
    const legacy = resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 4);
    expect(legacy[0].transition?.applied.id).toBe('overlay-fade');
    expect(legacy[1].transition).toBeUndefined();
    p.trackSettings = { v2: { hidden: true } };
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 4).map((t) => t.id)).toEqual(['v1']);
  });

  it('uses the requested slide/fixed-color entrance and treats Cut as no effect', () => {
    const p = fixture();
    p.transitions = [{ id: 'slide-in', defId: 'slide-up', anchorClipId: 'overlay-a', at: 0, duration: 2, entrance: true }];
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, .5)[1].layers[0].style.transform).toBe('translateY(75%)');
    p.transitions[0].defId = 'fade-to-white';
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, 1)[1].fill).toEqual({ color: '#FFFFFF', opacity: 1 });
    p.transitions[0].defId = 'cut';
    expect(resolvePreviewComposition(p, BUILTIN_TRANSITIONS, .5)[1].layers[0].style).toMatchObject({ opacity: 1 });
  });

  it('matches FFmpeg wipe directions and slide-up motion', () => {
    const wipe = transitionPreviewStyles(BUILTIN_TRANSITIONS.find((d) => d.id === 'wipe-left')!, .25);
    expect(wipe.incoming.clipPath).toBe('inset(0 0 0 75%)'); // incoming appears on the right first
    const slide = transitionPreviewStyles(BUILTIN_TRANSITIONS.find((d) => d.id === 'slide-up')!, .25);
    expect(slide.outgoing.transform).toBe('translateY(-25%)');
    expect(slide.incoming.transform).toBe('translateY(75%)');
  });

  it('dips through a full black or white frame at the exact transition midpoint', () => {
    for (const id of ['fade-to-black', 'fade-to-white']) {
      const styles = transitionPreviewStyles(BUILTIN_TRANSITIONS.find((d) => d.id === id)!, .5);
      expect(styles.outgoing.opacity).toBe(0);
      expect(styles.incoming.opacity).toBe(0);
      expect(styles.fill).toEqual({ color: id === 'fade-to-black' ? '#000000' : '#FFFFFF', opacity: 1 });
    }
  });
});
