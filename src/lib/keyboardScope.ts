/** Global editing shortcuts yield to text, custom controls, IME and dialogs. */
export function isEditorShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (document.querySelector('[role="dialog"], .modal')) return false;
  if (target?.closest('button, a[href], summary') && [' ', 'Enter'].includes(event.key)) return false;
  return !target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="spinbutton"], [role="slider"], [role="combobox"], [role="listbox"], [role="menu"], [role="separator"], [data-shortcut-scope="control"]');
}
