import { describe, expect, it } from 'vitest';
import { convertMovaviConfig, windowsPathToFileUrl } from '../src/lib/movavi';
import { validateProject } from '../src/lib/validate';

// Minimal but structurally faithful Movavi config (config v88 shape):
// main video track + linked audio track + music track + generated overlay.
function fixture() {
  const fileVideo = {
    '@meta': { class_name: 'Media::File', object_id: 100 },
    format: 'mov', length: 20000, path: 'C:\\Media\\take #1.mp4',
    audioTracks: [{ '@meta': { class_name: 'Media::AudioTrack', object_id: 101 } }],
    videoTracks: [{ '@meta': { class_name: 'Media::VideoTrack', object_id: 102 }, isImage: false, 'Media::Video': { '@meta': { class_name: 'Media::Video', object_id: 103 }, width: 1920, height: 1080 } }],
  };
  const fileMusic = {
    '@meta': { class_name: 'Media::File', object_id: 110 },
    format: 'mp3', length: 60000, path: 'C:\\Media\\song.mp3',
    audioTracks: [{ '@meta': { class_name: 'Media::AudioTrack', object_id: 111 } }],
    videoTracks: [],
  };
  const track = (id: number, type: number, linked = false) => ({ '@meta': { class_name: 'Timeline::Track', object_id: id }, type, hidden: false, muted: false, linked, gapless: false });
  const timing = (id: number, trackRef: number, timestamp: number, duration: number, sourcePosition: number, speed = 1) => ({
    '@meta': { class_name: 'Timeline::ClipTiming', object_id: id },
    timestamp, duration, sourcePosition, speed, track: { '@meta_reference': trackRef },
    fadeInDuration: 0, fadeOutDuration: 0, reversed: false, sourceDuration: duration, speedCompensated: false, timingMode: 0, transitionIn: 0, transitionOut: 0,
  });
  const clip = (id: number, name: string, type: number, file: unknown, volume = 100, overlay: unknown = null) => ({
    '@meta': { class_name: 'Timeline::Clip', object_id: id }, name, type, file, overlay,
    volume, enabled: true, broken: false, effects: [], cropEnvelope: null, moveEnvelope: null, volumeEnvelope: null, sourceDuration: 0,
  });
  return {
    version: '1.0',
    data: {
      content: {
        timeline: {
          video: { '@meta': { class_name: 'Media::Video', object_id: 3 }, width: 1920, height: 1080, frameRateN: 30000, frameRateD: 1001, aspectX: 1, aspectY: 1 },
          audio: { '@meta': { class_name: 'Media::Audio', object_id: 4 }, channelLayout: 2, sampleFormat: 1, sampleRate: 44100 },
          tracks: [track(5, 1), track(8, 4, true), track(9, 8), track(12, 16, true)],
          clips: [
            { clip: clip(15, 'take #1.mp4', 1, fileVideo), timing: timing(24, 5, 0, 5000, 2000) },
            { clip: clip(25, 'take #1.mp4', 2, { '@meta_reference': 100 }, 300), timing: timing(26, 8, 0, 5000, 2000) },
            { clip: clip(35, 'song.mp3', 2, fileMusic, 2), timing: timing(36, 9, 0, 20000, 0) },
            {
              clip: clip(45, 'ArrowShaped4', 4, null, 100, {
                '@meta': { class_name: 'Overlay::Preset', object_id: 46 }, description: 'ArrowShaped4', tag: 'ArrowShaped4', scriptId: 'CalloutAnimated',
                items: [{
                  '@meta': { class_name: 'Overlay::Item', object_id: 47 }, type: 16,
                  text: JSON.stringify({ 'begin-pos-x': 100, 'begin-pos-y': 50, 'end-pos-x': 300, 'end-pos-y': 200, color: '#ffd44b47', width: 20, 'begin-cap': 0, 'end-cap': 3 }),
                  transform: { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 10, m32: 20, m33: 1 },
                  envelope: { defaultValue: { opacity: 100 }, keyValues: [] },
                }],
              }),
              timing: timing(48, 12, 1000, 3000, -165),
            },
          ],
          transitions: [
            { clipFrom: null, clipTo: { '@meta_reference': 15 }, transition: { '@meta': { class_name: 'Transition::Blur', object_id: 60 }, blurType: 2, 'Transition::Object': { '@meta': { class_name: 'Transition::Object', object_id: 61 }, defaultDuration: 2000, description: 'BlurInOut' } } },
          ],
          links: [],
        },
      },
    },
  };
}

describe('Movavi conversion', () => {
  it('maps tracks, timing, source offsets, rational fps and percent gains', () => {
    const source = fixture();
    const before = JSON.stringify(source);
    const { project, report } = convertMovaviConfig(source, { projectName: 'Fixture' });
    expect(JSON.stringify(source)).toBe(before);
    expect(project.width).toBe(1920);
    expect(project.fps).toBeCloseTo(30000 / 1001, 6);
    expect(report.source.durationSec).toBe(20);
    const video = project.clips.find((c) => c.trackId === 'v1')!;
    expect(video.start).toBe(0);
    expect(video.duration).toBe(5);
    expect(video.offset).toBe(2);
    expect(video.mutedAudio).toBe(true); // linked audio carries the voice
    const voice = project.clips.find((c) => c.trackId === 'a1')!;
    expect(voice.volume).toBe(3); // 300%
    const music = project.clips.find((c) => c.trackId === 'a2')!;
    expect(music.volume).toBeCloseTo(0.02, 5); // 2%
    expect(project.media.find((m) => m.id === video.mediaId)?.src).toContain('take%20%231.mp4');
    expect(validateProject(project).ok).toBe(true);
  });

  it('resolves file @meta_reference and generated arrow geometry', () => {
    const { project, assets, report } = convertMovaviConfig(fixture());
    const arrow = assets.find((a) => a.kind === 'arrow')!;
    expect(arrow.arrow).toMatchObject({ x1: 110, y1: 70, x2: 310, y2: 220, color: '#d44b47', width: 20, head: true });
    const gen = project.clips.find((c) => c.generatedOverlay?.kind === 'arrow')!;
    expect(gen.offset).toBe(0);
    expect(gen.overlay).toMatchObject({ kind: 'arrow', animationOffset: -0.165, drawDuration: 0.5 });
    expect(project.media.find((m) => m.id === gen.mediaId)?.overlay).toEqual(gen.overlay);
    expect(gen.mediaId).toBe(arrow.mediaId);
    expect(report.mapped.clampedSourceOffsets).toBe(0); // preset phase is not a media seek
    expect(report.mapped.preservedAnimationOffsets).toBe(1);
    expect(report.mapped.linkedAudioClips).toBe(1);
  });

  it('maps BlurInOut entrance (clipFrom=null) and between-clip transitions', () => {
    const { project } = convertMovaviConfig(fixture());
    expect(project.transitions).toHaveLength(1);
    expect(project.transitions[0]).toMatchObject({ defId: 'blur-inout', entrance: true, duration: 2 });
    expect(project.transitions[0].anchorClipId).toBe(project.clips.find((c) => c.trackId === 'v1')!.id);
  });

  it('preserves Qt arrow alpha in the native CSS/SVG color ordering', () => {
    const cfg = fixture();
    const item = cfg.data.content.timeline.clips[3].clip.overlay!.items[0];
    item.text = item.text.replace('#ffd44b47', '#80d44b47');
    const { project } = convertMovaviConfig(cfg);
    expect(project.clips.find((c) => c.overlay)?.overlay?.color).toBe('#d44b4780');
  });

  it('keeps an overflowing credit roll editable, continuous and at the serialized font size', () => {
    const cfg = fixture() as unknown as { data: { content: { timeline: { clips: { clip: Record<string, unknown> }[] } } } };
    const target = cfg.data.content.timeline.clips.find((w) => (w.clip as { name?: string }).name === 'ArrowShaped4')!;
    const lines = Array.from({ length: 30 }, (_, i) => `Name ${i + 1}`);
    const html = `<html><head></head><body style="font-family:'Cygre Black'; font-size:40pt;">${lines.map((l) => `<p align="center"><span style="color:#ffffff;">${l}</span></p>`).join('')}</body></html>`;
    (target.clip as { overlay: unknown }).overlay = {
      '@meta': { class_name: 'Overlay::Preset', object_id: 46 }, description: 'Credits', tag: 'Credits', scriptId: 'Credits',
      items: [{
        '@meta': { class_name: 'Overlay::Item', object_id: 47 }, type: 1, text: html, textWidth: 800,
        transform: { m11: 0.625, m12: 0, m13: 0, m21: 0, m22: 0.625, m23: 0, m31: 100, m32: 100, m33: 1 },
        envelope: { defaultValue: { opacity: 100 }, keyValues: [] },
      }],
    };
    const { project, assets, report } = convertMovaviConfig(cfg);
    const titleAssets = assets.filter((a) => a.kind === 'title');
    expect(titleAssets.length).toBe(1);
    expect(titleAssets[0].title?.fontSizePx).toBeCloseTo(100 / 3); // 40pt * 96/72 * 0.625
    expect(titleAssets[0].title?.fontFamily).toBe('Cygre Black');
    const clips = project.clips.filter((c) => c.generatedOverlay?.preset === 'Credits').sort((a, b) => a.start - b.start);
    expect(clips.length).toBe(1);
    expect(clips[0].start).toBe(1);
    expect(clips[0].duration).toBe(3);
    const native = clips[0].overlay!;
    expect(native.kind).toBe('title');
    if (native.kind !== 'title') throw new Error('Expected native title');
    expect(native.text.split('\n')).toEqual(lines);
    expect(native.scroll).toMatchObject({ fromY: 1080, duration: 3 });
    expect(native.scroll!.toY).toBeLessThan(-1000);
    expect(report.unsupported.some((u) => /OPEN fidelity gap|Credit roll pagination/.test(u.item))).toBe(false);
    expect(report.mapped.nativeOverlays).toBe(1);
    expect(validateProject(project).ok).toBe(true);
  });

  it('rejects non-Movavi input with a useful error', () => {
    expect(() => convertMovaviConfig({ hello: 1 })).toThrow(/Not a Movavi/);
    expect(() => convertMovaviConfig(null)).toThrow(/Not a Movavi/);
  });

  it('encodes Windows paths as file URLs', () => {
    expect(windowsPathToFileUrl('C:\\a b\\c#d.mp4')).toBe('file:///C:/a%20b/c%23d.mp4');
    expect(windowsPathToFileUrl('\\\\server\\share\\x.mp4')).toBe('file://server/share/x.mp4');
  });
});
