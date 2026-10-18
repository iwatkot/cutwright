import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorToolController, type EditorToolController } from '../src/lib/editorTools';
import { createWebMcpAdapter, type WebMcpContext, type WebMcpRegisteredTool } from '../src/lib/webMcp';
import { demoProject, useStore } from '../src/lib/store';

const initial = useStore.getState(), controllers: EditorToolController[] = [], adapters: ReturnType<typeof createWebMcpAdapter>[] = [];
beforeEach(() => { useStore.setState({ ...initial, past: [], future: [] }, true); });
afterEach(async () => { for (const a of adapters.splice(0)) await a.dispose(); controllers.splice(0).forEach((c) => c.dispose()); vi.unstubAllGlobals(); useStore.setState(initial, true); });
function setup(api?: WebMcpContext, enabled = true) {
  const c = createEditorToolController({ enabled }); controllers.push(c);
  const a = createWebMcpAdapter(c, { document: { modelContext: api }, navigator: {} }); adapters.push(a); return { c, a };
}
function modernApi() {
  const tools = new Map<string, WebMcpRegisteredTool>(), signals: AbortSignal[] = [];
  const registerTool = vi.fn((tool: WebMcpRegisteredTool, options?: { signal: AbortSignal }) => {
    tools.set(tool.name, tool); if (options) { signals.push(options.signal); options.signal.addEventListener('abort', () => tools.delete(tool.name), { once: true }); }
  });
  return { tools, signals, registerTool };
}

describe('document WebMCP lifecycle adapter', () => {
  it('keeps local connector access separate and revokes old WebMCP handles after switching methods', async () => {
    const api = modernApi(), { c, a } = setup(api); await a.refresh();
    const saved = api.tools.get('get_project')!;
    await a.setActive(false);
    expect(c.enabled).toBe(true); expect(api.tools.size).toBe(0);
    expect(await saved.execute({})).toMatchObject({ ok: false, error: { code: 'DISABLED' } });
    await a.setActive(true);
    expect(api.tools.size).toBe(13);
    expect(await saved.execute({})).toMatchObject({ ok: false, error: { code: 'DISABLED' } });
    expect(await api.tools.get('get_project')!.execute({})).toMatchObject({ ok: true });
  });
  it('registers document tools with narrow schema/read-only hints and the actual controller', async () => {
    useStore.getState().setProject(demoProject(), true);
    const api = modernApi(), fallback = modernApi(), c = createEditorToolController({ enabled: true }); controllers.push(c);
    const a = createWebMcpAdapter(c, { document: { modelContext: api }, navigator: { modelContext: fallback } }); adapters.push(a);
    expect(await a.refresh()).toMatchObject({ supported: true, registered: true, toolCount: 13, context: 'document' });
    expect(fallback.registerTool).not.toHaveBeenCalled(); expect(api.registerTool).toHaveBeenCalledTimes(13);
    expect(api.tools.get('get_project')?.annotations.readOnlyHint).toBe(true); expect(api.tools.get('apply_edits')?.annotations.readOnlyHint).toBe(false);
    expect(api.tools.get('apply_edits')?.inputSchema).toMatchObject({ required: ['expectedRevision', 'ops'], additionalProperties: false });
    const result = await api.tools.get('get_project')!.execute({}) as { ok: boolean; revision: string };
    expect(result).toMatchObject({ ok: true, revision: c.status.revision });
    const clip = useStore.getState().project.clips[0];
    expect(await api.tools.get('apply_edits')!.execute({ expectedRevision: result.revision, ops: [{ type: 'setClipProps', clipId: clip.id, volume: .123 }] })).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().project.clips.find((x) => x.id === clip.id)?.volume).toBe(.123); expect(useStore.getState().past).toHaveLength(1);
    expect(api.registerTool).toHaveBeenCalledTimes(13);
  });

  it('unregisters through AbortSignal and rejects saved tool handles immediately on disable', async () => {
    const api = modernApi(), { c, a } = setup(api); await a.refresh();
    const saved = api.tools.get('get_project')!; c.setEnabled(false);
    expect(api.signals.every((s) => s.aborted)).toBe(true); expect(api.tools.size).toBe(0);
    expect(await saved.execute({})).toMatchObject({ ok: false, error: { code: 'DISABLED' } });
    expect(await a.refresh()).toMatchObject({ supported: true, registered: false, toolCount: 0 });
    c.setEnabled(true); await a.refresh(); expect(api.tools.size).toBe(13);
    await a.dispose(); expect(api.tools.size).toBe(0); expect(a.status.registered).toBe(false);
  });

  it('falls back to navigator only when document.modelContext is absent', async () => {
    const api = modernApi(), c = createEditorToolController({ enabled: true }); controllers.push(c);
    const a = createWebMcpAdapter(c, { document: {}, navigator: { modelContext: api } }); adapters.push(a);
    expect(await a.refresh()).toMatchObject({ supported: true, registered: true, context: 'navigator' });
  });

  it('reports unsupported browsers without registering or disabling ordinary editing', async () => {
    const { c, a } = setup(); expect(await a.refresh()).toEqual({ supported: false, registered: false, toolCount: 0, context: null });
    expect(c.enabled).toBe(true); expect((await c.execute('get_project', {})).ok).toBe(true);
  });

  it('attempts all legacy unregister calls even when some throw synchronously', async () => {
    const api = modernApi(), unregisterTool = vi.fn((name: string) => { api.tools.delete(name); if (name === 'get_project') throw new Error('Already removed'); });
    const { c, a } = setup({ registerTool: api.registerTool, unregisterTool }); await a.refresh(); c.setEnabled(false); await a.refresh();
    expect(unregisterTool).toHaveBeenCalledTimes(13); expect(a.status.registered).toBe(false);
  });

  it('cleans partial registration including a legacy API that throws after adding a tool', async () => {
    const tools = new Map<string, WebMcpRegisteredTool>(), unregisterTool = vi.fn((name: string) => { tools.delete(name); });
    const { a } = setup({ registerTool(tool) { tools.set(tool.name, tool); if (tool.name === 'undo') throw new Error('Registration denied'); }, unregisterTool });
    const result = await a.refresh(); expect(result).toMatchObject({ registered: false, toolCount: 0, error: 'Registration denied' });
    expect(tools.size).toBe(0); expect(unregisterTool).toHaveBeenCalledWith('undo');
  });

  it('cleans an in-flight legacy registration when disabled during its promise', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; }), tools = new Map<string, WebMcpRegisteredTool>();
    const { c, a } = setup({ async registerTool(tool) { await pending; tools.set(tool.name, tool); }, unregisterTool(name) { tools.delete(name); } });
    await Promise.resolve(); await Promise.resolve();
    c.setEnabled(false); release();
    expect(await a.refresh()).toMatchObject({ registered: false, toolCount: 0 }); expect(tools.size).toBe(0);
  });

  it('registration starts only after enable and controller disposal removes tools', async () => {
    const api = modernApi(), { c, a } = setup(api, false); await a.refresh(); expect(api.registerTool).not.toHaveBeenCalled();
    c.setEnabled(true); await a.refresh(); expect(api.tools.size).toBe(13);
    c.dispose(); await a.refresh(); expect(api.tools.size).toBe(0); await a.dispose(); await a.dispose();
  });
});
