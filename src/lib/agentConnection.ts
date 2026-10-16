import { createEditorToolController } from './editorTools';
import { createWebMcpAdapter } from './webMcp';
import { exportJobs } from './exportJobs';

export const editorController = createEditorToolController({ jobs: exportJobs });
export const webMcp = createWebMcpAdapter(editorController);
type DesktopStatus = { enabled: boolean; editor?: string; session?: string; command?: string; args?: string[]; env?: Record<string, string>; error?: string };
let desktop: DesktopStatus = { enabled: false };
let busy = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => { try { listener(); } catch { /* UI observers do not own connections. */ } });
editorController.subscribe(emit);
webMcp.subscribe(emit);

export const agentConnection = {
  get status() { return { ...editorController.status, desktop: { ...desktop }, web: webMcp.status, busy }; },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async setEnabled(enabled: boolean) {
    if (busy) return;
    busy = true; emit();
    // Disable immediately, so a retained tool callback cannot edit afterward.
    if (!enabled) editorController.setEnabled(false);
    try {
      if (window.cutwright) {
        if (enabled) editorController.setEnabled(true);
        desktop = await window.cutwright.setAgentConnectionEnabled(enabled);
        if (desktop.enabled !== enabled || desktop.error) editorController.setEnabled(false);
      } else {
        editorController.setEnabled(enabled);
        await webMcp.refresh();
        if (enabled && !webMcp.status.registered) editorController.setEnabled(false);
      }
    } catch (error) {
      editorController.setEnabled(false);
      desktop = { enabled: false, error: error instanceof Error ? error.message : String(error) };
    } finally { busy = false; emit(); }
  },
};

/** The preload forwards only the bounded, validated tool catalogue/calls. */
export function startAgentConnections(): () => void {
  const documentChanged = () => editorController.invalidateRevision();
  window.addEventListener('cw-project-will-load', documentChanged);
  window.addEventListener('cw-project-loaded', documentChanged);
  const clearDocumentListeners = () => { window.removeEventListener('cw-project-will-load', documentChanged); window.removeEventListener('cw-project-loaded', documentChanged); };
  const bridge = window.cutwright;
  if (!bridge) { void webMcp.refresh(); return () => { clearDocumentListeners(); void agentConnection.setEnabled(false); }; }
  const offRequest = bridge.onAgentRequest(async (request) => {
    try {
      const result = request.method === 'list' ? editorController.listTools() : await editorController.execute(request.name ?? '', request.args ?? {});
      bridge.respondAgentRequest({ id: request.id, result });
    } catch (error) { bridge.respondAgentRequest({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  });
  const offStatus = bridge.onAgentConnectionStatus((status) => {
    desktop = status;
    if (!status.enabled) editorController.setEnabled(false);
    emit();
  });
  return () => { clearDocumentListeners(); offRequest(); offStatus(); void agentConnection.setEnabled(false); };
}
