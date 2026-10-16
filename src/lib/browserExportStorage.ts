// OPFS File objects stop being readable after their directory entry is removed.
// Keep each result's entry alive under a Web Lock; another tab can reclaim it
// only after dispose or the owning document has gone away (including crashes).
const PREFIX = 'cutwright-export-v1-';
const NAME = /^cutwright-export-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/;
const lockName = (name: string) => `cutwright.export-storage.v1:${name}`;
const abortError = () => new DOMException('Export cancelled', 'AbortError');
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const missing = (error: unknown) => error instanceof Error && error.name === 'NotFoundError';

function environment() {
  if (!navigator.storage?.getDirectory || !navigator.locks?.request) throw new Error('Safe local export storage needs a current Chrome or Edge browser on HTTPS or localhost.');
  return { storage: navigator.storage, locks: navigator.locks };
}
export interface BrowserExportScratchSweep { removed: string[]; protected: string[]; failed: { name: string; error: string }[] }
export interface BrowserExportScratch {
  directory: FileSystemDirectoryHandle;
  handle: FileSystemFileHandle;
  name: string;
  dispose(): Promise<void>;
}

/** Reclaim only our exact, versioned filenames. ifAvailable never waits on a
 * live export/result in another tab. Legacy unversioned entries are untouched. */
export async function sweepBrowserExportScratch(options: { signal?: AbortSignal } = {}): Promise<BrowserExportScratchSweep> {
  check(options.signal);
  const { storage, locks } = environment(), directory = await storage.getDirectory();
  const result: BrowserExportScratchSweep = { removed: [], protected: [], failed: [] };
  const entries = directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, handle] of entries.entries()) {
    check(options.signal);
    if (handle.kind !== 'file' || !NAME.test(name)) continue;
    try {
      // The Web Locks specification disallows signal with ifAvailable. This
      // request never queues; check cancellation inside its callback instead.
      await locks.request(lockName(name), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        check(options.signal);
        if (!lock) { result.protected.push(name); return; }
        try { await directory.removeEntry(name); result.removed.push(name); }
        catch (error) { if (!missing(error)) result.failed.push({ name, error: message(error) }); }
      });
    } catch (error) {
      check(options.signal);
      result.failed.push({ name, error: message(error) });
    }
  }
  check(options.signal);
  return result;
}

/** signal cancels acquisition/creation. Once returned, the exporter owns the
 * writer and must close/cancel it before dispose; no abort callback deletes an
 * in-use file. A completed result retains this lock until its own disposal. */
export async function createBrowserExportScratch(options: { signal?: AbortSignal } = {}): Promise<BrowserExportScratch> {
  check(options.signal);
  await sweepBrowserExportScratch(options);
  check(options.signal);
  const { storage, locks } = environment(), directory = await storage.getDirectory();
  check(options.signal);
  const name = `${PREFIX}${crypto.randomUUID()}.mp4`;
  if (!NAME.test(name)) throw new Error('Could not create a unique local export filename.');
  let acquired!: () => void, failed!: (error: unknown) => void, release!: () => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  const retained = new Promise<void>((resolve) => { release = resolve; });
  const held = locks.request(lockName(name), { mode: 'exclusive', signal: options.signal }, async () => {
    acquired(); await retained;
  });
  // Observe rejection immediately, including abort while another owner holds it.
  void held.catch(failed);
  let created = false, disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    try { if (created) { try { await directory.removeEntry(name); } catch (error) { if (!missing(error)) throw error; } } }
    finally { release(); await held.catch(() => undefined); }
  })();
  try {
    await ready; check(options.signal);
    // A collision must never take ownership of somebody else's existing file.
    try { await directory.getFileHandle(name); throw new Error('The unique local export filename already exists. Retry the export.'); }
    catch (error) { if (!missing(error)) throw error; }
    created = true;
    const handle = await directory.getFileHandle(name, { create: true });
    check(options.signal);
    return { directory, handle, name, dispose };
  } catch (error) {
    // Cleanup errors leave an unlocked entry for the next sweep, while the
    // original acquisition/abort failure remains the actionable export error.
    await dispose().catch(() => undefined);
    throw options.signal?.aborted ? abortError() : error;
  }
}
