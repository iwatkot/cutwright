import type { MediaItem, Project } from './types';

// Project files contain durable references, never a session's blob: URLs.
// The files themselves stay in this browser's local IndexedDB storage.
const SOURCE_PREFIX = 'cutwright-local:';
const DATABASE = 'cutwright.media';
const STORE = 'files';
const RECOVERY = 'recovery';
const urls = new Map<string, { url: string; blob: Blob }>();
const loading = new Map<string, Promise<Blob | null>>();
let database: Promise<IDBDatabase> | undefined;

interface StoredMedia {
  source: string;
  blob: Blob;
  name: string;
  lastModified: number;
}

export interface StoredBrowserFile {
  source: string;
  url: string;
  persisted: boolean;
  error?: string;
}

export interface RestoredBrowserMedia {
  project: Project;
  missing: string[];
  errors: string[];
}

export interface BrowserRecovery {
  project: Project;
  at: number;
}

export function isBrowserMediaSource(source: string): boolean {
  return source.startsWith(SOURCE_PREFIX);
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Local media storage is unavailable in this browser.'));
      return;
    }
    const request = indexedDB.open(DATABASE, 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'source' });
      if (!request.result.objectStoreNames.contains(RECOVERY)) request.result.createObjectStore(RECOVERY);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open local media storage.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close other CutWright tabs to update local media storage.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      db.onclose = () => { database = undefined; };
      resolve(db);
    };
  });
  // A denied/quota/blocked attempt must not poison later imports or relinks.
  void database.catch(() => { database = undefined; });
  return database;
}

async function writeFile(record: StoredMedia): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not save media locally.'));
    transaction.onerror = () => { /* onabort reports the failed transaction. */ };
    transaction.objectStore(STORE).put(record);
  });
}

async function readFile(source: string): Promise<Blob | null> {
  const db = await openDatabase();
  return new Promise<Blob | null>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(source);
    let blob: Blob | null = null;
    request.onsuccess = () => {
      const record = request.result as StoredMedia | undefined;
      if (record?.blob instanceof Blob) blob = record.blob;
    };
    transaction.oncomplete = () => resolve(blob);
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not read locally saved media.'));
    transaction.onerror = () => { /* onabort reports the failed transaction. */ };
  });
}

/** Project snapshots share the larger local database budget with media,
 * instead of silently hitting localStorage's much smaller string quota. */
export async function writeBrowserRecovery(recovery: BrowserRecovery): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(RECOVERY, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not save the recovery project locally.'));
    transaction.onerror = () => { /* onabort reports the failed transaction. */ };
    transaction.objectStore(RECOVERY).put(recovery, 'latest');
  });
}

export async function readBrowserRecovery(): Promise<BrowserRecovery | null> {
  const db = await openDatabase();
  return new Promise<BrowserRecovery | null>((resolve, reject) => {
    const transaction = db.transaction(RECOVERY, 'readonly');
    const request = transaction.objectStore(RECOVERY).get('latest');
    let recovery: BrowserRecovery | null = null;
    request.onsuccess = () => { recovery = request.result ?? null; };
    transaction.oncomplete = () => resolve(recovery);
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not read the recovery project locally.'));
    transaction.onerror = () => { /* onabort reports the failed transaction. */ };
  });
}

function retain(source: string, blob: Blob): string {
  const existing = urls.get(source);
  if (existing) return existing.url;
  const url = URL.createObjectURL(blob);
  // Keep URLs alive for undo/redo and switching between projects this session.
  // The browser releases them when this page closes.
  urls.set(source, { url, blob });
  return url;
}

/** Import remains usable in this tab if storage is full or blocked, and the
 * caller must display the returned error rather than promise recovery. */
export async function storeBrowserFile(file: File): Promise<StoredBrowserFile> {
  const source = SOURCE_PREFIX + crypto.randomUUID();
  const url = retain(source, file);
  try {
    await writeFile({ source, blob: file, name: file.name, lastModified: file.lastModified });
    return { source, url, persisted: true };
  } catch (error) {
    return { source, url, persisted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Resolve synchronously after import/restore; never pass our private source
 * scheme to an HTML media element or accidentally fetch it from a server. */
export function browserMediaUrl(source: string): string {
  return isBrowserMediaSource(source) ? urls.get(source)?.url ?? '' : source;
}

/** Reusable by browser export: returns the original local bytes without an
 * upload, network request, or dependence on an HTML media element. */
export async function loadBrowserMedia(source: string): Promise<Blob | null> {
  if (!isBrowserMediaSource(source)) return null;
  const existing = urls.get(source);
  if (existing) return existing.blob;
  const pending = loading.get(source);
  if (pending) return pending;
  const task = readFile(source).then((blob) => {
    if (blob) retain(source, blob);
    return blob;
  }).finally(() => loading.delete(source));
  loading.set(source, task);
  return task;
}

/** Restore availability before publishing the project to the editor. Older
 * saved blob URLs and desktop file paths cannot grant browser file access. */
export async function restoreBrowserMedia(project: Project): Promise<RestoredBrowserMedia> {
  const missing: string[] = [];
  const errors = new Set<string>();
  const media = await Promise.all(project.media.map(async (item): Promise<MediaItem> => {
    if (item.overlay) return item;
    let available: boolean | undefined;
    let audioInfo: Partial<MediaItem> = {};
    if (isBrowserMediaSource(item.src)) {
      try {
        const file = await loadBrowserMedia(item.src);
        available = !!file;
        if (file && item.kind === 'video' && item.hasAudio === undefined) {
          audioInfo = await import('./browserMediaInfo').then(({browserMediaInfo}) => browserMediaInfo(file)).catch(() => ({}));
        }
      } catch (error) {
        available = false;
        errors.add(error instanceof Error ? error.message : String(error));
      }
    } else if (!item.src || /^(?:blob:|file:|cutwright-media:|[a-z]:[\\/]|\\\\|\/)/i.test(item.src)) {
      available = false;
    }
    if (available === undefined) return item;
    if (!available) missing.push(item.name);
    if (item.offline === !available && !Object.keys(audioInfo).length) return item;
    return { ...item, ...audioInfo, offline: !available };
  }));
  return { project: { ...project, media }, missing, errors: [...errors] };
}
