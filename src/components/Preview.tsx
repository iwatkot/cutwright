import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../lib/store';
import { useLayoutEffect } from 'react';
import { fmtTime } from '../lib/srt';
import { BUILTIN_TRANSITIONS } from '../lib/transitions';
import { mediaUrl } from '../lib/mediaUrl';
import { audioEnvelopeGain, resolveAudioEnvelope } from '../lib/audioEnv';
import { overlaySvg, resolveOverlay } from '../lib/overlay';
import { resolvePreviewComposition, transitionPreviewStyles, type PreviewLayer } from '../lib/previewComposition';
import { captionLayout, captionSvg } from '../lib/captions';
import { IconButton, IconFit, IconHand, IconPause, IconPlay, IconSkipEnd, IconSkipStart, IconStepBack, IconStepFwd, IconZoomIn, IconZoomOut } from './icons';
import { useShortcutLabel } from '../lib/shortcutPreferences';
import type { Clip, MediaItem } from '../lib/types';
import { toast } from './TopBar';
import ProjectSettings from './ProjectSettings';
import CanvasAids, { CanvasRulers } from './CanvasAids';
import { usePreviewNavigation } from './usePreviewNavigation';
import { MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from '../lib/previewNavigation';
import './previewNavigation.css';

function playableMediaUrl(media?: MediaItem): string {
  if (!media?.src || media.offline) return '';
  const source = mediaUrl(media.src);
  // Desktop project paths cannot load in a browser. An unrestored durable
  // local reference also resolves to ''; omit its HTML element entirely.
  if (!window.cutwright && /^(?:file:|cutwright-media:|[a-z]:[\\/]|\\\\)/i.test(source)) return '';
  return source;
}

const envelopeData = (clip: Clip) => {
  const e = resolveAudioEnvelope(clip);
  return { 'data-envelope-offset': e.offset, 'data-envelope-duration': e.duration, 'data-envelope-fadein': e.fadeIn, 'data-envelope-fadeout': e.fadeOut,
    'data-envelope-fadein-start': e.fadeInStart, 'data-envelope-fadein-window': e.fadeInWindow,
    'data-envelope-fadeout-end': e.fadeOutEnd, 'data-envelope-fadeout-window': e.fadeOutWindow };
};

// Preview gain path: HTMLMediaElement.volume caps at 1, the inspector allows
// 2x. Route elements through a WebAudio GainNode (created on user gesture)
// so preview gain/fades match the export's volume/afade math.
let actx: AudioContext | null = null;
const gainNodes = new WeakMap<HTMLMediaElement, GainNode>();
function routedGain(el: HTMLMediaElement): GainNode | null {
  try {
    actx ??= new AudioContext();
    void actx.resume();
    let g = gainNodes.get(el);
    if (!g) {
      const src = actx.createMediaElementSource(el);
      g = actx.createGain();
      src.connect(g);
      g.connect(actx.destination);
      gainNodes.set(el, g);
    }
    return g;
  } catch { return null; }
}

/**
 * Faithful preview of the export composition:
 * lowest video track is the base (gaps are black), higher tracks composite
 * above it, audio tracks play mixed. Every real media element is synced to
 * the playhead with frame-accurate seeks while paused.
 */
export default function Preview() {
  const panShortcut = useShortcutLabel('panHold');
  const project = useStore((s) => s.project);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setPlaying = useStore((s) => s.setPlaying);
  const totalDuration = useStore((s) => s.totalDuration());
  const stageRef = useRef<HTMLDivElement>(null);
  const navigation = usePreviewNavigation(project.width, project.height);

  const mediaById = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);
  const customTransitions = useStore((s) => s.project.customTransitions);
  const defs = useMemo(() => [...BUILTIN_TRANSITIONS, ...customTransitions], [customTransitions]);
  const previewDefId = useStore((s) => s.previewDefId);
  const previewDef = defs.find((d) => d.id === previewDefId);
  const [pp, setPp] = useState(0);
  const [pixelScale, setPixelScale] = useState(1);
  const ts = project.trackSettings ?? {};

  const composition = useMemo(() => resolvePreviewComposition(project, defs, playhead, pixelScale), [project, defs, playhead, pixelScale]);
  const baseTrack = composition.find((t) => t.base);
  const current = baseTrack?.layers.find(({ clip }) => playhead >= clip.start && playhead < clip.start + clip.duration)?.clip;
  const baseClips = project.clips.filter((c) => c.trackId === baseTrack?.id);
  const overlayClips = composition.filter((t) => !t.base).flatMap((t) => t.layers.map((l) => l.clip));
  const transition = composition.find((t) => t.transition)?.transition;
  const def = transition?.def;
  const blending = !!transition;
  const audioClips = project.clips.filter((c) => c.trackId.startsWith('a') && !ts[c.trackId]?.muted && !ts[c.trackId]?.hidden
    && playhead >= c.start && playhead < c.start + c.duration);
  const caption = useMemo(() => captionLayout(project, playhead), [project, playhead]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setPixelScale(stage.clientWidth / project.width);
    measure();
    const resize = new ResizeObserver(measure); resize.observe(stage);
    return () => resize.disconnect();
  }, [project.width]);

  // Movavi behavior: clicking a transition in the list previews it in the player.
  useEffect(() => {
    if (!previewDef) return;
    let raf = 0;
    const t0 = performance.now();
    const dur = Math.max(0.3, previewDef.duration);
    const step = (now: number) => {
      const phase = ((now - t0) / 1000) % (dur + 0.9);
      setPp(phase < 0.4 ? 0 : phase > dur + 0.4 ? 1 : (phase - 0.4) / dur);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [previewDef]);

  const demo = previewDef ? transitionPreviewStyles(previewDef, pp, pixelScale) : null;
  const demoStyle = (isNext: boolean): CSSProperties => (isNext ? demo?.incoming : demo?.outgoing) ?? {};

  // A transition handle can become frozen without replacing its video node.
  // Stop it before paint, including video→still dissolves with continuous audio.
  useLayoutEffect(() => {
    const cleanups: (() => void)[] = [];
    stageRef.current?.querySelectorAll<HTMLMediaElement>('[data-cw-media][data-frozen="1"]').forEach((el) => {
      const align = () => {
        el.pause();
        const requested = Number(el.dataset.sourceTime ?? 0);
        const target = Number.isFinite(el.duration) ? Math.min(requested, Math.max(0, el.duration - 1e-7)) : requested;
        const tolerance = Math.max(1e-6, Number(el.dataset.speed ?? 1) / project.fps / 2);
        if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - target) > tolerance) {
          try { el.currentTime = target; } catch { /* retry once metadata or the pending seek settles */ }
        }
      };
      el.addEventListener('loadedmetadata', align); el.addEventListener('seeked', align);
      cleanups.push(() => { el.removeEventListener('loadedmetadata', align); el.removeEventListener('seeked', align); });
      align();
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [playhead, project]);

  // Start/seek/cut as a group: the timeline waits for decoded, aligned media
  // rather than letting independent cold starts keep a permanent offset.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let alive = true;
    let generation = 0;
    let phase: 'aligning' | 'starting' | 'playing' = 'aligning';
    let elements: HTMLMediaElement[] = [];
    let elementSignature = '';
    let masterElement: HTMLMediaElement | undefined;
    let pending = 0;
    let rejection: unknown;
    let deadline = last + 10000;
    let expectedPlayhead = useStore.getState().playhead;
    let progressAt = last;
    let holdStart: number | null = last;
    let holdCount = 1, totalHold = 0, maxHold = 0;
    const corrections = new Map<HTMLMediaElement, number>();
    const lastCorrection = new WeakMap<HTMLMediaElement, number>();
    let correctionCount = 0, correctionMs = 0, maxCorrectionMs = 0;
    const stage = stageRef.current;
    const record = (state: string, now: number) => {
      if (!stage) return;
      stage.dataset.playbackState = state;
      stage.dataset.playbackHoldCount = String(holdCount);
      stage.dataset.playbackHoldMs = String(totalHold + (holdStart === null ? 0 : now - holdStart));
      stage.dataset.playbackMaxHoldMs = String(Math.max(maxHold, holdStart === null ? 0 : now - holdStart));
      stage.dataset.playbackCorrections = String(correctionCount);
      stage.dataset.playbackCorrectionMs = String(correctionMs);
      stage.dataset.playbackMaxCorrectionMs = String(maxCorrectionMs);
    };
    const silence = (el: HTMLMediaElement, muted: boolean) => {
      el.muted = muted || el.dataset.muted === '1';
      const gain = gainNodes.get(el);
      if (gain) gain.gain.value = muted ? 0 : Math.max(0, Number(el.dataset.gainNow ?? 1));
      else el.volume = muted ? 0 : Math.min(1, Math.max(0, Number(el.dataset.gainNow ?? 1)));
    };
    const freeze = (now: number, resetDeadline: boolean, reason = 'drift') => {
      const wasRunning = phase === 'playing';
      generation++;
      phase = 'aligning';
      pending = 0;
      rejection = undefined;
      corrections.clear();
      if (holdStart === null) { holdStart = now; holdCount++; }
      if (resetDeadline || wasRunning) deadline = now + 10000;
      for (const el of elements) { el.pause(); silence(el, true); }
      if (stage) stage.dataset.playbackHoldReason = reason;
    };
    const fail = (message: string) => {
      alive = false;
      for (const el of elements) el.pause();
      record('error', performance.now());
      setPlaying(false);
      toast(message);
    };
    const step = (now: number) => {
      if (!alive || !useStore.getState().playing) return;
      const dt = (now - last) / 1000;
      last = now;
      const state = useStore.getState();
      const currentTime = state.playhead;
      const nextElements = [...(stage?.querySelectorAll<HTMLMediaElement>('[data-cw-media]') ?? [])];
      const changed = nextElements.length !== elements.length || nextElements.some((el, i) => el !== elements[i]);
      const nextSignature = nextElements.map((el) => [el.getAttribute('src'), el.dataset.start, el.dataset.offset, el.dataset.speed, el.dataset.duration, el.dataset.frozen, el.dataset.frozen === '1' ? el.dataset.sourceTime : ''].join('|')).join('\n');
      const mappingChanged = nextSignature !== elementSignature;
      if (changed || mappingChanged || Math.abs(currentTime - expectedPlayhead) > 1e-6) {
        for (const el of elements) if (!nextElements.includes(el)) el.pause();
        elements = nextElements;
        elementSignature = nextSignature;
        progressAt = now;
        freeze(now, true, changed ? 'media change' : mappingChanged ? 'media mapping' : 'seek');
      }
      expectedPlayhead = currentTime;
      const frame = 1 / state.project.fps;
      const tolerance = Math.max(frame * 1.5, .05);
      const desired = (el: HTMLMediaElement) => {
        const speed = Number(el.dataset.speed ?? 1);
        const source = el.dataset.frozen === '1'
          ? Number(el.dataset.sourceTime ?? 0)
          : Number(el.dataset.offset ?? 0) + Math.max(0, currentTime - Number(el.dataset.start ?? 0)) * speed;
        return Number.isFinite(el.duration) ? Math.min(source, Math.max(0, el.duration - 1e-7)) : source;
      };
      const terminal = (el: HTMLMediaElement) => Number.isFinite(el.duration) && el.ended
        && desired(el) >= el.duration - Math.max(frame * Number(el.dataset.speed ?? 1), .02);
      const live = elements.filter((el) => el.dataset.frozen !== '1' && !terminal(el));
      const audible = live.filter((el) => el.dataset.muted !== '1' && el.dataset.hasAudio !== '0' && Number(el.dataset.volume ?? 0) > 0);
      const voices = audible.filter((el) => el.tagName === 'AUDIO' && Number(el.dataset.volume ?? 0) > .1)
        .sort((a, b) => Number(b.dataset.volume ?? 0) - Number(a.dataset.volume ?? 0));
      const audibleVideos = audible.filter((el) => el.tagName === 'VIDEO' && Number(el.dataset.volume ?? 0) > .1);
      const candidates = voices.length ? voices : audibleVideos.length ? audibleVideos : audible.length ? audible : live.filter((el) => el.tagName === 'VIDEO').reverse();
      const master = masterElement && candidates.includes(masterElement) ? masterElement : candidates[0] ?? live[0];
      if (masterElement && masterElement !== master && phase === 'playing') freeze(now, true, 'master change');
      masterElement = master;
      if (elements.some((el) => el.error)) { fail('Playback could not load local media. Use Import to relink the missing or unsupported file.'); return; }
      if (phase === 'playing') for (const el of elements) {
        if (terminal(el)) continue;
        const correctingSince = corrections.get(el);
        if (correctingSince !== undefined) {
          if (el.seeking || el.readyState < 2) {
            if (now - correctingSince < 500) continue;
          } else {
            const elapsed = now - correctingSince;
            correctionMs += elapsed; maxCorrectionMs = Math.max(maxCorrectionMs, elapsed);
            corrections.delete(el);
          }
        }
        const error = Math.abs(el.currentTime - desired(el)) / Number(el.dataset.speed ?? 1);
        if (el.readyState < 2 || el.seeking || (el.dataset.frozen !== '1' && el.paused) || error > .25 || (el.dataset.frozen === '1' && error > tolerance)) {
          freeze(now, false, 'media readiness'); break;
        }
        if (el.tagName === 'VIDEO' && el !== master && error > tolerance && now - (lastCorrection.get(el) ?? -Infinity) > 100) {
          // Correct a warm secondary clock without restarting the audible
          // master. One frame of lead covers the seek's decode scheduling.
          const target = desired(el) + frame * Number(el.dataset.speed ?? 1);
          try {
            corrections.set(el, now); lastCorrection.set(el, now); correctionCount++;
            el.currentTime = Number.isFinite(el.duration) ? Math.min(target, Math.max(0, el.duration - 1e-7)) : target;
          } catch { corrections.delete(el); }
        }
      }
      if (phase !== 'playing' && now > deadline) { fail('Playback is waiting for local media. Try Play again, or use Import to relink the file.'); return; }
      if (phase === 'aligning') {
        let ready = true;
        for (const el of elements) {
          el.pause(); silence(el, true);
          const target = desired(el);
          if (!terminal(el) && !el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - target) / Number(el.dataset.speed ?? 1) > frame / 2) {
            try { el.currentTime = target; } catch { /* metadata/seek readiness is checked on the next frame */ }
          }
          if (!terminal(el) && (el.readyState < 2 || el.seeking || Math.abs(el.currentTime - target) / Number(el.dataset.speed ?? 1) > frame / 2)) ready = false;
        }
        if (ready) {
          phase = 'starting';
          const ticket = ++generation;
          const active = elements.filter((el) => el.dataset.frozen !== '1' && !terminal(el));
          pending = active.length;
          for (const el of active) {
            void el.play().then(() => {
              if (alive && generation === ticket && el.isConnected) pending--;
            }).catch((error: unknown) => {
              if (alive && generation === ticket && el.isConnected) { rejection = error; pending--; }
            });
          }
        }
      }
      if (phase === 'starting' && pending === 0) {
        if (rejection) { fail('Playback was blocked. Press Play again to allow this local media to start.'); return; }
        const skew = elements.some((el) => !terminal(el) && Math.abs(el.currentTime - desired(el)) / Number(el.dataset.speed ?? 1) > tolerance);
        if (skew) freeze(now, false);
        else {
          phase = 'playing';
          progressAt = now;
          if (holdStart !== null) { const held = now - holdStart; totalHold += held; maxHold = Math.max(maxHold, held); holdStart = null; }
          for (const el of elements) silence(el, false);
          // Do not add the last blocked frame to the timeline on release.
          record(phase, now); raf = requestAnimationFrame(step); return;
        }
      }
      record(phase, now);
      if (phase !== 'playing') { raf = requestAnimationFrame(step); return; }
      // Follow the actual audible media clock after the group is ready. A
      // wall clock keeps running during the browser's audio scheduling delay
      // and forces healthy elements into a repeated pause/seek cycle.
      const mediaTime = master ? Number(master.dataset.start ?? 0) + (master.currentTime - Number(master.dataset.offset ?? 0)) / Number(master.dataset.speed ?? 1) : currentTime + dt;
      const t = Math.max(currentTime, mediaTime);
      if (t > currentTime + 1e-6) progressAt = now;
      else if (master && now - progressAt > 10000) { fail('Playback has stalled. Try Play again, or use Import to relink the file.'); return; }
      if (t >= useStore.getState().totalDuration()) { setPlayhead(useStore.getState().totalDuration()); setPlaying(false); return; }
      expectedPlayhead = t;
      setPlayhead(t);
      raf = requestAnimationFrame(step);
    };
    record(phase, last);
    raf = requestAnimationFrame(step);
    return () => {
      alive = false; generation++; cancelAnimationFrame(raf);
      for (const el of elements) { el.pause(); silence(el, false); }
      record('paused', performance.now());
    };
  }, [playing, setPlayhead, setPlaying]);

  // Synchronize every real media layer (video base/overlays + audio tracks).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cleanups: (() => void)[] = [];
    stage.querySelectorAll<HTMLMediaElement>('[data-cw-media]').forEach((el) => {
      const start = Number(el.dataset.start ?? 0);
      const offset = Number(el.dataset.offset ?? 0);
      const speed = Number(el.dataset.speed ?? 1);
      const target = el.dataset.sourceTime === undefined ? offset + Math.max(0, playhead - start) * speed : Number(el.dataset.sourceTime);
      // The group controller owns seeks while playing. Repeatedly assigning
      // currentTime during a pending seek prevents cold decodes from settling.
      if (!playing) {
        const seek = () => {
          const boundedTarget = Number.isFinite(el.duration) ? Math.min(target, Math.max(0, el.duration - 1e-7)) : target;
          if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - boundedTarget) > Math.max(1e-6, speed / project.fps / 2)) {
            try { el.currentTime = boundedTarget; } catch { /* retry after metadata/seek readiness */ }
          }
        };
        el.addEventListener('loadedmetadata', seek); el.addEventListener('seeked', seek);
        cleanups.push(() => { el.removeEventListener('loadedmetadata', seek); el.removeEventListener('seeked', seek); });
        seek();
      }
      el.playbackRate = speed;
      // Gain + shared fade envelope (src/lib/audioEnv.ts), identical rules
      // to the export. >1x gains go through the WebAudio gain path.
      const local = Math.max(0, playhead - start);
      const dur = Number(el.dataset.duration ?? 0);
      const fi = Number(el.dataset.fadein ?? 0);
      const fo = Number(el.dataset.fadeout ?? 0);
      const total = Number(el.dataset.volume ?? 1) * audioEnvelopeGain({
        offset: Number(el.dataset.envelopeOffset ?? 0), duration: Number(el.dataset.envelopeDuration ?? dur),
        fadeIn: Number(el.dataset.envelopeFadein ?? fi), fadeOut: Number(el.dataset.envelopeFadeout ?? fo),
        fadeInStart: el.dataset.envelopeFadeinStart === undefined ? undefined : Number(el.dataset.envelopeFadeinStart),
        fadeInWindow: el.dataset.envelopeFadeinWindow === undefined ? undefined : Number(el.dataset.envelopeFadeinWindow),
        fadeOutEnd: el.dataset.envelopeFadeoutEnd === undefined ? undefined : Number(el.dataset.envelopeFadeoutEnd),
        fadeOutWindow: el.dataset.envelopeFadeoutWindow === undefined ? undefined : Number(el.dataset.envelopeFadeoutWindow),
      }, local);
      el.dataset.gainNow = total.toFixed(3); // measured-parity hook (tests read the applied gain)
      const gain = routedGain(el);
      const held = playing && stage.dataset.playbackState !== 'playing';
      if (gain) { gain.gain.value = held ? 0 : Math.max(0, total); el.volume = 1; }
      else el.volume = held ? 0 : Math.min(1, Math.max(0, total));
      el.muted = held || el.dataset.muted === '1';
      if (!playing && !el.paused) el.pause();
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [playhead, playing, project]);

  const mediaLayer = ({ clip, style, sourceTime, frozen }: PreviewLayer, keyPrefix: string) => {
    const media = mediaById.get(clip.mediaId);
    const overlay = resolveOverlay(clip, media);
    const source = playableMediaUrl(media);
    const trackMuted = !!ts[clip.trackId]?.muted;
    const audible = playhead >= clip.start && playhead < clip.start + clip.duration;
    const volume = clip.mutedAudio || !audible ? 0 : (clip.volume ?? 1) * (ts[clip.trackId]?.volume ?? 1);
    const common = {
      ...envelopeData(clip),
      'data-cw-media': true,
      'data-start': clip.start,
      'data-offset': clip.offset,
      'data-speed': clip.speed ?? 1,
      'data-source-time': sourceTime,
      'data-frozen': frozen ? '1' : '0',
      'data-volume': trackMuted ? 0 : volume,
      'data-has-audio': media?.hasAudio === false ? '0' : '1',
      'data-muted': trackMuted || volume === 0 || clip.mutedAudio ? '1' : '0',
      'data-duration': clip.duration,
      'data-fadein': clip.fadeIn ?? 0,
      'data-fadeout': clip.fadeOut ?? 0,
    } as Record<string, unknown>;
    const fx: CSSProperties = {
      transform: `translate(${clip.posX ?? 0}%, ${clip.posY ?? 0}%) scale(${clip.scale ?? 1}) rotate(${clip.rotate ?? 0}deg)`,
      filter: `brightness(${clip.brightness ?? 1}) contrast(${clip.contrast ?? 1}) saturate(${clip.saturation ?? 1})`,
    };
    return (
      <div key={keyPrefix + clip.id} className="scene" data-cw-clip={clip.id} data-cw-layer-source-time={sourceTime} data-cw-frozen={frozen ? '1' : '0'} style={style}>
        {overlay ? (
          <div data-cw-overlay={overlay.kind} data-overlay-source-time={sourceTime}
            aria-label={overlay.kind === 'title' ? overlay.text : clip.name}
            style={{ position: 'absolute', inset: 0, ...fx }}
            dangerouslySetInnerHTML={{ __html: overlaySvg(overlay, project.width, project.height, sourceTime) }} />
        ) : source && media?.kind === 'video' ? (
          <video crossOrigin="anonymous" {...common} src={source} playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', ...fx }} />
        ) : source && media?.kind === 'image' ? (
          <img src={source} alt={clip.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', ...fx }} />
        ) : (
          <>
            <div className="scenename">{clip.name.replace(/_/g, ' ')}</div>
            <div className="scenesub">{project.name} · {project.width}×{project.height} · {project.fps}fps</div>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <ProjectSettings viewControls={<div className="canvas-view-actions" role="group" aria-label="Preview view">
        <IconButton label="Pan preview" action="panToggle" aria-pressed={navigation.handTool} title="Hand tool · Left-drag to pan · Right-drag always pans" onClick={navigation.toggleHand}><IconHand /></IconButton>
        <IconButton label="Zoom preview out" action="previewZoomOut" title="Zoom preview out · Wheel to zoom" disabled={navigation.view.zoom <= MIN_PREVIEW_ZOOM} onClick={() => navigation.zoom(1 / 1.25)}><IconZoomOut /></IconButton>
        <output aria-label="Preview zoom" data-tooltip={`Zoom relative to Fit · Wheel to zoom · Right-drag${panShortcut ? ` or hold ${panShortcut} and drag` : ''} to pan`}>{Math.round(navigation.view.zoom * 100)}%</output>
        <IconButton label="Zoom preview in" action="previewZoomIn" title="Zoom preview in · Wheel to zoom" disabled={navigation.view.zoom >= MAX_PREVIEW_ZOOM} onClick={() => navigation.zoom(1.25)}><IconZoomIn /></IconButton>
        <IconButton label="Fit preview" action="previewFit" title="Fit preview and center view" onClick={navigation.fit}><IconFit /></IconButton>
      </div>} />
      <div ref={navigation.viewportRef} className={`previewwrap cw-canvas-workspace${navigation.spaceHeld || navigation.handTool ? ' cw-preview-hand' : ''}${navigation.panning ? ' cw-preview-panning' : ''}`} role="region" aria-label="Video preview" tabIndex={0} data-preview-zoom={navigation.view.zoom} data-preview-pan-x={navigation.view.x} data-preview-pan-y={navigation.view.y} onPointerDownCapture={navigation.pointerDown} onClickCapture={event => { if (navigation.suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }} onContextMenu={event => event.preventDefault()} onMouseDownCapture={event => { if (event.button === 1 || event.button === 2) event.preventDefault(); }} onMouseDown={() => { const ae = document.activeElement as HTMLElement | null; if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur(); }}>
        <div className="canvas-frame" style={{ width: navigation.area.fitWidth * navigation.view.zoom, height: navigation.area.fitHeight * navigation.view.zoom, transform: `translate(${navigation.view.x}px, ${navigation.view.y}px)`, aspectRatio: `${project.width}/${project.height}` }}>
        <div className="stage" ref={stageRef} style={{ isolation: 'isolate', aspectRatio: `${project.width} / ${project.height}` }} onClick={() => { if (previewDef) useStore.getState().setPreviewDef(null); }}>
          {previewDef && (
            <>
              <div className="scene" style={{ background: 'linear-gradient(135deg,#155e75,#0b0c0e 72%)', ...demoStyle(false) }}>
                <div className="scenename">Clip A</div><div className="scenesub">Transition preview</div>
              </div>
              <div className="scene" style={{ background: 'linear-gradient(135deg,#92400e,#0b0c0e 72%)', ...demoStyle(true) }}>
                <div className="scenename">Clip B</div><div className="scenesub">{previewDef.name}</div>
              </div>
              {demo?.fill && (
                <div className="scene" style={{ background: demo.fill.color, opacity: demo.fill.opacity, mixBlendMode: 'plus-lighter', pointerEvents: 'none' }} />
              )}
              <div className="previewing">Previewing “{previewDef.name}” — drag it onto a cut below, or click the player to go back
                <button className="ghost" aria-label="Close transition preview" onClick={() => useStore.getState().setPreviewDef(null)}>✕</button>
              </div>
            </>
          )}
          {!previewDef && (
            <>
              {composition.length === 0 && <div className="scene" style={{ background: '#000' }}><div className="scenename">Empty timeline</div><div className="scenesub">Add media from the left panel to start</div></div>}
              {composition.map((track) => <div key={track.id} className="scene" data-cw-track={track.id} data-transition={track.transition?.applied.id}
                style={{ isolation: 'isolate', overflow: 'hidden', pointerEvents: 'none', ...(track.base ? { background: '#000' } : {}) }}>
                {track.layers.map((layer) => mediaLayer(layer, track.id + '-'))}
                {track.fill && <div className="scene" style={{ background: track.fill.color, opacity: track.fill.opacity, mixBlendMode: 'plus-lighter' }} />}
              </div>)}
              {audioClips.map((c) => {
                const media = mediaById.get(c.mediaId);
                const source = playableMediaUrl(media);
                if (!source) return null;
                const trackMuted = !!ts[c.trackId]?.muted;
                const volume = (c.volume ?? 1) * (ts[c.trackId]?.volume ?? 1);
                return (
                  <audio key={'au-' + c.id} {...envelopeData(c)} data-cw-media data-start={c.start} data-offset={c.offset} data-speed={c.speed ?? 1}
                    data-duration={c.duration} data-fadein={c.fadeIn ?? 0} data-fadeout={c.fadeOut ?? 0}
                    crossOrigin="anonymous" data-volume={trackMuted ? 0 : volume} data-muted={trackMuted || volume === 0 ? '1' : '0'} src={source} preload="auto" />
                );
              })}
              {caption && <div className="suboverlay" aria-label={caption.lines.map((line) => line.text).join('\n')}
                dangerouslySetInnerHTML={{ __html: captionSvg(caption, project.width, project.height) }} />}
            </>
          )}
          {!previewDef && <CanvasAids stageRef={stageRef} />}
        </div>
        </div>
        <div className="canvas-viewport-rulers"><CanvasRulers stageRef={stageRef} pixelScale={pixelScale} viewRect={{ width: navigation.area.width, height: navigation.area.height, stageWidth: navigation.area.fitWidth * navigation.view.zoom, stageHeight: navigation.area.fitHeight * navigation.view.zoom, x: navigation.view.x, y: navigation.view.y }} /></div>
      </div>
      <div className="transport">
        <div className="transport-buttons" role="group" aria-label="Playback">
          <IconButton label="Go to start" action="start" disabled={playhead <= 0} onClick={() => setPlayhead(0)}><IconSkipStart /></IconButton>
          <IconButton label="Previous frame" action="frameBack" disabled={playhead <= 0} onClick={() => { setPlaying(false); setPlayhead(Math.max(0, playhead - 1 / project.fps)); }}><IconStepBack /></IconButton>
          <IconButton label={playing ? 'Pause' : 'Play'} action="play" className="primary playbtn" aria-pressed={playing} onClick={() => { if (previewDef) useStore.getState().setPreviewDef(null); setPlaying(!playing); }}>{playing ? <IconPause /> : <IconPlay />}</IconButton>
          <IconButton label="Next frame" action="frameForward" disabled={playhead >= totalDuration} onClick={() => { setPlaying(false); setPlayhead(Math.min(totalDuration, playhead + 1 / project.fps)); }}><IconStepFwd /></IconButton>
          <IconButton label="Go to end" action="end" disabled={playhead >= totalDuration} onClick={() => setPlayhead(totalDuration)}><IconSkipEnd /></IconButton>
        </div>
        <div className="timecode">{fmtTime(playhead)} <span>/ {fmtTime(totalDuration)}</span></div>
        <span className="hint current-media" data-tooltip={current?.name}>{current ? current.name : baseClips.length ? 'Gap' : 'No clip'}{def && blending ? ` · ${def.name}` : ''}{overlayClips.length ? ` · +${overlayClips.length} overlay` : ''}</span>
        <div className="spacer" />
      </div>
    </>
  );
}

