import { useEffect, useState } from 'react';
import { SelectControl } from './Controls';

export type ThemePreference = 'auto' | 'light' | 'dark';
const KEY = 'cutwright.theme';
let sessionTheme: ThemePreference | undefined;
function readTheme(): ThemePreference { if (sessionTheme) return sessionTheme; try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark') return v; } catch { /* preferences can be unavailable */ } return 'auto'; }
function applyTheme(preference: ThemePreference) {
  const resolved = preference === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
}
export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(readTheme());
    const sync = () => { setTheme(readTheme()); update(); };
    const storage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) { sessionTheme = undefined; sync(); } };
    update(); media.addEventListener('change', update); window.addEventListener('storage', storage); window.addEventListener('cw-theme', sync);
    return () => { media.removeEventListener('change', update); window.removeEventListener('storage', storage); window.removeEventListener('cw-theme', sync); };
  }, []);
  return [theme, (next: ThemePreference) => { sessionTheme = next; try { localStorage.setItem(KEY, next); } catch { /* still apply for this session */ } setTheme(next); applyTheme(next); window.dispatchEvent(new Event('cw-theme')); }] as const;
}
export function ThemeControl() {
  const [theme, setTheme] = useTheme();
  return <SelectControl label="Appearance" className="theme-control" value={theme} onChange={v => setTheme(v as ThemePreference)} options={[{ value: 'auto', label: 'Auto', description: 'Follow your device appearance' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />;
}
