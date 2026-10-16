import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron';
import { spawn, execFile } from 'child_process';
import { net } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { startExport, type ExportTask } from './exportRunner';
import { createOverlayPreparation } from './overlayCache';
import { detectClis, runAgentCli, stopAgentRuns } from './agentCli';
import { writeProjectFile } from './projectFiles';
import { createHash } from 'crypto';
import { createAgentBridge, resolveAgentEditor, type AgentResponse } from './mcpBridge';
import { mcpTargetArgument, runMcpStdio } from './mcpStdio';
import { validateMp4Destination } from './exportDestination';
import { registerMediaProtocol } from './mediaProtocol';

const mcpStdioMode = process.argv.includes('--mcp-stdio');
if (mcpStdioMode) app.disableHardwareAcceleration();
let editorWindow: BrowserWindow | null = null;
let agentBridge: ReturnType<typeof createAgentBridge> | null = null;

// Local media is served to the renderer through a privileged protocol:
// an HTTP (dev) or file:// (packaged) page may not load file:/// media
// directly, and <video> needs Range support for seeking.
protocol.registerSchemesAsPrivileged([
  { scheme: 'cutwright-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
]);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath: string = (require('ffmpeg-static') as string).replace('app.asar', 'app.asar.unpacked');

const isDev = !!process.env.VITE_DEV_SERVER_URL || !app.isPackaged;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    backgroundColor: '#202020',
    // Native Windows 11 chrome: Mica backdrop + real caption buttons drawn by
    // Windows itself (via titleBarOverlay), with the app title bar dragged by CSS.
    ...(process.platform === 'win32'
      ? {
          backgroundMaterial: 'mica' as const,
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#202020', symbolColor: '#ededed', height: 40 },
        }
      : {}),
    title: 'CutWright',
    icon: path.join(__dirname, '..', app.isPackaged ? 'dist' : 'public', 'branding', 'cutwright-app.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  editorWindow = win;
  // An export may own a hidden SVG renderer. Closing the editor must still
  // cancel its encoders and quit; waiting for all windows would leave that
  // hidden renderer and its FFmpeg work running without a visible editor.
  win.once('closed', () => { editorWindow = null; void agentBridge?.dispose(); exportTask?.cancel(); app.quit(); });
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) void agentBridge?.setEnabled(false); });
  win.webContents.on('render-process-gone', () => { void agentBridge?.setEnabled(false); });
  win.once('ready-to-show', () => win.show());
  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

ipcMain.handle('cutwright:set-agent-connection-enabled', async (event, enabled: unknown) => {
  if (!editorWindow || event.sender !== editorWindow.webContents) throw new Error('Only the editor can change its external agent connection.');
  if (typeof enabled !== 'boolean') throw new Error('Connection enabled must be a boolean.');
  if (!agentBridge && !enabled) return { enabled: false };
  agentBridge ??= createAgentBridge({
    userDataPath: app.getPath('userData'), command: process.execPath,
    locatorDirectory: path.join(app.getPath('appData'), 'CutWright', 'agent-connections'),
    argsPrefix: [path.join(__dirname, 'mcpNode.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    onRequest: (request) => {
      if (!editorWindow || editorWindow.isDestroyed()) throw new Error('The editor window is closed.');
      editorWindow.webContents.send('cutwright:agent-request', request);
    },
    onStatus: (status) => {
      if (editorWindow && !editorWindow.isDestroyed()) editorWindow.webContents.send('cutwright:agent-connection-status', status);
    },
  });
  return agentBridge.setEnabled(enabled);
});
ipcMain.on('cutwright:agent-response', (event, response: AgentResponse) => {
  if (editorWindow && event.sender === editorWindow.webContents) agentBridge?.respond(response);
});
app.on('before-quit', () => { void agentBridge?.dispose(); });

function run(cmd: string, args: string[], input?: string, timeoutMs = 120_000, cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, cwd });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, out: out + '\n[timed out]' }); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: out.slice(-8000) }); });
    if (input) { child.stdin.write(input); }
    child.stdin.end();
  });
}

ipcMain.handle('cutwright:detect-clis', () => detectClis());
ipcMain.handle('cutwright:run-agent-cli', (_e, provider: string, prompt: string) =>
  runAgentCli(provider, prompt, path.join(app.getPath('userData'), 'agent-workspace')));
app.on('before-quit', stopAgentRuns);

ipcMain.handle('cutwright:call-llm', async (_e, provider: string, model: string, apiKey: string, prompt: string) => {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = (await res.json()) as { content?: { text?: string }[]; error?: { message?: string } };
      if (!res.ok) return { ok: false, text: data.error?.message ?? `HTTP ${res.status}` };
      return { ok: true, text: data.content?.map((c) => c.text ?? '').join('') ?? '' };
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] }),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (!res.ok) return { ok: false, text: data.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, text: data.choices?.[0]?.message?.content ?? '' };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
});

function toLocalPath(input: string): string {
  // URL-aware conversion: spaces, #, unicode and UNC paths survive intact.
  try { return input.startsWith('file:') ? fileURLToPath(input) : input; }
  catch { return input; }
}

ipcMain.handle('cutwright:check-media-files', (_e, sources: unknown) => {
  if (!Array.isArray(sources)) return [];
  return sources.filter((src): src is string => typeof src === 'string').slice(0, 10000).map((src) => {
    try { return { src, exists: fs.statSync(toLocalPath(src)).isFile() }; }
    catch { return { src, exists: false }; }
  });
});

function runBuffer(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; buf: Buffer; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, buf: Buffer.concat(chunks), err }); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, buf: Buffer.concat(chunks), err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, buf: Buffer.concat(chunks), err }); });
  });
}

ipcMain.handle('cutwright:probe-media', async (_e, input: string) => {
  const file = toLocalPath(input);
  const r = await run(ffmpegPath, ['-i', file], undefined, 30_000);
  const text = r.out;
  const durM = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const duration = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0;
  const dimM = /Video:.*? (\d{2,5})x(\d{2,5})/.exec(text);
  return { duration, width: dimM ? Number(dimM[1]) : 0, height: dimM ? Number(dimM[2]) : 0, hasAudio: /Stream .*Audio/.test(text), ok: duration > 0 || !!dimM };
});

ipcMain.handle('cutwright:media-thumb', async (_e, input: string) => {
  const file = toLocalPath(input);
  const dir = path.join(app.getPath('userData'), 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { ok: false }; }
  const key = createHash('sha256').update(`${file}\n${stat.size}\n${stat.mtimeMs}`).digest('hex');
  const out = path.join(dir, `${key}.jpg`);
  if (!fs.existsSync(out)) {
    const r = await run(ffmpegPath, ['-y', '-ss', '0', '-i', file, '-frames:v', '1', '-vf', 'scale=320:-1', out], undefined, 60_000);
    if (r.code !== 0) return { ok: false };
  }
  return { ok: true, url: pathToFileURL(out).href };
});

ipcMain.handle('cutwright:media-peaks', async (_e, input: string) => {
  const file = toLocalPath(input);
  const r = await runBuffer(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '4000', '-f', 'f32le', '-'], 120_000);
  if (r.code !== 0 || r.buf.length < 16) return { ok: false, peaks: [] as number[] };
  const samples = new Float32Array(r.buf.buffer, r.buf.byteOffset, Math.floor(r.buf.byteLength / 4));
  const N = 64;
  const peaks: number[] = [];
  const per = Math.max(1, Math.floor(samples.length / N));
  for (let i = 0; i < N; i++) {
    let max = 0;
    for (let j = i * per; j < Math.min(samples.length, (i + 1) * per); j += 7) max = Math.max(max, Math.abs(samples[j]));
    peaks.push(Math.min(1, max));
  }
  const peakMax = Math.max(...peaks, 0.01);
  return { ok: true, peaks: peaks.map((p) => Math.round((p / peakMax) * 100) / 100) };
});

ipcMain.handle('cutwright:initial-project', async () => {
  const file = process.env.CUTWRIGHT_PROJECT;
  if (!file) return { ok: false };
  try { return { ok: true, name: path.basename(file), content: fs.readFileSync(file, 'utf8') }; }
  catch (err) { return { ok: false, error: String(err) }; }
});

let exportTask: ExportTask | null = null;
let exportSelecting = false;
ipcMain.handle('cutwright:export-video', async (_e, payload: { args: string[]; srt: string | null; durationSec?: number; outputPath?: string }) => {
  if (exportTask || exportSelecting) return { ok: false, error: 'An export is already running. Cancel it or wait for it to finish.' };
  exportSelecting = true;
  let overlayPreparation: ReturnType<typeof createOverlayPreparation> | null = null;
  try {
  const envOut = process.env.CUTWRIGHT_EXPORT_TO;
  const requestedOut = payload.outputPath !== undefined ? validateMp4Destination(payload.outputPath) : envOut ? validateMp4Destination(envOut) : null;
  const save = requestedOut ? { canceled: false, filePath: requestedOut } : await dialog.showSaveDialog({
    title: 'Export MP4',
    defaultPath: 'cutwright-export.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, error: 'Export cancelled' };
  const win = editorWindow;
  overlayPreparation = createOverlayPreparation(ffmpegPath, path.join(app.getPath('userData'), 'overlay-cache'));
  const overlayCount = payload.args.filter((arg) => arg.startsWith('cutwright-overlay:')).length;
  let overlayPrepared = 0;
  const prepareInput = overlayPreparation.prepareInput;
  exportTask = startExport({
    ffmpegPath, args: payload.args, destination: save.filePath,
    srt: payload.srt, duration: payload.durationSec ?? 0,
    logDir: path.join(app.getPath('userData'), 'export-logs'),
    prepareInput: async (input, signal) => {
      if (input.startsWith('cutwright-overlay:') && win && !win.isDestroyed()) {
        win.webContents.send('cutwright:export-progress', { seconds: 0, total: payload.durationSec ?? 0, stage: `Preparing overlay ${++overlayPrepared} of ${overlayCount}` });
      }
      return prepareInput(input, signal);
    },
    onProgress: (seconds, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('cutwright:export-progress', { seconds, total, stage: 'Rendering composition' });
    },
  });
  return await exportTask.result;
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    overlayPreparation?.dispose();
    exportTask = null;
    exportSelecting = false;
  }
});

ipcMain.handle('cutwright:cancel-export', async () => {
  if (exportTask) { exportTask.cancel(); return { ok: true }; }
  return { ok: false };
});
app.on('before-quit', () => exportTask?.cancel());

ipcMain.handle('cutwright:save-text', async (_e, defaultName: string, content: string) => {
  const save = await dialog.showSaveDialog({ defaultPath: defaultName });
  if (save.canceled || !save.filePath) return { ok: false };
  fs.writeFileSync(save.filePath, content, 'utf8');
  return { ok: true, path: save.filePath };
});

ipcMain.handle('cutwright:save-project', async (_e, name: string, content: string) => {
  const envPath = process.env.CUTWRIGHT_SAVE_TO;
  const safeName = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const save = envPath ? { canceled: false, filePath: envPath } : await dialog.showSaveDialog({
    defaultPath: safeName.endsWith('.cutwright.json') ? safeName : `${safeName}.cutwright.json`,
    filters: [{ name: 'CutWright Project', extensions: ['json'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  return writeProjectFile(save.filePath, content);
});

ipcMain.handle('cutwright:open-project', async () => {
  const open = process.env.CUTWRIGHT_OPEN_FROM ? { canceled: false, filePaths: [process.env.CUTWRIGHT_OPEN_FROM] } : await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'CutWright Project', extensions: ['json'] }],
  });
  if (open.canceled || open.filePaths.length === 0) return { ok: false, canceled: true };
  const filePath = open.filePaths[0];
  try { return { ok: true, name: path.basename(filePath), content: await fs.promises.readFile(filePath, 'utf8') }; }
  catch (err) { return { ok: false, error: `Could not open ${filePath}: ${err instanceof Error ? err.message : String(err)}` }; }
});

ipcMain.handle('cutwright:pick-media', async () => {
  // Desktop verification replaces the picker destination only; probing,
  // thumbnails, waveforms, relinking and timeline insertion use normal IPC.
  const supplied: unknown = process.env.CUTWRIGHT_MEDIA_FILES ? JSON.parse(process.env.CUTWRIGHT_MEDIA_FILES) : null;
  const open = Array.isArray(supplied) && supplied.every((p) => typeof p === 'string') ? { canceled: false, filePaths: supplied as string[] } : await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'png', 'jpg', 'jpeg'] }],
  });
  if (open.canceled) return [];
  return open.filePaths.map((p) => ({ name: path.basename(p), path: pathToFileURL(p).href }));
});

if (mcpStdioMode) {
  void app.whenReady().then(async () => {
    let exitCode = 0;
    try {
      const target = mcpTargetArgument(process.argv);
      const session = target?.session ?? (target?.editor ? resolveAgentEditor(target.editor, path.join(app.getPath('appData'), 'CutWright', 'agent-connections')) : null);
      if (!session) throw new Error('Missing editor session.');
      await runMcpStdio(session);
    } catch (error) { exitCode = 1; process.stderr.write(`CutWright MCP: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally { app.exit(exitCode); }
  });
} else {
void app.whenReady().then(() => {
  // No native menu: CutWright has its own title bar. Electron's default Edit
  // menu would otherwise swallow Ctrl+Z / Ctrl+Y as native text-undo roles
  // and the editor's timeline undo would never see them.
  Menu.setApplicationMenu(null);
  registerMediaProtocol(protocol, (url, options) => net.fetch(url, options));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

// Keep execFile referenced for future ffprobe probing hooks.
void execFile;

