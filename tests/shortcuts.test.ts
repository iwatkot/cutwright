import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingFromEvent, bindingsFor, decodeShortcutOverrides, matchShortcut, SHORTCUTS, validateBindings, type ShortcutEvent } from '../src/lib/shortcuts';
import { useShortcutPreferences } from '../src/lib/shortcutPreferences';
const key = (code: string, modifiers: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
afterEach(() => { vi.unstubAllGlobals(); useShortcutPreferences.setState({ overrides: {}, sessionOnly: false }); });
describe('editor shortcut configuration', () => {
  it('has unambiguous defaults except the intentional preview hold/play context', () => {
    for (const row of SHORTCUTS) expect(validateBindings(row.id, [...row.defaults], {}), row.id).toBeUndefined();
    expect(matchShortcut(key('Space'), {})).toBe('play');
    expect(matchShortcut(key('Space'), {}, 'panHold')).toBe('panHold');
  });
  it('retains editing aliases and distinguishes navigation modifiers', () => {
    for (const event of [key('KeyC'), key('KeyB', { ctrlKey: true }), key('KeyK', { metaKey: true })]) expect(matchShortcut(event, {})).toBe('split');
    expect(matchShortcut(key('ArrowLeft'), {})).toBe('frameBack');
    expect(matchShortcut(key('ArrowLeft', { shiftKey: true }), {})).toBe('secondBack');
    expect(matchShortcut(key('ArrowLeft', { shiftKey: true, ctrlKey: true }), {})).toBe('previousMarker');
    expect(matchShortcut(key('NumpadAdd'), {})).toBe('zoomIn');
    expect(matchShortcut(key('NumpadSubtract', { ctrlKey: true }), {})).toBe('zoomOut');
  });
  it('replaces defaults rather than silently retaining them, and supports clearing every alias', () => {
    const overrides = { saveProject: ['F8'], delete: [] };
    expect(matchShortcut(key('F8'), overrides)).toBe('saveProject');
    expect(matchShortcut(key('KeyS', { ctrlKey: true }), overrides)).toBeUndefined();
    expect(matchShortcut(key('Delete'), overrides)).toBeUndefined();
    expect(matchShortcut(key('Backspace'), overrides)).toBeUndefined();
    expect(matchShortcut(key('F8', { shiftKey: true }), overrides)).toBeUndefined();
  });
  it('uses physical letter positions across layouts and accepts Command as Ctrl', () => {
    expect(bindingFromEvent(key('KeyS', { key: 'ы', metaKey: true }))).toBe('Mod+KeyS');
    expect(bindingFromEvent(key('', { key: 's', ctrlKey: true }))).toBe('Mod+KeyS');
    expect(bindingFromEvent(key('KeyS', { ctrlKey: true, metaKey: true }))).toBeNull();
  });
  it('rejects conflicting actions and duplicate aliases without modifying the configuration', () => {
    expect(validateBindings('saveProject', ['KeyC'], {})).toContain('Split at playhead');
    expect(validateBindings('saveProject', ['F8', 'F8'], {})).toContain('already assigned');
    expect(validateBindings('panHold', ['KeyK'], {})).toBeUndefined();
    expect(validateBindings('panHold', ['Mod+KeyS'], {})).toContain('Save project');
  });
  it('reserves control navigation and ignores modifier-only keypresses', () => {
    for (const code of ['Escape', 'Tab', 'ControlLeft', 'ShiftLeft', 'MetaLeft']) expect(bindingFromEvent(key(code))).toBeNull();
    expect(validateBindings('play', ['Escape'], {})).toContain('reserved');
  });
  it('loads saved unassigned actions, rejects ambiguous/corrupt data and ignores unknown actions', () => {
    const overrides = decodeShortcutOverrides(JSON.stringify({ version: 1, bindings: { play: [], saveProject: ['F8'], unknown: ['F9'] } }));
    expect(bindingsFor('play', overrides)).toEqual([]);
    expect(bindingsFor('saveProject', overrides)).toEqual(['F8']);
    expect(overrides).not.toHaveProperty('unknown');
    for (const raw of ['broken', '{"version":2}', JSON.stringify({ version: 1, bindings: { play: ['F8'], saveProject: ['F8'] } })]) expect(decodeShortcutOverrides(raw)).toEqual({});
  });
  it('keeps remaps usable for the session when browser storage fails and restores defaults', () => {
    vi.stubGlobal('localStorage', { setItem() { throw new Error('Storage unavailable'); } });
    expect(useShortcutPreferences.getState().setBindings('saveProject', ['F8'])).toBeUndefined();
    expect(useShortcutPreferences.getState().sessionOnly).toBe(true);
    expect(bindingsFor('saveProject', useShortcutPreferences.getState().overrides)).toEqual(['F8']);
    expect(useShortcutPreferences.getState().setBindings('play', ['F8'])).toContain('Save project');
    useShortcutPreferences.getState().resetAll();
    expect(bindingsFor('saveProject', useShortcutPreferences.getState().overrides)).toEqual(['Mod+KeyS']);
  });
});
