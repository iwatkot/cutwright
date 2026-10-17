import { t as uiText } from '../i18n/core';
import { transitionName } from '../i18n/presentation';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from '../lib/store';
import OverlayInspector from './OverlayInspector';
import { Field, NumberControl, RangeControl, InspectorSection } from './ui/Controls';
import { snapTimelineTime } from '../lib/canvasGeometry';
import TimelineMarkers from './TimelineMarkers';
import ContextMenu, { type ContextAction } from './ui/ContextMenu';
import './timeline-rc.css';
import type { Clip } from '../lib/types';
import { IconUnlink } from './icons';
import { fmtTime } from '../lib/srt';
import { useShortcutLabel } from '../lib/shortcutPreferences';
import { BUILTIN_TRANSITIONS } from '../lib/transitions';
import { toast } from './TopBar';
import { mediaUrl } from '../lib/mediaUrl';
import { overlaySvg, resolveOverlay } from '../lib/overlay';
import { overlayPreviewTime } from '../lib/overlayAssets';
import { IconButton, IconPlus, IconAudioPlus, IconClose, IconDelete, IconDots, IconEye, IconEyeOff, IconMuted, IconPlay, IconRedo, IconRipple, IconSnap, IconSplit, IconTrackHeight, IconUndo, IconVideoPlus, IconVolume, IconZoomIn, IconZoomOut } from './icons';

const LABEL_W = 118;

function thumbnailUrl(source: string): string {
  // A saved desktop path grants no browser file access, even when a legacy
  // thumbnail still points at an otherwise relinked media entry.
  if (!window.cutwright && /^(?:file:|cutwright-media:|[a-z]:[\\/]|\\\\)/i.test(source)) return '';
  return mediaUrl(source);
}

export default function Timeline() {
  const addMarkerShortcut = useShortcutLabel('addMarker');
  const project = useStore((s) => s.project);
  const playhead = useStore((s) => s.playhead);
  const pxPerSec = useStore((s) => s.pxPerSec);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setZoom = useStore((s) => s.setZoom);
  const selectedTransitionId = useStore((s) => s.selectedTransitionId);
  const selectedClipId = useStore((s) => s.selectedClipId);
  const selectedSubId = useStore((s) => s.selectedSubId);

  const [snapAt, setSnapAt] = useState<number | null>(null);
  const selectClip = useStore((s) => s.selectClip);
  const selectSub = useStore((s) => s.selectSub);
  const total = useStore((s) => s.totalDuration());
  const scrollRef = useRef<HTMLDivElement>(null);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const [trackMenu, setTrackMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [context, setContext] = useState<{x:number;y:number;time:number;clipId?:string;markerId?:string;transitionId?:string}|null>(null);
  useEffect(() => {
    if (!trackMenu) return;
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.trackmenu button:not(:disabled)')?.focus());
    const close = () => setTrackMenu(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, [trackMenu]);

  const markerEnd = Math.max(0, ...(project.markers ?? []).map(m => m.time));
  const width = Math.max(900, Math.max(total, markerEnd) * pxPerSec + 120);
  const customTransitions = useStore((s) => s.project.customTransitions);
  const defs = useMemo(() => [...BUILTIN_TRANSITIONS, ...customTransitions], [customTransitions]);
  const thumbnails = useMemo(() => new Map(project.clips.map((clip) => {
    const media = project.media.find((item) => item.id === clip.mediaId);
    const overlay = resolveOverlay(clip, media);
    const source = overlay
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(overlaySvg(overlay, project.width, project.height, overlayPreviewTime(overlay, project)))}`
      : !media || media.offline ? '' : thumbnailUrl(media.thumb ?? '') || (media.kind === 'image' ? thumbnailUrl(media.src) : '');
    return [clip.id, source];
  })), [project]);

  const scrubAt = (clientX: number, bypass: boolean) => {
    const r = document.getElementById('tl-inner')?.getBoundingClientRect(); if (!r) return;
    const raw = Math.max(0, (clientX - r.left - LABEL_W) / pxPerSec), st = useStore.getState();
    const value = st.snapEnabled && !bypass ? snapTimelineTime(raw, (st.project.markers ?? []).map(m => m.time), 7 / pxPerSec) : raw;
    setSnapAt(value !== raw ? value : null); setPlayhead(value);
  };
  const seekFromEvent = (e: ReactMouseEvent) => {
    const inner = document.getElementById('tl-inner');
    if (!inner) return;
    const r = inner.getBoundingClientRect();
    scrubAt(e.clientX, e.altKey);
  };

  const startScrub = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // Give keyboard focus back to the editor so Space/C/Ctrl+Z act on the
    // timeline even right after typing in a caption or the project name.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
    seekFromEvent(e);
    const move = (ev: MouseEvent) => {
      const inner = document.getElementById('tl-inner');
      if (!inner) return;
      const r = inner.getBoundingClientRect();
      scrubAt(ev.clientX, ev.altKey);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setSnapAt(null); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const startClipDrag = (e: ReactMouseEvent, clipId: string, mode: 'move' | 'l' | 'r') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Changing inspector height under a held pointer changes which track is
    // under it. Keep the previous properties until the gesture completes.
    selectClip(clipId);
    const clip = useStore.getState().project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    let committed = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...clip };
    let curTrack = orig.trackId;
    const move = (ev: MouseEvent) => {
      if (!committed) {
        if (Math.abs(ev.clientX - startX) < 2 && Math.abs(ev.clientY - startY) < 2) return;
        useStore.getState().commit();
        committed = true;
      }
      // Cross-track placement: dragging onto another track of the same kind
      // (video→video, audio→audio) moves the clip there.
      if (mode === 'move') {
        const rows = document.querySelectorAll<HTMLElement>('.track[data-track]');
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          const id = row.dataset.track!;
          if (ev.clientY >= r.top && ev.clientY <= r.bottom && id !== curTrack
            && id[0] === curTrack[0]) {
            useStore.getState().updateClip(clipId, { trackId: id }, false);
            curTrack = id;
            orig.trackId = id;
            break;
          }
        }
      }
      const dt = (ev.clientX - startX) / pxPerSec;
      const st = useStore.getState();
      const points = [0, st.playhead, ...(st.project.markers ?? []).map(m => m.time), ...st.project.clips.filter(c => c.trackId === curTrack && c.id !== clipId && (!orig.linkGroup || c.linkGroup !== orig.linkGroup)).flatMap(c => [c.start, c.start+c.duration])];
      const snapTime = (value:number) => st.snapEnabled && !ev.altKey ? snapTimelineTime(value, points, 7 / pxPerSec) : value;
      setSnapAt(null);
      if (mode === 'move') {
        const raw = Math.max(0, orig.start + dt), left = snapTime(raw), right = snapTime(raw + orig.duration);
        let ns = raw;
        if (left !== raw && (right === raw + orig.duration || Math.abs(left-raw) <= Math.abs(right-raw-orig.duration))) { ns=left; setSnapAt(left); }
        else if (right !== raw+orig.duration && right >= orig.duration) { ns=right-orig.duration; setSnapAt(right); }
        st.trimClip(clipId, { start: ns });
      } else if (mode === 'l') {
        const speed = orig.speed ?? 1;
        const desired = snapTime(orig.start + dt);
        const delta = Math.min(orig.duration - .2, Math.max(-orig.start, -orig.offset / speed, desired - orig.start));
        const ns = orig.start + delta;
        if (ns === desired && desired !== orig.start + dt) setSnapAt(ns);
        st.trimClip(clipId, { start: ns, duration: orig.duration - delta, offset: orig.offset + delta * speed });
      } else {
        const media = st.project.media.find(m => m.id === orig.mediaId), speed = orig.speed ?? 1;
        const desired = snapTime(orig.start + orig.duration + dt);
        let dur = Math.max(.2, desired-orig.start);
        if (media && media.kind !== 'image' && media.duration > 0) dur=Math.min(dur,(media.duration-orig.offset)/speed);
        if (orig.start+dur === desired && desired !== orig.start+orig.duration+dt) setSnapAt(desired);
        st.trimClip(clipId,{duration:Math.max(.2,dur)});
      }
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setSnapAt(null); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const ticks = useMemo(() => {
    const step = pxPerSec >= 40 ? 1 : pxPerSec >= 18 ? 2 : 5;
    const out: number[] = [];
    for (let t = 0; t <= Math.max(total, markerEnd) + 10; t += step) out.push(t);
    return out;
  }, [total, markerEnd, pxPerSec]);

  const split = () => {
    const err = useStore.getState().splitAtPlayhead();
    toast(err ?? uiText("Split at {0}", { 0: fmtTime(useStore.getState().playhead) }));
  };

  const snapEnabled = useStore((s) => s.snapEnabled);
  const rippleEnabled = useStore((s) => s.rippleEnabled);
  const displayTracks = (() => {
    const ids = new Set<string>(['v1', 'a1', ...project.clips.map((c) => c.trackId), ...Object.keys(project.trackSettings ?? {})]);
    let videos = [...ids].filter((i) => i.startsWith('v')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    let audios = [...ids].filter((i) => i.startsWith('a')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const order = project.trackOrder ?? [];
    const byOrder = (list: string[]) => list.slice().sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    if (order.length) { videos = byOrder(videos); audios = byOrder(audios); }
    return { videos, audios };
  })();
  // Keep names and 28px controls legible; many-track projects scroll rather
  // than squeezing every track into an unreadable strip.
  const trackCount = displayTracks.videos.length + displayTracks.audios.length;
  const [rowH, setRowH] = useState(48);
  // Initial framing per project: if the stack overflows, show the base and
  // audio tracks (bottom of the stack) rather than empty top rows. Runs on
  // project/track-set changes only — never fights the user's own scrolling.
  const projectName = project.name;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(raf);
  }, [projectName, trackCount]);
  useEffect(() => {
    if (!selectedClipId) return;
    const raf = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      const row = scroller?.querySelector('.clip.sel')?.closest('.track');
      if (!scroller || !row) return;
      const viewport = scroller.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      if (bounds.top < viewport.top + 26) scroller.scrollTop += bounds.top - viewport.top - 26;
      else if (bounds.bottom > viewport.bottom - 10) scroller.scrollTop += bounds.bottom - viewport.bottom + 10;
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedClipId]);
  const moveTrack = (kind: string, dir: -1 | 1) => {
    const st = useStore.getState();
    const order = [...(kind.startsWith('v') ? displayTracks.videos : displayTracks.audios)];
    const i = order.indexOf(kind);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    st.setTrackOrder(kind.startsWith('v') ? [...order, ...displayTracks.audios] : [...displayTracks.videos, ...order]);
  };

  return (
    <div className="timeline">
      <div className="tltools">
        <strong>{uiText("Timeline")}</strong>
        <div className="toolgroup" role="group" aria-label={uiText("History")}>
          <IconButton label={uiText("Undo")} action="undo" disabled={!canUndo} onClick={() => useStore.getState().undo()}><IconUndo /></IconButton>
          <IconButton label={uiText("Redo")} action="redo" disabled={!canRedo} onClick={() => useStore.getState().redo()}><IconRedo /></IconButton>
        </div>
        <div className="toolgroup" role="group" aria-label={uiText("Clip editing")}>
          <IconButton label={uiText("Split")} action="split" disabled={!project.clips.some((c) => playhead > c.start + .1 && playhead < c.start + c.duration - .1)} onClick={split}><IconSplit /></IconButton>
          <IconButton label={uiText('Delete')} action="delete" disabled={!selectedClipId && !selectedSubId && !selectedTransitionId} onClick={() => { const s = useStore.getState(); if (s.selectedTransitionId) { const id = s.selectedTransitionId; s.selectTransition(null); s.removeTransition(id); } else if (s.rippleEnabled) s.deleteSelectedRipple(); else s.deleteSelected(); }}><IconDelete /></IconButton>
        </div>
        <div className="toolgroup" role="group" aria-label={uiText("Editing behavior")}>
          <IconButton label={uiText("Snapping")} aria-pressed={snapEnabled} onClick={() => useStore.getState().setSnap(!snapEnabled)}><IconSnap /></IconButton>
          <IconButton label={uiText("Ripple editing")} aria-pressed={rippleEnabled} onClick={() => useStore.getState().setRipple(!rippleEnabled)}><IconRipple /></IconButton>
        </div>
        <div className="toolgroup" role="group" aria-label={uiText("Add tracks")}>
          <IconButton label={uiText("Add video track")} onClick={() => useStore.getState().addTrack('video')}><IconVideoPlus /></IconButton>
          <IconButton label={uiText("Add audio track")} onClick={() => useStore.getState().addTrack('audio')}><IconAudioPlus /></IconButton>
        </div>
        <TimelineMarkers />
        <div className="spacer" />
        <span className="timeline-length" data-tooltip={uiText("Project duration")}>{fmtTime(total)}</span>
        <div className="toolgroup zoomtools" role="group" aria-label={uiText("Timeline view")}>
          <IconButton label={uiText("Track height: {0}px · change size", { 0: rowH })} onClick={() => setRowH(rowH < 56 ? 56 : rowH < 72 ? 72 : 40)}><IconTrackHeight /></IconButton>
          <IconButton label={uiText("Zoom out")} action="zoomOut" shortcut="−" disabled={pxPerSec <= 4} onClick={() => setZoom(pxPerSec / 1.25)}><IconZoomOut /></IconButton>
          <RangeControl label={uiText("Timeline zoom")} min={4} max={80} value={pxPerSec} onChange={setZoom} />
          <IconButton label={uiText("Zoom in")} action="zoomIn" shortcut="+" disabled={pxPerSec >= 80} onClick={() => setZoom(pxPerSec * 1.25)}><IconZoomIn /></IconButton>
        </div>
      </div>
      <div className="tlscroll" ref={scrollRef} tabIndex={0} aria-label={uiText("Timeline tracks")} onContextMenu={e=>{
        if((e.target as Element).closest('.tracklabel'))return;
        const r=document.getElementById('tl-inner')?.getBoundingClientRect();if(!r)return;
        e.preventDefault();e.stopPropagation();setTrackMenu(null);const target=e.target as Element;
        setContext({x:e.clientX,y:e.clientY,time:Math.min(86400,Math.max(0,(e.clientX-r.left-LABEL_W)/pxPerSec)),clipId:target.closest<HTMLElement>('[data-context-clip]')?.dataset.contextClip,markerId:target.closest<HTMLElement>('[data-context-marker]')?.dataset.contextMarker,transitionId:target.closest<HTMLElement>('[data-context-transition]')?.dataset.contextTransition});
      }} onKeyDown={e=>{
        if(e.key!=='ContextMenu'&&!(e.shiftKey&&e.key==='F10'))return;
        e.preventDefault();e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();
        setContext({x:r.left+Math.min(r.width-16,160),y:r.top+30,time:playhead});
      }}>
        <div className={`tlinner ${rowH < 44 ? 'compact' : ''}`} id="tl-inner" style={{ width: width + LABEL_W }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const inner = document.getElementById('tl-inner');
            const r = inner?.getBoundingClientRect();
            const dropTime = r ? Math.max(0, (e.clientX - r.left - LABEL_W) / pxPerSec) : useStore.getState().playhead;
            const mediaId = e.dataTransfer.getData('cutwright/media');
            const transId = e.dataTransfer.getData('cutwright/transition');
            if (mediaId) { useStore.getState().addClipFromMedia(mediaId); toast(uiText("Added to the end of the timeline")); }
            if (transId) {
              const row = (e.target as HTMLElement).closest<HTMLElement>('.track[data-track]')?.dataset.track;
              const target = row?.startsWith('v') ? row : 'v1';
              const clips = useStore.getState().project.clips.filter((c) => c.trackId === target);
              const anchor = clips.reduce<Clip | undefined>((best, c) => !best || Math.abs(c.start - dropTime) < Math.abs(best.start - dropTime) ? c : best, undefined);
              if (anchor) { useStore.getState().applyTransition(transId, anchor.start, undefined, anchor.id); toast(uiText("Transition applied on {0} at {1}", { 0: target.toUpperCase(), 1: fmtTime(anchor.start) })); }
              else toast(uiText("Drop a transition onto a video track containing clips."));
            }
          }}>
          <div className="ruler" style={{ marginLeft: LABEL_W }} onMouseDown={startScrub}>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * pxPerSec }}>{fmtTime(t)}</div>
            ))}
          </div>
          <div className="track text" onMouseDown={startScrub}>
            <div className="tracklabel">{uiText("TXT")}</div>
            {project.subtitles.map((s) => (
              <div key={s.id} role="button" tabIndex={0} onKeyDown={e => {if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();selectSub(s.id);setPlayhead(s.start);}}} className={`subblock ${s.id === selectedSubId ? 'sel' : ''}`}
                style={{ left: LABEL_W + s.start * pxPerSec, width: Math.max(26, (s.end - s.start) * pxPerSec) }}
                data-tooltip={`${fmtTime(s.start)} — ${s.text}`}
                onMouseDown={(e) => { e.stopPropagation(); if(e.button!==0)return;selectSub(s.id); setPlayhead(s.start); }}>
                {s.text}
              </div>
            ))}
          </div>
          {displayTracks.videos.map((id) => renderTrack(id))}
          {displayTracks.audios.map((id) => renderTrack(id))}
          {(project.markers ?? []).map(m => <button key={m.id} data-context-marker={m.id} className="timeline-marker" style={{ left: LABEL_W + m.time * pxPerSec, '--marker-color': m.color } as React.CSSProperties} aria-label={uiText("Marker {0} at {1}", { 0: m.label, 1: fmtTime(m.time) })} data-tooltip={uiText("{0} · {1} · double-click to edit", { 0: m.label, 1: fmtTime(m.time) })} onMouseDown={e => e.stopPropagation()} onClick={() => setPlayhead(m.time)} onDoubleClick={() => window.dispatchEvent(new CustomEvent('cw-edit-marker', {detail:m.id}))}><span>◆</span><i /></button>)}
          {snapAt !== null && <div className="timeline-snap-indicator" style={{left: LABEL_W + snapAt * pxPerSec}}><span>{uiText("Snap")}</span></div>}
          <div className="playhead" style={{ left: LABEL_W + playhead * pxPerSec }} />
        </div>
      </div>
      {context&&<ContextMenu anchor={context} label={uiText("Timeline actions")} onClose={()=>setContext(null)} actions={contextActions()}/>}
      {trackMenu && <div className="trackmenu" role="menu" aria-label={uiText("{0} track actions", { 0: trackMenu.id.toUpperCase() })} style={{ left: trackMenu.x, top: trackMenu.y }} onClick={(e) => e.stopPropagation()} onKeyDown={e => { const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i=buttons.indexOf(document.activeElement as HTMLButtonElement); if (['ArrowDown','ArrowUp','Home','End','Escape'].includes(e.key)) {e.preventDefault();e.stopPropagation(); if(e.key==='Escape'){setTrackMenu(null);return;}const j=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[j]?.focus();} }}>
        <div className="menu-label">{trackMenu.id.toUpperCase()}{" "}{uiText("track")}</div>
        <button role="menuitem" disabled={(trackMenu.id.startsWith('v') ? displayTracks.videos : displayTracks.audios).indexOf(trackMenu.id) === 0} onClick={() => { moveTrack(trackMenu.id, -1); setTrackMenu(null); }}>{uiText("Move track up")}</button>
        <button role="menuitem" disabled={(trackMenu.id.startsWith('v') ? displayTracks.videos : displayTracks.audios).at(-1) === trackMenu.id} onClick={() => { moveTrack(trackMenu.id, 1); setTrackMenu(null); }}>{uiText("Move track down")}</button>
        <button role="menuitem" disabled={trackMenu.id === 'v1' || trackMenu.id === 'a1' || project.clips.some((c) => c.trackId === trackMenu.id)} onClick={() => { useStore.getState().removeTrack(trackMenu.id); setTrackMenu(null); }}>{uiText("Remove empty track")}</button>
      </div>}
    </div>
  );

  function contextActions(): ContextAction[] {
    if(!context)return [];
    const at=context.time, st=useStore.getState();
    const actions:ContextAction[]=[
      {label:uiText("Add marker"),hint:addMarkerShortcut || undefined,icon:<IconPlus/>,disabled:(project.markers?.length??0)>=1000,run:()=>{st.setPlaying(false);st.setPlayhead(at);const id=st.addMarker(at);if(id)window.dispatchEvent(new CustomEvent('cw-edit-marker',{detail:id}));}},
      {label:uiText("Move playhead here"),run:()=>{st.setPlaying(false);st.setPlayhead(at);}},
    ];
    if(context.markerId){const id=context.markerId;actions.push({label:uiText("Edit marker"),run:()=>window.dispatchEvent(new CustomEvent('cw-edit-marker',{detail:id}))},{label:uiText("Delete marker"),icon:<IconDelete/>,danger:true,run:()=>st.removeMarker(id)});}
    if(context.clipId){const id=context.clipId,c=project.clips.find(c=>c.id===id);actions.push({label:uiText("Split clip here"),icon:<IconSplit/>,disabled:!c||at<=c.start+.1||at>=c.start+c.duration-.1,run:()=>st.splitClipAt(id,at)},{label:uiText("Delete clip"),icon:<IconDelete/>,danger:true,run:()=>{st.selectClip(id);st.deleteSelected();}});}
    if(context.transitionId){const id=context.transitionId;actions.push({label:uiText("Remove transition"),icon:<IconDelete/>,danger:true,run:()=>{st.selectTransition(null);st.removeTransition(id);}});}
    return actions;
  }

  // Render keyed rows directly. A component declared inside Timeline receives
  // a new React type on every playhead tick and remounts all thumbnail nodes.
  function renderTrack(kind: string) {
    const label = kind.toUpperCase();
    const clips = project.clips.filter((c) => c.trackId === kind);
    const settings = project.trackSettings?.[kind] ?? {};
    const isVideo = kind.startsWith('v');
    const empty = clips.length === 0;
    return (
      <div key={kind} className={`track ${settings.hidden ? 'trackhidden' : ''}`} data-track={kind} style={{ height: empty ? 32 : rowH }} onMouseDown={startScrub}>
        <div className={`tracklabel ${empty ? 'slim' : ''}`}>
          <span className="trackname">{label}</span>
          <span className="trackbtns">
            {isVideo && <IconButton className="trackbtn" label={`${settings.hidden ? uiText("Show") : uiText("Hide")} ${label}`} aria-pressed={!settings.hidden} onMouseDown={(e) => e.stopPropagation()} onClick={() => useStore.getState().setTrackSettings(kind, { hidden: !settings.hidden })}>{settings.hidden ? <IconEyeOff /> : <IconEye />}</IconButton>}
            <IconButton className={`trackbtn ${settings.muted ? 'off' : ''}`} label={`${settings.muted ? uiText("Unmute") : uiText("Mute")} ${label}`} aria-pressed={!!settings.muted} onMouseDown={(e) => e.stopPropagation()} onClick={() => useStore.getState().setTrackSettings(kind, { muted: !settings.muted })}>{settings.muted ? <IconMuted /> : <IconVolume />}</IconButton>
            <IconButton className="trackbtn" label={uiText("{0} track actions", { 0: label })} aria-haspopup="menu" aria-expanded={trackMenu?.id === kind} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); setTrackMenu(trackMenu?.id === kind ? null : { id: kind, x: b.left, y: Math.max(48, Math.min(window.innerHeight - 155, b.top - 148)) }); }}><IconDots /></IconButton>
          </span>
        </div>
        {clips.map((c) => (
          <div key={c.id} data-context-clip={c.id} className={`clip ${c.id === selectedClipId ? 'sel' : ''}`}
            style={{ left: LABEL_W + c.start * pxPerSec, width: Math.max(30, c.duration * pxPerSec), background: c.color }}
            data-tooltip={uiText("{0} · {1} · {2}s (in {3}s)", { 0: c.name, 1: fmtTime(c.start), 2: c.duration.toFixed(1), 3: c.offset.toFixed(1) })}
            role="button" tabIndex={0} aria-label={uiText("{0}, {1}, {2} seconds", { 0: c.name, 1: fmtTime(c.start), 2: c.duration.toFixed(1) })} onKeyDown={e => {if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();selectClip(c.id);setPlayhead(c.start);}}} onMouseDown={(e) => startClipDrag(e, c.id, 'move')}>
            <span className="edge l" onMouseDown={(e) => startClipDrag(e, c.id, 'l')} />
            <span className="clipname">{c.name} · {c.duration.toFixed(1)}{uiText("s")}</span>
            {isVideo && thumbnails.get(c.id) && <span className="filmstrip" style={{ backgroundImage: `url(${JSON.stringify(thumbnails.get(c.id))})` }} />}
            {project.media.find((m) => m.id === c.mediaId)?.peaks?.length ? (
              <span className="wave" aria-hidden>
                {(() => {
                  const m = project.media.find((item) => item.id === c.mediaId)!;
                  const peaks = m.peaks!;
                  const start = Math.floor(c.offset / m.duration * peaks.length);
                  const end = Math.max(start + 1, Math.ceil((c.offset + c.duration * (c.speed ?? 1)) / m.duration * peaks.length));
                  const slice = peaks.slice(start, end);
                  const step = Math.max(1, Math.ceil(slice.length / 72));
                  return slice.filter((_, i) => i % step === 0).map((p, i) => <i key={i} style={{ height: `${Math.max(4, p * 100)}%` }} />);
                })()}
              </span>
            ) : null}
            <span className="edge r" onMouseDown={(e) => startClipDrag(e, c.id, 'r')} />
          </div>
        ))}
        {project.transitions.filter((tr) => tr.anchorClipId ? clips.some((c) => c.id === tr.anchorClipId) : kind === displayTracks.videos[displayTracks.videos.length - 1]).map((tr) => {
          const def = defs.find((d) => d.id === tr.defId);
          const w = Math.max(40, tr.duration * pxPerSec);
          return (
            <div key={tr.id} data-context-transition={tr.id} role="button" tabIndex={0} onKeyDown={e => {if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();useStore.getState().selectTransition(tr.id);}}} className={`tltrans ${tr.id === selectedTransitionId ? 'sel' : ''}`}
              style={{ left: LABEL_W + tr.at * pxPerSec - (tr.entrance ? 0 : w / 2), width: w }}
              data-tooltip={uiText("{0} · {1}s — right-click for actions", { 0: (def ? transitionName(def) : uiText("Transition")), 1: tr.duration.toFixed(1) })}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => useStore.getState().selectTransition(tr.id)}
              onDoubleClick={() => useStore.getState().selectTransition(tr.id)}
              >
              <span className="tltrans-icon">◆</span>
              <span className="tltrans-name">{def ? transitionName(def) : uiText("Transition")}</span>
            </div>
          );
        })}
      </div>
    );
  }
}

export function SelectionInspector() {
  const project = useStore(s => s.project);
  const clipId = useStore(s => s.selectedClipId), transitionId = useStore(s => s.selectedTransitionId);
  const gesture = useRef(false);
  const begin = () => { gesture.current = false; };
  const change = (action: () => void) => { if (!gesture.current) { useStore.getState().commit(); gesture.current = true; } action(); };
  const st = useStore.getState();
  const clip = project.clips.find(c => c.id === clipId);
  const tr = project.transitions.find(t => t.id === transitionId);
  if (tr) {
    const def = st.allDefs().find(d => d.id === tr.defId);
    return <div className="selection-properties"><div className="inspector"><div className="insp-main"><div className="insp-title">{(def ? transitionName(def) : uiText("Transition"))}</div><div className="insp-sub">{uiText("At")}{" "}{fmtTime(tr.at)} · {tr.entrance ? uiText("Entrance") : uiText("Between clips")}</div></div><Field label={uiText("Duration")}><NumberControl label={uiText("Transition duration")} min={.1} max={4} step={.1} value={tr.duration} unit="s" onGestureStart={begin} onChange={v => change(() => st.updateTransition(tr.id,v,false,false))} /></Field><RangeControl label={uiText("Transition duration slider")} min={.1} max={4} step={.1} value={tr.duration} onGestureStart={begin} onChange={v => change(() => st.updateTransition(tr.id,v,false,false))} /><button onClick={() => st.updateTransition(tr.id,tr.duration,true)}>{uiText("Apply to all")}</button><button onClick={() => {st.setPlayhead(Math.max(0,tr.at-tr.duration));st.setPlaying(true);}}><IconPlay />{uiText("Preview")}</button><button onClick={() => {st.selectTransition(null);st.removeTransition(tr.id);}}>{uiText("Remove")}</button><IconButton label={uiText("Close transition properties")} onClick={() => st.selectTransition(null)}><IconClose /></IconButton></div></div>;
  }
  if (!clip) return <div className="selection-empty"><strong>{uiText("Properties")}</strong><p>{uiText("Select a clip, title or transition to edit it.")}</p></div>;
  const overlay = resolveOverlay(clip,project.media.find(m=>m.id===clip.mediaId));
  const visual = clip.trackId.startsWith('v');
  const audible = clip.mutedAudio && clip.linkGroup ? project.clips.find(c=>c.linkGroup===clip.linkGroup&&c.trackId.startsWith('a'))??clip:clip;
  const num = (label:string,value:number,property:Partial<Clip>,key:keyof Clip,min=0,max=86400,step=.1,unit?:string) => <Field key={key} label={label}><NumberControl label={label} value={value} min={min} max={max} step={step} unit={unit} onGestureStart={begin} onChange={v=>change(()=>st.updateClip(clip.id,{...property,[key]:v},false))} /></Field>;
  const split = () => {const error=st.splitAtPlayhead();if(error)toast(error);};
  return <div className="selection-properties" key={clip.id}>
    <div className="selection-header"><strong>{clip.name}</strong><small>{uiText("Track")}{" "}{clip.trackId.toUpperCase()}{clip.linkGroup?uiText(" · Linked audio/video"):''}</small><IconButton label={uiText("Close clip properties")} onClick={()=>st.selectClip(null)}><IconClose /></IconButton></div>
    {overlay&&<OverlayInspector clip={clip} />}
    <InspectorSection title={uiText("Timing")}><div className="property-grid">{num(uiText("Start"),clip.start,{},'start',0,86400,.1,'s')}{num(uiText("Length"),clip.duration,{},'duration',.2,86400,.1,'s')}{num(uiText("Speed"),clip.speed??1,{},'speed',.1,8,.05,'×')}{num(uiText("Source in"),clip.offset,{},'offset',0,86400,.1,'s')}</div></InspectorSection>
    {!overlay&&<InspectorSection title={uiText("Audio")} defaultOpen={!visual}><div className="property-grid">{num(uiText("Volume"),audible.volume??1,{},'volume',0,4,.05,'×')}{num(uiText("Fade in"),audible.fadeIn??0,{},'fadeIn',0,86400,.1,'s')}{num(uiText("Fade out"),audible.fadeOut??0,{},'fadeOut',0,86400,.1,'s')}</div>{audible.audioEnvelope&&<p className="hint">{uiText("Fades retain their phase across split clips.")}</p>}<button onClick={()=>st.updateClip(clip.id,{volume:1,fadeIn:0,fadeOut:0,audioEnvelope:undefined})}>{uiText("Reset audio")}</button></InspectorSection>}
    {visual&&<InspectorSection title={uiText("Transform")} defaultOpen={!overlay}><div className="property-grid">{num(uiText("Scale"),clip.scale??1,{},'scale',.1,3,.05,'×')}{num(uiText("Opacity"),clip.opacity??1,{},'opacity',0,1,.05)}<Field label={uiText("Horizontal offset")}><NumberControl label={uiText("Horizontal offset")} value={(clip.posX??0)*project.width/100} min={-project.width/2} max={project.width/2} unit="px" onGestureStart={begin} onChange={v=>change(()=>st.updateClip(clip.id,{posX:v/project.width*100},false))}/></Field><Field label={uiText("Vertical offset")}><NumberControl label={uiText("Vertical offset")} value={(clip.posY??0)*project.height/100} min={-project.height/2} max={project.height/2} unit="px" onGestureStart={begin} onChange={v=>change(()=>st.updateClip(clip.id,{posY:v/project.height*100},false))}/></Field>{num(uiText("Rotation"),clip.rotate??0,{},'rotate',-180,180,1,'°')}</div><button onClick={()=>st.updateClip(clip.id,{scale:1,opacity:1,posX:0,posY:0,rotate:0})}>{uiText("Reset transform")}</button></InspectorSection>}
    {visual&&<InspectorSection title={uiText("Color")} defaultOpen={false}><div className="property-grid">{num(uiText("Brightness"),clip.brightness??1,{},'brightness',0,2,.05)}{num(uiText("Contrast"),clip.contrast??1,{},'contrast',0,2,.05)}{num(uiText("Saturation"),clip.saturation??1,{},'saturation',0,3,.05)}</div><button onClick={()=>st.updateClip(clip.id,{brightness:1,contrast:1,saturation:1})}>{uiText("Reset color")}</button></InspectorSection>}
    <div className="selection-actions">{clip.linkGroup&&<IconButton label={uiText("Unlink audio and video")} onClick={()=>st.unlinkClip(clip.id)}><IconUnlink /></IconButton>}<IconButton label={uiText("Split selected clip")} action="split" onClick={split}><IconSplit /></IconButton><IconButton label={uiText("Delete selected clip")} action="delete" onClick={()=>st.rippleEnabled?st.deleteSelectedRipple():st.deleteSelected()}><IconDelete /></IconButton></div>
  </div>;
}
