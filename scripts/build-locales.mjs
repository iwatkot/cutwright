import { readFileSync, writeFileSync } from 'node:fs';
const locales=['en','de','da','hr','sr','cs','nl','fr','es','ru','uk'];
const keys=['Export MP4','MP4 Video','CutWright Project','Media'];
const dictionaries=Object.fromEntries(locales.map(locale=>{
 const data=JSON.parse(readFileSync(`src/i18n/messages/${locale}.json`,'utf8'));
 return [locale,Object.fromEntries(keys.map(key=>{if(!data[key])throw Error(`Missing native ${locale} message: ${key}`);return[key,data[key]];}))];
}));
writeFileSync('electron/localeData.ts',`// Generated from the renderer's authored message catalogues.\nexport const NATIVE_TRANSLATIONS: Record<string, Record<string, string>> = ${JSON.stringify(dictionaries,null,2)};\n`);
