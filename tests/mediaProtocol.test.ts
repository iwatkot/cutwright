import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMediaProtocolHandler, parseMediaByteRange } from '../electron/mediaProtocol';

describe('local media byte ranges', () => {
  it.each([
    [null, 10, null], ['bytes=0-0', 10, { start: 0, end: 0 }],
    ['bytes=9-', 10, { start: 9, end: 9 }], ['bytes=2-99', 10, { start: 2, end: 9 }],
    ['bytes=-3', 10, { start: 7, end: 9 }], ['bytes=-99', 10, { start: 0, end: 9 }],
    ['bytes=0-999999999999999999999999', 10, { start: 0, end: 9 }],
    ['bytes=-999999999999999999999999', 10, { start: 0, end: 9 }],
    ['bytes=10-', 10, 'unsatisfiable'], ['bytes=5-2', 10, 'unsatisfiable'],
    ['bytes=-0', 10, 'unsatisfiable'], ['bytes=-', 10, 'unsatisfiable'],
    ['bytes=0-1,3-4', 10, 'unsatisfiable'], ['bytes=NaN-4', 10, 'unsatisfiable'],
    ['items=0-1', 10, 'unsatisfiable'], ['bytes=0-', 0, 'unsatisfiable'],
    [null, 0, null], ['bytes=999999999999999999999999-', 10, 'unsatisfiable'],
  ])('resolves %s against %i bytes', (header, size, expected) => {
    expect(parseMediaByteRange(header as string | null, size as number)).toEqual(expected);
  });
  it('rejects invalid file sizes and pathological range headers', () => {
    expect(() => parseMediaByteRange(null, -1)).toThrow();
    expect(() => parseMediaByteRange(null, 1.2)).toThrow();
    expect(parseMediaByteRange(`bytes=${'9'.repeat(300)}-`, 10)).toBe('unsatisfiable');
  });
});

const directory = mkdtempSync(path.join(tmpdir(), 'cw-protocol-'));
const file = path.join(directory, 'source # Ω.mp4');
writeFileSync(file, Uint8Array.from({ length: 10 }, (_, i) => i));
const request = (source = pathToFileURL(file).href, range?: string) => new Request(`cutwright-media://local/?src=${encodeURIComponent(source)}`, { headers: range ? { range } : {} });
afterEach(() => vi.restoreAllMocks());

describe('local media protocol streaming', () => {
  it('uses only a canonical file URL and passes the native stream without buffering', async () => {
    const native = new Response(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8, 9));
    const fetchLocal = vi.fn(async () => native), req = request();
    const result = await createMediaProtocolHandler(fetchLocal)(req);
    expect(fetchLocal).toHaveBeenCalledWith(pathToFileURL(file).href, { headers: {}, signal: req.signal });
    expect(result.body).toBe(native.body); expect(result.status).toBe(200);
    expect(result.headers.get('content-length')).toBe('10'); expect(result.headers.get('content-type')).toBe('video/mp4');
    expect(result.headers.get('access-control-allow-origin')).toBe('*');
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('normalizes suffix requests and Electron file-loader 200 responses to correct 206 metadata', async () => {
    const fetchLocal = vi.fn(async () => new Response(Uint8Array.of(7, 8, 9)));
    const req = request(undefined, 'bytes=-3'), result = await createMediaProtocolHandler(fetchLocal)(req);
    expect(fetchLocal).toHaveBeenCalledWith(pathToFileURL(file).href, { headers: { range: 'bytes=7-9' }, signal: req.signal });
    expect(result.status).toBe(206); expect(result.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(result.headers.get('content-length')).toBe('3'); expect(result.headers.get('accept-ranges')).toBe('bytes');
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([7, 8, 9]);
  });
  it('does not open a stream for absent files, directories, remote URLs or unsatisfiable ranges', async () => {
    const fetchLocal = vi.fn(), handler = createMediaProtocolHandler(fetchLocal);
    for (const source of [path.join(directory, 'missing.mp4'), directory, 'https://example.com/private.mp4']) expect((await handler(request(source))).status).toBe(404);
    const unsatisfiable = await handler(request(undefined, 'bytes=10-'));
    expect(unsatisfiable.status).toBe(416); expect(unsatisfiable.headers.get('content-range')).toBe('bytes */10');
    expect(fetchLocal).not.toHaveBeenCalled();
  });
});
