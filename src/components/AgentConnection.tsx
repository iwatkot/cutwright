import { t as uiText, getLocale } from '../i18n/core';
import { websiteHref } from '../i18n/links';
import { localizedActivity, localizedDiagnostic } from '../i18n/presentation';
import { useEffect, useRef, useState } from 'react';
import { agentConnection, type AgentMethod } from '../lib/agentConnection';
import { APP_VERSION } from '../version';
import { IconClose, IconConnection, IconTerminal, IconAsterisk, IconGlobe, IconCopy, IconChevronRight, IconButton } from './icons';
import { ToggleGroup, SelectControl, useDialogFocus } from './ui/Controls';
import './agentConnection.css';

const source = `https://github.com/iwatkot/cutwright/tree/${APP_VERSION}`;
const guide = () => websiteHref('docs/agents/');
function configured(method: AgentMethod): boolean {
  try { return localStorage.getItem(`cutwright.connectorConfigured.${method}`) === 'true'; } catch { return false; }
}
function ExtensionSuffix() {
  const text = uiText("file. Enable it and restart Claude if requested.");
  return <>{/^[.,;:!?]/.test(text) ? '' : ' '}{text}</>;
}
function CopyCommand({ text, label = uiText("Copy command") }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(false);
  return <><div className="connection-command"><code>{text}</code><IconButton label={copied ? uiText("Copied") : label} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setError(false); }).catch(() => setError(true)); }}><IconCopy /></IconButton></div>{error && <p role="status">{uiText("Select the command to copy it. Clipboard access was unavailable.")}</p>}</>;
}
export default function AgentConnection({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null), setup = useRef<HTMLDetailsElement>(null);
  useDialogFocus(dialog, onClose);
  const [status, setStatus] = useState(agentConnection.status);
  const [installed, setInstalled] = useState(configured(status.method));
  const [session, setSession] = useState('');
  useEffect(() => agentConnection.subscribe(() => setStatus(agentConnection.status)), []);
  useEffect(() => { setInstalled(configured(status.method)); setSession(''); if (setup.current) setup.current.open = false; }, [status.method]);
  useEffect(() => {
    if (status.local.connected && setup.current) setup.current.open = false;
    if (status.local.connected) { setInstalled(true); try { localStorage.setItem(`cutwright.connectorConfigured.${status.method}`, 'true'); } catch { /* Preferences are optional. */ } }
  }, [status.local.connected, status.method]);
  const desktop = !!window.cutwright, web = status.method === 'webmcp';
  const name = status.method === 'claude' ? 'Claude' : 'Codex';
  const busy = status.busy || status.local.checking;
  const error = status.desktop.error || (desktop ? undefined : web ? status.web.error : status.local.error);
  const unavailable = !desktop && web && !status.web.supported;
  const enabled = status.enabled;
  const configuration = status.desktop.command ? JSON.stringify({ mcpServers: { cutwright: { command: status.desktop.command, args: status.desktop.args, env: status.desktop.env } } }, null, 2) : '';
  const connector = `${import.meta.env.BASE_URL}connectors/${APP_VERSION}/cutwright-connector-${APP_VERSION}.cjs`;
  const extension = `${import.meta.env.BASE_URL}connectors/${APP_VERSION}/cutwright-claude-${APP_VERSION}.mcpb`;
  const installCommand = `node "$HOME/Downloads/cutwright-connector-${APP_VERSION}.cjs" --install-codex`;
  const connect = () => { void agentConnection.setEnabled(true, session ? Number(session) : undefined); };
  const primary = () => {
    if (enabled) { void agentConnection.setEnabled(false); return; }
    if (desktop || web || installed || error || status.local.candidates.length) connect();
    else if (setup.current) setup.current.open = !setup.current.open;
  };
  const label = busy ? uiText("Connecting…") : enabled ? uiText("Disconnect") : desktop ? uiText("Enable connection") : web ? uiText("Enable WebMCP") : installed || error || status.local.candidates.length ? uiText("Connect") : uiText("Set up {0}", { 0: name });
  const statusLabel = desktop ? enabled ? uiText("Local MCP enabled") : uiText("Disconnected") : web ? unavailable ? uiText("WebMCP unavailable in this browser") : enabled ? uiText("WebMCP enabled") : uiText("WebMCP available") : busy ? uiText("Checking connector…") : enabled ? uiText("Connected to {0}", { 0: name }) : error && !status.local.candidates.length ? uiText("Connector not found") : installed ? uiText("Disconnected") : uiText("One-time setup required");
  return <div className="modalback" onClick={onClose}>
    <section ref={dialog} className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <div className="connection-heading"><IconConnection /><h2 id="connection-title">{uiText("Agent connection")}</h2><IconButton label={uiText("Close connection settings")} onClick={onClose}><IconClose /></IconButton></div>
      <p className="connection-intro">{uiText("Use your own agent with this project.")}</p>
      {!desktop && <div className="connection-methods"><ToggleGroup label={uiText("Connection method")} value={status.method} options={[
        { value: 'codex', label: 'Codex', icon: <><IconTerminal /><span>Codex</span></>, disabled: busy },
        { value: 'claude', label: 'Claude', icon: <><IconAsterisk /><span>Claude</span></>, disabled: busy },
        { value: 'webmcp', label: 'WebMCP', icon: <><IconGlobe /><span>WebMCP</span></>, disabled: busy },
      ]} onChange={value => { void agentConnection.setMethod(value as AgentMethod); }} /></div>}
      <div className="connection-status" role="status"><i className={enabled || web && !unavailable ? 'connected' : ''} />{statusLabel}</div>
      <p className="connection-description">{desktop ? uiText("Enable access and add the configuration to your agent’s MCP settings.") : web ? unavailable ? uiText("Use a compatible agent browser, or choose Codex or Claude.") : uiText("Use your browser agent’s chat to work with this project.") : enabled ? uiText("Ask your agent to inspect this project. Keep this tab open.") : installed ? uiText("Open {0} with its CutWright connector enabled, then connect this tab.", { 0: name }) : uiText("Install a small connector. Keep editing in your browser.")}</p>
      {!desktop && !web && status.local.candidates.length > 1 && !enabled && <div className="connection-session"><SelectControl label={uiText("Agent session")} value={session} options={[{ value: '', label: uiText("Choose agent session"), disabled: true }, ...status.local.candidates.map(info => ({ value: String(info.port), label: `${name} · ${info.session}${info.paired ? uiText(" (another tab)") : ''}`, disabled: info.paired }))]} onChange={setSession} /></div>}
      {error && <p className="connection-error" role="alert">{localizedDiagnostic(error)}</p>}
      <div className="row"><button className={enabled ? '' : 'primary'} disabled={busy || unavailable} onClick={primary}>{label}</button></div>
      {desktop && enabled && configuration && <div className="connection-config"><h3>{uiText("MCP configuration")}</h3><CopyCommand text={configuration} label={uiText("Copy configuration")} /></div>}
      <details ref={setup} className="connection-setup"><summary><IconChevronRight />{uiText("Setup instructions")}</summary><div className="connection-steps">
        {desktop ? <ol><li>{uiText("Click")}{" "}<strong>{uiText("Enable connection")}</strong>{" "}{uiText("and copy the configuration.")}</li><li>{uiText("In Codex, add the command, arguments and environment in")}{" "}<strong>{uiText("Settings → MCP servers")}</strong>{uiText(". In Claude, add the configuration in its local MCP settings.")}</li><li>{uiText("Restart the agent if requested. Keep CutWright open and ask it to inspect the project.")}</li></ol> : web ? <ol><li>{uiText("Open this project in a")}{" "}<strong>{uiText("WebMCP-compatible agent browser")}</strong>.</li><li>{uiText("Click")}{" "}<strong>{uiText("Enable WebMCP")}</strong>{" "}{uiText("and keep this tab open.")}</li><li>{uiText("In your browser agent’s chat, ask it to inspect the CutWright project. Enabling WebMCP alone does not attach an agent.")}</li></ol> : status.method === 'claude' ? <><ol><li><a href={extension} download>{uiText("Download the CutWright extension")}</a>.</li><li>{uiText("In Claude, open")}{" "}<strong>{uiText("Settings → Extensions → Advanced settings → Install Extension")}</strong>{" "}{uiText("and select the downloaded")}{" "}<strong>.mcpb</strong><ExtensionSuffix /></li><li>{uiText("Open a Claude conversation, return here and click")}{" "}<strong>{uiText("Connect")}</strong>{uiText(". Keep this tab open. Allow local network access if your browser asks.")}</li></ol>{!installed && !enabled && !error && !status.local.candidates.length && <button disabled={busy} onClick={connect}>{uiText("Connect")}</button>}</> : <><ol><li>{uiText("Install")}{" "}<a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">{uiText("Node.js 22 or newer")}</a>{" "}{uiText("if needed, then")}{" "}<a href={connector} download>{uiText("download the CutWright connector")}</a>{" "}{uiText("to Downloads.")}</li><li>{uiText("Run this command in PowerShell on Windows, or Terminal on macOS/Linux:")}<CopyCommand text={installCommand} /></li><li>{uiText("Restart Codex and open a new conversation. Return here and click")}{" "}<strong>{uiText("Connect")}</strong>{uiText(". Keep this tab open. Allow local network access if your browser asks.")}</li></ol>{!installed && !enabled && !error && !status.local.candidates.length && <button disabled={busy} onClick={connect}>{uiText("Connect")}</button>}</>}
      </div></details>
      <details className="connection-activity"><summary><IconChevronRight />{uiText("Recent actions")}{" "}<span>{status.history.length}</span></summary>
        {status.history.length ? <ol className="connection-history">{status.history.slice(-12).reverse().map(entry => <li key={entry.id}><span className={entry.outcome === 'rejected' ? 'rejected' : ''}>{({import_media:uiText("Import"),save_project:uiText("Save"),open_project:uiText("Open"),seek_preview:uiText("Video preview"),get_project:uiText("Read project"),apply_edits:uiText("Apply edits"),undo:uiText("Undo"),redo:uiText("Redo"),export_video:uiText("Start export"),get_export:uiText("Export status"),cancel_export:uiText("Cancel export")} as Record<string,string>)[entry.tool] ?? entry.tool}</span><p>{localizedActivity(entry.summary)}</p><time>{new Date(entry.timestamp).toLocaleTimeString(getLocale())}</time></li>)}</ol> : <p className="connection-empty">{uiText("Agent actions will appear here.")}</p>}
      </details>
      <footer className="connection-footer"><a href={`${guide()}${desktop ? '#connect-on-windows' : web ? '#connect-in-browser' : `#connect-${status.method}`}`} target="_blank" rel="noopener noreferrer">{uiText("Full guide ↗")}</a><a href={source} target="_blank" rel="noopener noreferrer">{uiText("Source code · AGPL-3.0 ↗")}</a></footer>
    </section>
  </div>;
}
