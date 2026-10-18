import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { t as uiText } from '../i18n/core';
import type { Clip } from '../lib/types';
import { useStore } from '../lib/store';
import { resolveAudioEnvelope, clipFadeEnvelope } from '../lib/audioEnv';
import { clipVisualGain, fadeCurveAtMidpoint, fadeShape, resolveVisualEnvelope } from '../lib/clipFades';
import { trackPointer } from '../lib/timelinePointer';
import { Field, NumberControl } from './ui/Controls';

export function ClipFadeFields({ clip, visual }: { clip: Clip; visual: boolean }) {
  const editing = useRef(false);
  const fields = visual ? ['visualFadeIn', 'visualFadeOut', 'visualFadeInCurve', 'visualFadeOutCurve'] as const : ['fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve'] as const;
  const labels = visual ? [uiText('Visual fade in'), uiText('Visual fade out'), uiText('Visual fade-in curve'), uiText('Visual fade-out curve')]
    : [uiText('Fade in'), uiText('Fade out'), uiText('Audio fade-in curve'), uiText('Audio fade-out curve')];
  return <><div className="property-grid">{fields.map((field, index) => <Field key={field} label={labels[index]}><NumberControl label={labels[index]} value={clip[field] ?? 0} min={index < 2 ? 0 : -1} max={index < 2 ? clip.duration * (visual ? 1 : .5) : 1} step={.1} unit={index < 2 ? 's' : undefined} onGestureStart={() => { editing.current = false; }} onChange={value => {
    const s = useStore.getState(); if (!editing.current) { s.commit(); editing.current = true; } s.updateClip(clip.id, { [field]: value }, false);
  }} /></Field>)}</div><p className="hint">{uiText('Curve 0 is linear. Drag the middle handle to bend a fade.')}</p><button onClick={() => useStore.getState().updateClip(clip.id, visual
    ? { visualFadeIn: 0, visualFadeOut: 0, visualFadeInCurve: 0, visualFadeOutCurve: 0, visualEnvelope: undefined }
    : { fadeIn: 0, fadeOut: 0, fadeInCurve: 0, fadeOutCurve: 0, audioEnvelope: undefined })}>{uiText('Reset fades')}</button></>;
}

/** The SVG is the actual envelope, including inherited split phase. Handles do not move clips. */
export default function ClipFadeHandles({ clip, visual, fps }: { clip: Clip; visual: boolean; fps: number }) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const profile = visual ? resolveVisualEnvelope(clip, fps) : resolveAudioEnvelope(clip);
  const fraction = visual ? 1 : .5;
  const length = (edge: 'in' | 'out') => Math.min(profile[edge === 'in' ? 'fadeIn' : 'fadeOut'], (profile[edge === 'in' ? 'fadeInWindow' : 'fadeOutWindow'] ?? profile.duration) * fraction);
  const timeAt = (edge: 'in' | 'out', middle = false) => edge === 'in' ? (profile.fadeInStart ?? 0) - profile.offset + length(edge) * (middle ? .5 : 1)
    : (profile.fadeOutEnd ?? profile.duration) - profile.offset - length(edge) * (middle ? .5 : 1);
  const field = (edge: 'in' | 'out', curve: boolean) => visual ? edge === 'in' ? curve ? 'visualFadeInCurve' : 'visualFadeIn' : curve ? 'visualFadeOutCurve' : 'visualFadeOut'
    : edge === 'in' ? curve ? 'fadeInCurve' : 'fadeIn' : curve ? 'fadeOutCurve' : 'fadeOut';
  const label = (edge: 'in' | 'out', curve: boolean) => visual ? edge === 'in' ? curve ? uiText('Visual fade-in curve') : uiText('Visual fade in') : curve ? uiText('Visual fade-out curve') : uiText('Visual fade out')
    : edge === 'in' ? curve ? uiText('Audio fade-in curve') : uiText('Fade in') : curve ? uiText('Audio fade-out curve') : uiText('Fade out');
  const start = (event: ReactPointerEvent<HTMLButtonElement>, edge: 'in' | 'out', curve: boolean) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation(); cleanup.current?.();
    useStore.getState().selectClip(clip.id);
    const bounds = event.currentTarget.closest('.clip')!.getBoundingClientRect();
    const initial = clip[field(edge, curve)] ?? 0, startX = event.clientX;
    let committed = false;
    cleanup.current = trackPointer(event, next => {
      next.preventDefault();
      const value = curve ? fadeCurveAtMidpoint(1 - (next.clientY - bounds.top - 4) / Math.max(1, bounds.height - 8))
        : Math.max(0, Math.min(clip.duration * fraction, initial + (next.clientX - startX) / bounds.width * clip.duration * (edge === 'in' ? 1 : -1)));
      if (Math.abs(value - (useStore.getState().project.clips.find(c => c.id === clip.id)?.[field(edge, curve)] ?? 0)) < .00001) return;
      if (!committed) { useStore.getState().commit(); committed = true; }
      useStore.getState().updateClip(clip.id, { [field(edge, curve)]: value }, false);
    }, () => { cleanup.current = null; });
  };
  const points = Array.from({ length: 65 }, (_, i) => {
    const time = clip.duration * i / 64;
    const gain = visual ? clipVisualGain(clip, time, fps) : clipFadeEnvelope(clip, time);
    return `${i / 64 * 100},${4 + (1 - gain) * 92}`;
  }).join(' ');
  return <span className="clip-fades" data-shortcut-scope="control" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    {(profile.fadeIn > 0 || profile.fadeOut > 0) && <svg className="clip-fade-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points={`0,100 ${points} 100,100`} /><polyline points={points} /></svg>}
    {(['in', 'out'] as const).flatMap(edge => [false, true].map(curve => {
      const time = timeAt(edge, curve), value = clip[field(edge, curve)] ?? 0;
      if (curve && (length(edge) <= 0 || time < 0 || time > clip.duration)) return null;
      const gain = curve ? fadeShape(.5, profile[edge === 'in' ? 'fadeInCurve' : 'fadeOutCurve']) : 1;
      return <button key={`${edge}-${curve}`} type="button" role="slider" aria-label={label(edge, curve)} aria-valuenow={value} aria-valuemin={curve ? -1 : 0} aria-valuemax={curve ? 1 : clip.duration * fraction}
        className={`clip-fade-handle ${curve ? 'curve' : 'duration'}`} data-tooltip={label(edge, curve)}
        style={{ left: `${Math.min(97, Math.max(3, time / clip.duration * 100))}%`, top: `${4 + (1 - gain) * 92}%` }}
        onPointerDown={e => start(e, edge, curve)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const min = curve ? -1 : 0, max = curve ? 1 : clip.duration * fraction;
          const step = curve ? .1 : event.shiftKey ? 1 : 1 / fps;
          const next = event.key === 'Home' ? min : event.key === 'End' ? max : Math.min(max, Math.max(min, value + (event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : -step)));
          if (next !== value) useStore.getState().updateClip(clip.id, { [field(edge, curve)]: next });
        }} />;
    }))}
  </span>;
}
