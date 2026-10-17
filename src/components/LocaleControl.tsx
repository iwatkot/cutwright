import { useState } from 'react';
import { IconButton, IconCheck, IconGlobe } from './icons';
import type { SurfaceAnchor } from './ui/FloatingSurface';
import ContextMenu from './ui/ContextMenu';
import { setLocale, t as uiText } from '../i18n/core';
import { LANGUAGE_NAMES, LOCALES } from '../i18n/locales';
import { useLocale } from '../i18n/react';

export default function LocaleControl() {
  const locale = useLocale();
  const [anchor, setAnchor] = useState<SurfaceAnchor | null>(null);
  return <>
    <IconButton data-language-toggle label={uiText('Language')} aria-haspopup="menu" aria-expanded={!!anchor} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setAnchor(anchor ? null : { x: rect.left, y: rect.top, bottom: rect.bottom + 5 });
    }}><IconGlobe /></IconButton>
    {anchor && <ContextMenu anchor={anchor} label={uiText('Language')} onClose={() => setAnchor(null)} actions={LOCALES.map(value => ({ label: LANGUAGE_NAMES[value], lang: value === 'sr' ? 'sr-Latn' : value, checked: locale === value, icon: locale === value ? <IconCheck /> : undefined, run: () => setLocale(value) }))} />}
  </>;
}
