# External agents

CutWright has no embedded conversation or provider composer. Work in your agent's own app and enable access from **Agent** at the bottom of the left rail (Ctrl+/ by default, configurable in Keyboard shortcuts). Editing and local export do not require an agent, account or API key.

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
node scripts/verify-runtime-notices.mjs
```

The unit suite checks the command contract, validation, revisions and transport boundaries. The release pipeline's `scripts/smoke-windows-release.mjs` installs the matching Windows package and checks visible versions, controls, import, native export and full video/audio decode. It publishes `smoke-windows.json` with the installer. These checks do not certify a particular external agent client's configuration or browser's WebMCP support.

For an integration check, use a compatible client against an isolated project: discover the advertised tools, read the current revision, apply a small edit, undo/redo it, reject a stale revision, and start and inspect a local export. Disconnect and verify that further access fails. Client approval controls remain in effect. See the [user connection guide](https://cutwright.cc/docs/agents/) for the actual enable/configure/disconnect workflow.
