import { describe, expect, it } from 'vitest';
import { buildExportArgs } from '../src/lib/ffmpegPlan';
import { BUILTIN_TRANSITIONS } from '../src/lib/transitions';
import type { Project } from '../src/lib/types';

const base = (patch: Partial<Project>): Project => ({
  version: 1, name: 'fixture', width: 640, height: 360, fps: 30,
  media: [
    { id: 'a', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 10, color: '#111' },
    { id: 'b', name: 'b.mp4', kind: 'video', src: 'b.mp4', duration: 10, color: '#222' },
    { id: 'm', name: 'm.mp3', kind: 'audio', src: 'm.mp3', duration: 30, color: '#333' },
  ],
  clips: [], transitions: [], subtitles: [], customTransitions: [],
  ...patch,
});
const graph = (p: Project) => buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4').args.join(' ');

describe('ffmpegPlan composition', () => {
  it('includes longer audio and subtitle tails in the complete timeline', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'video', start: 0, duration: 2, offset: 0, color: '#111' },
      { id: '2', mediaId: 'm', trackId: 'a1', name: 'music', start: 0, duration: 5, offset: 0, color: '#111' },
    ], subtitles: [{ id: 's', start: 4, end: 6, text: 'End card' }] });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.duration).toBe(6);
    expect(plan.args.join(' ')).toContain('color=c=black');
    expect(plan.args.join(' ')).toContain('atrim=0:6.000');
    expect(plan.warnings).not.toContain(expect.stringMatching(/trimmed to the video/));
  });

  it('supports audio-only compositions on a black canvas', () => {
    const plan = buildExportArgs(base({ clips: [{ id: '1', mediaId: 'm', trackId: 'a1', name: 'music', start: 1, duration: 3, offset: 0, color: '#111' }] }), BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.duration).toBe(4);
    expect(plan.args.join(' ')).toContain('color=c=black');
    expect(plan.args.join(' ')).toContain('adelay=1000');
  });
  it('keeps the last quantized NTSC frame without extending raw audio or source windows', () => {
    const p = base({ fps: 30000 / 1001, clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'fractional end', start: .1499, duration: .901333, offset: .123456789, speed: 3, color: '#111' },
    ] });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    const end = .1499 + .901333;
    expect(plan.duration).toBe(end);
    expect(plan.args.join(' ')).toContain('trim=end_frame=32,settb=expr=1/29.97002997002997,setpts=N');
    expect(plan.args).not.toContain('-frames:v');
    expect(Number(plan.args[plan.args.lastIndexOf('-t') + 1])).toBeCloseTo(32 / p.fps, 8);
    expect(plan.args.join(' ')).toContain('atrim=0:1.051233000');
    expect(plan.args.filter((arg, i) => plan.args[i - 1] === '-t').slice(0, -1)).toEqual(['2.703999000', '2.703999000']);
    expect(plan.args.filter((arg, i) => plan.args[i - 1] === '-ss')).toEqual(['0.123456789', '0.123456789']);
  });
  it('bounds silent fallback audio by the raw fractional end', () => {
    const p = base({ fps: 30000 / 1001, media: [{ id: 'a', name: 'silent', kind: 'video', src: 'silent.mp4', duration: 5, hasAudio: false, color: '#111' }], clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'silent', start: .1499, duration: .901333, offset: 0, color: '#111' },
    ] });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.args.join(' ')).toContain('[1:a]atrim=0:1.051233000,asetpts=PTS-STARTPTS[asilent]');
    expect(plan.args.join(' ')).not.toContain('-shortest');
    expect(plan.args.join(' ')).toContain('trim=end_frame=32,settb=expr=1/29.97002997002997,setpts=N');
  });
  it('seeks independent source windows for repeated clips rather than retaining split frames', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'first', start: 0, duration: 2, offset: 1, color: '#111' },
      { id: '2', mediaId: 'a', trackId: 'v1', name: 'later', start: 2, duration: 2, offset: 7, color: '#111' },
    ] });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    const sources = plan.args.filter((arg, index) => plan.args[index - 1] === '-i');
    expect(sources).toEqual(['a.mp4', 'a.mp4', 'a.mp4', 'a.mp4']); // separate video and audio windows
    expect(plan.args.filter((arg, index) => plan.args[index - 1] === '-ss').map(Number)).toContain(7);
    expect(plan.args.join(' ')).not.toContain('trim=start=7.000');
  });

  it('native editable overlays export their exact source clock without depending on a thumbnail', () => {
    const overlay = { kind: 'title' as const, text: 'Native title', fontFamily: 'Arial', fontSize: 40, fontWeight: 700, color: '#FFFFFF', x: 20, y: 20, blockWidth: 500, lineHeight: 45, align: 'center' as const };
    const p = base({ media: [{ id: 'title', name: 'Title', kind: 'image', src: '', duration: 5, color: '#fff', overlay }], clips: [
      { id: '1', mediaId: 'title', trackId: 'v1', name: 'title', start: 0, duration: 2, offset: 1, speed: 2, color: '#fff' },
    ] });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    const descriptor = plan.args.find((arg) => arg.startsWith('cutwright-overlay:'))!;
    expect(JSON.parse(descriptor.slice('cutwright-overlay:'.length))).toMatchObject({ overlay, offset: 1, speed: 2, duration: 2 });
    expect(plan.args.join(' ')).not.toContain('setpts=(PTS-STARTPTS)/2'); // cache already samples the source clock
  });
  it('hard cuts stay hard cuts (no xfade) and duration is exact', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 4, offset: 0, color: '#111' },
      { id: '2', mediaId: 'b', trackId: 'v1', name: 'b', start: 4, duration: 4, offset: 0, color: '#222' },
    ]});
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.duration).toBe(8);
    expect(plan.args.join(' ')).not.toContain('xfade');
    expect(plan.args.join(' ')).toContain('concat');
  });

  it('gaps become black segments, never shifted timing', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 3, offset: 0, color: '#111' },
      { id: '2', mediaId: 'b', trackId: 'v1', name: 'b', start: 6, duration: 3, offset: 0, color: '#222' },
    ]});
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.duration).toBe(9);
    expect(plan.args.join(' ')).toContain('color=c=black');
  });

  it('a defined transition uses xfade but preserves total duration', () => {
    const p = base({
      clips: [
        { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 4, offset: 0, color: '#111' },
        { id: '2', mediaId: 'b', trackId: 'v1', name: 'b', start: 4, duration: 4, offset: 0, color: '#222' },
      ],
      transitions: [{ id: 't', defId: 'fade-to-black', at: 4, duration: 0.8 }],
    });
    const plan = buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4');
    expect(plan.args.join(' ')).toContain('xfade=transition=fadeblack');
    expect(plan.args.join(' ')).toContain('tpad'); // freeze-frame handles
    expect(plan.duration).toBe(8);
  });

  it('audio is mixed from all audible clips, not mapped from input 0', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 4, offset: 0, color: '#111' },
      { id: '2', mediaId: 'm', trackId: 'a1', name: 'm', start: 0, duration: 8, offset: 0, color: '#333' },
    ]});
    const g = graph(p);
    expect(g).toContain('amix=inputs=2');
    expect(g).not.toContain('0:a?');
    expect(g).toContain('adelay=');
  });

  it('V2 clips compose on transparent track gaps with opacity', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 6, offset: 0, color: '#111' },
      { id: '2', mediaId: 'b', trackId: 'v2', name: 'b', start: 2, duration: 2, offset: 0, color: '#222', opacity: 0.5 },
    ]});
    const g = graph(p);
    expect(g).toContain('overlay=');
    expect(g).toContain('color=c=black@0');
    expect(g).toContain('concat=n=2'); // joins transparent before/after the clip
    expect(g).toContain('colorchannelmixer=aa=0.500');
  });

  it('silent video (hasAudio=false) contributes no [n:a] reference', () => {
    const p = base({
      media: [
        { id: 'a', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 10, color: '#111', hasAudio: false },
        { id: 'm', name: 'm.mp3', kind: 'audio', src: 'm.mp3', duration: 30, color: '#333' },
      ],
      clips: [
        { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 4, offset: 0, color: '#111' },
        { id: '2', mediaId: 'm', trackId: 'a1', name: 'm', start: 0, duration: 4, offset: 0, color: '#333' },
      ],
    });
    const g = graph(p);
    expect(g).not.toContain('amix');
    expect(g).toContain('[1:a]atrim'); // only the music input (index 1)
    expect(g).not.toContain('[0:a]atrim');
  });

  it('overlapping clips on one track are rejected with an actionable error', () => {
    const p = base({ clips: [
      { id: '1', mediaId: 'a', trackId: 'v1', name: 'first', start: 0, duration: 5, offset: 0, color: '#111' },
      { id: '2', mediaId: 'b', trackId: 'v1', name: 'second', start: 3, duration: 5, offset: 0, color: '#222' },
    ]});
    expect(() => buildExportArgs(p, BUILTIN_TRANSITIONS, null, 'out.mp4')).toThrow(/overlap on track V1/);
  });

  it('muted tracks contribute no audio', () => {
    const p = base({
      trackSettings: { a1: { muted: true } },
      clips: [
        { id: '1', mediaId: 'a', trackId: 'v1', name: 'a', start: 0, duration: 4, offset: 0, color: '#111', volume: 0 },
        { id: '2', mediaId: 'm', trackId: 'a1', name: 'm', start: 0, duration: 4, offset: 0, color: '#333' },
      ],
    });
    const g = graph(p);
    expect(g).not.toContain('amix');
  });
});
