import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2), portArg = argv.find(arg => arg.startsWith('--port='));
const port = Number(portArg?.slice(7) ?? 47903);
if (portArg) argv.splice(argv.indexOf(portArg), 1);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local session port.');
const [name = 'get_project', ...rest] = argv;
const base = `http://127.0.0.1:${port}`;
if (['health', 'tools'].includes(name)) {
  const response = await fetch(`${base}/${name}`);
  if (!response.ok) throw new Error(`Session returned ${response.status}.`);
  console.log(JSON.stringify(await response.json(), null, 2));
} else {
  const args = rest[0] === '--file' ? JSON.parse(readFileSync(rest[1], 'utf8').replace(/^\uFEFF/, '')) : rest.length ? JSON.parse(rest.join(' ')) : {};
  const response = await fetch(`${base}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
  const result = await response.json();
  console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
  if (!response.ok || result.isError || result.structuredContent?.ok === false) process.exitCode = 1;
}
