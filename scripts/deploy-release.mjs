import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [component, tag, digest] = process.argv.slice(2);
if (!['app', 'website'].includes(component) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(tag || '') || !/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid deployment identity.');
if (!process.env.DEPLOY_SSH_KEY || !process.env.DEPLOY_KNOWN_HOSTS) throw new Error('Missing deployment SSH credentials.');
const dir = mkdtempSync(path.join(tmpdir(), 'cutwright-deploy-'));
const key = path.join(dir, 'key'), hosts = path.join(dir, 'known_hosts');
try {
  writeFileSync(key, process.env.DEPLOY_SSH_KEY.trim() + '\n', { mode: 0o600 });
  writeFileSync(hosts, process.env.DEPLOY_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
  const result = spawnSync('ssh', ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hosts}`, 'deploy@89.163.206.145', `cutwright-deploy ${component} ${tag} ${digest}`], { stdio: 'inherit', timeout: 300_000 });
  if (result.status !== 0) throw new Error('Deployment failed; inspect the preceding isolated deployment output.');
} finally {
  for (const file of [key, hosts]) { try { unlinkSync(file); } catch {} }
  rmdirSync(dir);
}
