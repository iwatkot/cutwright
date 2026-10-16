import type { Protocol } from 'electron';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type MediaByteRange = { start: number; end: number } | null | 'unsatisfiable';

/** One bounded byte range, including open-ended and suffix forms. Native media
 * clients request one range; malformed/multiple ranges receive a 416 response. */
export function parseMediaByteRange(header: string | null, size: number): MediaByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid local media size');
  if (header === null) return null;
  if (header.length > 256) return 'unsatisfiable';
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) return 'unsatisfiable';
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix) return 'unsatisfiable';
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || start > end) return 'unsatisfiable';
  return { start: Number(start), end: Number(end >= total ? total - 1n : end) };
}

const mimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
};
const corsHeaders = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range, accept-ranges, content-length' };
export type LocalMediaFetch = (url: string, options: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/** Electron's native file loader owns the stream and its cancellation. Passing
 * fs.ReadStream into Response can deadlock Electron44's main loop when picture
 * and linked voice replace/cancel concurrent requests for the same file.
 * https://www.electronjs.org/docs/latest/api/protocol */
export function createMediaProtocolHandler(fetchLocal: LocalMediaFetch) {
  return async (request: Request): Promise<Response> => {
    let file: string;
    try {
      const source = new URL(request.url).searchParams.get('src') ?? '';
      file = source.startsWith('file:') ? fileURLToPath(source) : source;
    } catch { return new Response('not found', { status: 404, headers: corsHeaders }); }
    let info;
    try { info = await stat(file); }
    catch { return new Response('not found', { status: 404, headers: corsHeaders }); }
    if (!info.isFile()) return new Response('not found', { status: 404, headers: corsHeaders });
    const range = parseMediaByteRange(request.headers.get('range'), info.size);
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...corsHeaders, 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' } });
    const native = await fetchLocal(pathToFileURL(file).href, {
      headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
      signal: request.signal,
    });
    const headers = new Headers(native.headers);
    for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
    if (!native.ok) return new Response(native.body, { status: native.status, headers });
    headers.set('content-type', mimeTypes[path.extname(file).toLowerCase()] ?? 'video/mp4');
    headers.set('accept-ranges', 'bytes');
    headers.set('content-length', String(range ? range.end - range.start + 1 : info.size));
    // Electron file fetch honors the range body but reports 200. Supply the
    // corresponding HTTP metadata so Chromium media seeking stays correct.
    if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`);
    else headers.delete('content-range');
    return new Response(native.body, { status: range ? 206 : native.status, headers });
  };
}

export function registerMediaProtocol(protocol: Pick<Protocol, 'handle'>, fetchLocal: LocalMediaFetch): void {
  protocol.handle('cutwright-media', createMediaProtocolHandler(fetchLocal));
}
