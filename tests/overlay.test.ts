import { describe, expect, it } from 'vitest';
import { overlayFrame, overlaySourceTime, overlaySvg, reflowTitleScroll, resolveOverlay, titleBlockHeight, validateOverlay } from '../src/lib/overlay';
import type { ArrowOverlay, Clip, MediaItem, TitleOverlay } from '../src/lib/types';

const arrow: ArrowOverlay = { kind: 'arrow', x1: 100, y1: 200, x2: 600, y2: 300, color: '#D44B47', width: 20, head: true, drawDuration: 0.5, animationOffset: -0.165, animationDuration: 3 };
const title: TitleOverlay = { kind: 'title', text: 'Thanks\nFirst supporter\nLast supporter', fontFamily: 'Cygre Black', fontSize: 40, fontWeight: 400, color: '#FFFFFF', x: 10, y: 100, blockWidth: 500, lineHeight: 50, align: 'center', scroll: { fromY: 1080, toY: -250, duration: 8 } };

describe('native overlay rendering', () => {
  it('preserves signed animation phase and draws shaft before the arrowhead', () => {
    expect(overlayFrame(arrow, 0)).toMatchObject({ opacity: 0, drawProgress: 0 });
    expect(overlayFrame(arrow, 0.415).drawProgress).toBeCloseTo(0.5);
    expect(overlaySvg(arrow, 1920, 1080, 0.415)).toContain('L412.5 262.5');
    expect(overlaySvg(arrow, 1920, 1080, 0.415).match(/<path/g)).toHaveLength(1);
    expect(overlaySvg(arrow, 1920, 1080, 0.665).match(/<path/g)).toHaveLength(3);
    expect(overlayFrame(arrow, 3.2).opacity).toBe(0);
  });

  it('keeps the source clock continuous across a split, in-point trim and speed change', () => {
    const before = { start: 10, offset: 0.3, speed: 2 };
    const after = { start: 11, offset: 2.3, speed: 2 };
    expect(overlaySourceTime(before, 11.2)).toBeCloseTo(overlaySourceTime(after, 11.2));
    expect(overlayFrame(arrow, overlaySourceTime(before, 11.2))).toEqual(overlayFrame(arrow, overlaySourceTime(after, 11.2)));
  });

  it('rolls every credit line continuously through the frame without pagination', () => {
    const first = overlayFrame(title, 0).scrollY;
    const mid = overlayFrame(title, 4).scrollY;
    const last = overlayFrame(title, 8).scrollY;
    expect(first).toBe(1080);
    expect(mid).toBe((1080 - 250) / 2);
    expect(last).toBe(-250);
    for (let i = 0; i < 3; i++) {
      const y = title.y + i * title.lineHeight;
      const atCenter = 8 * (title.scroll!.fromY + y - 540) / (title.scroll!.fromY - title.scroll!.toY);
      expect(y + overlayFrame(title, atCenter).scrollY).toBeCloseTo(540);
    }
  });

  it('reflows additional credit names and line spacing so every name crosses the frame before the end', () => {
    const before = structuredClone(title);
    const names = Array.from({ length: 60 }, (_, i) => `Supporter ${i + 1}`);
    const edited = reflowTitleScroll(title, { ...title, text: names.join('\n'), lineHeight: 75 });
    expect(edited.scroll?.fromY).toBe(title.scroll?.fromY);
    expect(edited.scroll?.duration).toBe(title.scroll?.duration);
    expect(edited.y + titleBlockHeight(edited) + edited.scroll!.toY).toBe(title.y + titleBlockHeight(title) + title.scroll!.toY);
    names.forEach((_, i) => {
      const y = edited.y + i * edited.lineHeight;
      const atCenter = edited.scroll!.duration * (edited.scroll!.fromY + y - 540) / (edited.scroll!.fromY - edited.scroll!.toY);
      expect(atCenter).toBeGreaterThanOrEqual(0);
      expect(atCenter).toBeLessThan(edited.scroll!.duration);
      expect(y + overlayFrame(edited, atCenter).scrollY).toBeCloseTo(540);
    });
    expect(title).toEqual(before);
  });

  it('escapes imported text and font names instead of executing HTML', () => {
    const svg = overlaySvg({ ...title, text: '</text><script>alert("x")</script>&name', fontFamily: 'A" onload="evil' }, 1920, 1080, 2);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('A&quot; onload=&quot;evil');
    expect(svg).toContain('&amp;name');
  });

  it('validates persisted overlays and resolves a reusable asset independently of clip overrides', () => {
    expect(validateOverlay(arrow)).toEqual([]);
    expect(validateOverlay(title)).toEqual([]);
    expect(validateOverlay({ ...title, fontSize: NaN, scroll: { fromY: 0, toY: 1, duration: 0 } })).toHaveLength(2);
    const media = { overlay: title } as MediaItem;
    const clip = { mediaId: 'title' } as Clip;
    expect(resolveOverlay(clip, media)).toBe(title);
    expect(resolveOverlay({ ...clip, overlay: { ...title, text: 'Edited' } }, media)?.kind).toBe('title');
    expect(title.text).toContain('First supporter');
  });
});
