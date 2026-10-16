import * as path from 'node:path';

export function validateMp4Destination(value: unknown, platform: string = process.platform): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Export outputPath must be an absolute .mp4 file path.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || paths.extname(value).toLowerCase() !== '.mp4'
    || platform === 'win32' && (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value) || /^\\\\[?.]\\/.test(value))) {
    throw new Error('Export outputPath must be an absolute .mp4 file path.');
  }
  return paths.normalize(value);
}
