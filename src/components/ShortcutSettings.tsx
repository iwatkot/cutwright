import { t as uiText } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from './ui/Controls';
import { IconButton, IconClose, IconKeyboard, IconPlus, IconUndo } from './icons';
import { bindingFromEvent, bindingsFor, formatBinding, SHORTCUTS, type ShortcutAction } from '../lib/shortcuts';
import { useShortcutPreferences } from '../lib/shortcutPreferences';
import './shortcuts.css';

export default function ShortcutSettings({ onClose }: { onClose: () => void }) {
  const locale = useLocale();
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const { overrides, sessionOnly, setBindings, resetAll } = useShortcutPreferences();
  const [search, setSearch] = useState('');
  const [listening, setListening] = useState<{ action: ShortcutAction; index: number } | null>(null);
  const [message, setMessage] = useState(uiText("Changes save automatically on this device."));
  const [error, setError] = useState(false);
  const restoreFocus = useRef<{ action: ShortcutAction; index: number } | null>(null);
  const feedback = (problem?: string, success = uiText("Shortcut saved.")) => { setMessage(problem || success); setError(!!problem); };
  useEffect(() => { setMessage(uiText("Changes save automatically on this device.")); setError(false); setListening(null); }, [locale]);
  useEffect(() => {
    if (listening || !restoreFocus.current) return;
    const { action, index } = restoreFocus.current;
    restoreFocus.current = null;
    (dialog.current?.querySelector<HTMLButtonElement>(`[data-shortcut-action="${action}"][data-shortcut-index="${index}"]`) ?? dialog.current?.querySelector<HTMLButtonElement>(`[data-shortcut-add="${action}"]`))?.focus();
  }, [listening, overrides]);
  useEffect(() => {
    if (!listening) return;
    const capture = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') { restoreFocus.current = listening; setListening(null); feedback(undefined, uiText("Recording cancelled.")); return; }
      const binding = bindingFromEvent(event);
      if (!binding) {
        if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) feedback(uiText("Choose a key combination. Tab and Escape are reserved for controls."));
        return;
      }
      const current = [...bindingsFor(listening.action, useShortcutPreferences.getState().overrides)];
      current[listening.index] = binding;
      const problem = setBindings(listening.action, current);
      feedback(problem);
      if (!problem) { restoreFocus.current = listening; setListening(null); }
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [listening, setBindings]);
  const shown = SHORTCUTS.filter(row => `${uiText(row.label)} ${uiText(row.group)}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <div className="modalback" onClick={onClose}>
    <div ref={dialog} className="modal shortcut-settings" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <div className="shortcut-heading"><IconKeyboard /><h2 id="shortcuts-title">{uiText("Keyboard shortcuts")}</h2><IconButton label={uiText("Close keyboard shortcuts")} onClick={onClose}><IconClose /></IconButton></div>
      <input className="shortcut-search" aria-label={uiText("Search shortcuts")} placeholder={uiText("Find an action…")} value={search} onChange={event => { setSearch(event.target.value); setListening(null); }} />
      <p className="shortcut-help">{uiText("Click a key to change it, + to add, or × to remove. Press Escape to cancel recording. Ctrl also works as Command on macOS.")}</p>
      <div className="shortcut-list">
        {shown.length === 0 && <p className="hint">{uiText("No matching actions.")}</p>}
        {[...new Set(shown.map(row => uiText(row.group)))].map(group => <section key={group} aria-label={uiText("{0} shortcuts", { 0: group })}>
          <h3>{group}</h3>
          {shown.filter(row => uiText(row.group) === group).map(row => {
            const bindings = bindingsFor(row.id, overrides);
            return <div key={row.id} className="shortcut-row" role="group" aria-label={uiText("{0} shortcuts", { 0: uiText(row.label) })}>
              <span>{uiText(row.label)}{row.id === 'panHold' && <small>{uiText("While the preview is active")}</small>}</span>
              <div className="shortcut-bindings">
                {bindings.map((binding, index) => <span className="shortcut-binding" key={`${index}-${binding}`}>
                  <button data-shortcut-action={row.id} data-shortcut-index={index} className={listening?.action === row.id && listening.index === index ? 'recording' : ''} aria-label={uiText("Change {0} shortcut: {1}", { 0: uiText(row.label), 1: formatBinding(binding) })} onClick={() => { setListening({ action: row.id, index }); feedback(undefined, uiText("Press the new key combination…")); }}>{listening?.action === row.id && listening.index === index ? uiText("Press keys…") : formatBinding(binding)}</button>
                  <button className="shortcut-remove" aria-label={uiText("Remove {0} shortcut: {1}", { 0: uiText(row.label), 1: formatBinding(binding) })} data-tooltip={uiText("Remove shortcut")} onClick={() => { restoreFocus.current = { action: row.id, index: -1 }; setListening(null); feedback(setBindings(row.id, bindings.filter((_, i) => i !== index)), uiText("Shortcut removed.")); }}><IconClose /></button>
                </span>)}
                {listening?.action === row.id && listening.index === bindings.length && <span className="shortcut-pending">{uiText("Press keys…")}</span>}
                {!bindings.length && listening?.action !== row.id && <span className="shortcut-unassigned">{uiText("Unassigned")}</span>}
                <IconButton data-shortcut-add={row.id} label={uiText("Add {0} shortcut", { 0: uiText(row.label) })} title={uiText("Add shortcut")} disabled={bindings.length >= 8} onClick={() => { setListening({ action: row.id, index: bindings.length }); feedback(undefined, uiText("Press the new key combination…")); }}><IconPlus /></IconButton>
                <IconButton label={uiText("Reset {0} shortcuts", { 0: uiText(row.label) })} title={uiText("Restore this action’s defaults")} disabled={overrides[row.id] === undefined} onClick={() => { setListening(null); feedback(setBindings(row.id, [...row.defaults]), uiText("Action defaults restored.")); }}><IconUndo /></IconButton>
              </div>
            </div>;
          })}
        </section>)}
      </div>
      <p className={`shortcut-feedback ${error ? 'error' : ''}`} role="status" aria-live="polite">{sessionOnly ? uiText("Browser storage is unavailable; changes last for this session. ") : ''}{message}</p>
      <div className="shortcut-footer"><button onClick={() => { resetAll(); setListening(null); feedback(undefined, uiText("All default shortcuts restored.")); }}>{uiText("Restore all defaults")}</button><button className="primary" onClick={onClose}>{uiText("Done")}</button></div>
    </div>
  </div>;
}
