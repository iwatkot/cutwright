import { storeBrowserFile, restoreBrowserMedia } from './browserMedia';
import { browserMediaInfo } from './browserMediaInfo';
import { projectDownloadBasename } from './projectFileName';
import { validateProject } from './validate';
import type { MediaItem, Project } from './types';
import { loadProjectFonts, prepareProjectFont } from './projectFonts';
import type { ProjectFont } from './types';

export interface StagedEditorFile { name: string; url: string; token: string }
export interface EditorFiles {
  font?(file: StagedEditorFile, family: string, weight: number): Promise<ProjectFont>;
  download?(url: string, destination: { url: string; token: string }): Promise<{ outputPath: string; bytes: number }>;
  import(files: StagedEditorFile[]): Promise<MediaItem[]>;
  open(file: StagedEditorFile): Promise<{ project: Project; missing: string[] }>;
  save(project: Project): Promise<{ fileName: string; downloadUrl: string }>;
}

/** Used by both the file picker and agent import, never trusts claimed metadata. */
export async function prepareBrowserFile(file: File): Promise<MediaItem> {
  const image = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  const audio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
  const info = image ? undefined : await browserMediaInfo(file);
  let size: { width?: number; height?: number } = {};
  if (image) { const bitmap = await createImageBitmap(file); size = { width: bitmap.width, height: bitmap.height }; bitmap.close(); }
  const stored = await storeBrowserFile(file);
  if (!stored.persisted) throw new Error(`Local media could not be saved: ${stored.error}`);
  return { id: crypto.randomUUID(), name: file.name, kind: image ? 'image' : audio ? 'audio' : 'video', src: stored.source, duration: info?.duration || 10, color: '#60a5fa', ...(info ? { hasAudio: info.hasAudio, width: info.width, height: info.height } : size) };
}

async function stagedBlob(file: StagedEditorFile): Promise<Blob> {
  const url = new URL(file.url);
  // Only the paired local connector can stage a file. No arbitrary URL fetching.
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) < 47831 || Number(url.port) > 47842 || !/^\/media\/[a-f0-9-]+$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('Expected a staged local connector file.');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${file.token}` }, credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`Local file transfer failed (${response.status}).`);
  return response.blob();
}

const downloads = new Map<string, string>();
export const browserEditorFiles: EditorFiles = {
  async font(file, family, weight) { const blob = await stagedBlob(file); return prepareProjectFont(new File([blob], file.name), family, weight); },
  async download(url, destination) {
    if (!url.startsWith(`blob:${location.origin}/`)) throw new Error('Expected a local browser download.');
    const target = new URL(destination.url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || Number(target.port) < 47831 || Number(target.port) > 47842 || !/^\/downloads\/[a-f0-9-]+$/.test(target.pathname) || target.username || target.password || target.search || target.hash) throw new Error('Expected a staged local connector file.');
    const file = await fetch(url).then(response => { if (!response.ok) throw new Error('Local transfer is unavailable.'); return response.blob(); });
    const response = await fetch(target, { method: 'POST', headers: { Authorization: `Bearer ${destination.token}`, 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'omit', redirect: 'error' });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Local transfer is unavailable.');
    return result;
  },
  async import(files) {
    const imported: MediaItem[] = [];
    for (const file of files) { const blob = await stagedBlob(file); imported.push(await prepareBrowserFile(new File([blob], file.name, { type: blob.type }))); }
    return imported;
  },
  async open(file) {
    const validation = validateProject(JSON.parse(await (await stagedBlob(file)).text()));
    if (!validation.ok || !validation.project) throw new Error(validation.errors.join('; '));
    await loadProjectFonts(validation.project);
    return restoreBrowserMedia(validation.project);
  },
  async save(project) {
    const validation = validateProject(project);
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    const fileName = `${projectDownloadBasename(project.name)}.cutwright.json`;
    const downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
    downloads.set(downloadUrl, fileName);
    while (downloads.size > 5) { const oldest = downloads.keys().next().value!; URL.revokeObjectURL(oldest); downloads.delete(oldest); }
    const link = document.createElement('a'); link.href = downloadUrl; link.download = fileName; link.click();
    window.dispatchEvent(new CustomEvent('cw-project-saved', { detail: project }));
    return { fileName, downloadUrl };
  },
};
