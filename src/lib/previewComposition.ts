import type { CSSProperties } from 'react';
import type { AppliedTransition, Clip, Project, TransitionDef } from './types';
import { clipVisualGain, visualLastFrame } from './clipFades';

export interface PreviewLayer {
  clip: Clip;
  sourceTime: number;
  frozen: boolean;
  style: CSSProperties;
  fill?: PreviewTrack['fill'];
}
export interface PreviewTrack {
  id: string;
  base: boolean;
  layers: PreviewLayer[];
  fill?: { color: string; opacity: number };
  transition?: { applied: AppliedTransition; def: TransitionDef; progress: number };
}
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Styles for an isolated track. Additive weighted layers preserve alpha
 * during a dissolve; ordinary source-over would dim opaque footage at 50%. */
export function transitionPreviewStyles(def: TransitionDef, progress: number, pixelScale = 1): { outgoing: CSSProperties; incoming: CSSProperties; fill?: PreviewTrack['fill'] } {
  const p = clamp(progress);
  const additive: CSSProperties = { mixBlendMode: 'plus-lighter' };
  const blend = { outgoing: { ...additive, opacity: 1 - p }, incoming: { ...additive, opacity: p } };
  if (def.xfade === 'fadeblack' || def.xfade === 'fadewhite') return {
    outgoing: { ...additive, opacity: Math.max(0, 1 - p * 2) },
    incoming: { ...additive, opacity: Math.max(0, p * 2 - 1) },
    fill: { color: def.xfade === 'fadewhite' ? '#FFFFFF' : '#000000', opacity: 1 - Math.abs(2 * p - 1) },
  };
  if (/^slide(left|right|up|down)$/.test(def.xfade)) {
    const vertical = /up|down/.test(def.xfade);
    const direction = /right|down/.test(def.xfade) ? 1 : -1;
    const axis = vertical ? 'Y' : 'X';
    return { outgoing: { transform: `translate${axis}(${direction * p * 100}%)` }, incoming: { transform: `translate${axis}(${-direction * (1 - p) * 100}%)` } };
  }
  if (/^wipe(left|right|up|down)$/.test(def.xfade)) {
    const f = p * 100, rest = (1 - p) * 100;
    const paths: Record<string, [string, string]> = {
      wipeleft: [`inset(0 ${f}% 0 0)`, `inset(0 0 0 ${rest}%)`],
      wiperight: [`inset(0 0 0 ${f}%)`, `inset(0 ${rest}% 0 0)`],
      wipeup: [`inset(0 0 ${f}% 0)`, `inset(${rest}% 0 0 0)`],
      wipedown: [`inset(${f}% 0 0 0)`, `inset(0 0 ${rest}% 0)`],
    };
    const [outgoing, incoming] = paths[def.xfade];
    return { outgoing: { clipPath: outgoing }, incoming: { clipPath: incoming } };
  }
  if (def.xfade === 'circleopen' || def.xfade === 'circleclose') {
    const radius = (def.xfade === 'circleopen' ? p : 1 - p) * 100;
    const inside = `radial-gradient(circle farthest-corner at center, #000 ${radius}%, transparent ${radius}%)`;
    const outside = `radial-gradient(circle farthest-corner at center, transparent ${radius}%, #000 ${radius}%)`;
    return def.xfade === 'circleopen' ? { outgoing: { maskImage: outside }, incoming: { maskImage: inside } } : { outgoing: { maskImage: inside }, incoming: { maskImage: outside } };
  }
  if (def.preview === 'blur') return {
    outgoing: { ...blend.outgoing, filter: `blur(${p * 14 * pixelScale}px)` },
    incoming: { ...blend.incoming, filter: `blur(${(1 - p) * 14 * pixelScale}px)` },
  };
  if (def.preview === 'zoom') return { outgoing: { ...blend.outgoing, transform: `scale(${1 + p * .18})` }, incoming: { ...blend.incoming, transform: `scale(${.85 + p * .15})` } };
  return blend;
}

/** Resolve each visual track independently. Transition handles freeze at
 * the trim boundary; they never play audio outside the clip's real window. */
export function resolvePreviewComposition(project: Project, defs: TransitionDef[], time: number, pixelScale = 1): PreviewTrack[] {
  const ids = [...new Set(project.clips.filter((c) => c.trackId.startsWith('v')).map((c) => c.trackId))];
  const requested = (project.trackOrder ?? []).filter((id) => ids.includes(id));
  const defaultOrder = ids.slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const visibleTop = [...requested, ...defaultOrder.filter((id) => !requested.includes(id))].filter((id) => !project.trackSettings?.[id]?.hidden);
  const baseId = visibleTop.at(-1);
  const defMap = new Map(defs.map((d) => [d.id, d]));
  return visibleTop.slice().reverse().map((id): PreviewTrack => {
    const clips = project.clips.filter((c) => c.trackId === id).slice().sort((a, b) => a.start - b.start);
    const layer = (clip: Clip, style: CSSProperties = {}): PreviewLayer => {
      const frozen = time < clip.start || time >= clip.start + clip.duration;
      const local = Math.min(Math.max(0, time - clip.start), Math.max(0, clip.duration - (frozen ? 1 / project.fps : 0)));
      const entrance = project.transitions.find((t) => t.entrance && (t.anchorClipId ? t.anchorClipId === clip.id : id === baseId && Math.abs(t.at - clip.start) < .26));
      const entryDef = entrance ? defMap.get(entrance.defId) : undefined;
      const p = entrance && entryDef && entryDef.id !== 'cut' ? clamp(local / Math.max(.001, Math.min(entrance.duration, clip.duration))) : 1;
      const entry = p < 1 && entryDef ? entryDef.xfade === 'fadewhite' || entryDef.xfade === 'fadeblack'
        ? { incoming: { opacity: p, mixBlendMode: 'plus-lighter' as const }, fill: { color: entryDef.xfade === 'fadewhite' ? '#FFFFFF' : '#000000', opacity: 1 - p } }
        : transitionPreviewStyles(entryDef, p, pixelScale) : undefined;
      const entryStyle: CSSProperties = entry?.incoming ?? {};
      const filter = [style.filter, entryStyle.filter].filter(Boolean).join(' ');
      const transform = [style.transform, entryStyle.transform].filter(Boolean).join(' ');
      const fadeLocal = Math.max(0, Math.min(visualLastFrame(clip, project.fps), (Math.round(time * project.fps) - Math.round(clip.start * project.fps)) / project.fps));
      const visualGain = clipVisualGain(clip, fadeLocal, project.fps);
      return { clip, frozen, sourceTime: clip.offset + local * (clip.speed ?? 1),
        style: { ...style, ...entryStyle, opacity: (clip.opacity ?? 1) * visualGain * Number(style.opacity ?? 1) * Number(entryStyle.opacity ?? 1), ...(filter ? { filter } : {}), ...(transform ? { transform } : {}) }, fill: entry?.fill ? { ...entry.fill, opacity: entry.fill.opacity * visualGain } : undefined };
    };
    for (const applied of project.transitions.filter((t) => !t.entrance)) {
      const incomingIndex = clips.findIndex((c) => applied.anchorClipId ? c.id === applied.anchorClipId : id === baseId && Math.abs(c.start - applied.at) < .26);
      if (incomingIndex <= 0) continue;
      const incoming = clips[incomingIndex], outgoing = clips[incomingIndex - 1];
      if (Math.abs(outgoing.start + outgoing.duration - incoming.start) >= .01) continue;
      const def = defMap.get(applied.defId);
      if (!def || def.id === 'cut') continue;
      const duration = Math.min(applied.duration, outgoing.duration / 2, incoming.duration / 2);
      if (duration <= 0) continue;
      const progress = (time - incoming.start + duration / 2) / duration;
      if (progress <= 0 || progress >= 1) continue;
      const styles = transitionPreviewStyles(def, progress, pixelScale);
      return { id, base: id === baseId, layers: [layer(outgoing, styles.outgoing), layer(incoming, styles.incoming)], fill: styles.fill, transition: { applied, def, progress } };
    }
    const active = clips.filter((c) => time >= c.start && time < c.start + c.duration);
    const layers = active.map((c) => layer(c));
    return { id, base: id === baseId, layers, fill: layers.find((l) => l.fill)?.fill };
  });
}
