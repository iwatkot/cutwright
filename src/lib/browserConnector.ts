import { CONNECTOR_PORTS, CONNECTOR_PROTOCOL, MAX_CONNECTOR_BYTES, type ConnectorClient, type ConnectorInfo, type ConnectorRequest } from '../../connector/protocol';
import type { EditorToolController } from './editorTools';

export interface BrowserConnectorStatus { connected: boolean; checking: boolean; candidates: ConnectorInfo[]; selected?: ConnectorInfo; error?: string }
export function createBrowserConnector(controller: EditorToolController, options: { fetch?: typeof fetch; ports?: number[]; timeout?: number } = {}) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let current: BrowserConnectorStatus = { connected: false, checking: false, candidates: [] };
  let active: { info: ConnectorInfo; token: string; abort: AbortController } | undefined;
  let attempt = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => { try { listener(); } catch { /* An observer does not own the connection. */ } });
  const snapshot = () => ({ ...current, candidates: current.candidates.map(info => ({ ...info })), selected: current.selected ? { ...current.selected } : undefined });
  const update = (patch: Partial<BrowserConnectorStatus>) => { current = { ...current, ...patch }; emit(); };
  async function json(port: number, route: string, init: RequestInit = {}, timeout = options.timeout ?? 2500): Promise<Record<string, unknown>> {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const response = await request(`http://127.0.0.1:${port}${route}`, { ...init, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    const text = await response.text();
    if (text.length > MAX_CONNECTOR_BYTES * 2) throw new Error('The connector response is too large.');
    const value = JSON.parse(text);
    if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Connector request failed.');
    return value;
  }
  const auth = (connection: NonNullable<typeof active>) => ({ Authorization: `Bearer ${connection.token}` });
  async function closeRemote(connection: NonNullable<typeof active>) {
    try { await json(connection.info.port, '/disconnect', { method: 'POST', headers: auth(connection), keepalive: true }, 1500); } catch { /* The lease also expires when the tab closes. */ }
  }
  async function disconnect() {
    attempt++;
    controller.setEnabled(false);
    const previous = active; active = undefined;
    previous?.abort.abort();
    update({ connected: false, checking: false, selected: undefined, candidates: [], error: undefined });
    if (previous) await closeRemote(previous);
  }
  async function poll(connection: NonNullable<typeof active>) {
    try {
      while (active === connection && !connection.abort.signal.aborted) {
        const result = await json(connection.info.port, '/poll', { headers: auth(connection), signal: connection.abort.signal }, 22_000);
        if (!Array.isArray(result.requests) || result.requests.length > 1) throw new Error('Invalid connector request.');
        for (const raw of result.requests) {
          if (active !== connection || connection.abort.signal.aborted) return;
          const item = raw as ConnectorRequest;
          if (typeof item.id !== 'string' || typeof item.name !== 'string' || !item.args || typeof item.args !== 'object' || Array.isArray(item.args)) throw new Error('Invalid connector tool request.');
          const output = await controller.execute(item.name, item.args);
          if (active !== connection || connection.abort.signal.aborted) return;
          await json(connection.info.port, '/result', { method: 'POST', headers: { ...auth(connection), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, result: output }), signal: connection.abort.signal });
        }
      }
    } catch (error) {
      if (active !== connection || connection.abort.signal.aborted) return;
      active = undefined; connection.abort.abort(); controller.setEnabled(false);
      update({ connected: false, selected: undefined, error: error instanceof Error ? error.message : 'Connection lost. Click Connect to retry.' });
      void closeRemote(connection);
    }
  }
  async function connect(client: ConnectorClient, selectedPort?: number): Promise<boolean> {
    await disconnect();
    const generation = ++attempt;
    update({ checking: true, error: undefined });
    const found = await Promise.all((options.ports ?? CONNECTOR_PORTS).map(async port => {
      try {
        // A first connection can wait for the browser's local-network permission prompt.
        const info = await json(port, '/health', {}, options.timeout ?? 20_000);
        return info.application === 'cutwright-connector' && info.protocol === CONNECTOR_PROTOCOL && info.client === client && info.port === port && typeof info.session === 'string' && /^[A-F0-9]{6}$/.test(info.session) ? info as unknown as ConnectorInfo : undefined;
      } catch { return undefined; }
    }));
    if (generation !== attempt) return false;
    const candidates = found.filter((info): info is ConnectorInfo => !!info);
    const available = candidates.filter(info => !info.paired);
    const info = selectedPort ? available.find(info => info.port === selectedPort) : available.length === 1 ? available[0] : undefined;
    if (!info) {
      update({ checking: false, candidates, error: !candidates.length ? 'Connector not found. Open your agent with the CutWright connector enabled, then try again. Allow local network access if your browser asks.' : !available.length ? 'These agent sessions are connected to other tabs. Disconnect there first, or open a new agent conversation.' : 'Choose the agent session, then click Connect. The agent can tell you its session code.' });
      return false;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const connection = { info, token: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), abort: new AbortController() };
    try {
      await json(info.port, '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: connection.token }) });
      if (generation !== attempt) { await closeRemote(connection); return false; }
      active = connection; controller.setEnabled(true);
      update({ connected: true, checking: false, candidates, selected: info, error: undefined });
      void poll(connection); return true;
    } catch (error) {
      if (generation === attempt) update({ checking: false, candidates, error: error instanceof Error ? error.message : 'Could not connect.' });
      return false;
    }
  }
  return { connect, disconnect, get status() { return snapshot(); }, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
