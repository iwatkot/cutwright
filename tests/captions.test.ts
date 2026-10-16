import { describe, expect, it } from 'vitest';
import { activeCaptions, captionLayout, captionStyle, captionTextWidth, subtitlesToAss, wrapCaption } from '../src/lib/captions';
import type { Project } from '../src/lib/types';

const project = (patch: Partial<Project> = {}): Project => ({ version: 1, name: 'Captions', width: 1920, height: 1080, fps: 30,
  media: [], clips: [], transitions: [], customTransitions: [], subtitleStyle: { fontSize: 48, color: '#D44B47' },
  subtitles: [{ id: 'first', start: .2, end: 1.2, text: 'First line\nSecond line' }], ...patch });

describe('shared caption composition', () => {
  it('uses project pixels at 1080p and preserves normalized geometry at 480p', () => {
    const full = captionLayout(project(), .5)!;
    const small = captionLayout(project({ width: 854, height: 480 }), .5)!;
    expect(full.fontSize).toBe(48);
    expect(full.bottomMargin).toBe(36);
    expect(full.outlineWidth).toBe(2);
    expect(small.fontSize / full.fontSize).toBeCloseTo(480 / 1080);
    expect(small.lines[1].y / 480).toBeCloseTo(full.lines[1].y / 1080);
    expect(full.lines[1].y - full.lines[0].y).toBeCloseTo(full.lineHeight);
  });

  it('stacks all active cues in stable order and uses an exclusive end', () => {
    const p = project({ subtitles: [{ id: 'a', start: 0, end: 1, text: 'One' }, { id: 'b', start: .5, end: 2, text: 'Two' }] });
    expect(activeCaptions(p, .5).map((c) => c.id)).toEqual(['a', 'b']);
    expect(captionLayout(p, .5)!.lines.map((l) => l.text)).toEqual(['One', 'Two']);
    expect(captionLayout(p, 1)!.lines.map((l) => l.text)).toEqual(['Two']);
    expect(captionLayout(p, 2)).toBeNull();
  });

  it('wraps words and long tokens while preserving explicit blank lines', () => {
    expect(wrapCaption('one two three\n\nabcdef', 5, (s) => s.length)).toEqual(['one', 'two', 'three', '', 'abcde', 'f']);
    const p = project({ width: 480, subtitles: [{ id: 'long', start: 0, end: 2, text: 'Long captions wrap safely inside the composition width rather than the preview viewport.' }] });
    const layout = captionLayout(p, 1)!;
    expect(layout.lines.length).toBeGreaterThan(2);
    expect(layout.lines.every((line) => line.width <= p.width - layout.sideMargin * 2)).toBe(true);
  });

  it('uses Arial advances and kerning without canvas or document access', () => {
    expect(captionTextWidth('MMMM', 48)).toBeGreaterThan(captionTextWidth('iiii', 48) * 2);
    expect(captionTextWidth('Caption geometry', 48)).toBeCloseTo(captionTextWidth('Caption geometry', 24) * 2);
    expect(captionTextWidth('AV', 48)).toBeLessThan(captionTextWidth('A', 48) + captionTextWidth('V', 48));
    expect(captionTextWidth('e\u0301', 48)).toBe(captionTextWidth('e', 48));
  });

  it('writes explicit ASS geometry and the same overlap/wrap segments', () => {
    const p = project({ subtitles: [{ id: 'a', start: 0, end: 1, text: 'One' }, { id: 'b', start: .5, end: 2, text: 'Two' }] });
    const ass = subtitlesToAss(p);
    expect(ass).toContain('PlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2');
    expect(ass).toContain('Default,Arial,53.625');
    expect(ass).toContain('One\\NTwo');
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(3);
    expect(captionStyle(p).color).toBe('#D44B47');
  });

  it('escapes imported ASS override text and literal backslash commands', () => {
    const ass = subtitlesToAss(project({ subtitles: [{ id: 's', start: 0, end: 1, text: '{\\pos(0,0)} literal \\N text' }] }));
    expect(ass).toContain('\\{');
    expect(ass).not.toContain('{\\pos(');
    expect(ass).toContain('\\\uFEFFN');
  });

  it('quantizes fractional cue boundaries by frame before ASS centiseconds', () => {
    const ass = subtitlesToAss(project({ subtitles: [{ id: 's', start: .201, end: 1.801, text: 'Fractional' }] }));
    expect(ass).toContain('0:00:00.23,0:00:01.83');
    expect(subtitlesToAss(project({ subtitles: [{ id: 's', start: .201, end: .202, text: 'No visible frame' }] }))).not.toContain('Dialogue:');
  });
});
