import { useEffect, useState, useRef } from 'react';
import { useStore } from '../lib/store';
import { useShortcutLabel } from '../lib/shortcutPreferences';
import { fmtTime } from '../lib/srt';
import { ColorControl, Field, NumberControl } from './ui/Controls';
import { IconButton, IconMarker, IconStepBack, IconStepFwd, IconMarkers, IconClose, IconDelete } from './icons';
import { FloatingSurface, type SurfaceAnchor } from './ui/FloatingSurface';

export default function TimelineMarkers(){
  const addMarkerShortcut = useShortcutLabel('addMarker');
  const project=useStore(s=>s.project),playhead=useStore(s=>s.playhead);
  const [anchor,setAnchor]=useState<SurfaceAnchor|null>(null),[selected,setSelected]=useState<string|null>(null);
  const toolbar=useRef<HTMLDivElement>(null);
  const open=()=>{const r=toolbar.current?.getBoundingClientRect();if(r)setAnchor({x:r.left,y:r.top-6,bottom:r.bottom+6});};
  useEffect(()=>{const edit=(e:Event)=>{setSelected((e as CustomEvent<string>).detail);open();};window.addEventListener('cw-edit-marker',edit);return()=>window.removeEventListener('cw-edit-marker',edit);},[]);
  const changed=useRef(false);
  const begin=()=>{changed.current=false;};
  const edit=(action:()=>void)=>{if(!changed.current){useStore.getState().commit();changed.current=true;}action();};
  const markers=project.markers??[],m=markers.find(m=>m.id===selected);
  const jump=(direction:-1|1)=>{const sorted=markers.slice().sort((a,b)=>a.time-b.time);const next=direction<0?sorted.filter(m=>m.time<playhead-1e-6).at(-1):sorted.find(m=>m.time>playhead+1e-6);if(next){useStore.getState().setPlaying(false);useStore.getState().setPlayhead(next.time);setSelected(next.id);}};
  return <><div ref={toolbar} className="marker-toolbar toolgroup" role="group" aria-label="Timeline markers">
    <IconButton label="Add marker" action="addMarker" disabled={markers.length>=1000} onClick={()=>{const id=useStore.getState().addMarker(playhead);if(id){setSelected(id);open();}}}><IconMarker/></IconButton>
    <IconButton label="Previous marker" action="previousMarker" shortcut="Ctrl+Shift+←" disabled={!markers.some(m=>m.time<playhead-1e-6)} onClick={()=>jump(-1)}><IconStepBack/></IconButton>
    <IconButton label="Next marker" action="nextMarker" shortcut="Ctrl+Shift+→" disabled={!markers.some(m=>m.time>playhead+1e-6)} onClick={()=>jump(1)}><IconStepFwd/></IconButton>
    <IconButton label="Markers" title={`Markers · ${markers.length}`} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={()=>{if(anchor)setAnchor(null);else{if(!m)setSelected(markers[0]?.id??null);open();}}}><IconMarkers/></IconButton>
  </div>
    {anchor&&<FloatingSurface anchor={anchor} label="Markers" className="marker-panel" onClose={()=>setAnchor(null)}>
      <div className="marker-heading"><strong>Markers <span>{markers.length}</span></strong><IconButton label="Close markers" onClick={()=>setAnchor(null)}><IconClose/></IconButton></div>
      <div className="marker-list" role="list" aria-label="Project markers">{markers.length===0&&<span className="hint">{addMarkerShortcut ? addMarkerShortcut + ' adds a marker at the playhead.' : 'Use Add marker to place a marker at the playhead.'}</span>}{markers.map(marker=><div role="listitem" key={marker.id}><button aria-pressed={selected===marker.id} className={selected===marker.id?'active':''} onClick={()=>{setSelected(marker.id);useStore.getState().setPlayhead(marker.time);}}><i style={{background:marker.color}}/><span>{marker.label||'Untitled marker'}</span><time>{fmtTime(marker.time)}</time></button></div>)}</div>
      {m&&<div className="marker-edit"><Field label="Name"><input data-autofocus aria-label="Marker name" maxLength={200} value={m.label} onFocus={begin} onChange={e=>edit(()=>useStore.getState().updateMarker(m.id,{label:e.target.value},false))}/></Field><div className="marker-values"><Field label="Time"><NumberControl label="Marker time" unit="s" min={0} max={86400} step={1/project.fps} value={m.time} onGestureStart={begin} onChange={v=>edit(()=>useStore.getState().updateMarker(m.id,{time:v},false))}/></Field><Field label="Color"><ColorControl label="Marker color" value={m.color} onChange={v=>useStore.getState().updateMarker(m.id,{color:v})}/></Field><IconButton label="Delete marker" onClick={()=>{useStore.getState().removeMarker(m.id);setSelected(markers.find(x=>x.id!==m.id)?.id??null);}}><IconDelete/></IconButton></div></div>}
    </FloatingSurface>}
  </>;
}
