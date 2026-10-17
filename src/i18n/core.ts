import en from './messages/en.json';
import de from './messages/de.json';
import da from './messages/da.json';
import hr from './messages/hr.json';
import sr from './messages/sr.json';
import cs from './messages/cs.json';
import nl from './messages/nl.json';
import fr from './messages/fr.json';
import es from './messages/es.json';
import ru from './messages/ru.json';
import uk from './messages/uk.json';
import { LOCALES, localeFromTag, type Locale } from './locales';

export const messages: Record<Locale, Record<string, string>> = { en, de, da, hr, sr, cs, nl, fr, es, ru, uk };
const storageKey = 'cutwright.language';
const listeners = new Set<() => void>();
function initialLocale(): Locale {
  try {
    const saved = localeFromTag(typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey));
    if (saved) return saved;
  } catch { /* Use the browser preference when storage is unavailable. */ }
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
    for (const language of navigator.languages || [navigator.language]) {
      const match = localeFromTag(language); if (match) return match;
    }
  }
  return 'en';
}
const explicitLocale = typeof location === 'undefined' ? undefined : localeFromTag(new URLSearchParams(location.search).get('lang'));
let current = explicitLocale ?? initialLocale();
if (explicitLocale) { try { localStorage.setItem(storageKey, explicitLocale); } catch { /* This tab still uses the explicit choice. */ } }
export const getLocale = () => current;
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setLocale(locale: Locale): void {
  if (!LOCALES.includes(locale)) return;
  try { localStorage.setItem(storageKey, locale); } catch { /* This session still changes. */ }
  if (typeof location !== 'undefined' && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) { url.searchParams.set('lang', locale); history.replaceState(history.state, '', url); }
  }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = locale === 'sr' ? 'sr-Latn' : locale;
  if (locale === current) return;
  current = locale; listeners.forEach(listener => listener());
}
if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = current === 'sr' ? 'sr-Latn' : current;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) setLocale(initialLocale());
});
export type MessageValues = Record<string, unknown>;
export function t(key: string, values: MessageValues = {}): string {
  const translated = messages[current][key];
  if (translated === undefined && Object.hasOwn(messages.en, key)) throw new Error(`Missing ${current} translation: ${key}`);
  const template = translated ?? key;
  return template.replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(values, name) ? String(values[name]) : token);
}
