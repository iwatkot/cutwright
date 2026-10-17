import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, messages, setLocale, subscribeLocale, t } from '../src/i18n/core';
import { LOCALES, localeFromTag } from '../src/i18n/locales';
import { useStore, emptyProject } from '../src/lib/store';
import { localizedActivity, localizedDiagnostic, transitionName } from '../src/i18n/presentation';
import { BUILTIN_TRANSITIONS } from '../src/lib/transitions';

const initial=useStore.getState();
afterEach(()=>{vi.unstubAllGlobals();setLocale('en');useStore.setState(initial,true);});
describe('language is an editor preference',()=>{
  it.each(LOCALES)('keeps project content, history and references intact in %s',locale=>{
    const project=emptyProject();project.name='My story — Мій фільм';project.subtitles=[{id:'s',start:0,end:1,text:'Save; Привіт!'}];project.markers=[{id:'m',time:1,label:'Media',color:'#FFFFFF'}];
    useStore.setState({...initial,project,past:[structuredClone(project)],future:[structuredClone(project)]},true);
    const before=useStore.getState(),serialized=JSON.stringify({project:before.project,past:before.past,future:before.future});
    setLocale(locale);
    const after=useStore.getState();expect(after.project).toBe(before.project);expect(after.past).toBe(before.past);expect(after.future).toBe(before.future);
    expect(JSON.stringify({project:after.project,past:after.past,future:after.future})).toBe(serialized);
    expect(t('Save')).toBe(messages[locale].Save);expect(emptyProject().name).toBe(messages[locale]['Untitled project']);
  });
  it('persists the choice and updates document language without redundant notifications',()=>{
    const values=new Map<string,string>();const element={lang:'en'};
    vi.stubGlobal('localStorage',{setItem:(key:string,value:string)=>values.set(key,value),getItem:(key:string)=>values.get(key)||null});
    vi.stubGlobal('document',{documentElement:element});const changed=vi.fn(),off=subscribeLocale(changed);
    setLocale('de');setLocale('de');expect(getLocale()).toBe('de');expect(element.lang).toBe('de');expect(values.get('cutwright.language')).toBe('de');expect(changed).toHaveBeenCalledTimes(1);off();
  });
  it('keeps substitutions literal and saved transition names untouched',()=>{
    setLocale('uk');expect(t('Add {0}',{0:'<My "clip">'})).toContain('<My "clip">');
    expect(transitionName({...BUILTIN_TRANSITIONS[1],id:'my-own-transition',name:'Cross Dissolve'})).toBe('Cross Dissolve');
    expect(transitionName(BUILTIN_TRANSITIONS[1])).toBe(messages.uk['Cross Dissolve']);
  });
  it('localizes activity sentences without translating a person’s quoted text',()=>{
    setLocale('de');
    const result=localizedActivity('2 operation(s): Deleted "Save; My clip"; Undid one editing transaction.');
    expect(result).toContain('Save; My clip');expect(result).not.toContain('Deleted');expect(result).not.toContain('Undid');
    const moved=localizedDiagnostic('Moved "Media" and linked audio/video to 00:02 on V1');
    expect(moved).toContain('Media');expect(moved).toContain('00:02');expect(moved).toContain('V1');expect(moved).not.toContain('Moved');
  });
  it('recognizes supported language tags and rejects unknown ones',()=>{
    expect(localeFromTag('sr-Latn-RS')).toBe('sr');expect(localeFromTag('uk_UA')).toBe('uk');expect(localeFromTag('xx')).toBeUndefined();
  });
  it('localizes nested owned validation errors without changing the file name',()=>{
    setLocale('fr');
    const validation=localizedDiagnostic('setOverlay: Overlay color must be #RRGGBB or #RRGGBBAA');
    expect(validation).not.toContain('must be');expect(validation).toContain('#RRGGBBAA');expect(validation).toContain('setOverlay:');
    const name='My project — Мій фільм';
    const save=localizedDiagnostic(`Could not save ${name}: Local media storage is unavailable in this browser.`);
    expect(save).toContain(name);expect(save).not.toContain('unavailable in this browser');
    expect(localizedDiagnostic('No clip under the playhead — move it inside a clip first.')).toBe(messages.fr['No clip under the playhead — move it inside a clip first.']);
  });
});
