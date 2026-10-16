import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEMENT_TEMPLATES, insertTemplate, templatePreview, TEXT_CATEGORIES, TEXT_TEMPLATES } from '../src/components/textTemplates';
import { overlayFrame, overlaySvg, resolveOverlay, validateOverlay } from '../src/lib/overlay';
import { overlayPreviewTime } from '../src/lib/overlayAssets';
import { resolvePreviewComposition } from '../src/lib/previewComposition';
import { useStore } from '../src/lib/store';
import type { NativeOverlay, Project, TitleOverlay } from '../src/lib/types';
import { validateProject } from '../src/lib/validate';

const formats = [
  { name: 'landscape', width: 1920, height: 1080 },
  { name: 'portrait', width: 1080, height: 1920 },
  { name: 'square', width: 1080, height: 1080 },
  { name: 'smallest supported', width: 2, height: 2 },
  { name: 'largest supported', width: 16384, height: 16384 },
  { name: 'narrow custom', width: 2, height: 16384 },
  { name: 'wide custom', width: 16384, height: 2 },
];
const templates = [...TEXT_TEMPLATES, ...ELEMENT_TEMPLATES];
const findTemplate = (id: string) => {
  const template = templates.find((entry) => entry.id === id);
  if (!template) throw new Error(`Missing template: ${id}`);
  return template;
};
const title = (overlay: NativeOverlay | undefined): TitleOverlay => {
  if (overlay?.kind !== 'title') throw new Error('Expected an independently editable native title');
  return overlay;
};
const fixture = (width = 1920, height = 1080): Project => ({
  version: 1, name: 'Existing editorial project', width, height, fps: 30000 / 1001,
  media: [
    { id: 'footage', name: 'Original footage', kind: 'video', src: 'original.mp4', duration: 60, hasAudio: false, color: '#336699' },
    { id: 'music', name: 'Original music', kind: 'audio', src: 'music.wav', duration: 60, color: '#669933' },
  ],
  clips: [
    { id: 'opening', mediaId: 'footage', trackId: 'v1', name: 'Opening', start: 0, duration: 10, offset: 2, color: '#336699' },
    { id: 'main', mediaId: 'footage', trackId: 'v1', name: 'Main', start: 10, duration: 20, offset: 20, color: '#336699' },
    { id: 'inset', mediaId: 'footage', trackId: 'v3', name: 'Inset', start: 0, duration: 25, offset: 0, color: '#336699', scale: .4 },
    { id: 'soundtrack', mediaId: 'music', trackId: 'a1', name: 'Soundtrack', start: 0, duration: 30, offset: 0, color: '#669933', volume: .2 },
  ],
  transitions: [{ id: 'cut', defId: 'cross-dissolve', at: 10, duration: .6, anchorClipId: 'main' }],
  subtitles: [{ id: 'caption', start: 12, end: 15, text: 'Existing caption' }],
  subtitleStyle: { fontSize: 24, color: '#FFFFFF' },
  customTransitions: [],
  trackOrder: ['v3', 'a2', 'v1', 'a1'],
  trackSettings: { v8: { hidden: true }, a2: { volume: .15 }, v3: { muted: true } },
  markers: [{ id: 'note', time: 12.5, label: 'Add the title here', color: '#FFCF63' }],
});
const freeze = <T,>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = () => JSON.stringify(useStore.getState().project);

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  useStore.setState({ past: [], future: [], selectedClipId: null, selectedTransitionId: null, selectedSubId: null, playhead: 0, playing: false });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(templates)('$name native template', (template) => {
  it.each(formats)('remains valid and renders editable content on a $name canvas', ({ width, height }) => {
    const overlays = template.create(width, height);
    expect(overlays.length).toBeGreaterThan(0);
    overlays.forEach((overlay) => expect(validateOverlay(overlay)).toEqual([]));
    const project = fixture(width, height);
    const inserted = insertTemplate(project, template.name, overlays, 12.5);
    expect(validateProject(inserted.project)).toMatchObject({ ok: true, errors: [] });
    expect(inserted.project.clips).toHaveLength(project.clips.length + overlays.length);
    expect(inserted.project.media).toHaveLength(project.media.length + overlays.length);
    inserted.project.clips.slice(project.clips.length).forEach((clip, index) => {
      const media = inserted.project.media.find((entry) => entry.id === clip.mediaId);
      expect(clip.start).toBe(12.5);
      expect(resolveOverlay(clip, media)).toEqual(overlays[index]);
      expect(media?.src).toBe('');
      expect(media?.overlay).toEqual(overlays[index]);
      expect(media?.overlay).not.toBe(clip.overlay);
    });

    const preview = templatePreview(overlays, width, height);
    expect(preview).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(preview.slice(preview.indexOf(',') + 1));
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(svg).not.toMatch(/<image\b|<foreignObject\b|data:image\/(?:png|jpe?g|webp)|<script\b/i);
    let previousLayer = -1;
    overlays.forEach((overlay) => {
      // Card previews must contain the same real renderer output used for
      // composition/export, including that overlay's visible animation phase.
      const rendered = overlaySvg(overlay, width, height, overlayPreviewTime(overlay, { width, height }));
      const layer = svg.indexOf(rendered, previousLayer + 1);
      expect(layer).toBeGreaterThan(previousLayer);
      expect(rendered).toContain(overlay.kind === 'title' ? '<text ' : '<path ');
      previousLayer = layer;
    });
  });
});

describe('text library behavior', () => {
  it('provides unique searchable styles in real text categories, separate from elements', () => {
    expect(new Set(templates.map((entry) => entry.id)).size).toBe(templates.length);
    expect(TEXT_TEMPLATES.every((entry) => TEXT_CATEGORIES.includes(entry.category))).toBe(true);
    expect(TEXT_TEMPLATES.every((entry) => entry.name.trim() && entry.description.trim())).toBe(true);
    for (const category of ['Basic', 'Headings', 'Lower thirds', 'Cinematic', 'Animated', 'Credits']) {
      expect(TEXT_TEMPLATES.some((entry) => entry.category === category)).toBe(true);
    }
    expect(TEXT_TEMPLATES.every((entry) => entry.create(1920, 1080).every((overlay) => overlay.kind === 'title'))).toBe(true);
    expect(ELEMENT_TEMPLATES.some((entry) => entry.create(1920, 1080).some((overlay) => overlay.kind === 'arrow'))).toBe(true);
  });

  it('adds title and subtitle above existing tracks without mutating or replacing project content', () => {
    const project = fixture();
    const before = structuredClone(project);
    const overlays = findTemplate('title-subtitle').create(project.width, project.height);
    const originalOverlays = structuredClone(overlays);
    freeze(project);
    freeze(overlays);
    const inserted = insertTemplate(project, 'Title + subtitle', overlays, 12.5);
    expect(project).toEqual(before);
    expect(overlays).toEqual(originalOverlays);
    expect(inserted.project).not.toBe(project);
    expect(inserted.project.clips.slice(0, project.clips.length)).toEqual(project.clips);
    expect(inserted.project.media.slice(0, project.media.length)).toEqual(project.media);
    for (const key of ['transitions', 'subtitles', 'subtitleStyle', 'customTransitions', 'trackSettings', 'markers'] as const) {
      expect(inserted.project[key]).toEqual(project[key]);
    }
    const added = inserted.project.clips.slice(project.clips.length);
    expect(added).toHaveLength(2);
    expect(added.map((clip) => clip.trackId)).toEqual(['v9', 'v10']);
    expect(inserted.project.trackOrder?.slice(0, 2)).toEqual(['v10', 'v9']);
    expect(inserted.project.trackOrder?.filter((id) => project.trackOrder!.includes(id))).toEqual(project.trackOrder);
    expect(inserted.project.trackOrder).toContain('v8');
    expect(new Set(inserted.project.trackOrder).size).toBe(inserted.project.trackOrder?.length);
    expect(added.find((clip) => clip.id === inserted.selectedId)?.overlay).toEqual(overlays[0]);
    expect(title(added[0].overlay).text).toBe('Your title');
    expect(title(added[1].overlay).text).toBe('The story starts here');
  });

  it('composes the two independent layers together over footage only inside their timeline window', () => {
    const project = fixture();
    const template = findTemplate('title-subtitle');
    const inserted = insertTemplate(project, template.name, template.create(project.width, project.height), 12.5);
    const added = inserted.project.clips.slice(project.clips.length);
    const visible = (time: number) => resolvePreviewComposition(inserted.project, [], time).flatMap((track) => track.layers.map((layer) => layer.clip));
    expect(visible(12.49).filter((clip) => added.some((entry) => entry.id === clip.id))).toEqual([]);
    const atTitle = visible(13);
    expect(atTitle.filter((clip) => added.some((entry) => entry.id === clip.id)).map((clip) => title(clip.overlay).text)).toEqual(['Your title', 'The story starts here']);
    expect(atTitle.some((clip) => clip.id === 'main')).toBe(true);
    expect(added.every((clip) => clip.start === 12.5 && clip.duration === 5)).toBe(true);
    expect(visible(17.5).filter((clip) => added.some((entry) => entry.id === clip.id))).toEqual([]);
  });

  it('records one insertion and independent layer edits with exact undo/redo and save/open content', () => {
    useStore.getState().setProject(fixture(), true);
    const before = snapshot();
    const project = useStore.getState().project;
    const template = findTemplate('title-subtitle');
    const inserted = insertTemplate(project, template.name, template.create(project.width, project.height), 12.5);
    useStore.getState().setProject(inserted.project);
    const afterInsert = snapshot();
    const added = useStore.getState().project.clips.slice(project.clips.length);
    expect(useStore.getState().past).toHaveLength(1);
    useStore.getState().undo();
    expect(snapshot()).toBe(before);
    useStore.getState().redo();
    expect(snapshot()).toBe(afterInsert);

    useStore.getState().updateClip(added[0].id, { overlay: { ...title(added[0].overlay), text: 'My new title', color: '#FFCF63' } });
    const afterTitle = snapshot();
    expect(title(useStore.getState().project.clips.find((clip) => clip.id === added[1].id)?.overlay).text).toBe('The story starts here');
    expect(title(useStore.getState().project.media.find((media) => media.id === added[0].mediaId)?.overlay).text).toBe('Your title');
    useStore.getState().updateClip(added[1].id, { overlay: { ...title(added[1].overlay), text: 'My separate subtitle', fontSize: 40 } });
    const afterSubtitle = snapshot();
    expect(title(useStore.getState().project.clips.find((clip) => clip.id === added[0].id)?.overlay)).toMatchObject({ text: 'My new title', color: '#FFCF63' });
    expect(useStore.getState().past).toHaveLength(3);
    for (const expected of [afterTitle, afterInsert, before]) {
      useStore.getState().undo();
      expect(snapshot()).toBe(expected);
    }
    for (const expected of [afterInsert, afterTitle, afterSubtitle]) {
      useStore.getState().redo();
      expect(snapshot()).toBe(expected);
    }
    const reopened = validateProject(JSON.parse(afterSubtitle));
    expect(reopened).toMatchObject({ ok: true, errors: [] });
    useStore.getState().setProject(reopened.project!, true);
    expect(useStore.getState().project).toEqual(JSON.parse(afterSubtitle));
    expect(title(useStore.getState().project.clips.find((clip) => clip.id === added[1].id)?.overlay).text).toBe('My separate subtitle');
  });

  it('keeps inserted copies independent of later template changes, including credit scroll settings', () => {
    const template = findTemplate('rolling');
    const project = fixture();
    const overlays = template.create(project.width, project.height);
    const first = insertTemplate(project, template.name, overlays, 5);
    const second = insertTemplate(first.project, template.name, overlays, 25);
    const firstClip = first.project.clips.at(-1)!;
    const secondClip = second.project.clips.at(-1)!;
    title(overlays[0]).text = 'Changed template';
    title(overlays[0]).scroll!.toY = -1;
    title(secondClip.overlay).text = 'Changed second instance';
    title(secondClip.overlay).scroll!.toY = -2;
    expect(title(firstClip.overlay).text).toContain('Thank you for watching');
    expect(title(firstClip.overlay).scroll?.toY).toBeLessThan(-1000);
    expect(firstClip.duration).toBe(12);
    expect(firstClip.overlay).not.toBe(first.project.media.at(-1)?.overlay);
    expect(title(second.project.media.at(-1)?.overlay).text).toContain('Thank you for watching');
    expect(title(template.create(project.width, project.height)[0]).text).toContain('Thank you for watching');
  });

  it('uses actual fade and rolling-credit animation and safely encodes edited text in previews', () => {
    const fade = findTemplate('fade').create(1920, 1080)[0];
    expect(overlayFrame(fade, 0).opacity).toBe(0);
    expect(overlayFrame(fade, 2).opacity).toBe(1);
    expect(overlayFrame(fade, 4.8).opacity).toBeGreaterThan(0);
    expect(overlayFrame(fade, 4.8).opacity).toBeLessThan(1);
    const credits = findTemplate('rolling').create(1920, 1080)[0];
    expect(overlayFrame(credits, 9).scrollY).toBeLessThan(overlayFrame(credits, 3).scrollY);
    const edited = { ...title(findTemplate('simple').create(1920, 1080)[0]), text: 'R&D <launch> "today"', fontFamily: 'A&B "Display"' };
    const svg = decodeURIComponent(templatePreview([edited], 1920, 1080).split(',').slice(1).join(','));
    expect(svg).toContain('R&amp;D &lt;launch&gt; &quot;today&quot;');
    expect(svg).toContain('A&amp;B &quot;Display&quot;, Arial, sans-serif');
    expect(svg).not.toContain('<launch>');
  });
});
