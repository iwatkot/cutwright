import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clipGestureReady, trackPointer } from '../src/lib/timelinePointer';

afterEach(() => vi.unstubAllGlobals());

describe('touch timeline intent', () => {
  it('keeps finger jitter and vertical swipes on unselected clips from creating edits', () => {
    expect(clipGestureReady('touch', false, 4, 5)).toBe(false);
    expect(clipGestureReady('touch', false, 3, 30)).toBe(false);
    expect(clipGestureReady('touch', false, 12, 4)).toBe(true);
  });
  it('allows a selected clip to move between tracks and preserves precise mouse/pen edits', () => {
    expect(clipGestureReady('touch', true, 0, 30)).toBe(true);
    expect(clipGestureReady('touch', true, 1, 1)).toBe(false);
    expect(clipGestureReady('mouse', false, 2, 0)).toBe(true);
    expect(clipGestureReady('pen', false, 0, 2)).toBe(true);
  });
});

describe('timeline pointer lifetime', () => {
  function setup() {
    const events = new EventTarget(), node = new EventTarget();
    let captured = false;
    Object.assign(node, {
      setPointerCapture: vi.fn(() => { captured = true; }),
      hasPointerCapture: vi.fn(() => captured),
      releasePointerCapture: vi.fn(() => { captured = false; }),
    });
    vi.stubGlobal('window', events);
    const move = vi.fn(), finish = vi.fn();
    const cleanup = trackPointer({ currentTarget: node, pointerId: 7 } as unknown as ReactPointerEvent<HTMLElement>, move, finish);
    const send = (type: string, pointerId = 7, target = events) => {
      const event = new Event(type); Object.assign(event, { pointerId }); target.dispatchEvent(event);
    };
    return { node, move, finish, cleanup, send, get captured() { return captured; } };
  }
  it('ignores unrelated fingers, including their release and cancellation', () => {
    const s = setup();
    s.send('pointermove', 8); s.send('pointerup', 8); s.send('pointercancel', 8);
    expect(s.move).not.toHaveBeenCalled(); expect(s.finish).not.toHaveBeenCalled();
    s.send('pointermove'); expect(s.move).toHaveBeenCalledOnce();
    s.cleanup();
  });
  for (const end of ['pointerup', 'pointercancel', 'blur']) {
    it(`cleans up after ${end} and never leaves a held gesture`, () => {
      const s = setup(); expect(s.captured).toBe(true);
      s.send('pointermove'); s.send(end); s.send('pointermove'); s.send('pointerup'); s.cleanup();
      expect(s.captured).toBe(false); expect(s.finish).toHaveBeenCalledOnce(); expect(s.move).toHaveBeenCalledOnce();
    });
  }
  it('ends when capture is lost or the editor unmounts', () => {
    const s = setup(); s.send('lostpointercapture', 7, s.node); s.send('pointermove');
    expect(s.finish).toHaveBeenCalledOnce(); expect(s.move).not.toHaveBeenCalled();
    const next = setup(); next.cleanup(); next.send('pointermove');
    expect(next.finish).toHaveBeenCalledOnce(); expect(next.move).not.toHaveBeenCalled();
  });
});
