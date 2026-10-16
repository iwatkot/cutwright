// Enforce the RC's visible-widget architecture; actual styling, focus and
// interaction still require the browser/desktop UI acceptance checks.
import ts from 'typescript';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : /\.[jt]sx$/.test(file) ? [file] : [];
});
const findings = [];
const sharedPrimitives = [];
const widgetTypes = new Set(['range', 'number', 'checkbox', 'radio', 'date', 'time', 'datetime-local', 'month', 'week']);
const files = walk(sourceRoot);
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const report = (node, reason) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file: relative, line: position.line + 1, reason });
  };
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (/^[a-z]/.test(tag) && node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'title')) {
        report(node, 'Native title tooltip: use the reusable themed tooltip layer and accessible naming.');
      }
      if (['select', 'option', 'datalist'].includes(tag)) report(node, `Native <${tag}>: use the reusable custom select/listbox.`);
      if (tag === 'input') {
        const attribute = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'type');
        const initializer = attribute?.initializer;
        const type = initializer && ts.isStringLiteral(initializer) ? initializer.text.toLowerCase() : initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression) ? initializer.expression.text.toLowerCase() : 'text';
        if (type === 'color') report(node, 'Native OS color picker: use the reusable custom color control.');
        if (widgetTypes.has(type)) {
          if (!relative.startsWith('src/components/ui/')) report(node, `Native ${type} widget outside the reusable UI controls.`);
          else sharedPrimitives.push({ file: relative, type, note: 'Shared semantic primitive: manual custom-style and interaction review required.' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const report = { kind: 'RC widget source architecture audit', at: new Date().toISOString(), filesChecked: files.length, findings, sharedPrimitives, ok: findings.length === 0, limits: 'Source audit does not establish appearance, keyboard behavior, focus restoration, accessible naming or themes. Native file/text/button primitives remain permitted.' };
const outputIndex = process.argv.indexOf('--report');
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  if (!output) throw new Error('--report requires a path');
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
