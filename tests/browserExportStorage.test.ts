import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserExportScratch, sweepBrowserExportScratch } from '../src/lib/browserExportStorage';

const UUID = '12345678-1234-4123-8123-123456789abc';
const filename = (id = UUID) => `cutwright-export-v1-${id}.mp4`;
const missing = () => new DOMException('Missing file', 'NotFoundError');
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const files = new Map<string, { kind: 'file' | 'directory'; name: string }>();
  const owned = new Set<string>(), events: string[] = [], queues = new Map<string, (() => void)[]>();
  const failDelete = new Set<string>();
  const locks = { request: vi.fn((name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: { name: string } | null) => unknown) => new Promise((resolve, reject) => {
    if (options.ifAvailable && options.signal) { reject(new DOMException('signal cannot be combined with ifAvailable', 'NotSupportedError')); return; }
    let granted = false;
    const abort = () => { if (!granted) reject(new DOMException('Cancelled', 'AbortError')); };
    const grant = () => {
      if (options.signal?.aborted) { abort(); return; }
      if (owned.has(name)) {
        if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
        const queue = queues.get(name) ?? []; queue.push(grant); queues.set(name, queue); return;
      }
      granted = true; options.signal?.removeEventListener('abort', abort); owned.add(name); events.push(`locked:${name}`);
      void Promise.resolve().then(() => callback({ name })).then(resolve, reject).finally(() => {
        owned.delete(name); events.push(`unlocked:${name}`); queues.get(name)?.shift()?.();
      });
    };
    options.signal?.addEventListener('abort', abort, { once: true }); grant();
  })) };
  const directory = {
    async *entries() { for (const entry of [...files]) yield entry; },
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name) && !options?.create) throw missing();
      if (options?.create) { events.push(`created:${name}`); files.set(name, { kind: 'file', name }); }
      return files.get(name);
    }),
    removeEntry: vi.fn(async (name: string) => {
      events.push(`delete:${name}`); if (failDelete.has(name)) throw new DOMException('Writer still open', 'InvalidStateError');
      if (!files.delete(name)) throw missing();
    }),
  };
  const getDirectory = vi.fn(async () => directory);
  vi.stubGlobal('navigator', { storage: { getDirectory }, locks });
  vi.stubGlobal('crypto', { randomUUID: () => UUID });
  return { files, owned, events, locks, directory, getDirectory, failDelete };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('locked local export scratch files', () => {
  it('acquires before creation and protects a retained result until idempotent disposal', async () => {
    const f = fixture(), scratch = await createBrowserExportScratch();
    expect(scratch.name).toBe(filename()); expect(f.files.has(scratch.name)).toBe(true);
    expect(f.events.findIndex((event) => event.startsWith('locked:'))).toBeLessThan(f.events.indexOf(`created:${scratch.name}`));
    expect(await sweepBrowserExportScratch()).toEqual({ removed: [], protected: [scratch.name], failed: [] });
    const first = scratch.dispose(); expect(scratch.dispose()).toBe(first); await first; await settled();
    expect(f.files.size).toBe(0); expect(f.owned.size).toBe(0); expect(f.directory.removeEntry).toHaveBeenCalledTimes(1);
  });
  it('sweeps exact versioned orphan files while preserving legacy files, other names and directories', async () => {
    const f = fixture();
    for (const name of [filename(), 'cutwright-export-123.mp4', filename() + '.backup', 'movie.mp4']) f.files.set(name, { kind: 'file', name });
    const dir = filename('abcdefab-abcd-4abc-8abc-abcdefabcdef'); f.files.set(dir, { kind: 'directory', name: dir });
    expect(await sweepBrowserExportScratch()).toEqual({ removed: [filename()], protected: [], failed: [] });
    expect([...f.files.keys()]).toEqual(['cutwright-export-123.mp4', filename() + '.backup', 'movie.mp4', dir]);
  });
  it('releases a lock after deletion failure, allowing a later sweep to recover the orphan', async () => {
    const f = fixture(), scratch = await createBrowserExportScratch(); f.failDelete.add(scratch.name);
    await expect(scratch.dispose()).rejects.toThrow('Writer still open'); await settled(); expect(f.owned.size).toBe(0);
    f.failDelete.clear(); expect((await sweepBrowserExportScratch()).removed).toEqual([scratch.name]);
  });
  it('aborts before allocating storage', async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await expect(createBrowserExportScratch({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(f.getDirectory).not.toHaveBeenCalled();
  });
  it('aborts a pending lock request without creating a file or releasing another owner', async () => {
    const f = fixture(), key = `cutwright.export-storage.v1:${filename()}`; f.owned.add(key);
    const abort = new AbortController(), pending = createBrowserExportScratch({ signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.locks.request).toHaveBeenCalledTimes(1)); abort.abort(); await rejected;
    expect(f.files.size).toBe(0); expect(f.owned.has(key)).toBe(true);
  });
  it('cleans a file if cancellation arrives during its creation', async () => {
    const f = fixture(), abort = new AbortController(), original = f.directory.getFileHandle.getMockImplementation()!;
    f.directory.getFileHandle.mockImplementation(async (name, options) => { const value = await original(name, options); if (options?.create) abort.abort(); return value; });
    await expect(createBrowserExportScratch({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' }); await settled();
    expect(f.files.size).toBe(0); expect(f.owned.size).toBe(0);
  });
  it('releases its lock on creation errors without hiding the original failure', async () => {
    const f = fixture(), original = f.directory.getFileHandle.getMockImplementation()!;
    f.directory.getFileHandle.mockImplementation(async (name, options) => { if (options?.create) throw new Error('Storage quota exceeded'); return original(name, options); });
    await expect(createBrowserExportScratch()).rejects.toThrow('Storage quota exceeded'); await settled(); expect(f.owned.size).toBe(0);
  });
  it('never deletes a preexisting file if a name collision appears after the sweep', async () => {
    const f = fixture(); let calls = 0;
    f.getDirectory.mockImplementation(async () => { if (++calls === 2) f.files.set(filename(), { kind: 'file', name: filename() }); return f.directory; });
    await expect(createBrowserExportScratch()).rejects.toThrow('already exists'); await settled();
    expect(f.files.has(filename())).toBe(true); expect(f.directory.removeEntry).not.toHaveBeenCalled(); expect(f.owned.size).toBe(0);
  });
  it('isolates a failed cleanup and continues sweeping other orphans', async () => {
    const f = fixture(), other = filename('abcdefab-abcd-4abc-8abc-abcdefabcdef');
    for (const name of [filename(), other]) f.files.set(name, { kind: 'file', name }); f.failDelete.add(filename());
    const result = await sweepBrowserExportScratch(); expect(result.removed).toEqual([other]); expect(result.failed).toEqual([{ name: filename(), error: 'Writer still open' }]);
  });
  it('fails clearly when safe cross-tab ownership is unavailable', async () => {
    fixture(); vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
    await expect(createBrowserExportScratch()).rejects.toThrow('Safe local export storage needs');
  });
});
