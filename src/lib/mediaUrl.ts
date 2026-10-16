import { browserMediaUrl } from './browserMedia';

/**
 * Renderer-safe URL for local media. In the desktop app, file:/// URLs are
 * routed through the privileged cutwright-media protocol (Range-capable);
 * Browser-local references resolve to this session's restored object URLs.
 */
export function mediaUrl(src: string): string {
  if (!src) return src;
  const inDesktop = typeof window !== 'undefined' && !!(window as { cutwright?: unknown }).cutwright;
  if (inDesktop && src.startsWith('file:')) {
    return `cutwright-media://file?src=${encodeURIComponent(src)}`;
  }
  return browserMediaUrl(src);
}
