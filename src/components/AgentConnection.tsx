import { useEffect, useRef, useState } from 'react';
import { agentConnection } from '../lib/agentConnection';
import { IconClose, IconConnection } from './icons';
import { useDialogFocus } from './ui/Controls';

export default function AgentConnection({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(dialog, onClose);
  const [status, setStatus] = useState(agentConnection.status);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => agentConnection.subscribe(() => setStatus(agentConnection.status)), []);
  const desktop = !!window.cutwright;
  const available = desktop || status.web.supported;
  const configuration = status.desktop.command ? JSON.stringify({ mcpServers: { cutwright: { command: status.desktop.command, args: status.desktop.args, env: status.desktop.env } } }, null, 2) : '';
  const error = status.desktop.error || status.web.error;
  return <div className="modalback" onClick={onClose}>
    <section ref={dialog} className="modal connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      <div className="connection-heading"><IconConnection /><h2 id="connection-title">Agent connection</h2><button className="icon-button" aria-label="Close connection settings" onClick={onClose}><IconClose /></button></div>
      <p>Work with your agent in its own app. Connect it here to read the live project, apply edits, use undo and redo, and control local exports.</p>
      <div className="connection-status" role="status"><i className={status.enabled ? 'connected' : ''} />{status.enabled ? `${desktop ? 'Local MCP' : 'WebMCP'} enabled` : 'Disconnected'}</div>
      {desktop ? <p>Enable the connection, then add the configuration below to your agent’s MCP settings. Keep this editor open. This configuration reconnects to this editor profile after restart.</p> : <p>{status.web.supported ? 'This browser supports WebMCP. Enable the connection, then use your browser agent’s own chat to work with this project.' : 'This browser does not expose WebMCP. Open this editor in a compatible agent browser to connect. Editing and local export remain available here.'}</p>}
      {error && <p className="connection-error" role="alert">{error}</p>}
      <div className="row"><button className={status.enabled ? '' : 'primary'} disabled={status.busy || !available} onClick={() => void agentConnection.setEnabled(!status.enabled)}>{status.busy ? 'Updating…' : status.enabled ? 'Disconnect' : 'Enable connection'}</button></div>
      {desktop && status.enabled && configuration && <div className="connection-config"><h3>MCP configuration</h3><pre tabIndex={0}>{configuration}</pre><button onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(configuration)).then(() => { setCopied(true); setCopyError(false); }).catch(() => { setCopyError(true); setCopied(false); }); }}>{copied ? 'Copied' : 'Copy configuration'}</button>{copyError && <p role="status">Select the configuration text to copy it. Clipboard access was unavailable.</p>}</div>}
      <h3>Recent agent actions</h3>
      {status.history.length ? <ol className="connection-history">{status.history.slice(-12).reverse().map((entry) => <li key={entry.id}><span className={entry.outcome === 'rejected' ? 'rejected' : ''}>{entry.tool.replaceAll('_', ' ')}</span><p>{entry.summary}</p><time>{new Date(entry.timestamp).toLocaleTimeString()}</time></li>)}</ol> : <p className="connection-empty">Agent actions will appear here.</p>}
    </section>
  </div>;
}
