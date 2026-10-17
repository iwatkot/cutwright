export const SHORTCUTS = [
  { id: 'newProject', label: 'New project', group: 'Project', defaults: [] },
  { id: 'openProject', label: 'Open project', group: 'Project', defaults: ['Mod+KeyO'] },
  { id: 'saveProject', label: 'Save project', group: 'Project', defaults: ['Mod+KeyS'] },
  { id: 'importMedia', label: 'Import media', group: 'Project', defaults: [] },
  { id: 'export', label: 'Focus export', group: 'Project', defaults: ['Mod+KeyE'] },
  { id: 'agent', label: 'Agent connection', group: 'Project', defaults: ['Mod+Slash'] },
  { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Project', defaults: [] },
  { id: 'theme', label: 'Cycle appearance', group: 'Project', defaults: [] },
  { id: 'play', label: 'Play / pause', group: 'Playback', defaults: ['Space', 'KeyK'] },
  { id: 'seekBack', label: 'Seek back 2 seconds', group: 'Playback', defaults: ['KeyJ'] },
  { id: 'seekForward', label: 'Seek forward 2 seconds', group: 'Playback', defaults: ['KeyL'] },
  { id: 'frameBack', label: 'Previous frame', group: 'Playback', defaults: ['ArrowLeft'] },
  { id: 'frameForward', label: 'Next frame', group: 'Playback', defaults: ['ArrowRight'] },
  { id: 'secondBack', label: 'Seek back 1 second', group: 'Playback', defaults: ['Shift+ArrowLeft'] },
  { id: 'secondForward', label: 'Seek forward 1 second', group: 'Playback', defaults: ['Shift+ArrowRight'] },
  { id: 'boundaryBack', label: 'Previous clip boundary', group: 'Playback', defaults: ['ArrowUp'] },
  { id: 'boundaryForward', label: 'Next clip boundary', group: 'Playback', defaults: ['ArrowDown'] },
  { id: 'start', label: 'Go to start', group: 'Playback', defaults: ['Home', 'KeyI'] },
  { id: 'end', label: 'Go to end', group: 'Playback', defaults: ['End', 'KeyO'] },
  { id: 'split', label: 'Split at playhead', group: 'Editing', defaults: ['KeyC', 'Mod+KeyB', 'Mod+KeyK'] },
  { id: 'delete', label: 'Delete selection', group: 'Editing', defaults: ['Delete', 'Backspace'] },
  { id: 'undo', label: 'Undo', group: 'Editing', defaults: ['Mod+KeyZ'] },
  { id: 'redo', label: 'Redo', group: 'Editing', defaults: ['Mod+KeyY', 'Mod+Shift+KeyZ'] },
  { id: 'addMarker', label: 'Add marker', group: 'Timeline', defaults: ['Mod+KeyM'] },
  { id: 'previousMarker', label: 'Previous marker', group: 'Timeline', defaults: ['Mod+Shift+ArrowLeft'] },
  { id: 'nextMarker', label: 'Next marker', group: 'Timeline', defaults: ['Mod+Shift+ArrowRight'] },
  { id: 'snapping', label: 'Toggle timeline snapping', group: 'Timeline', defaults: ['KeyS'] },
  { id: 'zoomIn', label: 'Zoom timeline in', group: 'Timeline', defaults: ['Equal', 'Shift+Equal', 'Mod+Equal', 'Mod+Shift+Equal', 'NumpadAdd', 'Mod+NumpadAdd'] },
  { id: 'zoomOut', label: 'Zoom timeline out', group: 'Timeline', defaults: ['Minus', 'Shift+Minus', 'Mod+Minus', 'Mod+Shift+Minus', 'NumpadSubtract', 'Mod+NumpadSubtract'] },
  { id: 'previewFit', label: 'Fit preview', group: 'Preview', defaults: [] },
  { id: 'previewZoomIn', label: 'Zoom preview in', group: 'Preview', defaults: [] },
  { id: 'previewZoomOut', label: 'Zoom preview out', group: 'Preview', defaults: [] },
  { id: 'panToggle', label: 'Toggle hand tool', group: 'Preview', defaults: [] },
  { id: 'panHold', label: 'Hold to pan preview', group: 'Preview', defaults: ['Space'] },
] as const;
export type ShortcutAction = typeof SHORTCUTS[number]['id'];
export type ShortcutOverrides = Partial<Record<ShortcutAction, string[]>>;
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;
const keyPattern = /^(?:Mod\+)?(?:Alt\+)?(?:Shift\+)?(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Delete|Backspace|Enter|Equal|Minus|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Backquote|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|Numpad[0-9])$/;
const definition = (action: ShortcutAction) => SHORTCUTS.find(row => row.id === action)!;
export const bindingsFor = (action: ShortcutAction, overrides: ShortcutOverrides): readonly string[] => overrides[action] ?? definition(action).defaults;
export function bindingFromEvent(event: ShortcutEvent): string | null {
  if (event.ctrlKey && event.metaKey) return null;
  let code = event.code;
  if (!code) {
    const key = event.key;
    code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : ({ ' ': 'Space', '/': 'Slash', '=': 'Equal', '+': 'Equal', '-': 'Minus', '_': 'Minus' }[key] ?? key);
  }
  const binding = `${event.ctrlKey || event.metaKey ? 'Mod+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${code}`;
  return keyPattern.test(binding) ? binding : null;
}
export function matchShortcut(event: ShortcutEvent, overrides: ShortcutOverrides, action?: ShortcutAction): ShortcutAction | undefined {
  const binding = bindingFromEvent(event);
  if (!binding) return;
  return action ? (bindingsFor(action, overrides).includes(binding) ? action : undefined)
    : SHORTCUTS.find(row => row.id !== 'panHold' && bindingsFor(row.id, overrides).includes(binding))?.id;
}
export function bindingConflict(action: ShortcutAction, binding: string, overrides: ShortcutOverrides): ShortcutAction | undefined {
  return SHORTCUTS.find(row => row.id !== action && !([row.id, action].includes('panHold') && [row.id, action].includes('play')) && bindingsFor(row.id, overrides).includes(binding))?.id;
}
export function validateBindings(action: ShortcutAction, bindings: string[], overrides: ShortcutOverrides): string | undefined {
  if (bindings.length > 8) return 'Use up to eight shortcuts for one action.';
  if (bindings.some(binding => !keyPattern.test(binding))) return 'Use a key with optional Ctrl, Alt or Shift. Tab and Escape are reserved for controls.';
  if (new Set(bindings).size !== bindings.length) return 'That shortcut is already assigned to this action.';
  for (const binding of bindings) {
    const conflict = bindingConflict(action, binding, overrides);
    if (conflict) return `${formatBinding(binding)} is already assigned to ${definition(conflict).label}. Remove it there first or choose another shortcut.`;
  }
}
export function decodeShortcutOverrides(raw: string | null): ShortcutOverrides {
  try {
    if (!raw || raw.length > 20000) return {};
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !value.bindings || typeof value.bindings !== 'object') return {};
    const overrides: ShortcutOverrides = {};
    for (const row of SHORTCUTS) {
      const bindings: unknown = value.bindings[row.id];
      if (Array.isArray(bindings) && bindings.length <= 8 && bindings.every(binding => typeof binding === 'string' && keyPattern.test(binding)) && new Set(bindings).size === bindings.length) overrides[row.id] = bindings;
    }
    // Reject ambiguous saved configurations instead of executing the wrong action.
    if (SHORTCUTS.some(row => validateBindings(row.id, [...bindingsFor(row.id, overrides)], overrides))) return {};
    return overrides;
  } catch { return {}; }
}
export function formatBinding(binding: string): string {
  const names: Record<string, string> = { Mod: 'Ctrl', Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Equal: '=', Minus: '−', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`', NumpadAdd: 'Num +', NumpadSubtract: 'Num −' };
  return binding.split('+').map(part => names[part] ?? part.replace(/^Key|^Digit/, '')).join('+');
}
