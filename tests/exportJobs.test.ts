import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/lib/types';
import type { EditorExportJobSnapshot } from '../src/lib/editorTools';

const mocks = vi.hoisted(() => ({ browser: vi.fn(), plan: vi.fn() }));
vi.mock('../src/lib/browserExport', () => ({ exportBrowserProject: mocks.browser }));
vi.mock('../src/lib/ffmpegPlan', () => ({ buildExportArgs: mocks.plan }));

const fixture = (): Project => ({ version: 1, name: 'Export snapshot', width: 640, height: 360, fps: 30,
  media: [{ id: 'm', name: 'Source.mp4', kind: 'video', src: 'C:/local/source.mp4', duration: 10, color: '#111111' }],
  clips: [{ id: 'c', mediaId: 'm', trackId: 'v1', name: 'Picture', start: 0, duration: 2, offset: 0, color: '#111111' }],
  transitions: [], subtitles: [], customTransitions: [] });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
type NativeResult = { ok: boolean; path?: string; error?: string };
let service: typeof import('../src/lib/exportJobs')['exportJobs'];
let store: typeof import('../src/lib/store')['useStore'];
let progress: (update: { seconds: number; total: number; stage?: string }) => void;
let unsubscribe: ReturnType<typeof vi.fn>, click: ReturnType<typeof vi.fn>;
let native: { exportVideo: ReturnType<typeof vi.fn>; cancelExport: ReturnType<typeof vi.fn>; onExportProgress: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  vi.resetModules(); mocks.browser.mockReset(); mocks.plan.mockReset().mockReturnValue({ args: ['native-plan'], duration: 2, warnings: [] });
  unsubscribe = vi.fn(); click = vi.fn();
  native = { exportVideo: vi.fn().mockResolvedValue({ ok: true, path: 'C:/out.mp4' }), cancelExport: vi.fn().mockResolvedValue(true), onExportProgress: vi.fn((callback) => { progress = callback; return unsubscribe; }) };
  vi.stubGlobal('window', { cutwright: native, dispatchEvent: vi.fn() });
  vi.stubGlobal('document', { createElement: vi.fn(() => ({ click, href: '', download: '' })) });
  ({ useStore: store } = await import('../src/lib/store'));
  store.setState({ project: fixture(), past: [], future: [] });
  ({ exportJobs: service } = await import('../src/lib/exportJobs'));
});
afterEach(() => { vi.unstubAllGlobals(); });
const waitStatus = async (id: string, status: EditorExportJobSnapshot['status']) => { await vi.waitFor(() => expect(service.get(id)?.status).toBe(status)); };

describe('shared local export job lifecycle', () => {
  it('rejects a concurrent job and renders an isolated project/definitions snapshot', async () => {
    const pending = deferred<NativeResult>(); native.exportVideo.mockReturnValue(pending.promise);
    const project = store.getState().project;
    const job = await service.start({ preset: '720', outputPath: 'C:/chosen.mp4' });
    expect(job.status).toBe('queued'); expect(() => service.start({ preset: 'source' })).toThrow('already running');
    project.clips[0].volume = .125; project.name = 'Edited during export'; project.customTransitions.push({ id: 'later', name: 'Later', description: '', xfade: 'fade', preview: 'fade', duration: 1, collection: 'Custom' });
    await vi.waitFor(() => expect(native.exportVideo).toHaveBeenCalledTimes(1));
    const [captured, defs, , , options] = mocks.plan.mock.calls[0];
    expect(captured.name).toBe('Export snapshot'); expect(captured.clips[0].volume).toBeUndefined(); expect(defs.some((d: { id: string }) => d.id === 'later')).toBe(false);
    expect(options).toMatchObject({ maxHeight: 720 }); expect(native.exportVideo.mock.calls[0][0]).toMatchObject({ outputPath: 'C:/chosen.mp4', durationSec: 2 });
    progress({ seconds: 1, total: 2, stage: 'Encoding picture' }); expect(service.get(job.id)).toMatchObject({ status: 'running', progress: .5, stage: 'Encoding picture' });
    progress({ seconds: 3, total: 2 }); expect(service.get(job.id)?.progress).toBe(.99);
    pending.resolve({ ok: true, path: 'C:/chosen.mp4' }); await waitStatus(job.id, 'completed');
    expect(service.get(job.id)).toMatchObject({ progress: 1, outputPath: 'C:/chosen.mp4' }); expect(unsubscribe).toHaveBeenCalledTimes(1);
    progress({ seconds: 0, total: 2 }); expect(service.get(job.id)?.progress).toBe(1);
  });

  it('cancels native work, releases the progress subscription, and allows retry', async () => {
    const pending = deferred<NativeResult>(); native.exportVideo.mockReturnValueOnce(pending.promise);
    const job = await service.start({ preset: 'source' }); await vi.waitFor(() => expect(native.exportVideo).toHaveBeenCalledTimes(1));
    expect(await service.cancel(job.id)).toBe(true); expect(native.cancelExport).toHaveBeenCalledTimes(1); expect(service.get(job.id)?.stage).toBe('Cancelling');
    pending.resolve({ ok: false, error: 'Export cancelled' }); await waitStatus(job.id, 'cancelled');
    expect(unsubscribe).toHaveBeenCalledTimes(1); expect(await service.cancel(job.id)).toBe(false);
    const retry = await service.start({ preset: '480' }); await waitStatus(retry.id, 'completed'); expect(mocks.plan.mock.calls[1][4]).toMatchObject({ maxHeight: 480, crf: 18 });
  });

  it('cancels queued work before invoking a codec or native renderer', async () => {
    const job = service.start({ preset: 'source' }) as EditorExportJobSnapshot;
    await service.cancel(job.id); await waitStatus(job.id, 'cancelled'); expect(native.exportVideo).not.toHaveBeenCalled();
  });

  it('does not wedge future jobs when a subscriber throws during start/progress/completion', async () => {
    service.subscribe(() => { throw new Error('Broken view'); });
    const first = await service.start({ preset: 'source' }); await waitStatus(first.id, 'completed');
    const second = await service.start({ preset: 'source' }); await waitStatus(second.id, 'completed');
    expect(native.exportVideo).toHaveBeenCalledTimes(2);
  });

  it('reports validation/missing media/native failures and permits retry without leaked subscriptions', async () => {
    store.setState({ project: { ...fixture(), width: 0 } }); expect(() => service.start({ preset: 'source' })).toThrow('Cannot export');
    const offline = fixture(); offline.media[0].offline = true; store.setState({ project: offline });
    const missing = await service.start({ preset: 'source' }); await waitStatus(missing.id, 'failed'); expect(service.get(missing.id)?.error).toContain('need media'); expect(native.exportVideo).not.toHaveBeenCalled();
    store.setState({ project: fixture() }); native.exportVideo.mockRejectedValueOnce(new Error('Native encoder failed'));
    const failed = await service.start({ preset: 'source' }); await waitStatus(failed.id, 'failed'); expect(service.get(failed.id)?.error).toBe('Native encoder failed'); expect(unsubscribe).toHaveBeenCalledTimes(1);
    const retry = await service.start({ preset: 'source' }); await waitStatus(retry.id, 'completed');
  });

  it('disposes a late browser result and never downloads after cancellation', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const pending = deferred<unknown>(), dispose = vi.fn().mockResolvedValue(undefined); mocks.browser.mockReturnValue(pending.promise);
    const job = await service.start({ preset: '1080' }); await vi.waitFor(() => expect(mocks.browser).toHaveBeenCalledTimes(1));
    const options = mocks.browser.mock.calls[0][2]; expect(options.signal.aborted).toBe(false);
    expect(await service.cancel(job.id)).toBe(true); expect(options.signal.aborted).toBe(true);
    pending.resolve({ file: { name: 'movie.mp4' }, url: 'blob:local-result', report: {}, dispose });
    await waitStatus(job.id, 'cancelled'); expect(dispose).toHaveBeenCalledTimes(1); expect(click).not.toHaveBeenCalled();
  });

  it('downloads completed browser results, converts percent progress, and retires old files', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const disposers: ReturnType<typeof vi.fn>[] = [];
    mocks.browser.mockImplementation(async (_project, _defs, options) => {
      options.onProgress({ progress: 42, stage: 'Mixing local audio' });
      const dispose = vi.fn().mockResolvedValue(undefined); disposers.push(dispose);
      return { file: { name: 'movie.mp4' }, url: `blob:result-${disposers.length}`, report: { frames: 60 }, dispose };
    });
    const snapshots: EditorExportJobSnapshot[] = []; service.subscribe(() => { const item = service.latest(); if (item) snapshots.push({ ...item }); });
    const first = await service.start({ preset: 'source' }); await waitStatus(first.id, 'completed');
    expect(snapshots.some((s) => s.progress === .42 && s.stage === 'Mixing local audio')).toBe(true);
    expect(service.get(first.id)).toMatchObject({ status: 'completed', downloadUrl: 'blob:result-1', fileName: 'movie.mp4' }); expect(click).toHaveBeenCalledTimes(1);
    disposers[0].mockRejectedValue(new Error('Retired file already gone'));
    for (let i = 0; i < 5; i++) { const job = await service.start({ preset: 'source' }); await waitStatus(job.id, 'completed'); }
    expect(service.get(first.id)).toBeUndefined(); expect(disposers[0]).toHaveBeenCalledTimes(1); expect(disposers[1]).not.toHaveBeenCalled();
  });
});


describe('export quality routing', () => {
  it('passes the same independent quality to native planning and browser export without editing the project', async () => {
    const before = structuredClone(store.getState().project);
    const nativeJob = await service.start({ preset: '720', quality: 'balanced' });
    await waitStatus(nativeJob.id, 'completed');
    expect(mocks.plan.mock.calls[0][4]).toMatchObject({ maxHeight: 720, crf: 23 });
    expect(service.get(nativeJob.id)?.quality).toBe('balanced');
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    mocks.browser.mockResolvedValue({ file: { name: 'movie.mp4' }, url: 'blob:test', report: {}, dispose: vi.fn() });
    const browserJob = await service.start({ preset: 'source', quality: 'compact' });
    await waitStatus(browserJob.id, 'completed');
    expect(mocks.browser.mock.calls[0][2]).toMatchObject({ maxHeight: undefined, quality: 'compact' });
    expect(service.get(browserJob.id)?.quality).toBe('compact');
    expect(store.getState().project).toEqual(before);
    expect(store.getState().past).toEqual([]);
  });
});
