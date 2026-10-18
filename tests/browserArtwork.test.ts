import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { filmstripFrames, startBrowserArtwork } from '../src/lib/browserArtwork';
import { useStore, emptyProject } from '../src/lib/store';
import { createEditorToolController } from '../src/lib/editorTools';
import type { Clip, MediaItem } from '../src/lib/types';

const original = useStore.getState();
let stop = () => {};
beforeEach(() => useStore.setState({ ...original, project: emptyProject(), past: [], future: [] }, true));
afterEach(() => { stop(); useStore.setState(original, true); });
const media = (id: string): MediaItem => ({ id, name: `${id}.mp4`, kind: 'video', src: `cutwright-local:${id}`, duration: 10, hasAudio: false, color: '#FFFFFF' });
const artwork = { thumb: 'data:image/jpeg;base64,AA', filmstrip: [{ time: 1, url: 'first' }, { time: 8, url: 'last' }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it('prepares imported browser media through a bounded queue without revision or undo changes', async () => {
  useStore.setState({ project: { ...emptyProject(), media: [media('one'), media('two')] } });
  const controller = createEditorToolController({ enabled: true }), revision = controller.status.revision;
  let active = 0, peak = 0;
  const prepare = vi.fn(async () => { peak = Math.max(peak, ++active); await tick(); active--; return artwork; });
  stop = startBrowserArtwork({ prepare });
  await vi.waitFor(() => expect(useStore.getState().project.media.every(m => !!m.filmstrip?.length)).toBe(true));
  expect(prepare).toHaveBeenCalledTimes(2); expect(peak).toBe(1);
  expect(controller.status.revision).toBe(revision); expect(useStore.getState().past).toHaveLength(0);
  expect((await controller.execute('get_project')).project).toEqual({ ...emptyProject(), media: [media('one'), media('two')] });
  controller.dispose();
});

it('does not apply completed old-source artwork after a relink or document replacement', async () => {
  useStore.setState({ project: { ...emptyProject(), media: [media('one')] } });
  let complete!: (value: typeof artwork) => void;
  const prepare = vi.fn(() => new Promise<typeof artwork>(resolve => { complete = resolve; }));
  stop = startBrowserArtwork({ prepare }); await tick();
  useStore.setState({ project: { ...emptyProject(), media: [{ ...media('one'), src: 'cutwright-local:replacement' }] } });
  complete(artwork); await tick();
  expect(useStore.getState().project.media[0].thumb).toBeUndefined();
});

it('reuses preserved artwork after save/open and skips overlays and missing files', async () => {
  useStore.setState({ project: { ...emptyProject(), media: [{ ...media('one'), ...artwork }, { ...media('missing'), offline: true }] } });
  const prepare = vi.fn(); stop = startBrowserArtwork({ prepare }); await tick();
  expect(prepare).not.toHaveBeenCalled();
});

it('chooses sampled source frames for trims and speed and bounds rendered cells', () => {
  const item = { ...media('one'), ...artwork };
  const clip: Clip = { id: 'c', mediaId: item.id, name: 'c', trackId: 'v1', start: 100, offset: 6, duration: 2, speed: 2, color: '#FFFFFF' };
  expect(filmstripFrames(item, clip, 2)).toEqual(['last', 'last']);
  expect(filmstripFrames(item, clip, 10000)).toHaveLength(64);
  expect(filmstripFrames(media('none'), clip, 2)).toEqual([]);
});
