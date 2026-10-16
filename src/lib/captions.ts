import type { Project, Subtitle } from './types';
import { ARIAL_ADVANCES, ARIAL_KERNING } from './captionMetrics';

/** Captions use composition pixels, with the stored size defined at 1080p.
 * Arial's 2288-unit line box and 434-unit descent use a 2048-unit em.
 * libass FontSize describes that line box; CSS/canvas FontSize describes em. */
export const ARIAL_LINE_HEIGHT = 2288 / 2048;
export const ARIAL_DESCENT = 434 / 2048;
export type CaptionMeasure = (text: string, font: string) => number;
export interface CaptionLine { text: string; x: number; y: number; width: number; cueId: string }
export interface CaptionLayout {
  font: string; fontSize: number; lineHeight: number; outlineWidth: number;
  bottomMargin: number; sideMargin: number; color: string; lines: CaptionLine[];
}

const advances = new Map(ARIAL_ADVANCES.flatMap(([start, ...widths]) => widths.map((width, i) => [start + i, width] as const)));

/** Pure Arial measurement keeps wrapping identical when ASS is generated in
 * Node and when the same caption is drawn by SVG/canvas. Unknown glyphs get
 * a conservative em; combining marks and joiners have no advance. */
export function captionTextWidth(text: string, fontSize: number): number {
  let units = 0, previous = '';
  for (const char of Array.from(text)) {
    const point = char.codePointAt(0)!;
    const zero = /[\p{Mark}\u200B-\u200D\uFEFF\uFE00-\uFE0F]/u.test(char);
    units += zero ? 0 : advances.get(point) ?? 2048;
    if (previous) units += ARIAL_KERNING[previous + char] ?? 0;
    previous = char;
  }
  return units / 2048 * fontSize;
}

export function captionStyle(project: Pick<Project, 'height' | 'subtitleStyle'>) {
  const scale = project.height / 1080;
  const fontSize = (project.subtitleStyle?.fontSize ?? 22) * scale;
  return { font: `400 ${fontSize}px Arial`, fontSize, lineHeight: fontSize * ARIAL_LINE_HEIGHT,
    outlineWidth: 2 * scale, bottomMargin: 36 * scale, sideMargin: 36 * scale,
    color: project.subtitleStyle?.color ?? '#FFFFFF' };
}

export function activeCaptions(project: Pick<Project, 'subtitles'>, time: number): Subtitle[] {
  // Stable project order is also the visual order when cues overlap.
  return project.subtitles.filter((cue) => time >= cue.start && time < cue.end);
}

export function wrapCaption(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      // Split long tokens as well, without splitting surrogate pairs.
      for (const char of Array.from(word)) {
        if (line && measure(line + char) > maxWidth) { lines.push(line); line = ''; }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function captionLayout(project: Project, time: number, measureText?: CaptionMeasure): CaptionLayout | null {
  const cues = activeCaptions(project, time);
  if (!cues.length) return null;
  const style = captionStyle(project);
  const measure = (text: string) => measureText?.(text, style.font) ?? captionTextWidth(text, style.fontSize);
  const width = Math.max(1, project.width - style.sideMargin * 2);
  const wrapped = cues.flatMap((cue) => wrapCaption(cue.text, width, measure).map((text) => ({ text, cueId: cue.id })));
  const lastBaseline = project.height - style.bottomMargin - style.fontSize * ARIAL_DESCENT;
  return { ...style, lines: wrapped.map(({ text, cueId }, i) => ({ text, cueId, x: project.width / 2,
    y: lastBaseline - (wrapped.length - 1 - i) * style.lineHeight, width: measure(text) })) };
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function captionSvg(layout: CaptionLayout, width: number, height: number): string {
  const text = layout.lines.map((line) => `<text x="${line.x}" y="${line.y}" xml:space="preserve">${xml(line.text)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%"><g font-family="Arial, sans-serif" font-size="${layout.fontSize}" font-weight="400" text-anchor="middle" fill="${xml(layout.color)}" stroke="#000000" stroke-width="${layout.outlineWidth * 2}" stroke-linejoin="round" paint-order="stroke fill">${text}</g></svg>`;
}

export function drawCaption(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, project: Project, time: number): void {
  const layout = captionLayout(project, time);
  if (!layout) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, project.width, project.height); ctx.clip();
  ctx.font = layout.font; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round'; ctx.lineWidth = layout.outlineWidth * 2;
  ctx.strokeStyle = '#000000'; ctx.fillStyle = layout.color;
  for (const line of layout.lines) { ctx.strokeText(line.text, line.x, line.y); ctx.fillText(line.text, line.x, line.y); }
  ctx.restore();
}

const assTime = (time: number) => {
  const total = Math.floor(Math.max(0, time) * 100 + 1e-7);
  return `${Math.floor(total / 360000)}:${String(Math.floor(total / 6000) % 60).padStart(2, '0')}:${String(Math.floor(total / 100) % 60).padStart(2, '0')}.${String(total % 100).padStart(2, '0')}`;
};
// libass supports escaped braces. A zero-width separator makes an imported
// literal backslash harmless before N/n/h or an escaped brace.
const assText = (text: string) => text.replace(/\\/g, '\\\uFEFF').replace(/{/g, '\\{').replace(/}/g, '\\}');

/** Pure, standalone ASS with explicit resolution, wrapping and overlap
 * segments. It can travel through the existing subtitle string transport. */
export function subtitlesToAss(project: Project): string {
  const style = captionStyle(project);
  const color = '&H00' + style.color.replace('#', '').match(/../g)!.reverse().join('').toUpperCase();
  // ASS stores centiseconds. First quantize to the first frame at/after a
  // boundary; rounding raw milliseconds could otherwise show a cue one frame
  // early (0.201s -> 0.20s on a 30fps timeline).
  const firstFrame = (time: number) => Math.ceil(time * project.fps - 1e-9);
  const boundaries = [...new Set(project.subtitles.flatMap((cue) => [firstFrame(cue.start), firstFrame(cue.end)]))].sort((a, b) => a - b);
  const events: string[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i] / project.fps, end = boundaries[i + 1] / project.fps;
    const layout = captionLayout(project, start);
    if (!layout || assTime(start) === assTime(end)) continue;
    const text = layout.lines.map((line) => assText(line.text)).join('\\N');
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${project.width}\nPlayResY: ${project.height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${style.fontSize * ARIAL_LINE_HEIGHT},${color},${color},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${style.outlineWidth},0,2,${style.sideMargin},${style.sideMargin},${style.bottomMargin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
