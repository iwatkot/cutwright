import type { Clip, MediaItem, NativeOverlay, Project, TitleOverlay, TrackSettings } from './types';

/**
 * Read-only Movavi .mepj conversion.
 *
 * A .mepj file is a plain ZIP containing meta.json + config.json (readable
 * JSON, config version 88 observed). This module converts the parsed
 * config.json into a CutWright project. It never touches the original
 * project or media: clips reference the original absolute paths, and
 * generated overlays retain editable text/geometry plus PNG fallback assets.
 *
 * Timing values in config.json are milliseconds. Volume is a percent
 * (100 = unity gain, so 300 -> 3.0x voice, 2 -> 0.02x music bed).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ms = (v: unknown): number => num(v) / 1000;

export interface MovaviArrowGeom { x1: number; y1: number; x2: number; y2: number; color: string; width: number; head: boolean }
export interface MovaviAsset {
  mediaId: string;
  fileName: string;
  kind: 'arrow' | 'title';
  overlay: NativeOverlay;
  arrow?: MovaviArrowGeom;
  title?: { lines: string[]; fontSizePx: number; fontFamily: string; fontWeight: number; color: string; x: number; y: number; blockWidth: number; lineHeight: number };
}

export interface MovaviReport {
  source: { clips: number; tracks: number; transitions: number; mediaFiles: number; durationSec: number };
  mapped: { clips: number; media: number; transitions: number; linkedAudioClips: number; generatedOverlays: number; nativeOverlays: number; preservedAnimationOffsets: number; clampedSourceOffsets: number };
  unsupported: { item: string; detail: string }[];
  warnings: string[];
}

export interface MovaviConversion { project: Project; assets: MovaviAsset[]; report: MovaviReport }

/** Index every full object (`@meta.object_id`) anywhere in the config tree. */
function indexObjects(root: unknown): Map<number, Obj> {
  const idx = new Map<number, Obj>();
  const walk = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    if (isObj(o) && isObj(o['@meta']) && typeof (o['@meta'] as Obj).object_id === 'number') {
      idx.set((o['@meta'] as Obj).object_id as number, o);
    }
    for (const v of Object.values(o as Obj)) walk(v);
  };
  walk(root);
  return idx;
}

function resolveRef(idx: Map<number, Obj>, v: unknown): Obj | null {
  if (!isObj(v)) return null;
  if (typeof v['@meta_reference'] === 'number') return idx.get(v['@meta_reference'] as number) ?? null;
  return v;
}

const oid = (o: Obj | null | undefined): number => (o && isObj(o['@meta']) ? num((o['@meta'] as Obj).object_id, -1) : -1);

/** Windows path -> file:/// URL (segments encoded, drive/UNC preserved). */
export function windowsPathToFileUrl(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const enc = (s: string) => s.split('/').map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  if (/^\/\//.test(norm)) return 'file:' + enc(norm); // UNC \\server\share
  return 'file:///' + enc(norm);
}

function parseHtmlText(html: string): { lines: string[]; fontSizePt: number; fontFamily: string; fontWeight: number; color: string; align: TitleOverlay['align'] } {
  const bodyFont = /font-size:\s*([\d.]+)pt/i.exec(html);
  const family = /font-family:\s*['"]?([^;'"<>]+)/i.exec(html);
  const weight = /font-weight:\s*(\d+)/i.exec(html);
  const align = /<p[^>]*align=["'](left|center|right)["']/i.exec(html);
  const colorM = /color:\s*(#[0-9a-fA-F]{6})/i.exec(html);
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  const strip = (s: string) => s.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => { const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code); return point <= 0x10ffff ? String.fromCodePoint(point) : ''; });
  const lines = (paras.length ? paras : [html]).flatMap((p) => strip(p).split('\n'));
  return { lines, fontSizePt: bodyFont ? Number(bodyFont[1]) : 48, fontFamily: family?.[1].trim() || 'Arial', fontWeight: weight ? Number(weight[1]) : 400, color: colorM ? colorM[1].toUpperCase() : '#FFFFFF', align: (align?.[1].toLowerCase() as TitleOverlay['align']) || 'center' };
}

const TRACK_COLORS: Record<string, string> = {
  v1: '#2dd4bf', v2: '#60a5fa', v3: '#f472b6', v4: '#facc15', v5: '#fb7185', v6: '#a3e635',
  a1: '#38bdf8', a2: '#a3e635', a3: '#f59e0b', a4: '#94a3b8',
};

export function convertMovaviConfig(config: unknown, opts: { projectName?: string; assetSrcPrefix?: string } = {}): MovaviConversion {
  if (!isObj(config) || !isObj(config.data) || !isObj((config.data as Obj).content)) {
    throw new Error('Not a Movavi config.json (missing data.content)');
  }
  const content = (config.data as Obj).content as Obj;
  const timeline = content.timeline as Obj | undefined;
  if (!isObj(timeline) || !Array.isArray(timeline.clips) || !Array.isArray(timeline.tracks)) {
    throw new Error('Movavi config has no timeline clips/tracks');
  }
  const idx = indexObjects(config);
  const unsupported: { item: string; detail: string }[] = [];
  const warnings: string[] = [];
  const assetPrefix = opts.assetSrcPrefix ?? '__movavi_assets__';

  const video = isObj(timeline.video) ? timeline.video : {};
  const width = num(video.width, 1920);
  const height = num(video.height, 1080);
  const fps = num(video.frameRateN, 30000) / Math.max(1, num(video.frameRateD, 1001));

  // ---- tracks: Movavi type 1/2/16 are visual (16 = generated overlays),
  // 4/8 are audio (4 = linked to video). Ids assigned in file order. ----
  interface TrackMap { id: string; kind: 'video' | 'audio'; movaviType: number; linked: boolean }
  const trackByOid = new Map<number, TrackMap>();
  let vn = 0; let an = 0;
  const trackSettings: Record<string, TrackSettings> = {};
  for (const t of timeline.tracks as Obj[]) {
    const type = num(t.type, 1);
    const kind: 'video' | 'audio' = type === 4 || type === 8 ? 'audio' : 'video';
    const id = kind === 'video' ? `v${++vn}` : `a${++an}`;
    trackByOid.set(oid(t), { id, kind, movaviType: type, linked: !!t.linked });
    trackSettings[id] = { ...(t.hidden ? { hidden: true } : {}), ...(t.muted ? { muted: true } : {}) };
  }
  const videoIds = [...trackByOid.values()].filter((t) => t.kind === 'video').map((t) => t.id);
  const audioIds = [...trackByOid.values()].filter((t) => t.kind === 'audio').map((t) => t.id);
  // Stacking: later Movavi tracks sit above earlier ones; main track (v1) is base.
  const trackOrder = [...videoIds.slice().reverse(), ...audioIds.slice().reverse()];
  let extraOverlayTracks = 0;

  // ---- media (dedupe by resolved Media::File object) ----
  const mediaByFileOid = new Map<number, MediaItem>();
  const media: MediaItem[] = [];
  const assets: MovaviAsset[] = [];
  const mediaFor = (clip: Obj, timing: Obj): MediaItem | null => {
    const file = resolveRef(idx, clip.file);
    if (!file || typeof file.path !== 'string') return null;
    const foid = oid(file);
    const existing = mediaByFileOid.get(foid);
    if (existing) return existing;
    const p = file.path as string;
    const vTracks = Array.isArray(file.videoTracks) ? (file.videoTracks as Obj[]) : [];
    const aTracks = Array.isArray(file.audioTracks) ? (file.audioTracks as Obj[]) : [];
    const isImageFile = /\.(png|jpe?g|gif|bmp)$/i.test(p) || vTracks.some((v) => v.isImage === true);
    const usedAsVideo = (timeline.clips as Obj[]).some((w) => {
      const c = isObj(w.clip) ? w.clip : null;
      return !!c && num(c.type) === 1 && oid(resolveRef(idx, c.file)) === foid;
    });
    const kind: MediaItem['kind'] = isImageFile ? 'image' : usedAsVideo || (vTracks.length > 0 && aTracks.length > 0 && num(clip.type) === 1) ? 'video' : vTracks.length > 0 && aTracks.length === 0 && !isImageFile ? 'video' : 'audio';
    const v0 = vTracks[0] && isObj(vTracks[0]['Media::Video']) ? (vTracks[0]['Media::Video'] as Obj) : null;
    const item: MediaItem = {
      id: `movavi-media-${foid}`,
      name: p.split(/[\\/]/).pop() ?? p,
      kind,
      src: windowsPathToFileUrl(p),
      duration: ms(file.length),
      color: '#60a5fa',
      ...(v0 ? { width: num(v0.width) || undefined, height: num(v0.height) || undefined } : {}),
      ...(kind === 'video' ? { hasAudio: aTracks.length > 0 } : {}),
    };
    void timing;
    mediaByFileOid.set(foid, item);
    media.push(item);
    return item;
  };

  // ---- clips ----
  const clips: Clip[] = [];
  const clipIdByOid = new Map<number, string>();
  let clampedOffsets = 0;
  let preservedAnimationOffsets = 0;
  let generatedOverlays = 0;
  const wrappers = timeline.clips as Obj[];
  for (const w of wrappers) {
    const clip = isObj(w.clip) ? w.clip : null;
    const timing = isObj(w.timing) ? w.timing : null;
    if (!clip || !timing) continue;
    const trackRef = isObj(timing.track) ? num(timing.track['@meta_reference'], -1) : -1;
    const track = trackByOid.get(trackRef);
    if (!track) { warnings.push(`Clip "${String(clip.name)}" references unknown track ${trackRef}; skipped`); continue; }
    const id = `movavi-clip-${oid(clip)}`;
    clipIdByOid.set(oid(clip), id);
    const start = ms(timing.timestamp);
    const duration = Math.max(0.04, ms(timing.duration));
    const sourceOffset = ms(timing.sourcePosition);
    const offset = Math.max(0, sourceOffset);
    const base: Clip = {
      id,
      mediaId: '',
      trackId: track.id,
      name: String(clip.name ?? 'clip'),
      start, duration, offset,
      color: TRACK_COLORS[track.id] ?? '#60a5fa',
      volume: num(clip.volume, 100) / 100,
      speed: num(timing.speed, 1) || 1,
      ...(num(timing.fadeInDuration) ? { fadeIn: ms(timing.fadeInDuration) } : {}),
      ...(num(timing.fadeOutDuration) ? { fadeOut: ms(timing.fadeOutDuration) } : {}),
    };
    const file = resolveRef(idx, clip.file);
    if (file && typeof file.path === 'string') {
      if (sourceOffset < 0) clampedOffsets++;
      const m = mediaFor(clip, timing);
      if (!m) continue;
      base.mediaId = m.id;
      clips.push(base);
      continue;
    }
    // Preserve generated items as native editable content. Raster assets are
    // thumbnails/fallbacks only; preview/export render the structured model.
    const overlay = isObj(clip.overlay) ? clip.overlay : null;
    if (!overlay || !Array.isArray(overlay.items)) {
      warnings.push(`Clip "${base.name}" has neither file nor overlay; skipped`);
      continue;
    }
    generatedOverlays++;
    if (sourceOffset < 0) preservedAnimationOffsets++;
    const items = overlay.items as Obj[];
    const titleLayout = (item: Obj): TitleOverlay => {
      const tr = isObj(item.transform) ? item.transform : {};
      const parsed = parseHtmlText(String(item.text ?? ''));
      const scale = Math.hypot(num(tr.m11, 1), num(tr.m12)) || 1;
      const fontSize = parsed.fontSizePt * (96 / 72) * scale;
      return { kind: 'title', text: parsed.lines.join('\n'), fontFamily: parsed.fontFamily, fontWeight: parsed.fontWeight, fontSize,
        color: parsed.color, x: num(tr.m31), y: num(tr.m32), blockWidth: num(item.textWidth) * scale,
        lineHeight: fontSize * 1.25, align: parsed.align, animationOffset: sourceOffset,
        animationDuration: Math.max(0.04, duration * (base.speed ?? 1) + sourceOffset) };
    };
    const rolling = String(overlay.scriptId) === 'Credits';
    const textLayouts = items.filter((item) => num(item.type) !== 16).map(titleLayout);
    const rollTop = Math.min(0, ...textLayouts.map((t) => t.y));
    const rollBottom = Math.max(0, ...textLayouts.map((t) => t.y + t.text.split('\n').length * t.lineHeight));
    const roll = { fromY: height - rollTop, toY: -rollBottom, duration: Math.max(0.04, duration * (base.speed ?? 1)) };
    items.forEach((item, itemIdx) => {
      const c: Clip = { ...base, id: itemIdx ? `${id}-item${itemIdx}` : id };
      c.offset = 0; // signed preset phase belongs to overlay.animationOffset
      const envelope = isObj(item.envelope) ? item.envelope : {};
      const defaultValue = isObj(envelope.defaultValue) ? envelope.defaultValue : {};
      if (num(defaultValue.opacity, 100) !== 100) c.opacity = Math.max(0, Math.min(1, num(defaultValue.opacity, 100) / 100));
      if (itemIdx > 0) {
        extraOverlayTracks++;
        const nid = `v${videoIds.length + extraOverlayTracks}`;
        c.trackId = nid;
        if (!trackSettings[nid]) trackSettings[nid] = {};
        if (!trackOrder.includes(nid)) trackOrder.unshift(nid);
      }
      const mediaId = `movavi-gen-${oid(clip)}${itemIdx ? `-${itemIdx}` : ''}`;
      const fileName = `${mediaId}.png`;
      const tr = isObj(item.transform) ? item.transform : {};
      const m11 = num(tr.m11, 1); const m21 = num(tr.m21, 0); const m31 = num(tr.m31, 0);
      const m12 = num(tr.m12, 0); const m22 = num(tr.m22, 1); const m32 = num(tr.m32, 0);
      const applyT = (x: number, y: number) => ({ x: m11 * x + m21 * y + m31, y: m12 * x + m22 * y + m32 });
      if (num(item.type) === 16) {
        // Arrow: geometry lives in the item's text JSON (positions, color, width).
        let g: Obj = {};
        try { g = JSON.parse(String(item.text ?? '{}')) as Obj; } catch { warnings.push(`Arrow on "${base.name}" has unparseable geometry JSON`); }
        const b = applyT(num(g['begin-pos-x']), num(g['begin-pos-y']));
        const e = applyT(num(g['end-pos-x']), num(g['end-pos-y']));
        const rawColor = String(g.color ?? '#FF0000');
        // Qt stores #AARRGGBB; SVG/native overlays use #RRGGBB[AA].
        const color = /^#[0-9a-fA-F]{8}$/.test(rawColor) ? '#' + rawColor.slice(3) + (rawColor.slice(1, 3).toLowerCase() === 'ff' ? '' : rawColor.slice(1, 3)) : rawColor;
        const arrow = { x1: b.x, y1: b.y, x2: e.x, y2: e.y, color, width: Math.max(2, num(g.width, 20) * Math.hypot(m11, m12)), head: num(g['end-cap'], 0) !== 0 };
        const native: NativeOverlay = { kind: 'arrow', ...arrow, animationOffset: sourceOffset,
          animationDuration: ms(timing.sourceDuration) || Math.max(0.04, duration * (base.speed ?? 1) + sourceOffset),
          drawDuration: 0.5 / Math.max(0.01, num(overlay.scriptSpeed, 1)) };
        c.overlay = native;
        assets.push({
          mediaId, fileName, kind: 'arrow',
          arrow, overlay: native,
        });
        c.generatedOverlay = { kind: 'arrow', preset: String(overlay.description ?? 'Arrow') };
      } else {
        const native = titleLayout(item);
        if (rolling) native.scroll = { ...roll };
        else if (/fade/i.test(String(item.scriptRole))) { native.fadeIn = 0.5; native.fadeOut = 0.5; }
        c.overlay = native;
        assets.push({ mediaId, fileName, kind: 'title', overlay: native, title: {
          lines: native.text.split('\n'), fontSizePx: native.fontSize, fontFamily: native.fontFamily, fontWeight: native.fontWeight,
          color: native.color, x: native.x, y: native.y, blockWidth: native.blockWidth, lineHeight: native.lineHeight,
        } });
        c.generatedOverlay = { kind: 'title', text: native.text, preset: String(overlay.description ?? 'Title') };
      }
      media.push({ id: mediaId, name: c.overlay?.kind === 'title' ? c.overlay.text.split('\n')[0] || 'Title' : `${base.name} arrow`, kind: 'image', src: `${assetPrefix}/${fileName}`, duration, color: '#facc15', overlay: structuredClone(c.overlay) });
      c.mediaId = mediaId;
      clips.push(c);
    });
  }

  // Linked voice: an audio clip on a linked audio track that mirrors a video
  // clip (same file, same start/duration/offset) carries that video's audio.
  // The video clip's own audio is muted so the voice is never doubled.
  let linkedAudioClips = 0;
  for (const a of clips.filter((c) => c.trackId.startsWith('a'))) {
    const trackMovavi = [...trackByOid.values()].find((t) => t.id === a.trackId);
    if (!trackMovavi?.linked) continue;
    const match = clips.find((v) => v.trackId.startsWith('v') && v.mediaId === a.mediaId
      && Math.abs(v.start - a.start) < 0.01 && Math.abs(v.duration - a.duration) < 0.01 && Math.abs(v.offset - a.offset) < 0.01);
    if (match) { match.mutedAudio = true; match.linkGroup = `linked-${match.id}`; a.linkGroup = match.linkGroup; linkedAudioClips++; }
  }

  // Image media get a usable duration for trim bounds (their file "length"
  // in Movavi is meaningless); the clip duration rules.
  for (const m of media) {
    if (m.kind === 'image' && mediaByFileOid.get(Number(m.id.replace('movavi-media-', ''))) === m) {
      m.duration = Math.max(m.duration, ...clips.filter((c) => c.mediaId === m.id).map((c) => c.duration), 1);
    }
  }

  // ---- transitions (Transition::Blur / BlurInOut) ----
  const transitions: Project['transitions'] = [];
  const rawTransitions = Array.isArray(timeline.transitions) ? (timeline.transitions as Obj[]) : [];
  rawTransitions.forEach((t, i) => {
    const inner = isObj(t.transition) ? t.transition : {};
    const tObj = isObj(inner['Transition::Object']) ? (inner['Transition::Object'] as Obj) : {};
    const className = isObj(inner['@meta']) ? String((inner['@meta'] as Obj).class_name ?? '') : '';
    const toRef = isObj(t.clipTo) ? num(t.clipTo['@meta_reference'], -1) : -1;
    const toId = clipIdByOid.get(toRef);
    if (!toId) { warnings.push(`Transition #${i + 1} references unknown clipTo ${toRef}; skipped`); return; }
    const entrance = !t.clipFrom;
    transitions.push({
      id: `movavi-transition-${oid(tObj) > 0 ? oid(tObj) : i}`,
      defId: 'blur-inout',
      at: clips.find((c) => c.id === toId)?.start ?? 0,
      duration: Math.max(0.1, ms(tObj.defaultDuration ?? 2000)),
      anchorClipId: toId,
      ...(entrance ? { entrance: true } : {}),
    });
    if (!/Blur/.test(className)) unsupported.push({ item: `Transition ${className}`, detail: 'Non-blur transition mapped to Blur In/Out' });
  });

  const durationSec = Math.max(0, ...clips.map((c) => c.start + c.duration));
  const project: Project = {
    version: 1,
    name: opts.projectName ?? 'Movavi import',
    width, height, fps,
    media, clips, transitions,
    subtitles: [],
    customTransitions: [],
    trackSettings,
    trackOrder,
  };

  unsupported.push(
    { item: 'Transition::Blur (BlurInOut)', detail: 'Mapped to FFmpeg xfade=hblur with a blur preview; Movavi blurType=2 kernel is approximated, not bit-identical. Entrance instances (clipFrom=null) render as blur+fade-in at the clip start.' },
    { item: 'CalloutAnimated motion curve', detail: 'Native arrows retain exact transformed endpoints, color, width and signed source phase. The proprietary draw curve is not serialized; a linear 0.5-second shaft/head draw is used, scaled by scriptSpeed. Its duration is editable. Preview and export share this reconstruction.' },
    { item: 'TitleStandard/Credits motion and typography', detail: 'Native editable text retains saved font family, font size, text, position and block width. Credits roll continuously as one group instead of pagination. The original proprietary scroll/fade easing and Qt line metrics are reconstructed with linear motion and 1.25-em line spacing; exact visual equivalence requires reference comparison. The requested font must be installed; PNG thumbnails are not the render source.' },
    { item: 'Volume percent', detail: 'Movavi volume is interpreted linearly (100% = 1.0x): linked voice at 300% becomes 3.0x, music at 2% becomes 0.02x. Linked audio clips carry the voice; the matching video clips are mutedAudio so nothing is doubled.' },
    { item: 'Overlay coordinate space', detail: 'Serialized overlay coordinates are treated as composition pixels at 1920x1080 with the item transform matrix applied.' },
  );

  return {
    project,
    assets,
    report: {
      source: {
        clips: wrappers.length,
        tracks: (timeline.tracks as Obj[]).length,
        transitions: rawTransitions.length,
        mediaFiles: mediaByFileOid.size,
        durationSec,
      },
      mapped: {
        clips: clips.length,
        media: media.length,
        transitions: transitions.length,
        linkedAudioClips,
        generatedOverlays,
        nativeOverlays: clips.filter((c) => c.overlay).length,
        preservedAnimationOffsets,
        clampedSourceOffsets: clampedOffsets,
      },
      unsupported,
      warnings,
    },
  };
}
