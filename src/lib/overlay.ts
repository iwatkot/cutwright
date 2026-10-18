import type { Clip, MediaItem, NativeOverlay, TitleOverlay } from './types';
import type { ProjectFont } from './types';
import { projectFontStyles } from './projectFonts';

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const n = (v: number) => Number(v.toFixed(5));

export function validateOverlay(raw: unknown): string[] {
  if (!obj(raw) || (raw.kind !== 'arrow' && raw.kind !== 'title')) return ['Overlay kind must be arrow or title'];
  const errors: string[] = [];
  const number = (key: string, lo: number, hi: number, optional = false) => {
    if (optional && raw[key] === undefined) return;
    if (!finite(raw[key]) || raw[key] < lo || raw[key] > hi) errors.push(`Overlay ${key} must be ${lo}..${hi}`);
  };
  number('animationOffset', -86400, 86400, true);
  number('animationDuration', 0.001, 86400, true);
  number('fadeIn', 0, 86400, true); number('fadeOut', 0, 86400, true);
  if (typeof raw.color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(raw.color)) errors.push('Overlay color must be #RRGGBB or #RRGGBBAA');
  if (raw.kind === 'arrow') {
    for (const key of ['x1', 'y1', 'x2', 'y2']) number(key, -100000, 100000);
    number('width', 0.1, 2000); number('drawDuration', 0, 86400, true);
    if (typeof raw.head !== 'boolean') errors.push('Overlay head must be a boolean');
  } else {
    if (typeof raw.text !== 'string' || raw.text.length > 100000) errors.push('Overlay text must be a string of at most 100000 characters');
    if (typeof raw.fontFamily !== 'string' || !raw.fontFamily.trim() || raw.fontFamily.length > 200) errors.push('Overlay fontFamily must name a font');
    number('fontSize', 1, 2000); number('fontWeight', 100, 1000);
    number('x', -100000, 100000); number('y', -100000, 100000);
    number('blockWidth', 0, 100000); number('lineHeight', 1, 10000);
    if (!['left', 'center', 'right'].includes(String(raw.align))) errors.push('Overlay alignment must be left, center or right');
    if (raw.scroll !== undefined) {
      if (!obj(raw.scroll) || !finite(raw.scroll.fromY) || !finite(raw.scroll.toY) || !finite(raw.scroll.duration) || raw.scroll.duration <= 0 || raw.scroll.duration > 86400) errors.push('Overlay scroll needs finite fromY/toY and a positive duration');
    }
  }
  return errors;
}

export const resolveOverlay = (clip: Clip, media?: MediaItem): NativeOverlay | undefined => clip.overlay ?? media?.overlay;

export function titleBlockHeight(title: TitleOverlay): number {
  return title.text.replace(/\r\n?/g, '\n').split('\n').length * title.lineHeight;
}

/** Keep a rolling block's initial placement and final bottom edge when its
 * text/line spacing changes. The duration stays under the editor's control. */
export function reflowTitleScroll(previous: TitleOverlay, next: TitleOverlay): TitleOverlay {
  if (!previous.scroll || !next.scroll) return next;
  const delta = titleBlockHeight(next) - titleBlockHeight(previous);
  return { ...next, scroll: { ...next.scroll, toY: next.scroll.toY - delta } };
}

/** One source clock for playback, trims, splits, speed changes and export. */
export function overlaySourceTime(clip: Pick<Clip, 'start' | 'offset' | 'speed'>, timelineTime: number): number {
  return clip.offset + Math.max(0, timelineTime - clip.start) * (clip.speed ?? 1);
}

export function overlayFrame(overlay: NativeOverlay, sourceTime: number) {
  const time = sourceTime + (overlay.animationOffset ?? 0);
  const duration = overlay.animationDuration ?? Infinity;
  let opacity = time < 0 || time > duration ? 0 : 1;
  if (overlay.fadeIn) opacity *= clamp(time / overlay.fadeIn);
  if (overlay.fadeOut) opacity *= clamp((duration - time) / overlay.fadeOut);
  const drawProgress = overlay.kind === 'arrow' && overlay.drawDuration ? clamp(time / overlay.drawDuration) : 1;
  const scrollY = overlay.kind === 'title' && overlay.scroll
    ? overlay.scroll.fromY + (overlay.scroll.toY - overlay.scroll.fromY) * clamp(time / overlay.scroll.duration)
    : 0;
  return { time, opacity, drawProgress, scrollY };
}

/** Safe standalone SVG. Preview and the desktop alpha-video cache both call
 * this renderer; it never executes imported HTML, scripts or font URLs. */
export function overlaySvg(overlay: NativeOverlay, width: number, height: number, sourceTime: number, fonts?: ProjectFont[]): string {
  const frame = overlayFrame(overlay, sourceTime);
  let content = '';
  if (overlay.kind === 'arrow') {
    const { x1, y1, x2, y2 } = overlay;
    const p = frame.drawProgress;
    const body = overlay.head ? clamp(p / 0.8) : p;
    const segment = (ax: number, ay: number, bx: number, by: number, progress: number) => progress > 0
      ? `<path d="M${n(ax)} ${n(ay)}L${n(ax + (bx - ax) * progress)} ${n(ay + (by - ay) * progress)}"/>` : '';
    content = segment(x1, y1, x2, y2, body);
    if (overlay.head) {
      const head = clamp((p - 0.8) / 0.2);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const length = Math.max(18, overlay.width * 2.4);
      for (const a of [2.6, -2.6]) content += segment(x2, y2, x2 + length * Math.cos(angle + a), y2 + length * Math.sin(angle + a), head);
    }
    content = `<g fill="none" stroke="${xml(overlay.color)}" stroke-width="${n(overlay.width)}" stroke-linecap="round" stroke-linejoin="round">${content}</g>`;
  } else {
    const anchor = overlay.align === 'left' ? 'start' : overlay.align === 'right' ? 'end' : 'middle';
    const x = overlay.x + (overlay.align === 'left' ? 0 : overlay.align === 'right' ? overlay.blockWidth : overlay.blockWidth / 2);
    const lines = overlay.text.replace(/\r\n?/g, '\n').split('\n');
    content = `<g transform="translate(0 ${n(frame.scrollY)})" fill="${xml(overlay.color)}" font-family="${xml(overlay.fontFamily)}, Arial, sans-serif" font-size="${n(overlay.fontSize)}" font-weight="${n(overlay.fontWeight)}" text-anchor="${anchor}">`;
    content += lines.map((line, i) => `<text x="${n(x)}" y="${n(overlay.y + i * overlay.lineHeight)}" dominant-baseline="text-before-edge" xml:space="preserve">${xml(line)}</text>`).join('');
    content += '</g>';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="width:100%;height:100%;display:block">${overlay.kind === 'title' ? projectFontStyles(fonts, overlay.fontFamily) : ''}<g opacity="${n(frame.opacity)}">${content}</g></svg>`;
}
