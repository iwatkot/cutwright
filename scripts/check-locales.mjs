import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {collectMessages,LOCALES} from './locale-sources.mjs';

const keys=collectMessages(), file='src/i18n/messages/en.json';
if(process.argv.includes('--write-source')){
 writeFileSync(file,JSON.stringify(Object.fromEntries(keys.map(key=>[key,key])),null,2)+'\n');
 console.log(`Collected ${keys.length} source messages; translations are authored separately.`);
}else{
 const english=JSON.parse(readFileSync(file,'utf8'));
 assert.deepEqual(Object.keys(english).sort(),[...keys].sort(),'English catalogue differs from UI sources. Run npm run locales:source, then author all translations.');
 const placeholders=text=>[...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]))].sort();
 for(const locale of LOCALES){
  const data=JSON.parse(readFileSync(`src/i18n/messages/${locale}.json`,'utf8'));
  assert.deepEqual(Object.keys(data).sort(),Object.keys(english).sort(),`${locale}: missing or obsolete messages`);
  for(const key of keys){
   const value=data[key];assert(typeof value==='string'&&value.trim(),`${locale}: empty ${key}`);
   assert.deepEqual(placeholders(value),placeholders(key),`${locale}: changed placeholders in ${key}`);
   assert(!/\b(?:TODO_TRANSLATE|MISSING_TRANSLATION)\b/.test(value),`${locale}: unfinished ${key}`);
   if(locale!=='en'&&key.length>50&&/[a-zA-Z]{3} [a-zA-Z]{3}/.test(key))assert.notEqual(value,key,`${locale}: untranslated sentence ${key}`);
  }
 }
 console.log(`Translation coverage passed: ${keys.length} messages in all ${LOCALES.length} languages, with matching placeholders and no missing sentence translations.`);
}
