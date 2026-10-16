import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoProject } from '../src/lib/store';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe('browser local media', () => {
  it('keeps imported media playable when local storage is unavailable, and reports that recovery failed', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const media = await import('../src/lib/browserMedia');
    const file = new File(['original media bytes'], 'clip.mp4', { type: 'video/mp4' });
    const result = await media.storeBrowserFile(file);
    expect(result.persisted).toBe(false);
    expect(result.error).toMatch(/storage is unavailable/);
    expect(result.source).toMatch(/^cutwright-local:/);
    expect(media.browserMediaUrl(result.source)).toBe(result.url);
    expect(await (await fetch(result.url)).text()).toBe('original media bytes');
    expect(await media.loadBrowserMedia(result.source)).toBe(file);
    URL.revokeObjectURL(result.url);
  });

  it('marks old blob URLs and desktop paths missing without changing clip edits or attempting network access', async () => {
    const network = vi.fn(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', network);
    const { restoreBrowserMedia, browserMediaUrl } = await import('../src/lib/browserMedia');
    const project = demoProject();
    project.media = [
      { id: 'video', name: 'old.mp4', kind: 'video', src: 'blob:https://example.org/expired', duration: 12, color: '#fff' },
      { id: 'audio', name: 'voice.wav', kind: 'audio', src: 'file:///C:/media/voice.wav', duration: 12, color: '#fff' },
      { id: 'windows', name: 'picture.png', kind: 'image', src: 'C:\\media\\picture.png', duration: 10, color: '#fff' },
    ];
    const clips = structuredClone(project.clips);
    const restored = await restoreBrowserMedia(project);
    expect(restored.missing.sort()).toEqual(['old.mp4', 'picture.png', 'voice.wav']);
    expect(restored.project.media.every((item) => item.offline)).toBe(true);
    expect(restored.project.clips).toEqual(clips);
    expect(project.media.some((item) => item.offline)).toBe(false);
    expect(browserMediaUrl('cutwright-local:not-in-this-tab')).toBe('');
    expect(browserMediaUrl('https://example.org/video.mp4')).toBe('https://example.org/video.mp4');
    expect(network).not.toHaveBeenCalled();
  });

  it('restores an imported source without changing its durable saved reference', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const media = await import('../src/lib/browserMedia');
    const imported = await media.storeBrowserFile(new File(['image'], 'still.png', { type: 'image/png' }));
    const project = demoProject();
    project.media = [{ id: 'still', name: 'still.png', kind: 'image', src: imported.source, duration: 4, color: '#fff', offline: true }];
    const restored = await media.restoreBrowserMedia(project);
    expect(restored.project.media[0]).toMatchObject({ src: imported.source, offline: false });
    expect(restored.missing).toEqual([]);
    expect(JSON.stringify(restored.project)).not.toContain('blob:');
    URL.revokeObjectURL(imported.url);
  });

  it('preserves missing durable references when browser storage is blocked so they can be relinked', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { restoreBrowserMedia } = await import('../src/lib/browserMedia');
    const project = demoProject();
    project.media = [{ id: 'blocked', name: 'voice.wav', kind: 'audio', src: 'cutwright-local:stored-on-another-device', duration: 12, color: '#fff' }];
    const restored = await restoreBrowserMedia(project);
    expect(restored.project.media[0]).toMatchObject({ id: 'blocked', src: project.media[0].src, offline: true });
    expect(restored.missing).toEqual(['voice.wav']);
    expect(restored.errors).toEqual(['Local media storage is unavailable in this browser.']);
    expect(restored.project.clips).toBe(project.clips);
  });
});
