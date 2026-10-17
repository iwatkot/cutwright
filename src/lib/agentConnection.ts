import { createEditorToolController } from './editorTools';
import { createWebMcpAdapter } from './webMcp';
import { createBrowserConnector } from './browserConnector';
import { exportJobs } from './exportJobs';

export type AgentMethod = 'codex' | 'claude' | 'webmcp';
export const editorController = createEditorToolController({ jobs: exportJobs });
export const webMcp = createWebMcpAdapter(editorController);
export const browserConnector = createBrowserConnector(editorController);
void webMcp.setActive(false);
type DesktopStatus = { enabled: boolean; editor?: string; session?: string; command?: string; args?: string[]; env?: Record<string, string>; error?: string };
let desktop: DesktopStatus = { enabled: false };
let busy = false;
function preferredMethod(): AgentMethod {
  try { const saved = localStorage.getItem('cutwright.agentMethod'); if (saved === 'codex' || saved === 'claude' || saved === 'webmcp') return saved; } catch { /* Preferences are optional. */ }
  return 'codex';
}
let method = preferredMethod();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => { try { listener(); } catch { /* UI observers do not own connections. */ } });
editorController.subscribe(emit); webMcp.subscribe(emit); browserConnector.subscribe(emit);

export const agentConnection = {
  get status() { return { ...editorController.status, method, desktop: { ...desktop }, web: webMcp.status, local: browserConnector.status, busy }; },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async setMethod(value: AgentMethod) {
    if (busy || value === method) return;
    await this.setEnabled(false);
    method = value;
    try { localStorage.setItem('cutwright.agentMethod', value); } catch { /* Preferences are optional. */ }
    emit();
  },
  async setEnabled(enabled: boolean, port?: number) {
    if (busy && enabled) return;
    busy = true; emit();
    if (!enabled) editorController.setEnabled(false);
    try {
      if (window.cutwright) {
        if (enabled) editorController.setEnabled(true);
        desktop = await window.cutwright.setAgentConnectionEnabled(enabled);
        if (desktop.enabled !== enabled || desktop.error) editorController.setEnabled(false);
      } else if (!enabled) {
        await Promise.all([browserConnector.disconnect(), webMcp.setActive(false)]);
      } else if (method === 'webmcp') {
        await browserConnector.disconnect();
        editorController.setEnabled(true);
        await webMcp.setActive(true);
        if (!webMcp.status.registered) editorController.setEnabled(false);
      } else {
        await webMcp.setActive(false);
        await browserConnector.connect(method, port);
      }
    } catch (error) {
      editorController.setEnabled(false);
      desktop = { enabled: false, error: error instanceof Error ? error.message : String(error) };
    } finally { busy = false; emit(); }
  },
};

/** Desktop preload and browser transports share the same validated controller. */
export function startAgentConnections(): () => void {
  const documentChanged = () => editorController.invalidateRevision();
  const pageClosed = () => { void agentConnection.setEnabled(false); };
  window.addEventListener('cw-project-will-load', documentChanged);
  window.addEventListener('cw-project-loaded', documentChanged);
  window.addEventListener('pagehide', pageClosed);
  const clear = () => { window.removeEventListener('cw-project-will-load', documentChanged); window.removeEventListener('cw-project-loaded', documentChanged); window.removeEventListener('pagehide', pageClosed); };
  const bridge = window.cutwright;
  if (!bridge) { void webMcp.refresh(); return () => { clear(); void agentConnection.setEnabled(false); }; }
  const offRequest = bridge.onAgentRequest(async request => {
    try {
      const result = request.method === 'list' ? editorController.listTools() : await editorController.execute(request.name ?? '', request.args ?? {});
      bridge.respondAgentRequest({ id: request.id, result });
    } catch (error) { bridge.respondAgentRequest({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  });
  const offStatus = bridge.onAgentConnectionStatus(status => { desktop = status; if (!status.enabled) editorController.setEnabled(false); emit(); });
  return () => { clear(); offRequest(); offStatus(); void agentConnection.setEnabled(false); };
}
