import type { Project, ProjectFont } from './types';

export function validProjectFonts(value: unknown): value is ProjectFont[] {
  if (!Array.isArray(value) || value.length > 4) return false;
  const keys = new Set<string>();
  return value.every(font => {
    if (!font || typeof font.family !== 'string' || !font.family.trim() || font.family.length > 200 || !Number.isInteger(font.weight) || font.weight < 100 || font.weight > 1000
      || typeof font.dataUrl !== 'string' || font.dataUrl.length > 1400000 || !/^data:font\/(ttf|otf|woff2?);base64,[A-Za-z0-9+/]+={0,2}$/.test(font.dataUrl)) return false;
    const key = font.family.toLowerCase() + ':' + font.weight; if (keys.has(key)) return false; keys.add(key); return true;
  });
}
const faces = new Map<string, Promise<FontFace>>();
let generation = 0;
let applied: FontFace[] = [];
export async function loadProjectFonts(project: Pick<Project, 'fonts'>): Promise<void> {
  const fonts = project.fonts ?? []; if (!validProjectFonts(fonts)) throw new Error('Invalid embedded project fonts.');
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') { if (fonts.length) throw new Error('Local font loading is unavailable.'); return; }
  const current = ++generation;
  const loaded = await Promise.all(fonts.map(font => {
    const key = JSON.stringify(font);
    let loading = faces.get(key);
    if (!loading) { loading = new FontFace(font.family, `url(${font.dataUrl})`, { weight: String(font.weight) }).load(); faces.set(key, loading); void loading.catch(() => faces.delete(key)); }
    return loading;
  }));
  if (current !== generation) return;
  applied.forEach(face => document.fonts.delete(face)); loaded.forEach(face => document.fonts.add(face)); applied = loaded;
  for (const key of faces.keys()) if (!fonts.some(font => JSON.stringify(font) === key)) faces.delete(key);
}
export async function prepareProjectFont(file: File, family: string, weight = 400): Promise<ProjectFont> {
  const extension = file.name.match(/\.(ttf|otf|woff2?)$/i)?.[1]?.toLowerCase();
  if (!extension || file.size > 1024 * 1024 || !file.size) throw new Error('Choose a TTF, OTF, WOFF or WOFF2 font up to 1 MiB.');
  const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(`data:font/${extension};base64,${String(reader.result).split(',')[1]}`); reader.onerror = reject; reader.readAsDataURL(file); });
  const font = { family: family.trim(), weight, dataUrl }; if (!validProjectFonts([font])) throw new Error('Invalid embedded project fonts.');
  // Parse original bytes before changing any project; a bad font is never accepted as success.
  await new FontFace(font.family, `url(${dataUrl})`, { weight: String(weight) }).load(); return font;
}
export function projectFontStyles(fonts: ProjectFont[] = [], family: string): string {
  const css = fonts.filter(font => font.family === family).map(font => `@font-face{font-family:${JSON.stringify(font.family)};font-weight:${font.weight};src:url(${font.dataUrl})}`).join('');
  return css ? `<defs><style>${css.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</style></defs>` : '';
}
