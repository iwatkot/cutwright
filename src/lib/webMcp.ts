import type { EditorToolController, EditorToolDefinition } from './editorTools';

export interface WebMcpRegisteredTool extends EditorToolDefinition { execute(args: unknown): Promise<unknown> }
export interface WebMcpContext {
  registerTool(tool: WebMcpRegisteredTool, options?: { signal: AbortSignal }): unknown | Promise<unknown>;
  /** Older implementations expose explicit unregistration; current spec uses signal. */
  unregisterTool?(name: string): unknown | Promise<unknown>;
}
export interface WebMcpEnvironment {
  document?: { modelContext?: WebMcpContext };
  navigator?: { modelContext?: WebMcpContext };
}
export interface WebMcpStatus {
  supported: boolean; registered: boolean; toolCount: number;
  context: 'document' | 'navigator' | null; error?: string;
}

/** Official OpenAI site tools use document.modelContext. The optional navigator
 * fallback accommodates older implementations without pretending unsupported
 * browsers have a live agent connection. Source: learn.chatgpt.com/docs/webmcp */
export function createWebMcpAdapter(controller: EditorToolController, environment: WebMcpEnvironment = {}) {
  const listeners = new Set<(status: WebMcpStatus) => void>();
  let current: WebMcpStatus = { supported: false, registered: false, toolCount: 0, context: null };
  let activeContext: WebMcpContext | undefined, registration: AbortController | undefined;
  let names: string[] = [], disposed = false, active = true, queue: Promise<unknown> = Promise.resolve();
  const status = () => ({ ...current });
  const update = (next: WebMcpStatus) => { current = next; listeners.forEach((listener) => { try { listener(status()); } catch { /* UI observers do not control registrations. */ } }); };
  function context() {
    const doc = environment.document ?? (typeof document !== 'undefined' ? document as unknown as WebMcpEnvironment['document'] : undefined);
    if (typeof doc?.modelContext?.registerTool === 'function') return { api: doc.modelContext, kind: 'document' as const };
    const nav = environment.navigator ?? (typeof navigator !== 'undefined' ? navigator as unknown as WebMcpEnvironment['navigator'] : undefined);
    if (typeof nav?.modelContext?.registerTool === 'function') return { api: nav.modelContext, kind: 'navigator' as const };
    return undefined;
  }
  async function clear() {
    registration?.abort(); registration = undefined;
    const previous = activeContext, registered = names; activeContext = undefined; names = [];
    if (previous?.unregisterTool) {
      // Attempt every cleanup even if one legacy implementation rejects a name.
      await Promise.allSettled(registered.map((name) => Promise.resolve().then(() => previous.unregisterTool!(name))));
    }
  }
  async function reconcile(): Promise<WebMcpStatus> {
    const found = context();
    if (disposed || !active || !controller.enabled || !found) {
      await clear(); update({ supported: !!found, registered: false, toolCount: 0, context: found?.kind ?? null }); return status();
    }
    const definitions = controller.listTools();
    if (activeContext === found.api && names.length === definitions.length && names.length > 0) return status();
    await clear();
    activeContext = found.api; registration = new AbortController();
    const signal = registration.signal;
    try {
      for (const definition of definitions) {
        if (disposed || !active || !controller.enabled || signal.aborted) break;
        names.push(definition.name);
        await found.api.registerTool({ ...definition, execute: (args) => signal.aborted || !active
          ? Promise.resolve({ ok: false, revision: controller.status.revision, error: { code: 'DISABLED', message: 'This WebMCP connection was revoked.' } })
          : controller.execute(definition.name, args) }, { signal });
      }
      if (disposed || !active || !controller.enabled || signal.aborted) {
        await clear(); update({ supported: true, registered: false, toolCount: 0, context: found.kind });
      } else update({ supported: true, registered: names.length === definitions.length && names.length > 0, toolCount: names.length, context: found.kind });
    } catch (error) {
      await clear();
      update({ supported: true, registered: false, toolCount: 0, context: found.kind,
        ...(!disposed && controller.enabled ? { error: error instanceof Error ? error.message : String(error) } : {}) });
    }
    return status();
  }
  function refresh(): Promise<WebMcpStatus> {
    const next = queue.then(reconcile, reconcile); queue = next; return next;
  }
  let lastEnabled = controller.enabled;
  const unsubscribe = controller.subscribe((next) => {
    if (next.enabled === lastEnabled) return;
    lastEnabled = next.enabled;
    if (!next.enabled) registration?.abort();
    void refresh();
  });
  void refresh();
  return { refresh, async setActive(value: boolean) { active = value; if (!active) registration?.abort(); return refresh(); }, get status() { return status(); }, subscribe(listener: (status: WebMcpStatus) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async dispose(): Promise<void> { if (disposed) { await queue; return; } disposed = true; registration?.abort(); unsubscribe(); await refresh(); listeners.clear(); },
  };
}
