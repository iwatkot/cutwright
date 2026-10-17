import { t as uiText } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { loadOverlayAssets, scaleOverlay } from '../lib/overlayAssets';
import { ELEMENT_TEMPLATES, insertTemplate, templatePreview, TEXT_CATEGORIES, TEXT_TEMPLATES, type TextTemplate } from './textTemplates';
import { SelectControl } from './ui/Controls';
import { toast } from './TopBar';
import { validateOverlay } from '../lib/overlay';
import './overlay.css';

export default function OverlayLibrary({ elements = false }: { elements?: boolean }) {
  const locale = useLocale();
  const [assets, setAssets] = useState(loadOverlayAssets);
  const [query,setQuery] = useState(''), [category,setCategory] = useState('All styles');
  useEffect(() => { const refresh = () => setAssets(loadOverlayAssets()); window.addEventListener('cw-overlay-assets',refresh); return () => window.removeEventListener('cw-overlay-assets',refresh); }, []);
  const saved = useMemo<TextTemplate[]>(() => assets.filter(a=>elements ? a.overlay.kind === 'arrow' : a.overlay.kind === 'title').map(a=>({id:a.id,name:a.name,category:'My assets',description:uiText("Your saved editable style"),create:(width,height)=>[scaleOverlay(a.overlay,a,{width,height})]})),[assets,elements,locale]);
  const all = [...(elements ? ELEMENT_TEMPLATES : TEXT_TEMPLATES).map(template => ({ ...template, name: uiText(template.name), description: uiText(template.description) })),...saved];
  const shown = all.filter(t=>(category === 'All styles' || category === t.category) && `${t.name} ${uiText(t.category)} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  const categories = elements ? ['All styles','Arrows','Lines','Callouts','My assets'] : TEXT_CATEGORIES;
  const add = (template: TextTemplate) => { const s = useStore.getState(); const layers = template.create(s.project.width,s.project.height); if (layers.some(layer=>validateOverlay(layer).length)) { toast(uiText("This style could not be added at the current project size.")); return; } const result = insertTemplate(s.project,template.name,layers,s.playhead); s.setProject(result.project); s.selectClip(result.selectedId); toast(uiText("{0} added{1}. Edit it in the inspector.", { 0: template.name, 1: layers.length>1 ? uiText(" · {0} editable layers", { 0: layers.length }) : '' })); };
  return <div className="text-library">
    <header className="galleryhead"><div><h2>{elements ? uiText("Elements") : uiText("Text")}</h2><p>{elements ? uiText("Native pointers, lines and callouts.") : uiText("Titles and typography. Every layer is editable.")}</p></div></header>
    <div className="text-library-tools"><input aria-label={elements ? uiText("Search elements") : uiText("Search text templates")} placeholder={elements ? uiText("Search elements…") : uiText("Search text styles…")} value={query} onChange={e=>setQuery(e.target.value)} /><SelectControl label={elements ? uiText("Element category") : uiText("Text category")} value={category} onChange={setCategory} options={categories.map(c=>({value:c,label:uiText(c),description:c === 'My assets' ? uiText("{0} saved styles", { 0: saved.length }) : undefined}))} /></div>
    <div className="text-library-scroll"><div className="template-count">{category === 'All styles' ? elements ? uiText("ELEMENTS") : uiText("TEMPLATE LIBRARY") : uiText(category).toLocaleUpperCase(locale)}<span>{shown.length}</span></div><div className="text-template-grid">{shown.map(t=>{ const layers=t.create(1920,1080); return <button type="button" key={t.id} className="text-template" aria-label={uiText("Add {0}", { 0: t.name })} data-tooltip={uiText("{0} · Add at playhead", { 0: t.description })} onClick={()=>add(t)}><div className="text-template-art"><img alt="" src={templatePreview(layers,1920,1080)} />{layers.length>1 && <span className="template-layers">{uiText("Layers: {0}", { 0: layers.length })}</span>}{t.category === 'Animated' && <span className="template-motion" aria-hidden="true">◷</span>}</div><span>{t.name}</span><small>{uiText(t.category)}</small></button>;})}</div>{!shown.length && <div className="empty">{category === 'My assets' ? uiText("Save a selected title or element in the inspector to reuse it here.") : uiText("No matching styles. Try another search or category.")}</div>}<p className="template-note">{elements ? uiText("Added on their own timeline tracks.") : uiText("Text clips are independent of captions.")}{" "}{uiText("Saved assets stay on this device.")}</p></div>
  </div>;
}
