import { exportDimensions } from './outputDimensions';
import type { Clip, Project, TransitionDef } from './types';
import { resolveOverlay } from './overlay';
import { resolveAudioEnvelope } from './audioEnv';
import { envelopeExpression, resolveVisualEnvelope } from './clipFades';
import { defocusSigma } from './defocus';

export interface ExportPlan {
  args: string[];
  duration: number;
  warnings: string[];
}

const f3 = (n: number) => n.toFixed(3);
const seconds = (n: number) => n.toFixed(9);

/**
 * Build a faithful FFmpeg command for the whole timeline.
 *
 * Composition rules (verified by tests/render fixtures):
 * - V1 clips sit at their real timeline starts; gaps become black segments.
 * - Hard cuts stay hard cuts (concat) — never micro-fades.
 * - A defined transition uses xfade, with freeze-frame handles (tpad clone)
 *   on both sides so the total duration is preserved exactly.
 * - Higher tracks concatenate clips with transparent gaps, then composite
 *   once per track, honoring opacity and track visibility.
 * - Every audible clip (audio tracks + video clips' own audio) is trimmed,
 *   delayed to its timeline start, gained, faded and mixed with amix.
 * - Subtitles burn last, matching the preview overlay.
 */
export interface ExportOptions {
  maxHeight?: number; // legacy option name: maximum output short edge, preserving orientation
  crf?: number;
  x264Preset?: string;
}

export function buildExportArgs(project: Project, defs: TransitionDef[], srtPath: string | null, outPath: string, opts: ExportOptions = {}): ExportPlan {
  const warnings: string[] = [];
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const defById = new Map(defs.map((d) => [d.id, d]));
  const ts = project.trackSettings ?? {};
  const { width: W, height: H, fps } = project;

  const onTrack = (trackId: string) => project.clips
    .filter((c) => c.trackId === trackId && !ts[trackId]?.hidden)
    .slice()
    .sort((a, b) => a.start - b.start);
  // Composition contract (shared with the preview): video tracks stack —
  // lowest track is the base, every higher track composites over it. Clips on
  // one track may touch or gap, never overlap; overlaps are rejected here
  // with an actionable error instead of being silently concatenated.
  const videoTrackIds = [...new Set(project.clips.filter((c) => c.trackId.startsWith('v')).map((c) => c.trackId))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // One explicit order everywhere (UI, preview, export): project.trackOrder
  // is TOP-to-BOTTOM. The bottom visible track is the base; overlays
  // composite bottom-first so the top track always wins. Without an explicit
  // order, higher track numbers sit on top (V3 over V2 over V1).
  const defaultTopOrder = videoTrackIds.slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const requested = (project.trackOrder ?? []).filter((id) => videoTrackIds.includes(id));
  const topOrder = [...requested, ...defaultTopOrder.filter((id) => !requested.includes(id))];
  const visibleTop = topOrder.filter((id) => !ts[id]?.hidden);
  const baseTrack = visibleTop[visibleTop.length - 1] ?? null;
  const v1 = baseTrack ? onTrack(baseTrack).filter((c) => mediaById.get(c.mediaId)?.kind !== 'audio') : [];
  const v2 = visibleTop.slice(0, -1).reverse().flatMap((id) =>
    onTrack(id).filter((c) => mediaById.get(c.mediaId)?.kind !== 'audio'),
  );
  for (const trackId of videoTrackIds) {
    const list = onTrack(trackId);
    for (let i = 1; i < list.length; i++) {
      const prevEnd = list[i - 1].start + list[i - 1].duration;
      if (list[i].start < prevEnd - 0.01) {
        throw new Error(`Clips "${list[i - 1].name}" and "${list[i].name}" overlap on track ${trackId.toUpperCase()} — move or trim one of them before exporting.`);
      }
    }
  }

  // Every timeline item contributes to the end. Audio/title-only projects
  // and tails use a black canvas; no edit is silently truncated to video.
  const T = Math.max(0, ...project.clips.map((c) => c.start + c.duration), ...project.subtitles.map((s) => s.end));
  if (T <= 0) throw new Error('Timeline is empty — add media or subtitles before exporting.');
  const outputFrames = Math.max(1, Math.round(T * fps));
  const outputEnd = Math.max(T, outputFrames / fps);

  // Each clip owns a bounded input window. Reusing a single decoded source
  // for trims at 0s, 100s and 200s makes FFmpeg's implicit split retain the
  // intervening full-resolution frames until every consumer catches up.
  // Real multiclip projects can exhaust RAM before producing one frame.
  // Seek before decoding instead; image inputs also stop at the clip end.
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const addInput = (clip: Clip, stream: 'v' | 'a'): number => {
    const key = `${clip.id}:${stream}`;
    const existing = inputIndex.get(key);
    if (existing !== undefined) return existing;
    const media = mediaById.get(clip.mediaId);
    if (!media) throw new Error(`Media for clip "${clip.name}" is missing — relink it before exporting.`);
    const idx = inputIndex.size;
    inputIndex.set(key, idx);
    inputs.push('-threads', '2');
    const overlay = stream === 'v' ? resolveOverlay(clip, media) : undefined;
    if (overlay) {
      // The desktop resolves this descriptor into a cached alpha video using
      // the same SVG renderer as preview, sampled on the clip's source clock.
      inputs.push('-t', seconds(clip.duration), '-i', 'cutwright-overlay:' + JSON.stringify({
        overlay, fonts: project.fonts, width: W, height: H, fps, duration: clip.duration,
        offset: clip.offset, speed: clip.speed ?? 1,
      }));
      return idx;
    }
    if (media.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', seconds(clip.duration));
    else inputs.push('-ss', seconds(clip.offset), '-t', seconds(clip.duration * (clip.speed ?? 1)));
    inputs.push('-i', media.src);
    return idx;
  };

  const filters: string[] = [];
  let uidN = 0;
  const next = (p: string) => `${p}${uidN++}`;
  // Quantize cumulative timeline boundaries, rather than rounding every
  // independent clip duration upward. Otherwise 16 fractional 29.97fps
  // clips can shift all later cuts by several frames.
  const frameAt = (seconds: number) => Math.round(seconds * fps);
  const framesBetween = (start: number, end: number) => Math.max(1, frameAt(end) - frameAt(start));
  // Canvas exports encode sRGB pixel values with the BT.709 YUV matrix.
  // FFmpeg's implicit RGB conversion defaults to BT.601 even at HD sizes;
  // select the matrix at the conversion itself, then carry matching metadata.
  const colorParams = 'setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709';
  const rgbToYuv = (alpha: boolean) => `scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=${alpha ? 'yuva444p' : 'yuv420p'},${colorParams}`;
  const entranceFor = (clip: Clip) => project.transitions.find((t) => t.entrance
    && (t.anchorClipId ? t.anchorClipId === clip.id : clip.trackId === baseTrack && Math.abs(t.at - clip.start) < .26));

  // Clip look/transform, one coordinate system with the CSS preview:
  // content is scaled about the frame center, translated by posX/posY
  // percent of the frame, rotated about the center — always re-fitted onto
  // the fixed WxH canvas (pad with transparency/black, never crop the canvas).
  const applyVisualFade = (label: string, clip: Clip, alpha: boolean): string => {
    const envelope = resolveVisualEnvelope(clip, fps);
    if (!envelope.fadeIn && !envelope.fadeOut) return label;
    const gain = envelopeExpression(envelope, 'T', 1), out = next('vfaded');
    const expr = alpha
      ? `lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*${gain}'`
      : `lum='16+(lum(X,Y)-16)*${gain}':cb='128+(cb(X,Y)-128)*${gain}':cr='128+(cr(X,Y)-128)*${gain}'`;
    filters.push(`[${label}]${alpha ? 'format=yuva444p,' : ''}geq=${expr}[${out}]`);
    return out;
  };
  const lookFx = (clip: Clip, overlay = false): string => {
    const parts: string[] = [];
    const b = clip.brightness ?? 1, c = clip.contrast ?? 1, s = clip.saturation ?? 1;
    // Match the preview's CSS filter order in RGB. FFmpeg eq brightness is
    // an additive luma offset, whereas CSS brightness multiplies channels.
    if (b !== 1) parts.push(`colorchannelmixer=rr=${f3(b)}:gg=${f3(b)}:bb=${f3(b)}`);
    if (c !== 1) parts.push(`lutrgb=r='(val-127.5)*${f3(c)}+127.5':g='(val-127.5)*${f3(c)}+127.5':b='(val-127.5)*${f3(c)}+127.5'`);
    if (s !== 1) {
      // CSS Filter Effects saturation matrix; split extreme values to keep
      // colorchannelmixer coefficients within its -2..2 supported range.
      const factors = s > 2 ? [Math.sqrt(s), Math.sqrt(s)] : [s];
      for (const factor of factors) {
        const a = 1 - factor;
        parts.push(`colorchannelmixer=rr=${f3(.213 * a + factor)}:rg=${f3(.715 * a)}:rb=${f3(.072 * a)}:gr=${f3(.213 * a)}:gg=${f3(.715 * a + factor)}:gb=${f3(.072 * a)}:br=${f3(.213 * a)}:bg=${f3(.715 * a)}:bb=${f3(.072 * a + factor)}`);
      }
    }
    if (!overlay && (clip.opacity ?? 1) < .999) {
      const opacity = f3(clip.opacity ?? 1);
      parts.push(`colorchannelmixer=rr=${opacity}:gg=${opacity}:bb=${opacity}`);
    }
    const sc = clip.scale ?? 1;
    const px = Math.round(((clip.posX ?? 0) / 100) * W);
    const py = Math.round(((clip.posY ?? 0) / 100) * H);
    if (sc !== 1 || px !== 0 || py !== 0 || clip.rotate) {
      const fill = overlay ? 'black@0' : 'black';
      // CSS applies rotate, then uniform scale, then translation. Expand
      // around the center before cropping so small clips can really move:
      // cropping a frame-sized padded image merely clamps x/y to zero.
      if (clip.rotate) {
        const radians = f3((clip.rotate * Math.PI) / 180);
        parts.push(`rotate=a=${radians}:ow=rotw(${radians}):oh=roth(${radians}):fillcolor=${fill}`);
      }
      if (sc !== 1) parts.push(`scale=iw*${f3(sc)}:ih*${f3(sc)}`);
      parts.push(`pad=max(iw\\,${W + 2 * Math.abs(px)}):max(ih\\,${H + 2 * Math.abs(py)}):(ow-iw)/2:(oh-ih)/2:color=${fill}`);
      parts.push(`crop=${W}:${H}:(iw-${W})/2${px >= 0 ? '-' : '+'}${Math.abs(px)}:(ih-${H})/2${py >= 0 ? '-' : '+'}${Math.abs(py)}`);
    }
    // Rotation and fractional scaling can change sample aspect ratio while
    // returning to the same canvas size. All timeline segments use square
    // pixels, including the black/transparent gaps joined by concat/xfade.
    parts.push('setsar=1');
    return ',' + parts.join(',');
  };

  const normVideo = (label: string, clip: Clip): string => {
    const idx = addInput(clip, 'v');
    const media = mediaById.get(clip.mediaId)!;
    const native = !!resolveOverlay(clip, media);
    const speed = native ? 1 : clip.speed ?? 1;
    const srcDur = clip.duration * speed;
    const frames = framesBetween(clip.start, clip.start + clip.duration);
    const out = next('seg');
    const raw = next('vraw');
    if (media.kind === 'image' && !native) {
      // The raw image input duration can round down while its global timeline
      // endpoints require one more frame. Supply that frame before trimming;
      // otherwise concat permanently shifts every later segment on the track.
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frames},setpts=PTS-STARTPTS${lookFx(clip)},format=rgba,settb=AVTB[${raw}]`);
    } else {
      // Choose source frames before retiming them. Dividing source PTS first
      // truncates coarse ticks across fps half-frame boundaries; changing the
      // sampling rate preserves source-clock precision and exact frame ties.
      const sample = speed !== 1 ? `fps=${fps / speed},settb=expr=1/${fps},setpts=N,fps=${fps}` : `fps=${fps}`;
      filters.push(`[${idx}:v]trim=duration=${seconds(srcDur)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,${sample},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frames},setpts=PTS-STARTPTS${lookFx(clip)},format=rgba,settb=AVTB[${raw}]`);
    }
    // Dropping RGBA's alpha with format=yuv420p would turn a quarter-opaque
    // white title fully white. Composite against the actual black canvas in
    // RGB first, then convert to YUV. This also handles alpha video/images.
    const canvas = next('canvas');
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f3((frames + 1) / fps)},format=rgba,trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=AVTB[${canvas}]`);
    filters.push(`[${canvas}][${raw}]overlay=x=0:y=0:eof_action=pass:shortest=1:format=rgb,${rgbToYuv(false)},settb=AVTB[${out}]`);
    void label;
    return applyVisualFade(applyClipEntrance(out, clip, false), clip, false);
  };

  /**
   * Progressive entrance effect matching the preview ramp (blur 14px->0 and
   * opacity 0->1 across the window): the window is split out, a blurred copy
   * is cross-blended into the sharp copy with an hblur xfade (progressive
   * deblur, no abrupt cutoff), then faded in and concatenated back.
   */
  const applyEntranceFx = (label: string, startAt: number, tdIn: number, streamDur: number, alpha: boolean): string => {
    const td = Math.min(tdIn, streamDur - startAt);
    if (td <= 0.05) return label;
    const src = next('esrc');
    const nParts = (startAt > 0.01 ? 1 : 0) + 1 + (streamDur - (startAt + td) > 0.01 ? 1 : 0);
    filters.push(`[${label}]split=${nParts}${Array.from({ length: nParts }, (_, i) => `[${src}${i}]`).join('')}`);
    const parts: string[] = [];
    let pi = 0;
    if (startAt > 0.01) {
      const p = next('epre');
      filters.push(`[${src}${pi++}]trim=0:${f3(startAt)},setpts=PTS-STARTPTS[${p}]`);
      parts.push(p);
    }
    const winIn = `${src}${pi++}`;
    const win = next('ewin');
    filters.push(`[${winIn}]trim=${f3(startAt)}:${f3(startAt + td)},setpts=PTS-STARTPTS[${win}]`);
    let winOut = win;
    if (!alpha) {
      // Linear progressive deblur: a blurred copy fades out (alpha) over a
      // sharp copy, so sharpness returns evenly across the whole window —
      // no plateau and no abrupt cutoff at the end.
      const wb = next('ewb'); const ws = next('ews'); const wblur = next('ewblur'); const wmix = next('ewmix');
      filters.push(`[${win}]format=yuva420p,split[${wb}][${ws}]`);
      filters.push(`[${wb}]gblur=sigma=16:planes=7,fade=t=out:st=0:d=${f3(td)}:alpha=1[${wblur}]`);
      filters.push(`[${ws}][${wblur}]overlay=x=0:y=0,format=yuv420p[${wmix}]`);
      winOut = wmix;
    } else {
      const wb = next('eab'); const ws = next('eas'); const blurred = next('eablur'); const mixed = next('eamix');
      filters.push(`[${win}]format=yuva444p,split[${wb}][${ws}]`);
      filters.push(`[${wb}]gblur=sigma=14:planes=15[${blurred}]`);
      filters.push(`[${blurred}][${ws}]blend=all_expr='A*(1-min(1,T/${f3(td)}))+B*min(1,T/${f3(td)})'[${mixed}]`);
      winOut = mixed;
    }
    const wf = next('ewf');
    filters.push(`[${winOut}]fade=t=in:st=0:d=${f3(td)}${alpha ? ':alpha=1' : ''},setpts=PTS-STARTPTS[${wf}]`);
    parts.push(wf);
    if (streamDur - (startAt + td) > 0.01) {
      const p = next('epost');
      filters.push(`[${src}${pi++}]trim=start=${f3(startAt + td)},setpts=PTS-STARTPTS[${p}]`);
      parts.push(p);
    }
    if (parts.length === 1) return parts[0];
    const out = next('ejoin');
    filters.push(`${parts.map((p) => `[${p}]`).join('')}concat=n=${parts.length}:v=1:a=0[${out}]`);
    return out;
  };

  const applyClipEntrance = (label: string, clip: Clip, alpha: boolean): string => {
    const applied = entranceFor(clip);
    const def = applied ? defById.get(applied.defId) : undefined;
    if (!applied || !def || def.id === 'cut') return label;
    const duration = Math.min(applied.duration, clip.duration);
    if (duration <= .001) return label;
    if (def.xfade === 'gaussian') {
      const focused = focusFilter(label, 0, duration), out = next('focusenter');
      filters.push(`[${focused}]fade=t=in:st=0:d=${f3(duration)}${alpha ? ':alpha=1' : ''}[${out}]`); return out;
    }
    if (def.preview === 'blur') return applyEntranceFx(label, 0, duration, clip.duration, alpha);
    const blank = next('enterblank'); const incoming = next('enterin'); const out = next('entered');
    const fmt = alpha ? 'yuva444p' : 'yuv444p';
    filters.push(`color=c=${def.xfade === 'fadewhite' ? 'white' : alpha ? 'black@0' : 'black'}:s=${W}x${H}:r=${fps}:d=${f3(duration + 1 / fps)},format=${fmt},trim=end_frame=${Math.max(1, frameAt(duration))},settb=AVTB[${blank}]`);
    filters.push(`[${label}]format=${fmt},settb=AVTB[${incoming}]`);
    const effect = def.xfade === 'fadewhite' || def.xfade === 'fadeblack' ? 'fade' : def.xfade;
    filters.push(`[${blank}][${incoming}]xfade=transition=${effect}:duration=${f3(duration)}:offset=0,format=${fmt},fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${framesBetween(clip.start, clip.start + clip.duration)},setpts=PTS-STARTPTS,format=${alpha ? 'yuva420p' : 'yuv420p'},settb=AVTB[${out}]`);
    return out;
  };

  /** Native Gaussian accepts per-frame sigma commands. Sending just before
   * each output tick avoids rounding a command onto the following frame. */
  const focusFilter = (input: string, offset: number, length: number) => {
    const name = next('focus'), output = next('focused');
    const commands: string[] = [];
    for (let frame = Math.max(0, Math.ceil(offset * fps)); frame <= Math.ceil((offset + length) * fps); frame++) {
      const p = (frame / fps - offset) / length, sigma = defocusSigma(p, W, H).toFixed(6);
      commands.push(`${Math.max(0, (frame - .25) / fps).toFixed(6)} gblur@${name} sigma ${sigma}, gblur@${name} sigmaV ${sigma}`);
    }
    filters.push(`[${input}]sendcmd=c='${commands.join(';')}',gblur@${name}=sigma=0:sigmaV=0:steps=3[${output}]`);
    return output;
  };

  // ---- V1 base: segments incl. black gaps, joined by concat or xfade ----
  interface Seg { label: string; dur: number; endClip?: Clip }
  const joinSegments = (parts: Seg[], alpha: boolean): { label: string; duration: number } => {
    let label = parts[0].label;
    let duration = parts[0].dur;
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i];
      const previous = parts[i - 1].endClip;
      const incoming = seg.endClip;
      const applied = previous && incoming ? project.transitions.find((t) => !t.entrance
        && (t.anchorClipId ? t.anchorClipId === incoming.id : !alpha && Math.abs(t.at - incoming.start) < .26)) : undefined;
      const def = applied ? defById.get(applied.defId) : undefined;
      const out = next('join');
      const td = applied && previous && incoming ? Math.min(applied.duration, previous.duration / 2, incoming.duration / 2) : 0;
      if (def && def.id !== 'cut' && td > .001) {
        const a = next('aext'); const b = next('bext');
        const fmt = alpha ? 'yuva444p' : 'yuv444p';
        filters.push(`[${label}]format=${fmt},tpad=stop_mode=clone:stop_duration=${f3(td / 2)},settb=AVTB[${a}]`);
        filters.push(`[${seg.label}]format=${fmt},tpad=start_mode=clone:start_duration=${f3(td / 2)},settb=AVTB[${b}]`);
        const blend = def.xfade === 'gaussian' ? next('focusblend') : out;
        filters.push(`[${a}][${b}]xfade=transition=${def.xfade === 'gaussian' ? 'fade' : def.xfade}:duration=${f3(td)}:offset=${f3(duration - td / 2)},format=${fmt},fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frameAt(duration + seg.dur)},setpts=PTS-STARTPTS,format=${alpha ? 'yuva420p' : 'yuv420p'},settb=AVTB[${blend}]`);
        if (def.xfade === 'gaussian') { const focused = focusFilter(blend, Number((duration - td / 2).toFixed(3)), Number(td.toFixed(3))); filters.push(`[${focused}]null[${out}]`); }
      } else filters.push(`[${label}][${seg.label}]concat=n=2:v=1:a=0[${out}]`);
      label = out;
      duration += seg.dur;
    }
    // concat uses a microsecond clock. At NTSC rates its rounded boundary
    // can lie 1us before the matching base frame, causing overlay framesync
    // to hold the preceding image. Restore exact integer project ticks only
    // after joining; xfade retains its common AVTB clock inside the join.
    const clock = next('trackclock');
    filters.push(`[${label}]settb=expr=1/${fps},setpts=N[${clock}]`);
    return { label: clock, duration };
  };
  const segs: Seg[] = [];
  let cursor = 0;
  for (const clip of v1) {
    if (frameAt(clip.start) > frameAt(cursor)) {
      const gapDur = clip.start - cursor;
      const frames = framesBetween(cursor, clip.start);
      const g = next('gap');
      filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f3(gapDur + 1 / fps)},trim=end_frame=${frames},format=yuv420p,settb=AVTB[${g}]`);
      segs.push({ label: g, dur: frames / fps });
      cursor = clip.start;
    }
    const label = normVideo('v', clip);
    segs.push({ label, dur: framesBetween(clip.start, clip.start + clip.duration) / fps, endClip: clip });
    cursor = Math.max(cursor, clip.start + clip.duration);
  }
  if (frameAt(cursor) < frameAt(T)) {
    const g = next('gap');
    const frames = framesBetween(cursor, T);
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f3(T - cursor + 1 / fps)},trim=end_frame=${frames},format=yuv420p,settb=AVTB[${g}]`);
    segs.push({ label: g, dur: frames / fps });
  }
  if (segs.length === 0) {
    // Base track hidden/empty: visible higher layers composite over black.
    const g = next('gap');
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f3(T + 1 / fps)},trim=end_frame=${Math.max(1, frameAt(T))},format=yuv420p,settb=AVTB[${g}]`);
    segs.push({ label: g, dur: T });
  }

  const joinedBase = joinSegments(segs, false);
  let base = joinedBase.label;
  const acc = joinedBase.duration;
  if (Math.abs(acc - T) > 0.05) warnings.push(`Composed duration ${acc.toFixed(2)}s differs from timeline ${T.toFixed(2)}s.`);

  // Composite tracks, rather than every individual clip. Passing 226 seconds
  // through 45 full-frame overlay filters also processes 44 inactive clips
  // on every frame. Transparent gaps + concat reduce that to one compositor
  // per visible video track and retain the exact top-to-bottom order.
  for (const trackId of visibleTop.slice(0, -1).reverse()) {
    const trackClips = v2.filter((clip) => clip.trackId === trackId);
    if (!trackClips.length) continue;
    const trackParts: Seg[] = [];
    let trackCursor = 0;
    const transparentGap = (start: number, end: number) => {
      const gap = next('clear');
      filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${f3(end - start + 1 / fps)},format=yuva420p,trim=end_frame=${framesBetween(start, end)},setpts=PTS-STARTPTS,settb=AVTB[${gap}]`);
      trackParts.push({ label: gap, dur: framesBetween(start, end) / fps });
    };
    for (const clip of trackClips) {
    if (frameAt(clip.start) > frameAt(trackCursor)) transparentGap(trackCursor, clip.start);
    const idx = addInput(clip, 'v');
    const media = mediaById.get(clip.mediaId)!;
    const native = !!resolveOverlay(clip, media);
    const speed = native ? 1 : clip.speed ?? 1;
    const ov = next('ov');
    const srcDur = clip.duration * speed;
    const frames = framesBetween(clip.start, clip.start + clip.duration);
    if (media.kind === 'image' && !native) {
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=rgba${lookFx(clip, true)},settb=AVTB[${ov}raw]`);
    } else {
      const sample = speed !== 1 ? `fps=${fps / speed},settb=expr=1/${fps},setpts=N,fps=${fps}` : `fps=${fps}`;
      filters.push(`[${idx}:v]trim=duration=${seconds(srcDur)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,${sample},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=rgba${lookFx(clip, true)},settb=AVTB[${ov}raw]`);
    }
    const opacity = clip.opacity ?? 1;
    if (opacity < 0.999) filters.push(`[${ov}raw]colorchannelmixer=aa=${f3(opacity)}[${ov}op]`);
    let ovLabel = opacity < 0.999 ? `${ov}op` : `${ov}raw`;
    // Finish every RGB operation before selecting the YUV matrix. An opacity
    // mixer after this point would force an implicit RGB/YUV round trip.
    const ovColor = next('ovcolor');
    filters.push(`[${ovLabel}]${rgbToYuv(true)}[${ovColor}]`);
    ovLabel = ovColor;
    // Entrance anchored to an overlay-track clip: progressive fade-in over
    // the base (blur is applied on the base-track path; overlay alpha fade
    // is the faithful equivalent over already-composited content).
    ovLabel = applyClipEntrance(ovLabel, clip, true);
    ovLabel = applyVisualFade(ovLabel, clip, true);
    const ready = next('ovready');
    filters.push(`[${ovLabel}]format=yuva420p[${ready}]`);
    trackParts.push({ label: ready, dur: frames / fps, endClip: clip });
    trackCursor = clip.start + clip.duration;
    }
    if (frameAt(trackCursor) < frameAt(T)) transparentGap(trackCursor, T);
    const track = joinSegments(trackParts, true).label;
    const out = next('comp');
    // Position lives inside the clip's own canvas (lookFx), exactly like the
    // preview's CSS transform — the overlay itself always lands at 0,0.
    filters.push(`[${base}][${track}]overlay=x=0:y=0:eof_action=pass[${out}]`);
    base = out;
  }

  // ---- audio: every audible clip, delayed + gained + faded, then mixed ----
  const audioLabels: string[] = [];
  const addAudio = (clip: Clip) => {
    const media = mediaById.get(clip.mediaId);
    if (!media || media.kind === 'image') return;
    if (media.kind === 'video' && media.hasAudio === false) return; // silent video: no [n:a] stream exists
    if (clip.mutedAudio) return; // embedded audio is carried by a linked audio clip (Movavi) — never double it
    if (ts[clip.trackId]?.muted) return;
    const idx = addInput(clip, 'a');
    const speed = clip.speed ?? 1;
    const srcDur = clip.duration * speed;
    const gain = (clip.volume ?? 1) * (ts[clip.trackId]?.volume ?? 1);
    const label = next('aud');
    let chain = `[${idx}:a]atrim=duration=${seconds(srcDur)},asetpts=PTS-STARTPTS`;
    if (speed !== 1) {
      // atempo accepts 0.5..100 per instance in modern FFmpeg, but chaining
      // keeps every factor inside 0.5..2 for maximum compatibility.
      let rest = speed;
      while (rest > 2) { chain += ',atempo=2.000'; rest /= 2; }
      while (rest < 0.5) { chain += ',atempo=0.500'; rest *= 2; }
      chain += `,atempo=${f3(rest)}`;
    }
    chain += `,volume=${f3(gain)}`;
    // Fade lengths clamp to duration/2 — the same rule the preview envelope
    // uses (src/lib/audioEnv.ts), so both ramps start and end together.
    if (clip.audioEnvelope || clip.fadeInCurve || clip.fadeOutCurve) {
      const envelope = resolveAudioEnvelope(clip);
      // t is the post-tempo clip clock. A split crops the inherited profile
      // rather than restarting its ramps; val(ch), c=same keeps every input
      // channel independent without an unintended stereo/mono downmix.
      chain += `,aeval=exprs='val(ch)*${envelopeExpression(envelope, 't')}':c=same`;
    } else {
      if (clip.fadeIn) chain += `,afade=t=in:st=0:d=${f3(Math.min(clip.fadeIn, clip.duration / 2))}`;
      if (clip.fadeOut) {
        const fo = Math.min(clip.fadeOut, clip.duration / 2);
        chain += `,afade=t=out:st=${f3(Math.max(0, clip.duration - fo))}:d=${f3(fo)}`;
      }
    }
    // Fractional milliseconds are supported by adelay; integer rounding can
    // introduce a waveform phase jump after a split at a fractional frame.
    // adelay can emit its leading silence without timestamps before the first
    // source frame is requested. Give the entire delayed stream a sample clock
    // so amix cannot advance a later clip into an earlier timeline window.
    chain += `,adelay=${seconds(clip.start * 1000)}:all=1,asetpts=N/SR/TB[${label}]`;
    filters.push(chain);
    audioLabels.push(label);
  };
  project.clips
    .filter((c) => (c.trackId.startsWith('a') || c.trackId.startsWith('v')) && !ts[c.trackId]?.hidden)
    .slice()
    .sort((a, b) => a.start - b.start)
    .forEach(addAudio);

  let audioOut: string | null = null;
  if (audioLabels.length === 1) {
    audioOut = audioLabels[0];
  } else if (audioLabels.length > 1) {
    filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[amixed]`);
    audioOut = 'amixed';
  }
  if (audioOut) {
    // Every audio path obeys the composition contract: pad short, trim long,
    // exactly T — a lone clip can never outlast or under-run the video.
    filters.push(`[${audioOut}]apad,atrim=0:${seconds(T)},asetpts=PTS-STARTPTS[afinal]`);
    audioOut = 'afinal';
  }

  // ---- optional preset downscale (before subtitles so text scales too) ----
  const output = exportDimensions(project, opts.maxHeight);
  if (output.width !== W || output.height !== H) {
    filters.push(`[${base}]scale=${output.width}:${output.height}[vscaled]`);
    base = 'vscaled';
  }

  // ---- subtitles ----
  if (srtPath && project.subtitles.length > 0) {
    const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    // The shared ASS document carries explicit project coordinates, Arial
    // metrics, wrapping and simultaneous cues. libass scales that geometry
    // to a downscaled export instead of inventing an SRT-sized canvas.
    // libass converts PTS to integer milliseconds. AVTB's floating-point
    // conversion can round an exact cue boundary down a millisecond, so use
    // the project frame clock for inclusive starts and exclusive ends.
    // libass's YUV drawing path uses BT.601 color coefficients. Draw on RGB
    // so colored captions use the same sRGB values as Canvas, then encode709.
    filters.push(`[${base}]settb=expr=1/${fps},setpts=N,format=rgba,subtitles='${escaped}',${rgbToYuv(false)}[vsub]`);
    base = 'vsub';
  }
  const videoOut = next('vfinal');
  filters.push(`[${base}]trim=end_frame=${outputFrames},settb=expr=1/${fps},setpts=N,${colorParams}[${videoOut}]`);
  base = videoOut;

  const silentIdx = inputIndex.size;
  const allInputs = audioOut ? inputs : [...inputs, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  if (!audioOut) {
    filters.push(`[${silentIdx}:a]atrim=0:${seconds(T)},asetpts=PTS-STARTPTS[asilent]`);
    audioOut = 'asilent';
  }
  const args = ['-y', '-filter_complex_threads', '2', ...allInputs, '-filter_complex', filters.join(';'), '-map', `[${base}]`];
  args.push('-map', `[${audioOut}]`);
  // Keep the quantized video end separate from the raw audio/source end.
  // A millisecond-rounded -t can cross a half-frame boundary at NTSC rates
  // and discard a frame that the composition already produced. Video has
  // an explicit frame count; every audio path remains trimmed to the real T.
  // An output -frames:v limit would also stop audio muxing early when the
  // final video boundary rounds down. The final video trim above bounds its
  // frames without preventing the independently trimmed audio from finishing.
  args.push('-map_metadata', '-1', '-c:v', 'libx264', '-threads', '4', '-preset', opts.x264Preset ?? 'medium', '-crf', String(opts.crf ?? 18), '-r', String(fps), '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-c:a', 'aac', '-ar', '48000', '-t', seconds(outputEnd), '-movflags', '+faststart', outPath);
  return { args, duration: T, warnings };
}
