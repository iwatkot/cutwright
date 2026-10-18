import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const LOCALES=['en','de','da','hr','sr','cs','nl','fr','es','ru','uk'];
export const nativeKeys=['Export MP4','MP4 Video','CutWright Project','Media'];
const invariantText=new Set(['CutWright','Cut','Wright','Codex','Claude','WebMCP','GitHub','MCP','STDIO','AGPL-3.0','.mcpb','MP4','px','fps','dB']);
const visibleAttributes=new Set(['label','aria-label','aria-description','data-tooltip','placeholder','hint','description','title','alt','sub']);
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
const parse=file=>ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
const message=node=>{
 if(ts.isStringLiteralLike(node))return node.text;
 if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map((span,index)=>`{${index}}${span.literal.text}`).join('');
};
export function collectMessages(){
 const keys=new Set(nativeKeys), add=node=>{const text=message(node);if(text&&/[A-Za-z]/.test(text))keys.add(text);};
 for(const file of walk('src').filter(file=>/\.tsx?$/.test(file)&&!file.includes(`${path.sep}i18n${path.sep}messages`))){
  const source=parse(file);
  const checkRendered=node=>{
   if(ts.isStringLiteralLike(node)&&/[A-Za-z]/.test(node.text)&&!invariantText.has(node.text.trim()))throw Error(`${file}: unlocalized rendered expression: ${node.text}`);
   if(ts.isConditionalExpression(node)){checkRendered(node.whenTrue);checkRendered(node.whenFalse);}
   if(ts.isParenthesizedExpression(node))checkRendered(node.expression);
   if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))checkRendered(node.right);
  };
  const visit=node=>{
   if(ts.isCallExpression(node)&&['uiText','t'].includes(node.expression.getText(source))&&node.arguments[0]){
    const key=message(node.arguments[0]);
    if(key&&/^(?:#[a-f\d]{6,8}|https?:\/\/|--[\w-]+)$/i.test(key))throw Error(`${file}: technical values must not be translated: ${key}`);
    add(node.arguments[0]);
   }
   if(file.endsWith('.tsx')&&ts.isJsxText(node)&&/[A-Za-z]/.test(node.text)){
    const key=node.text.trim(), parent=node.parent;
    const tag=ts.isJsxElement(parent)?parent.openingElement.tagName.getText(source):'';
    if(key&&!invariantText.has(key)&&!['svg','code','pre','kbd'].includes(tag))throw Error(`${file}: unlocalized visible text: ${key}`);
   }
   if(ts.isJsxAttribute(node)&&visibleAttributes.has(node.name.getText(source))&&node.initializer&&ts.isStringLiteral(node.initializer)){
    const key=node.initializer.text;
    if(/[A-Za-z]/.test(key)&&!invariantText.has(key))throw Error(`${file}: unlocalized ${node.name.getText(source)}: ${key}`);
   }
   if(ts.isJsxExpression(node)&&node.expression){
    const parent=node.parent,attribute=ts.isJsxAttribute(parent),tag=ts.isJsxElement(parent)?parent.openingElement.tagName.getText(source):'';
    if((!attribute||visibleAttributes.has(parent.name.getText(source)))&&!['svg','code','pre','kbd'].includes(tag))checkRendered(node.expression);
   }
   ts.forEachChild(node,visit);
  };visit(source);
 }
 for(const [file,properties] of [
  ['src/components/textTemplates.ts',['name','category','description']],
  ['src/lib/transitions.ts',['name','description','collection']],
  ['src/lib/shortcuts.ts',['label','group']],
 ]){
  const source=parse(file);
  const visit=node=>{
   if(ts.isPropertyAssignment(node)&&properties.includes(node.name.getText(source)))add(node.initializer);
   if(file.endsWith('textTemplates.ts')&&ts.isVariableDeclaration(node)&&node.name.getText(source)==='TEXT_CATEGORIES'&&ts.isArrayLiteralExpression(node.initializer))node.initializer.elements.forEach(add);
   ts.forEachChild(node,visit);
  };visit(source);
 }
 // These remain stable diagnostics on the wire; localize them where the app presents them.
 const runtimeFiles=['browserConnector','webMcp','agentConnection','exportJobs','browserExport','browserAudio','browserExportStorage','browserMedia','browserPcm','browserTempo','browserVideoDecoder','browserComposition','previewComposition','ffmpegPlan','validate','overlay','overlayAssets','clipEdits','editorTools','editorFiles','agentOps','shortcuts','movavi','store'];
 for(const file of [...runtimeFiles.map(name=>`src/lib/${name}.ts`),'connector/server.ts','electron/main.ts','electron/projectFiles.ts','electron/exportRunner.ts','electron/mcpBridge.ts','electron/exportDestination.ts']){
  const source=parse(file);
  const descendants=node=>{
   const text=message(node);
   if(text&&!/^[A-Z_]+$/.test(text)&&( /\s/.test(text)||/^[A-Z][A-Za-z]+$/.test(text)))keys.add(text);
   if(ts.isTemplateExpression(node))return;
   ts.forEachChild(node,descendants);
  };
  const visit=node=>{
   if(ts.isNewExpression(node)&&['Error','DOMException'].includes(node.expression.getText(source))&&node.arguments?.[0])descendants(node.arguments[0]);
   if(ts.isPropertyAssignment(node)&&['error','stage','summary'].includes(node.name.getText(source)))descendants(node.initializer);
   if(ts.isCallExpression(node)){
    const fn=node.expression.getText(source);
    if(['progress','options.onPrepare'].includes(fn)&&node.arguments[0])descendants(node.arguments[0]);
    if(fn==='record'&&node.arguments[2])descendants(node.arguments[2]);
    if(fn==='failure'&&node.arguments[1])descendants(node.arguments[1]);
    if(/(?:errors|warnings|applied|rejected|diagnostics|effects)\.push$/.test(fn))node.arguments.forEach(descendants);
   }
   if(/(?:shortcuts|store)\.ts$/.test(file)&&ts.isReturnStatement(node)&&node.expression&&(ts.isStringLiteralLike(node.expression)||ts.isTemplateExpression(node.expression)))descendants(node.expression);
   if(file.endsWith('overlay.ts')&&ts.isReturnStatement(node)&&node.expression&&ts.isArrayLiteralExpression(node.expression))descendants(node.expression);
   if(file.endsWith('browserComposition.ts')&&ts.isVariableDeclaration(node)&&node.name.getText(source)==='effects'&&node.initializer)descendants(node.initializer);
   ts.forEachChild(node,visit);
  };visit(source);
 }
 return [...keys].filter(key=>/[A-Za-z]/.test(key)&&!/^\{\d+\}$/.test(key)&&!['string','boolean','number','object','undefined','function','AbortError','TypeError','error'].includes(key)).sort((a,b)=>a.localeCompare(b));
}
