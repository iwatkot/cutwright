import { t as uiText } from '../i18n/core';
import type { Clip, MediaItem, NativeOverlay, Project, TitleOverlay } from '../lib/types';
import { overlaySvg } from '../lib/overlay';
import { overlayPreviewTime } from '../lib/overlayAssets';

export interface TextTemplate { id: string; name: string; category: string; description: string; create: (width: number, height: number) => NativeOverlay[] }
const text = (w: number, h: number, content: string, patch: Partial<TitleOverlay> = {}): TitleOverlay => {
  const size = Math.min(w * .072, h * .12);
  const result: TitleOverlay = { kind: 'title', text: content, fontFamily: 'Arial', fontSize: size, fontWeight: 400, color: '#FFFFFF', x: w * .1, y: h * .42, blockWidth: w * .8, lineHeight: size * 1.2, align: 'center', animationDuration: 5, ...patch };
  return { ...result, fontSize: Math.max(1,Math.min(2000,result.fontSize)), lineHeight: Math.max(1,Math.min(10000,result.lineHeight)) };
};
export const TEXT_CATEGORIES = ['All styles', 'Basic', 'Headings', 'Lower thirds', 'Cinematic', 'Animated', 'Credits', 'My assets'];
export const TEXT_TEMPLATES: TextTemplate[] = [
  { id: 'simple', name: 'Simple text', category: 'Basic', description: 'A clean, centered title', create: (w,h) => [text(w,h,uiText("Your text"))] },
  { id: 'bold', name: 'Bold statement', category: 'Headings', description: 'Strong, oversized heading', create: (w,h) => [text(w,h,uiText("MAKE\nIT HAPPEN"),{ fontWeight: 900, fontSize: Math.min(w*.12,h*.18), y: h*.29, lineHeight: Math.min(w*.125,h*.19) })] },
  { id: 'title-subtitle', name: 'Title + subtitle', category: 'Basic', description: 'Two independently editable text layers', create: (w,h) => [text(w,h,uiText("Your title"),{ fontWeight: 700, y:h*.34 }),text(w,h,uiText("The story starts here"),{ fontSize:Math.min(w*.037,h*.055),y:h*.55,color:'#DDE4EB' })] },
  { id: 'editorial', name: 'Editorial', category: 'Cinematic', description: 'A serif title with a quiet byline', create: (w,h) => [text(w,h,uiText("A new\nperspective"),{fontFamily:'Georgia',fontSize:Math.min(w*.085,h*.13),lineHeight:Math.min(w*.09,h*.14),y:h*.27}),text(w,h,uiText("A FILM BY YOU"),{fontSize:Math.min(w*.023,h*.033),y:h*.66,color:'#FFCF63'})] },
  { id: 'lower-name', name: 'Name & role', category: 'Lower thirds', description: 'A left-aligned name and role', create: (w,h) => [text(w,h,'Alex Morgan',{fontWeight:700,fontSize:Math.min(w*.055,h*.085),align:'left',y:h*.72}),text(w,h,uiText("DESIGNER / STORYTELLER"),{fontSize:Math.min(w*.025,h*.037),align:'left',y:h*.83,color:'#65DDD3'})] },
  { id: 'location', name: 'On location', category: 'Lower thirds', description: 'Location label with an accent line', create: (w,h) => [text(w,h,'BELGRADE',{fontWeight:700,fontSize:Math.min(w*.045,h*.07),align:'left',y:h*.76}),text(w,h,'44.7866° N · 20.4489° E',{fontFamily:'Consolas',fontSize:Math.min(w*.023,h*.034),align:'left',y:h*.85,color:'#FFCF63'})] },
  { id: 'chapter', name: 'Chapter opener', category: 'Headings', description: 'Chapter number and large heading', create: (w,h) => [text(w,h,uiText("01 / THE BEGINNING"),{align:'left',fontSize:Math.min(w*.027,h*.04),color:'#FFCF63',y:h*.26}),text(w,h,uiText("Every story\nstarts somewhere"),{align:'left',fontWeight:700,fontSize:Math.min(w*.075,h*.115),lineHeight:Math.min(w*.08,h*.125),y:h*.38})] },
  { id: 'quote', name: 'Pull quote', category: 'Cinematic', description: 'A centered serif quote', create: (w,h) => [text(w,h,uiText("“Stay curious.\nKeep creating.”"),{fontFamily:'Georgia',fontSize:Math.min(w*.075,h*.11),lineHeight:Math.min(w*.085,h*.13),y:h*.3,color:'#FFCF63'}),text(w,h,uiText("YOUR NAME"),{fontSize:Math.min(w*.023,h*.032),y:h*.65})] },
  { id: 'minimal', name: 'Quiet text', category: 'Basic', description: 'Small independent text with generous space', create: (w,h) => [text(w,h,uiText("A moment to remember"),{fontSize:Math.min(w*.03,h*.045),y:h*.76,color:'#DDE4EB'})] },
  { id: 'poster', name: 'Poster title', category: 'Headings', description: 'Condensed type and stacked hierarchy', create: (w,h) => [text(w,h,uiText("THE\nNEXT WAVE"),{fontFamily:'Impact',fontSize:Math.min(w*.13,h*.2),lineHeight:Math.min(w*.135,h*.205),y:h*.24,color:'#9CE49F'})] },
  { id: 'fade', name: 'Soft reveal', category: 'Animated', description: 'Native fade in and out', create: (w,h) => [text(w,h,uiText("Something\nbeautiful"),{fontFamily:'Georgia',fontSize:Math.min(w*.075,h*.11),lineHeight:Math.min(w*.085,h*.13),y:h*.32,fadeIn:.9,fadeOut:.9})] },
  { id: 'endcard', name: 'End card', category: 'Animated', description: 'Two-layer outro with staggered fades', create: (w,h) => [text(w,h,uiText("THANK YOU"),{fontWeight:800,fontSize:Math.min(w*.08,h*.12),y:h*.35,fadeIn:.5,fadeOut:.7}),text(w,h,uiText("See you in the next one"),{fontSize:Math.min(w*.033,h*.05),y:h*.55,color:'#9AA5FF',fadeIn:1.3,fadeOut:.7})] },
  { id: 'rolling', name: 'Rolling credits', category: 'Credits', description: 'An editable native credit roll', create: (w,h) => [text(w,h,uiText("A CUTWRIGHT FILM\n\nDirected by\nYour name\n\nCreated with\nYour team\n\nThank you for watching"),{fontSize:Math.min(w*.04,h*.06),lineHeight:Math.min(w*.065,h*.09),y:0,animationDuration:12,scroll:{fromY:h,toY:-h*1.2,duration:12},fadeIn:.3,fadeOut:.3})] },
  { id: 'credit-slate', name: 'Credit slate', category: 'Credits', description: 'A restrained, static closing slate', create: (w,h) => [text(w,h,uiText("CREATED BY"),{fontSize:Math.min(w*.023,h*.035),color:'#DDE4EB',y:h*.31}),text(w,h,uiText("Your name"),{fontFamily:'Georgia',fontSize:Math.min(w*.07,h*.1),y:h*.43}),text(w,h,uiText("© 2026  /  ALL RIGHTS RESERVED"),{fontSize:Math.min(w*.019,h*.028),y:h*.68,color:'#DDE4EB'})] },
];
export const ELEMENT_TEMPLATES: TextTemplate[] = [
  { id: 'draw-arrow', name: 'Drawn arrow', category: 'Arrows', description: 'Animated directional pointer', create: (w,h) => [{kind:'arrow',x1:w*.25,y1:h*.68,x2:w*.72,y2:h*.32,width:Math.max(.1,Math.min(w,h)*.012),head:true,color:'#FFCF63',drawDuration:.7,animationDuration:5}] },
  { id: 'line', name: 'Accent line', category: 'Lines', description: 'An editable animated line', create: (w,h) => [{kind:'arrow',x1:w*.2,y1:h*.55,x2:w*.8,y2:h*.55,width:Math.max(.1,Math.min(w,h)*.008),head:false,color:'#65DDD3',drawDuration:.5,animationDuration:5}] },
  { id: 'callout', name: 'Look here', category: 'Callouts', description: 'Editable text and pointer', create: (w,h) => [text(w,h,uiText("LOOK HERE"),{fontWeight:700,fontSize:Math.min(w*.055,h*.075),y:h*.21,color:'#FFCF63'}),{kind:'arrow',x1:w*.48,y1:h*.38,x2:w*.7,y2:h*.7,width:Math.max(.1,Math.min(w,h)*.01),head:true,color:'#FFCF63',drawDuration:.8,animationDuration:5}] },
];

/** Compose the exact native overlays used by preview and both exports. */
export function templatePreview(overlays: NativeOverlay[], width: number, height: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${overlays.map(o => overlaySvg(o,width,height,overlayPreviewTime(o,{width,height}))).join('')}</svg>`)}`;
}

/** Insert every layer in one immutable project edit and one undo step. */
export function insertTemplate(project: Project, name: string, overlays: NativeOverlay[], at: number): { project: Project; selectedId: string } {
  const ids = [...new Set([...(project.trackOrder ?? []), ...Object.keys(project.trackSettings ?? {}), ...project.clips.map(c=>c.trackId)])];
  let track = Math.max(1,...ids.filter(id=>/^v\d+$/.test(id)).map(id=>Number(id.slice(1))));
  const media: MediaItem[] = [], clips: Clip[] = [], tracks: string[] = [];
  overlays.forEach((overlay,i) => {
    const trackId = `v${++track}`; tracks.unshift(trackId);
    const duration = Math.max(.2,(overlay.animationDuration ?? 5)-(overlay.animationOffset ?? 0));
    const label = overlays.length > 1 ? `${name} · ${i === 0 ? uiText("Title") : overlay.kind === 'title' ? uiText("Subtitle") : uiText("Pointer")}` : name;
    const item: MediaItem = {id:crypto.randomUUID(),name:label,kind:'image',src:'',duration,color:overlay.color.slice(0,7),width:project.width,height:project.height,overlay:structuredClone(overlay)};
    media.push(item); clips.push({id:crypto.randomUUID(),mediaId:item.id,name:label,trackId,start:at,duration,offset:0,color:item.color,overlay:structuredClone(overlay)});
  });
  const previousOrder = [...(project.trackOrder ?? []), ...ids.filter(t=>t.startsWith('v')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})), ...ids.filter(t=>!t.startsWith('v'))];
  return {project:{...project,media:[...project.media,...media],clips:[...project.clips,...clips],trackOrder:[...new Set([...tracks,...previousOrder])]},selectedId:clips[0].id};
}
