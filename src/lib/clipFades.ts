import type { Clip, ClipFadeEnvelope } from './types';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
/** Legacy zero is linear; all curves are monotonic with exact endpoints. */
export function fadeShape(progress: number, curve = 0): number {
  const p = clamp(progress), c = clamp(curve, -1, 1);
  if (c === 0) return p;
  return c >= 0 ? 1 - Math.pow(1 - p, 1 + 4 * c) : Math.pow(p, 1 - 4 * c);
}
export function fadeCurveAtMidpoint(gain: number): number {
  const g = clamp(gain, .03125, .96875);
  return clamp(g >= .5 ? (Math.log(1 - g) / Math.log(.5) - 1) / 4 : (1 - Math.log(g) / Math.log(.5)) / 4, -1, 1);
}
export function envelopeGain(e: ClipFadeEnvelope, local: number, fraction = .5): number {
  const time = local + e.offset;
  const fi = Math.min(Math.max(0, e.fadeIn), Math.max(0, e.fadeInWindow ?? e.duration) * fraction);
  const fo = Math.min(Math.max(0, e.fadeOut), Math.max(0, e.fadeOutWindow ?? e.duration) * fraction);
  return Math.min(fi > 0 ? fadeShape((time - (e.fadeInStart ?? 0)) / fi, e.fadeInCurve) : 1,
    fo > 0 ? fadeShape(((e.fadeOutEnd ?? e.duration) - time) / fo, e.fadeOutCurve) : 1);
}
export function visualLastFrame(clip: Clip, fps: number): number {
  return Math.max(0, (Math.max(1, Math.round((clip.start + clip.duration) * fps) - Math.round(clip.start * fps)) - 1) / fps);
}
export function resolveVisualEnvelope(clip: Clip, fps: number): ClipFadeEnvelope {
  return clip.visualEnvelope ?? { offset: 0, duration: clip.duration, fadeIn: clip.visualFadeIn ?? 0, fadeOut: clip.visualFadeOut ?? 0,
    fadeInCurve: clip.visualFadeInCurve, fadeOutCurve: clip.visualFadeOutCurve, fadeOutEnd: visualLastFrame(clip, fps) };
}
export function clipVisualGain(clip: Clip, local: number, fps: number): number {
  return envelopeGain(resolveVisualEnvelope(clip, fps), local, 1);
}
/** Shared scalar expression for native per-sample sound and per-frame alpha. */
export function envelopeExpression(e: ClipFadeEnvelope, clock: string, fraction = .5): string {
  const n = (v: number) => String(Number(v.toFixed(12)));
  const shape = (p: string, c = 0) => c === 0 ? p : c > 0 ? `(1-pow(1-(${p}),${n(1 + 4 * c)}))` : `pow(${p},${n(1 - 4 * c)})`;
  const time = `(${clock}+${n(e.offset)})`;
  const fi = Math.min(Math.max(0, e.fadeIn), Math.max(0, e.fadeInWindow ?? e.duration) * fraction);
  const fo = Math.min(Math.max(0, e.fadeOut), Math.max(0, e.fadeOutWindow ?? e.duration) * fraction);
  const attack = fi > 0 ? shape(`min(1,max(0,(${time}-${n(e.fadeInStart ?? 0)})/${n(fi)}))`, e.fadeInCurve) : '1';
  const release = fo > 0 ? shape(`min(1,max(0,(${n(e.fadeOutEnd ?? e.duration)}-${time})/${n(fo)}))`, e.fadeOutCurve) : '1';
  return `min(${attack},${release})`;
}
