import { create } from 'zustand';
import { bindingsFor, decodeShortcutOverrides, formatBinding, matchShortcut, validateBindings, type ShortcutAction, type ShortcutEvent, type ShortcutOverrides } from './shortcuts';
const KEY = 'cutwright.shortcuts';
function read(): ShortcutOverrides { try { return decodeShortcutOverrides(localStorage.getItem(KEY)); } catch { return {}; } }
type Preferences = {
  overrides: ShortcutOverrides;
  sessionOnly: boolean;
  setBindings(action: ShortcutAction, bindings: string[]): string | undefined;
  resetAll(): void;
};
export const useShortcutPreferences = create<Preferences>((set, get) => {
  const persist = (overrides: ShortcutOverrides) => {
    let sessionOnly = false;
    try { localStorage.setItem(KEY, JSON.stringify({ version: 1, bindings: overrides })); } catch { sessionOnly = true; }
    set({ overrides, sessionOnly });
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('cw-shortcuts-changed'));
  };
  return { overrides: read(), sessionOnly: false,
    setBindings(action, bindings) {
      const error = validateBindings(action, bindings, get().overrides);
      if (error) return error;
      persist({ ...get().overrides, [action]: [...bindings] });
    },
    resetAll() { persist({}); },
  };
});
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) { useShortcutPreferences.setState({ overrides: read(), sessionOnly: false }); window.dispatchEvent(new Event('cw-shortcuts-changed')); }
});
export const matchConfiguredShortcut = (event: ShortcutEvent, action?: ShortcutAction) => matchShortcut(event, useShortcutPreferences.getState().overrides, action);
export function useShortcutLabel(action?: ShortcutAction): string {
  const overrides = useShortcutPreferences(state => state.overrides);
  return action ? bindingsFor(action, overrides).map(formatBinding).join(' / ') : '';
}
