import { t as uiText } from '../i18n/core';
import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../lib/store';
import { defaultCanvasSettings, resolveGuideDrag, snapCanvasPoint } from '../lib/canvasGeometry';
import { overlayFrame, overlaySourceTime, resolveOverlay, titleBlockHeight } from '../lib/overlay';
import type { CanvasGuide, Clip } from '../lib/types';
import { NumberControl } from './ui/Controls';
import { matchConfiguredShortcut } from '../lib/shortcutPreferences';

/** A guide's raw pointer position remains separate from its snapped position:
 * dragging outside must still remove it when Shift snaps back to an edge. */
function beginGuideGesture(e: ReactPointerEvent, axis: CanvasGuide['axis'], stageRef: RefObject<HTMLDivElement>, existing?: CanvasGuide): () => void {
  const initial = useStore.getState().project.editorCanvas ?? defaultCanvasSettings();
  if (e.button !== 0 || !e.isPrimary || initial.guidesLocked || (!existing && initial.guides.length >= 200)) return () => {};
  e.preventDefault(); e.stopPropagation();
  const anchor = e.currentTarget as HTMLElement, pointerId = e.pointerId;
  const id = existing?.id ?? crypto.randomUUID();
  let active = true, committed = false, created = !!existing, outside = false, shift = e.shiftKey;
  let point = { x: e.clientX, y: e.clientY };
  const update = () => {
    if (!active) return;
    const stage = stageRef.current;
    if (!stage?.isConnected) { finish(); return; }
    const state = useStore.getState(), project = state.project;
    const settings = project.editorCanvas ?? defaultCanvasSettings();
    const guide = settings.guides.find(item => item.id === id);
    if (settings.guidesLocked || (created && !guide) || (!created && settings.guides.length >= 200)) { finish(); return; }
    const frame = stage.getBoundingClientRect();
    if (!frame.width || !frame.height) return;
    const extent = axis === 'x' ? project.width : project.height;
    const raw = axis === 'x' ? (point.x - frame.left) / frame.width * extent : (point.y - frame.top) / frame.height * extent;
    const result = resolveGuideDrag(raw, axis, extent, settings.grid, shift);
    outside = result.outside;
    // A ruler drag creates nothing until its pointer enters the frame.
    if (!created && outside) return;
    if (guide?.position === result.position) return;
    if (!committed) { state.commit(); committed = true; }
    state.setCanvasSettings({ ...settings, guides: guide
      ? settings.guides.map(item => item.id === id ? { ...item, position: result.position } : item)
      : [...settings.guides, { id, axis, position: result.position }] }, false);
    created = true;
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    const changed = point.x !== event.clientX || point.y !== event.clientY || shift !== event.shiftKey;
    point = { x: event.clientX, y: event.clientY }; shift = event.shiftKey;
    if (changed) update();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Shift' || event.isComposing || shift === event.shiftKey) return;
    shift = event.shiftKey; update();
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) { move(event); finish(); } };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
  function finish() {
    if (!active) return;
    active = false;
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', finish);
    window.removeEventListener('cw-project-will-load', finish); anchor.removeEventListener('lostpointercapture', cancel);
    if (anchor.hasPointerCapture?.(pointerId)) anchor.releasePointerCapture(pointerId);
    if (!created || !outside) return;
    const state = useStore.getState(), settings = state.project.editorCanvas;
    if (!settings?.guides.some(item => item.id === id)) return;
    if (!committed) state.commit();
    state.setCanvasSettings({ ...settings, guides: settings.guides.filter(item => item.id !== id) }, false);
  }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', finish);
  window.addEventListener('cw-project-will-load', finish); anchor.addEventListener('lostpointercapture', cancel);
  anchor.setPointerCapture(pointerId);
  return finish;
}

function useGuideGesture(stageRef: RefObject<HTMLDivElement>) {
  const finish = useRef<() => void>();
  useEffect(() => () => finish.current?.(), []);
  return (event: ReactPointerEvent, axis: CanvasGuide['axis'], existing?: CanvasGuide) => {
    finish.current?.(); finish.current = beginGuideGesture(event, axis, stageRef, existing);
  };
}

function bounds(clip: Clip) {
  const p = useStore.getState().project, media = p.media.find(m => m.id === clip.mediaId);
  const o = resolveOverlay(clip,media);
  const scroll = o ? overlayFrame(o,overlaySourceTime(clip,useStore.getState().playhead)).scrollY : 0;
  const fit = media?.width && media?.height ? Math.min(p.width / media.width, p.height / media.height) : 1;
  const mediaW = media?.width ? media.width * fit : p.width, mediaH = media?.height ? media.height * fit : p.height;
  const b = o?.kind === 'title' ? {x:o.x,y:o.y+scroll,w:Math.max(10,o.blockWidth),h:titleBlockHeight(o)} : o?.kind === 'arrow' ? {x:Math.min(o.x1,o.x2)-o.width,y:Math.min(o.y1,o.y2)-o.width,w:Math.max(20,Math.abs(o.x2-o.x1)+o.width*2),h:Math.max(20,Math.abs(o.y2-o.y1)+o.width*2)} : {x:(p.width-mediaW)/2,y:(p.height-mediaH)/2,w:mediaW,h:mediaH};
  const scale = clip.scale ?? 1, angle = (clip.rotate ?? 0)*Math.PI/180;
  const point = (x:number,y:number) => ({x:p.width/2+(x-p.width/2)*scale*Math.cos(angle)-(y-p.height/2)*scale*Math.sin(angle)+(clip.posX??0)*p.width/100,y:p.height/2+(x-p.width/2)*scale*Math.sin(angle)+(y-p.height/2)*scale*Math.cos(angle)+(clip.posY??0)*p.height/100});
  const corners = [point(b.x,b.y),point(b.x+b.w,b.y),point(b.x,b.y+b.h),point(b.x+b.w,b.y+b.h)];
  return {x:Math.min(...corners.map(c=>c.x)),y:Math.min(...corners.map(c=>c.y)),w:Math.max(...corners.map(c=>c.x))-Math.min(...corners.map(c=>c.x)),h:Math.max(...corners.map(c=>c.y))-Math.min(...corners.map(c=>c.y)),overlay:o};
}

export interface CanvasRulerViewRect {
  width: number;
  height: number;
  stageWidth: number;
  stageHeight: number;
  x: number;
  y: number;
}

export function CanvasRulers({stageRef,pixelScale,viewRect}:{stageRef:RefObject<HTMLDivElement>;pixelScale:number;viewRect?:CanvasRulerViewRect}) {
  const p = useStore(s=>s.project), config=p.editorCanvas??defaultCanvasSettings();
  const startGuide = useGuideGesture(stageRef);
  if (!config.rulers) return null;
  const scale = viewRect ? viewRect.stageWidth / p.width : pixelScale;
  const ticks=(size:number)=>{const wanted=55/Math.max(.001,scale),base=10**Math.floor(Math.log10(wanted));const major=([1,2,5,10].find(n=>n*base>=wanted)??10)*base;const minor=major/5;return Array.from({length:Math.ceil(size/minor)},(_,i)=>({value:i*minor,label:i%5===0}));};
  const position = (value:number,axis:CanvasGuide['axis']) => {
    const size = axis === 'x' ? p.width : p.height;
    if (!viewRect) return `${value / size * 100}%`;
    const viewport = axis === 'x' ? viewRect.width : viewRect.height;
    const stage = axis === 'x' ? viewRect.stageWidth : viewRect.stageHeight;
    const pan = axis === 'x' ? viewRect.x : viewRect.y;
    return (viewport - stage) / 2 + pan + value / size * stage;
  };
  return <><div className="canvas-ruler horizontal" aria-label={uiText("Horizontal pixel ruler, drag for a horizontal guide")} data-tooltip={uiText("Drag a horizontal guide · Shift = grid step")} onPointerDown={e=>startGuide(e,'y')}>{ticks(p.width).map(t=><i key={t.value} className={t.label?'major':'minor'} style={{left:position(t.value,'x')}}>{t.label?t.value:''}</i>)}</div><div className="canvas-ruler vertical" aria-label={uiText("Vertical pixel ruler, drag for a vertical guide")} data-tooltip={uiText("Drag a vertical guide · Shift = grid step")} onPointerDown={e=>startGuide(e,'x')}>{ticks(p.height).map(t=><i key={t.value} className={t.label?'major':'minor'} style={{top:position(t.value,'y')}}>{t.label?t.value:''}</i>)}</div></>;
}

export default function CanvasAids({stageRef}:{stageRef:RefObject<HTMLDivElement>}) {
  const project=useStore(s=>s.project), selected=useStore(s=>s.selectedClipId), playing=useStore(s=>s.playing), time=useStore(s=>s.playhead);
  const config=project.editorCanvas??defaultCanvasSettings();
  const [editingGuide,setEditingGuide]=useState<string|null>(null);
  const [snap,setSnap]=useState<{x?:number,y?:number}>({});
  const startGuide = useGuideGesture(stageRef);
  const active=project.clips.filter(c=>c.trackId.startsWith('v')&&!project.trackSettings?.[c.trackId]?.hidden&&time>=c.start&&time<c.start+c.duration);
  const clip=active.find(c=>c.id===selected), box=clip?bounds(clip):null;
  const endpoint=clip&&box?.overlay?.kind==='arrow'?(()=>{const o=box.overlay,a=(clip.rotate??0)*Math.PI/180,s=clip.scale??1;return{x:project.width/2+(o.x2-project.width/2)*s*Math.cos(a)-(o.y2-project.height/2)*s*Math.sin(a)+(clip.posX??0)*project.width/100,y:project.height/2+(o.x2-project.width/2)*s*Math.sin(a)+(o.y2-project.height/2)*s*Math.cos(a)+(clip.posY??0)*project.height/100};})():null;
  // Keep the handle reachable when visual bounds extend beyond the clipped frame.
  // Gestures still use the real project geometry, including off-canvas edges.
  const margin=8/Math.max(.001,(stageRef.current?.clientWidth??project.width)/project.width);
  const marginX=Math.min(project.width/2,margin),marginY=Math.min(project.height/2,margin);
  const handle=box?{x:Math.max(marginX,Math.min(project.width-marginX,endpoint?.x??box.x+box.w)),y:Math.max(marginY,Math.min(project.height-marginY,endpoint?.y??box.y+box.h))}:null;
  const guide=config.guides.find(g=>g.id===editingGuide);
  const dragItem=(e:ReactPointerEvent,resize=false)=>{
    if(!clip||!box||playing)return;e.preventDefault();e.stopPropagation();const r=stageRef.current?.getBoundingClientRect();if(!r)return;
    const startX=e.clientX,startY=e.clientY,orig=structuredClone(clip),originalBox=box;let changed=false;
    const move=(ev:PointerEvent)=>{
      let dx=(ev.clientX-startX)/r.width*project.width,dy=(ev.clientY-startY)/r.height*project.height;
      if(!changed&&Math.abs(ev.clientX-startX)+Math.abs(ev.clientY-startY)<2)return;
      if(!changed){useStore.getState().commit();changed=true;}
      const settings=ev.altKey?{...config,snap:false,grid:{...config.grid,snap:false}}:config;
      const st=useStore.getState();
      if(resize){
        const o=originalBox.overlay, angle=-(orig.rotate??0)*Math.PI/180, scale=orig.scale??1;
        if(o?.kind==='arrow') {
          const a=-angle;
          const ex=project.width/2+(o.x2-project.width/2)*scale*Math.cos(a)-(o.y2-project.height/2)*scale*Math.sin(a)+(orig.posX??0)*project.width/100;
          const ey=project.height/2+(o.x2-project.width/2)*scale*Math.sin(a)+(o.y2-project.height/2)*scale*Math.cos(a)+(orig.posY??0)*project.height/100;
          const target=snapCanvasPoint(ex+dx,ey+dy,project.width,project.height,settings,6/r.width*project.width);
          const tx=target.x-ex,ty=target.y-ey;
          st.updateClip(clip.id,{overlay:{...o,x2:Math.max(-100000,Math.min(100000,o.x2+(tx*Math.cos(angle)-ty*Math.sin(angle))/scale)),y2:Math.max(-100000,Math.min(100000,o.y2+(tx*Math.sin(angle)+ty*Math.cos(angle))/scale))}},false);
          setSnap({x:target.snappedX,y:target.snappedY});
        } else {
          // Uniform scale; media scales about its center, titles about their text origin.
          const factor=o?.kind==='title'?1:2;
          const horizontal=Math.abs(dx/originalBox.w)>=Math.abs(dy/originalBox.h);
          let ratio=Math.max(.1,Math.min(10,1+(horizontal?dx/originalBox.w:dy/originalBox.h)*factor));
          const edgeX=originalBox.x+originalBox.w+(ratio-1)*originalBox.w/factor;
          const edgeY=originalBox.y+originalBox.h+(ratio-1)*originalBox.h/factor;
          const target=snapCanvasPoint(edgeX,edgeY,project.width,project.height,settings,6/r.width*project.width);
          if(horizontal&&target.snappedX!==undefined)ratio=1+(target.x-originalBox.x-originalBox.w)*factor/originalBox.w;
          if(!horizontal&&target.snappedY!==undefined)ratio=1+(target.y-originalBox.y-originalBox.h)*factor/originalBox.h;
          ratio=Math.max(.1,Math.min(10,ratio));
          if(o?.kind==='title')st.updateClip(clip.id,{overlay:{...o,blockWidth:Math.min(100000,Math.max(1,o.blockWidth*ratio)),fontSize:Math.min(2000,Math.max(1,o.fontSize*ratio)),lineHeight:Math.min(10000,Math.max(1,o.lineHeight*ratio))}},false);
          else st.updateClip(clip.id,{scale:Math.max(.1,Math.min(3,(orig.scale??1)*ratio))},false);
          const actual=bounds(useStore.getState().project.clips.find(c=>c.id===clip.id)!);
          setSnap({x:horizontal&&target.snappedX!==undefined&&Math.abs(actual.x+actual.w-target.x)<.01?target.x:undefined,y:!horizontal&&target.snappedY!==undefined&&Math.abs(actual.y+actual.h-target.y)<.01?target.y:undefined});
        }
      }else{
        // Snap all three edges of the selection, then apply the smallest correction.
        const candidates=[0,.5,1].map(f=>{const x=originalBox.x+originalBox.w*f+dx,y=originalBox.y+originalBox.h*f+dy;return {f,x,y,s:snapCanvasPoint(x,y,project.width,project.height,settings,6/r.width*project.width)};});
        const sx=candidates.filter(c=>c.s.snappedX!==undefined).sort((a,b)=>Math.abs(a.s.x-a.x)-Math.abs(b.s.x-b.x))[0];
        const sy=candidates.filter(c=>c.s.snappedY!==undefined).sort((a,b)=>Math.abs(a.s.y-a.y)-Math.abs(b.s.y-b.y))[0];
        if(sx)dx+=sx.s.x-sx.x;if(sy)dy+=sy.s.y-sy.y;setSnap({x:sx?.s.snappedX,y:sy?.s.snappedY});
        const o=originalBox.overlay,angle=-(orig.rotate??0)*Math.PI/180,scale=orig.scale??1;
        const ox=(dx*Math.cos(angle)-dy*Math.sin(angle))/scale,oy=(dx*Math.sin(angle)+dy*Math.cos(angle))/scale;
        if(o?.kind==='title')st.updateClip(clip.id,{overlay:{...o,x:Math.max(-100000,Math.min(100000,o.x+ox)),y:Math.max(-100000,Math.min(100000,o.y+oy))}},false);
        else if(o?.kind==='arrow') {
          const tx=Math.max(-100000-Math.min(o.x1,o.x2),Math.min(100000-Math.max(o.x1,o.x2),ox));
          const ty=Math.max(-100000-Math.min(o.y1,o.y2),Math.min(100000-Math.max(o.y1,o.y2),oy));
          st.updateClip(clip.id,{overlay:{...o,x1:o.x1+tx,y1:o.y1+ty,x2:o.x2+tx,y2:o.y2+ty}},false);
        }
        else st.updateClip(clip.id,{posX:Math.max(-50,Math.min(50,(orig.posX??0)+dx/project.width*100)),posY:Math.max(-50,Math.min(50,(orig.posY??0)+dy/project.height*100))},false);
        const actual=bounds(useStore.getState().project.clips.find(c=>c.id===clip.id)!);
        setSnap({x:sx&&Math.abs(actual.x+actual.w*sx.f-sx.s.x)<.01?sx.s.snappedX:undefined,y:sy&&Math.abs(actual.y+actual.h*sy.f-sy.s.y)<.01?sy.s.snappedY:undefined});
      }
    };
    const up=()=>{setSnap({});window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
  };
  const style=(b:{x:number,y:number,w:number,h:number})=>({left:`${b.x/project.width*100}%`,top:`${b.y/project.height*100}%`,width:`${b.w/project.width*100}%`,height:`${b.h/project.height*100}%`});
  return <div className="canvas-aids" data-editor-only="true">
    {config.grid.visible&&<svg className="canvas-grid" width="100%" height="100%" aria-hidden><defs><pattern id="cw-grid" patternUnits="userSpaceOnUse" width={`${config.grid.spacingX/project.width*100}%`} height={`${config.grid.spacingY/project.height*100}%`} x={`${config.grid.originX/project.width*100}%`} y={`${config.grid.originY/project.height*100}%`}><path d="M 0 0 H 10000 M 0 0 V 10000" stroke="#8ba0b2" strokeOpacity=".3" strokeWidth="1" /></pattern></defs><rect width="100%" height="100%" fill="url(#cw-grid)" /></svg>}
    {!playing&&active.filter(c=>c.id!==selected&&resolveOverlay(c,project.media.find(m=>m.id===c.mediaId))).map(c=><button key={c.id} className="canvas-hit-target" aria-label={uiText("Select {0} on canvas", { 0: c.name })} style={style(bounds(c))} onClick={()=>useStore.getState().selectClip(c.id)} />)}
    {!playing&&box&&clip&&handle&&<div className="canvas-selection" style={style(box)} onPointerDown={e=>dragItem(e)} role="group" aria-label={uiText("{0} canvas selection", { 0: clip.name })}><span className="selection-label">{clip.name} · {Math.round(box.x)}, {Math.round(box.y)} px</span><button className="canvas-resize" style={{left:`${(handle.x-box.x)/box.w*100}%`,top:`${(handle.y-box.y)/box.h*100}%`,right:'auto',bottom:'auto',transform:'translate(-50%,-50%)'}} aria-label={uiText("Resize {0} on canvas", { 0: clip.name })} data-tooltip={endpoint?uiText("Drag arrow endpoint"):box.overlay ? uiText("Resize visual item") : uiText("Scale media from its center")} onPointerDown={e=>dragItem(e,true)} /></div>}
    {config.guidesVisible&&config.guides.map(g=><button key={g.id} aria-label={uiText("{0} guide at {1} pixels", { 0: g.axis==='x'?uiText("Vertical"):uiText("Horizontal"), 1: Math.round(g.position) })} data-tooltip={uiText("Drag to move · Shift = grid step · Double-click to edit")} className={`canvas-guide ${g.axis} ${config.guidesLocked?'locked':''}`} style={{[g.axis==='x'?'left':'top']:`${g.position/(g.axis==='x'?project.width:project.height)*100}%`}} onPointerDown={e=>startGuide(e,g.axis,g)} onDoubleClick={()=>setEditingGuide(g.id)} onKeyDown={e=>{if(config.guidesLocked)return;if(e.key==='Enter'){e.preventDefault();e.stopPropagation();setEditingGuide(g.id);return;}if(matchConfiguredShortcut(e.nativeEvent, 'delete')){e.preventDefault();e.stopPropagation();useStore.getState().setCanvasSettings({...config,guides:config.guides.filter(x=>x.id!==g.id)});}}} />)}
    {snap.x!==undefined&&<i className="canvas-snap-line x" style={{left:`${snap.x/project.width*100}%`}} />}{snap.y!==undefined&&<i className="canvas-snap-line y" style={{top:`${snap.y/project.height*100}%`}} />}
    {guide&&<div className="guide-editor" data-shortcut-scope="control"><NumberControl label={uiText("Guide position")} value={guide.position} min={-16384} max={32768} unit="px" onChange={v=>useStore.getState().setCanvasSettings({...config,guides:config.guides.map(g=>g.id===guide.id?{...g,position:v}:g)})} /><button onClick={()=>setEditingGuide(null)}>{uiText("Done")}</button><button onClick={()=>{useStore.getState().setCanvasSettings({...config,guides:config.guides.filter(g=>g.id!==guide.id)});setEditingGuide(null);}}>{uiText("Delete guide")}</button></div>}
  </div>;
}
