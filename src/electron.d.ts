export interface DesktopAgentRequest { id: string; method: 'list' | 'call'; name?: string; args?: Record<string, unknown> }
export interface DesktopAgentResponse { id: string; result?: unknown; error?: string }
export interface DesktopAgentConnectionStatus { enabled: boolean; editor?: string; command?: string; args?: string[]; env?: Record<string, string>; error?: string }
export interface DesktopExportPayload { args: string[]; srt: string | null; durationSec?: number; outputPath?: string }
export interface CutwrightDesktopApi {
  platform: string;
  setLocale(locale: string): Promise<void>;
  detectClis(): Promise<{ name: string; found: boolean; version?: string }[]>;
  runAgentCli(provider: string, prompt: string): Promise<{ ok: boolean; text: string }>;
  callLlm(provider: string, model: string, apiKey: string, prompt: string): Promise<{ ok: boolean; text: string }>;
  exportVideo(payload: DesktopExportPayload): Promise<{ ok: boolean; path?: string; error?: string; log?: string; logPath?: string; progressPath?: string }>;
  saveTextFile(defaultName: string, content: string): Promise<{ ok: boolean; path?: string }>;
  openProjectFile(): Promise<{ ok: boolean; name?: string; content?: string; error?: string; canceled?: boolean }>;
  saveProjectFile(name: string, content: string): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>;
  pickMedia(): Promise<{ name: string; path: string }[]>;
  probeMedia(src: string): Promise<{ ok: boolean; duration: number; width: number; height: number; hasAudio: boolean }>;
  mediaThumb(src: string): Promise<{ ok: boolean; url?: string }>;
  mediaPeaks(src: string): Promise<{ ok: boolean; peaks: number[] }>;
  checkMediaFiles(sources: string[]): Promise<{ src: string; exists: boolean }[]>;
  initialProject(): Promise<{ ok: boolean; name?: string; content?: string; error?: string }>;
  cancelExport(): Promise<{ ok: boolean }>;
  onExportProgress(cb: (progress: { seconds: number; total: number; stage?: string }) => void): () => void;
  setAgentConnectionEnabled(enabled: boolean): Promise<DesktopAgentConnectionStatus>;
  onAgentRequest(handler: (request: DesktopAgentRequest) => void): () => void;
  respondAgentRequest(response: DesktopAgentResponse): void;
  onAgentConnectionStatus(handler: (status: DesktopAgentConnectionStatus) => void): () => void;
}
declare global { interface Window { cutwright?: CutwrightDesktopApi } }
