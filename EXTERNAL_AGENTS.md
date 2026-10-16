# External agents

CutWright has no embedded conversation or provider composer. Work in your agent's own app and enable access from **Agent connection** (Ctrl+/). Editing and local export do not require an agent, account or API key.

## Windows: local MCP

Keep the editor open, choose **Enable connection**, and copy its MCP configuration into your agent client's settings. The configuration uses the installed executable and a stable editor identity. A launcher discovers the currently enabled session over local IPC; it does not open a network port or render service. Configuration syntax differs between clients; the displayed JSON is the common `mcpServers` form.

The same configuration can reconnect after restarting or re-enabling that editor profile. Access starts disabled each application launch. **Disconnect** closes the connection and invalidates prior revisions. A different editor profile has a different identity. Do not edit two projects in separate windows using one profile.

## Browser: WebMCP

Open the editor in a compatible agent browser and enable **Agent connection**. CutWright advertises the same validated tools through `document.modelContext` (with an implementation-compatible `navigator.modelContext` fallback). Use the agent browser's own chat to request edits. WebMCP support depends on the browser, client and feature availability; ordinary browsers can edit and export without exposing this connection. The dialog reports actual capability and registration status.

Tools unregister on disconnect. Previously retained execution handles still check the enabled state. The application does not substitute a custom chat when WebMCP is unavailable.

## Shared command contract

| Tool | Purpose |
| --- | --- |
| `get_project` | Read the current project, revision, transition definitions, undo/redo availability and concise action history. Derived thumbnails, waveforms and availability flags are omitted. |
| `apply_edits` | Validate an entire structured operation batch and apply it as one undo step. Rejected batches apply nothing. |
| `undo`, `redo` | Restore one editing transaction. |
| `export_video` | Start a local export; return a job immediately. Presets: `source`, `1080`, `720`, `480`. Desktop accepts an absolute `.mp4` `outputPath`; browser output downloads locally. |
| `get_export` | Read job progress, final result or failure by job `id`. |
| `cancel_export` | Request cancellation of a running job by `id`. Read its terminal status afterward. |

Read `get_project` before every edit or other side effect, then send its `revision` as `expectedRevision`. Project edits, document replacement and connection changes invalidate earlier revisions. Thumbnail/waveform preparation and file-availability checks do not. On `STALE_REVISION`, read the project again and reconsider the requested changes.

Operation schemas are advertised with the tools. Clip properties are flat fields beside `clipId`, for example:

```json
{
  "expectedRevision": "revision returned by get_project",
  "ops": [
    { "type": "setClipProps", "clipId": "voice-clip-id", "volume": 0.8 },
    { "type": "setSubtitleStyle", "fontSize": 30, "color": "#FFD44B" }
  ]
}
```

Tool results include `ok` and the current `revision`. Failures include a structured `error.code` and message. Export states are `queued`, `running`, `completed`, `cancelled`, or `failed`; progress is a fraction from 0 to 1. A cancellation response acknowledges the request, so inspect the final job state. Completed browser download URLs remain available while their bounded result entry and editor tab remain open.

## Verification

```powershell
npm run typecheck
npm test
npm run build
node scripts/verify-external-agent.mjs
```

The external-agent verifier uses the official MCP client and a signed-in Codex CLI in its own process. `CW_PACKAGED_EXE` selects an installed executable. It drives actual connection controls, reads/edits the live project, checks exact undo/redo and stale revisions, and exercises local export jobs. It writes its report, protocol calls, agent events and screenshots under ignored `screenshots/external-agent-*/`. A passing unit test or injected `modelContext` stub does not certify an actual agent connection. See [ACCEPTANCE.md](ACCEPTANCE.md) for recorded results and remaining conditions.

`node scripts/verify-webmcp.mjs` runs the official Chrome DevTools MCP server 1.11.0 against an isolated Chrome 150+ profile with experimental `--enable-features=WebMCP`. `CW_WEBMCP_CHROME` overrides the executable. It verifies native tool discovery, atomic editing/history/revisions and actual local export/cancellation, with generated fixtures and evidence under `screenshots/webmcp-*/`. This checks an external protocol client; support in ordinary unflagged browsers and a model's natural-language planning are separate concerns.

The Codex verifier authorizes only its requested fixture tools for that invocation. It does not modify persistent client settings. In normal use, the agent client retains its own tool approval controls.
