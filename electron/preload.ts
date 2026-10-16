import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRequest, AgentResponse, AgentConnectionStatus } from './mcpBridge';

contextBridge.exposeInMainWorld('cutwright', {
  platform: process.platform,
  detectClis: () => ipcRenderer.invoke('cutwright:detect-clis'),
  runAgentCli: (provider: string, prompt: string) => ipcRenderer.invoke('cutwright:run-agent-cli', provider, prompt),
  callLlm: (provider: string, model: string, apiKey: string, prompt: string) =>
    ipcRenderer.invoke('cutwright:call-llm', provider, model, apiKey, prompt),
  exportVideo: (payload: unknown) => ipcRenderer.invoke('cutwright:export-video', payload),
  saveTextFile: (defaultName: string, content: string) => ipcRenderer.invoke('cutwright:save-text', defaultName, content),
  openProjectFile: () => ipcRenderer.invoke('cutwright:open-project'),
  saveProjectFile: (name: string, content: string) => ipcRenderer.invoke('cutwright:save-project', name, content),
  pickMedia: () => ipcRenderer.invoke('cutwright:pick-media'),
  probeMedia: (src: string) => ipcRenderer.invoke('cutwright:probe-media', src),
  mediaThumb: (src: string) => ipcRenderer.invoke('cutwright:media-thumb', src),
  mediaPeaks: (src: string) => ipcRenderer.invoke('cutwright:media-peaks', src),
  checkMediaFiles: (sources: string[]) => ipcRenderer.invoke('cutwright:check-media-files', sources),
  initialProject: () => ipcRenderer.invoke('cutwright:initial-project'),
  cancelExport: () => ipcRenderer.invoke('cutwright:cancel-export'),
  setAgentConnectionEnabled: (enabled: boolean) => ipcRenderer.invoke('cutwright:set-agent-connection-enabled', enabled),
  respondAgentRequest: (response: AgentResponse) => ipcRenderer.send('cutwright:agent-response', response),
  onAgentRequest: (cb: (request: AgentRequest) => void) => {
    const listener = (_event: unknown, request: AgentRequest) => cb(request);
    ipcRenderer.on('cutwright:agent-request', listener);
    return () => ipcRenderer.removeListener('cutwright:agent-request', listener);
  },
  onAgentConnectionStatus: (cb: (status: AgentConnectionStatus) => void) => {
    const listener = (_event: unknown, status: AgentConnectionStatus) => cb(status);
    ipcRenderer.on('cutwright:agent-connection-status', listener);
    return () => ipcRenderer.removeListener('cutwright:agent-connection-status', listener);
  },
  onExportProgress: (cb: (p: { seconds: number; total: number; stage?: string }) => void) => {
    const listener = (_e: unknown, p: { seconds: number; total: number; stage?: string }) => cb(p);
    ipcRenderer.on('cutwright:export-progress', listener);
    return () => ipcRenderer.removeListener('cutwright:export-progress', listener);
  },
});
