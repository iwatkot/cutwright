import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { loadOverlayAssets, scaleOverlay } from '../lib/overlayAssets';
import { ELEMENT_TEMPLATES, insertTemplate, templatePreview, TEXT_CATEGORIES, TEXT_TEMPLATES, type TextTemplate } from './textTemplates';
import { SelectControl } from './ui/Controls';
import { toast } from './TopBar';
import { validateOverlay } from '../lib/overlay';
import './overlay.css';

export default function OverlayLibrary({ elements = false }: { elements?: boolean }) {
  const [assets, setAssets] = useState(loadOverlayAssets);
  const [query,setQuery] = useState(''), [category,setCategory] = useState('All styles');
  useEffect(() => { const refresh = () => setAssets(loadOverlayAssets()); window.addEventListener('cw-overlay-assets',refresh); return () => window.removeEventListener('cw-overlay-assets',refresh); }, []);
  const saved = useMemo<TextTemplate[]>(() => assets.filter(a=>elements ? a.overlay.kind === 'arrow' : a.overlay.kind === 'title').map(a=>({id:a.id,name:a.name,category:'My assets',description:'Your saved editable style',create:(width,height)=>[scaleOverlay(a.overlay,a,{width,height})]})),[assets,elements]);
  const all = [...(elements ? ELEMENT_TEMPLATES : TEXT_TEMPLATES),...saved];
  const shown = all.filter(t=>(category === 'All styles' || category === t.category) && `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  const categories = elements ? ['All styles','Arrows','Lines','Callouts','My assets'] : TEXT_CATEGORIES;
  const add = (template: TextTemplate) => { const s = useStore.getState(); const layers = template.create(s.project.width,s.project.height); if (layers.some(layer=>validateOverlay(layer).length)) { toast('This style could not be added at the current project size.'); return; } const result = insertTemplate(s.project,template.name,layers,s.playhead); s.setProject(result.project); s.selectClip(result.selectedId); toast(`${template.name} added${layers.length>1 ? ` · ${layers.length} editable layers` : ''}. Edit it in the inspector.`); };
  return <div className="text-library">
    <header className="galleryhead"><div><h2>{elements ? 'Elements' : 'Text'}</h2><p>{elements ? 'Native pointers, lines and callouts.' : 'Titles and typography. Every layer is editable.'}</p></div></header>
    <div className="text-library-tools"><input aria-label={elements ? 'Search elements' : 'Search text templates'} placeholder={elements ? 'Search elements…' : 'Search text styles…'} value={query} onChange={e=>setQuery(e.target.value)} /><SelectControl label={elements ? 'Element category' : 'Text category'} value={category} onChange={setCategory} options={categories.map(c=>({value:c,label:c,description:c === 'My assets' ? `${saved.length} saved styles` : undefined}))} /></div>
    <div className="text-library-scroll"><div className="template-count">{category === 'All styles' ? elements ? 'ELEMENTS' : 'TEMPLATE LIBRARY' : category.toUpperCase()}<span>{shown.length}</span></div><div className="text-template-grid">{shown.map(t=>{ const layers=t.create(1920,1080); return <button type="button" key={t.id} className="text-template" aria-label={`Add ${t.name}`} data-tooltip={`${t.description} · Add at playhead`} onClick={()=>add(t)}><div className="text-template-art"><img alt="" src={templatePreview(layers,1920,1080)} />{layers.length>1 && <span className="template-layers">{layers.length} layers</span>}{t.category === 'Animated' && <span className="template-motion" aria-hidden="true">◷</span>}</div><span>{t.name}</span><small>{t.category}</small></button>;})}</div>{!shown.length && <div className="empty">{category === 'My assets' ? 'Save a selected title or element in the inspector to reuse it here.' : 'No matching styles. Try another search or category.'}</div>}<p className="template-note">{elements ? 'Added on their own timeline tracks.' : 'Text clips are independent of captions.'} Saved assets stay on this device.</p></div>
  </div>;
}
