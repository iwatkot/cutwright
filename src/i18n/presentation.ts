import type { TransitionDef } from '../lib/types';
import { BUILTIN_TRANSITIONS } from '../lib/transitions';
import { messages, t } from './core';

/** Built-in catalogue labels are UI; a person's own saved names remain their content. */
export function transitionName(definition: TransitionDef): string {
  return BUILTIN_TRANSITIONS.some(item => item.id === definition.id) ? t(definition.name) : definition.name;
}
export function localizedBuiltin(definition: TransitionDef): TransitionDef {
  return { ...definition, name: t(definition.name), description: t(definition.description), collection: t(definition.collection) };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let patterns: { key: string; names: string[]; regex: RegExp }[] | undefined;
/** Translate owned runtime diagnostics at presentation, preserving protocol values and file details. */
export function localizedDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  if (Object.hasOwn(messages.en, text)) return t(text);
  patterns ??= Object.keys(messages.en).filter(key => /\{\w+\}/.test(key)).sort((a, b) => b.length - a.length).map(key => {
    const names = [...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
    return { key, names, regex: new RegExp('^' + key.split(/\{\w+\}/).map(escape).join('([\\s\\S]*?)') + '$') };
  });
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match) {
      const values: Record<string,string> = Object.fromEntries(pattern.names.map((name, index) => [name, match[index + 1]]));
      if (['setCanvasSettings: {0}', 'setClipProps: {0}', 'setOverlay: {0}', 'Cannot export this project: {0}', 'Could not enable the local agent connection: {0}'].includes(pattern.key) && values['0'].length < text.length) values['0'] = localizedDiagnostic(values['0']);
      if (['Could not open {0}: {1}', 'Could not save {0}: {1}', 'Audio speed processing failed ({0}). {1}'].includes(pattern.key) && values['1'].length < text.length) values['1'] = localizedDiagnostic(values['1']);
      if (pattern.key === '{0} is already assigned to {1}. Remove it there first or choose another shortcut.') values['1'] = t(values['1']);
      if (pattern.key.startsWith('Moved "') || pattern.key.startsWith('Trimmed "')) {
        if (values['1'] === ' and linked audio/video') values['1'] = t(' and linked audio/video');
        if (pattern.key.startsWith('Moved "') && /^ on [VA]\d+$/.test(values['3'] || '')) values['3'] = t(' on {0}', { 0: values['3'].slice(4) });
      }
      return t(pattern.key, values);
    }
  }
  return text;
}

export function localizedActivity(summary: string): string {
  const transaction = summary.match(/^(\d+) operation\(s\): ([\s\S]*)$/);
  if (!transaction) return localizedDiagnostic(summary);
  const parts: string[] = []; let quoted = false, escaped = false, start = 0;
  for (let index = 0; index < transaction[2].length; index++) {
    const char = transaction[2][index];
    if (char === '"' && !escaped) quoted = !quoted;
    if (!quoted && transaction[2].slice(index,index+2) === '; ') { parts.push(transaction[2].slice(start,index)); start=index+2; }
    escaped = char === '\\' && !escaped;
  }
  parts.push(transaction[2].slice(start));
  return t('{0} operation(s): {1}', { 0: transaction[1], 1: parts.map(localizedDiagnostic).join('; ') });
}
