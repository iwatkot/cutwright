import { t as uiText } from '../i18n/core';
import { useRef, useState } from 'react';
import { ColorControl, Field, InspectorSection, NumberControl, SelectControl, ToggleGroup } from './ui/Controls';
import type { Clip, NativeOverlay } from '../lib/types';
import { useStore } from '../lib/store';
import { reflowTitleScroll, resolveOverlay, validateOverlay } from '../lib/overlay';
import { saveOverlayAsset } from '../lib/overlayAssets';
import { toast } from './TopBar';
import './overlay.css';

export default function OverlayInspector({ clip }: { clip: Clip }) {
  const [assetName, setAssetName] = useState(clip.name);
  const media = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId));
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const overlay = resolveOverlay(clip, media);
  if (!overlay) return null;
  const committed = useRef(false);
  const begin = () => { committed.current = false; };
  const sourceEnd = Math.min(86400, Math.max(.001, clip.offset + clip.duration * (clip.speed ?? 1) + (overlay.animationOffset ?? 0)));
  const patch = (values: Record<string, unknown>) => {
    let next = { ...overlay, ...values } as NativeOverlay;
    if ('fadeOut' in values && Number(values.fadeOut) > 0 && next.animationDuration === undefined) next.animationDuration = sourceEnd;
    const reflow = overlay.kind === 'title' && next.kind === 'title' && ('text' in values || 'lineHeight' in values);
    if (reflow && overlay.kind === 'title' && next.kind === 'title') next = reflowTitleScroll(overlay, next);
    if (validateOverlay(next).length) return;
    const s = useStore.getState();
    // Movavi credit headings and names are separate editable items sharing
    // one roll. Resize their common travel together, in the same undo step.
    const oldScroll = overlay.kind === 'title' ? overlay.scroll : undefined;
    const newScroll = next.kind === 'title' ? next.scroll : undefined;
    const travelDelta = reflow && oldScroll && newScroll ? newScroll.toY - oldScroll.toY : 0;
    const siblings = travelDelta && clip.generatedOverlay?.preset === 'Credits' ? s.project.clips.filter((c) => c.id !== clip.id
      && c.generatedOverlay?.preset === 'Credits' && c.start === clip.start && c.duration === clip.duration
      && c.offset === clip.offset && (c.speed ?? 1) === (clip.speed ?? 1)) : [];
    if (JSON.stringify(next) === JSON.stringify(overlay)) return;
    if (!committed.current) { s.commit(); committed.current = true; }
    s.updateClip(clip.id, { overlay: next }, false);
    for (const sibling of siblings) {
      const content = resolveOverlay(sibling, s.project.media.find((m) => m.id === sibling.mediaId));
      if (content?.kind !== 'title' || !content.scroll || !oldScroll
        || content.scroll.fromY !== oldScroll.fromY || content.scroll.toY !== oldScroll.toY || content.scroll.duration !== oldScroll.duration
        || (content.animationOffset ?? 0) !== (overlay.animationOffset ?? 0)) continue;
      s.updateClip(sibling.id, { overlay: { ...content, scroll: { ...content.scroll, toY: content.scroll.toY + travelDelta } } }, false);
    }
  };
  const num = (label: string, key: string, value: number, min = -100000, max = 100000, step = 1, unit?: string) => <Field key={key} label={label}><NumberControl label={uiText("Overlay {0}", { 0: label.toLowerCase() })} value={value} min={min} max={max} step={step} unit={unit} onGestureStart={begin} onChange={v => patch({ [key]: v })} /></Field>;
  const action = (values: Record<string,unknown>) => { begin(); patch(values); };
  return <div className="overlay-inspector" aria-label={overlay.kind === 'title' ? uiText("Editable text properties") : uiText("Editable element properties")}>
    {overlay.kind === 'title' ? <>
      <InspectorSection title={uiText("Text")}>
        <Field label={uiText("Content")}><textarea rows={3} aria-label={uiText("Overlay text")} value={overlay.text} onFocus={begin} onChange={e => patch({text:e.target.value})} /></Field>
        <Field label={uiText("Typeface")}><SelectControl label={uiText("Overlay font")} value={overlay.fontFamily} onGestureStart={begin} onChange={fontFamily=>patch({fontFamily})} options={[...new Set([overlay.fontFamily,'Arial','Georgia','Impact','Consolas','Segoe UI','Times New Roman','Verdana'])].map(font=>({value:font,label:font}))} /></Field>
        <div className="inspector-grid">{num(uiText("Font size"),'fontSize',overlay.fontSize,1,2000,1,'px')}<Field label={uiText("Weight")}><SelectControl label={uiText("Overlay font weight")} value={String(overlay.fontWeight)} onGestureStart={begin} onChange={v=>patch({fontWeight:Number(v)})} options={[...new Set([overlay.fontWeight,400,500,600,700,800,900])].sort((a,b)=>a-b).map(v=>({value:String(v),label:v===400?uiText("Regular"):v===700?uiText("Bold"):String(v)}))} /></Field></div>
        <Field label={uiText("Alignment")}><ToggleGroup label={uiText("Overlay alignment")} value={overlay.align} options={[{value:'left',label:uiText("Left")},{value:'center',label:uiText("Center")},{value:'right',label:uiText("Right")}]} onChange={align=>action({align})} /></Field>
        <Field label={uiText("Text color")}><ColorControl label={uiText("Overlay color")} value={overlay.color} onGestureStart={begin} onChange={color=>patch({color})} /></Field>
        <button className="inspector-reset" onClick={()=>action({fontFamily:'Arial',fontSize:Math.min(width*.072,height*.12),lineHeight:Math.min(width*.072,height*.12)*1.2,fontWeight:400,align:'center',color:'#FFFFFF'})}>{uiText("Reset type style")}</button>
      </InspectorSection>
      <InspectorSection title={uiText("Text layout")} defaultOpen={false}><div className="inspector-grid">{num(uiText("X position"),'x',overlay.x,-100000,100000,1,'px')}{num(uiText("Y position"),'y',overlay.y,-100000,100000,1,'px')}{num(uiText("Text width"),'blockWidth',overlay.blockWidth,0,100000,1,'px')}{num(uiText("Line height"),'lineHeight',overlay.lineHeight,1,10000,1,'px')}</div><button className="inspector-reset" onClick={()=>action({x:width*.1,y:height*.42,blockWidth:width*.8,align:'center'})}>{uiText("Center text on canvas")}</button></InspectorSection>
    </> : <InspectorSection title={uiText("Element")}><div className="inspector-grid">{num(uiText("From X"),'x1',overlay.x1)}{num(uiText("From Y"),'y1',overlay.y1)}{num(uiText("To X"),'x2',overlay.x2)}{num(uiText("To Y"),'y2',overlay.y2)}{num(uiText("Stroke"),'width',overlay.width,.1,2000,.5,'px')}{num(uiText("Draw time"),'drawDuration',overlay.drawDuration??0,0,86400,.1,'s')}</div><Field label={uiText("Arrowhead")}><ToggleGroup label={uiText("Arrowhead")} value={overlay.head?'on':'off'} options={[{value:'on',label:uiText("On")},{value:'off',label:uiText("Off")}]} onChange={v=>action({head:v==='on'})} /></Field><Field label={uiText("Element color")}><ColorControl label={uiText("Overlay color")} value={overlay.color} onGestureStart={begin} onChange={color=>patch({color})} /></Field></InspectorSection>}
    <InspectorSection title={uiText("Animation")} defaultOpen={false}><div className="inspector-grid">{num(uiText("Fade in"),'fadeIn',overlay.fadeIn??0,0,86400,.1,'s')}{num(uiText("Fade out"),'fadeOut',overlay.fadeOut??0,0,86400,.1,'s')}{num(uiText("Animation length"),'animationDuration',overlay.animationDuration??sourceEnd,.001,86400,.1,'s')}{overlay.kind==='title' && overlay.scroll && <Field label={uiText("Scroll duration")}><NumberControl label={uiText("Credit scroll duration")} value={overlay.scroll.duration} min={.1} max={86400} step={.1} unit="s" onGestureStart={begin} onChange={duration=>patch({scroll:{...overlay.scroll,duration}})} /></Field>}</div><p className="inspector-note">{uiText("Fades and")}{" "}{overlay.kind==='title' ? uiText("credit rolls") : uiText("line drawing")}{" "}{uiText("use the same native animation in preview and export.")}</p><button className="inspector-reset" onClick={()=>action({fadeIn:0,fadeOut:0})}>{uiText("Reset fades")}</button></InspectorSection>
    <div className="overlay-save-area"><Field label={uiText("Asset name")}><input aria-label={uiText("Reusable asset name")} maxLength={200} value={assetName} onChange={e=>setAssetName(e.target.value)} /></Field><button className="overlay-save" onClick={() => toast(saveOverlayAsset(assetName,overlay,{width,height}) ? uiText("Saved to My assets in {0}. Available in every project.", { 0: overlay.kind==='title'?uiText("Text"):uiText("Elements") }) : uiText("Could not save the asset. Check storage space."))}>{uiText("Save as reusable asset")}</button><p>{uiText("Keep this editable style in My assets.")}</p></div>
  </div>;
}
