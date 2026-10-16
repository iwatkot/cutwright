import type { Clip } from './types';

/** Shared fade/gain math so preview and FFmpeg export produce the same envelope. */
export function clampFade(fade: number, duration: number): number {
  return Math.min(Math.max(0, fade), Math.max(0, duration) / 2);
}

/** Gain multiplier (0..) at `local` seconds into a clip. */
export function fadeEnvelope(local: number, duration: number, fadeIn: number, fadeOut: number): number {
  const fi = clampFade(fadeIn, duration);
  const fo = clampFade(fadeOut, duration);
  let env = 1;
  if (fi > 0) env = Math.min(env, Math.max(0, local) / fi);
  if (fo > 0 && duration > 0) env = Math.min(env, Math.max(0, (duration - local) / fo));
  return Math.min(1, Math.max(0, env));
}

export function resolveAudioEnvelope(clip: Clip): NonNullable<Clip['audioEnvelope']> {
  return clip.audioEnvelope ?? { offset: 0, duration: clip.duration, fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0 };
}

export function clipFadeEnvelope(clip: Clip, local: number): number {
  return audioEnvelopeGain(resolveAudioEnvelope(clip), local);
}

/** Independent edge anchors preserve an untouched fade after an edge edit. */
export function audioEnvelopeGain(e: NonNullable<Clip['audioEnvelope']>, local: number): number {
  const time = local + e.offset;
  const fi = clampFade(e.fadeIn, e.fadeInWindow ?? e.duration);
  const fo = clampFade(e.fadeOut, e.fadeOutWindow ?? e.duration);
  let gain = 1;
  if (fi > 0) gain = Math.min(gain, (time - (e.fadeInStart ?? 0)) / fi);
  if (fo > 0) gain = Math.min(gain, ((e.fadeOutEnd ?? e.duration) - time) / fo);
  return Math.min(1, Math.max(0, gain));
}
