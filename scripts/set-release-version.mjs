import { readFileSync, writeFileSync } from 'node:fs';
const tag = process.env.RELEASE_TAG || process.argv[2];
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(tag || '')) throw new Error('RELEASE_TAG must be an exact semantic version without a v prefix.');
for (const file of ['package.json', 'package-lock.json']) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.version = tag;
  if (data.packages?.['']) data.packages[''].version = tag;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
console.log(`Build version injected from release tag: ${tag}`);
