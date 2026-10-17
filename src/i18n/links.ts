import {getLocale} from './core';

/** An explicit choice also overrides a different preference saved on the website origin. */
export function websiteHref(relative=''): string {
  const locale=getLocale();
  return `https://cutwright.cc/${locale==='en'?'':locale+'/'}${relative.replace(/^\//,'')}?lang=${locale}`;
}
