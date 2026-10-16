import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type CliProvider = 'codex' | 'claude' | 'muse';
const PROVIDERS: CliProvider[] = ['codex', 'claude', 'muse'];
const running = new Set<ReturnType<typeof spawn>>();

function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  } else child.kill('SIGTERM');
}

export function stopAgentRuns(): void { for (const child of running) killTree(child); }

/** Prompt text never enters cmd.exe, argv, or an environment variable. */
export function cliInvocation(bin: string, args: string[], platform = process.platform): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args, env: process.env };
  const env = { ...process.env, CW_AGENT_BIN: bin };
  const refs = args.map((arg, i) => {
    const key = `CW_AGENT_ARG_${i}`;
    (env as NodeJS.ProcessEnv)[key] = arg;
    return `"%${key}%"`;
  });
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `""%CW_AGENT_BIN%" ${refs.join(' ')}"`], env };
}

function capture(bin: string, args: string[], cwd: string | undefined, timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const spec = cliInvocation(bin, args);
    const child = spawn(spec.command, spec.args, { shell: false, windowsHide: true, cwd, env: spec.env });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number, reason = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(child);
      resolve({ code, stdout, stderr: stderr + reason });
    };
    const timer = setTimeout(() => { killTree(child); finish(-1, '\nProvider timed out. Check its sign-in and quota, then retry.'); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 8 * 1024 * 1024) { killTree(child); finish(-1, '\nProvider output exceeded 8 MB. Request fewer edits.'); }
    });
    child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-32_000); });
    child.on('error', (e) => finish(-1, `\n${e.message}`));
    child.on('close', (code) => finish(code ?? -1));
    // A missing executable can close stdin before the prompt is written.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function resolveCli(provider: CliProvider): Promise<string | null> {
  if (provider === 'muse' && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dir = path.join(process.env.LOCALAPPDATA, 'Programs', 'muse');
    try {
      const bins = fs.readdirSync(dir).filter((name) => /^muse-bin-.+\.exe$/i.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (bins.length) return path.join(dir, bins[0]);
    } catch { /* search PATH below */ }
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = await capture(locator, [provider], undefined, 10_000);
  const candidates = found.stdout.trim().split(/\r?\n/).filter((file) => fs.existsSync(file));
  // Current Claude npm installs ship a native executable behind the shim.
  for (const file of candidates) {
    const native = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (provider === 'claude' && fs.existsSync(native)) return native;
  }
  return candidates.find((file) => /\.exe$/i.test(file)) ?? candidates.find((file) => !/\.ps1$/i.test(file)) ?? null;
}

export async function detectClis(): Promise<{ name: string; found: boolean; version?: string; resolved?: string }[]> {
  return Promise.all(PROVIDERS.map(async (name) => {
    const bin = await resolveCli(name);
    if (!bin) return { name, found: false };
    const r = await capture(bin, ['--version'], undefined, 15_000);
    return r.code === 0 ? { name, found: true, version: (r.stdout || r.stderr).trim().split(/\r?\n/)[0], resolved: bin } : { name, found: false };
  }));
}

export async function runAgentCli(provider: string, prompt: string, workspaceRoot: string): Promise<{ ok: boolean; text: string }> {
  if (!PROVIDERS.includes(provider as CliProvider)) return { ok: false, text: `Unknown CLI provider "${provider}".` };
  const bin = await resolveCli(provider as CliProvider);
  if (!bin) return { ok: false, text: `${provider} CLI was not found. Install it and sign in, or choose another provider in Settings.` };
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(workspaceRoot, 'request-'));
  try {
    let args: string[];
    let input: string | undefined;
    if (provider === 'muse') {
      const promptFile = path.join(workspace, 'prompt.txt');
      fs.writeFileSync(promptFile, prompt, 'utf8');
      args = ['exec', '--workspace', workspace, '--trust-workspace', '--disable-write', '--disable-shell', '--disable-web-tools', '--no-session-log', '--no-foreign-personal-context', '--reasoning-effort', 'medium', '--max-model-steps', '3', '--user-input-auto-resolve', '--prompt-file', promptFile];
    } else if (provider === 'codex') {
      args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', path.join(workspace, 'reply.txt'), '-'];
      input = prompt;
    } else {
      args = ['--print', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--input-format', 'text'];
      input = prompt;
    }
    const r = await capture(bin, args, workspace, provider === 'muse' ? 420_000 : 300_000, input);
    const replyFile = path.join(workspace, 'reply.txt');
    const text = provider === 'codex' && fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8') : r.stdout;
    return { ok: r.code === 0, text: (r.code === 0 ? text : `${r.stderr}\n${text}`).trim() || `(no output, exit ${r.code})` };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  } finally {
    // Only the per-request temporary directory created here is removed.
    const relative = path.relative(path.resolve(workspaceRoot), path.resolve(workspace));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(workspace, { recursive: true, force: true });
  }
}
