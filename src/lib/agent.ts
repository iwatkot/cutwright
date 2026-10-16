import { useStore, uid } from './store';
import { synthesizeTransition } from './transitions';
import { parseTimecode, fmtTime } from './srt';
import { applyOpsToProject, parseAgentOps } from './agentOps';

const SYSTEM_CONTEXT = () => {
  const s = useStore.getState();
  const p = s.project;
  const clips = p.clips
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => `${c.id} "${c.name}" track=${c.trackId} start=${c.start.toFixed(2)} dur=${c.duration.toFixed(2)} offset=${(c.offset ?? 0).toFixed(2)} speed=${c.speed ?? 1} vol=${c.volume ?? 1} opacity=${c.opacity ?? 1} scale=${c.scale ?? 1} posX=${c.posX ?? 0} posY=${c.posY ?? 0} rotate=${c.rotate ?? 0} bright=${c.brightness ?? 1} contrast=${c.contrast ?? 1} sat=${c.saturation ?? 1} fadeIn=${c.fadeIn ?? 0} fadeOut=${c.fadeOut ?? 0}${c.mutedAudio ? ' mutedAudio(linked)' : ''}${c.linkGroup ? ' linkGroup=' + c.linkGroup : ''}${c.audioEnvelope ? ' inheritedAudioEnvelope=' + JSON.stringify(c.audioEnvelope) : ''}${c.overlay ? ' overlay=' + JSON.stringify(c.overlay) : ''}`)
    .join('\n');
  const trackIds = [...new Set([...p.clips.map((c) => c.trackId), ...Object.keys(p.trackSettings ?? {}), ...(p.trackOrder ?? [])])];
  const tracks = trackIds.map((id) => {
    const ts = p.trackSettings?.[id] ?? {};
    return `${id}${ts.muted ? ' muted' : ''}${ts.hidden ? ' hidden' : ''} vol=${ts.volume ?? 1}`;
  }).join('; ');
  const transitions = p.transitions.map((t) => `${t.defId}@${t.at.toFixed(2)} (${t.duration}s${t.entrance ? ', entrance' : ''})`).join('; ') || 'none';
  const defs = s.allDefs().map((d) => `${d.id} "${d.name}"`).join('; ');
  const subs = p.subtitles.map((x) => `${x.id} [${x.start.toFixed(2)}-${x.end.toFixed(2)}] "${x.text}"`).join('; ') || 'none';
  const media = p.media.map((m) => `${m.id} "${m.name}" ${m.kind} dur=${m.duration.toFixed(1)}s`).join('; ');
  return (
    `You are the CutWright video-editing agent. Project "${p.name}" ${p.width}x${p.height}@${p.fps}fps, duration ${s.totalDuration().toFixed(1)}s, playhead ${fmtTime(s.playhead)}.\n` +
    `Tracks (settings): ${tracks}\nTrack order top-to-bottom: ${(p.trackOrder ?? []).join(' > ') || '(default: higher track number on top)'}\n` +
    `Clips (id "name" track start dur source-offset speed volume opacity scale posX posY rotate brightness contrast saturation fades):\n${clips}\n` +
    `Media: ${media}\nTransitions on timeline: ${transitions}\nAvailable transition defs: ${defs}\n` +
    `Subtitles: ${subs}\nSubtitle style: fontSize=${p.subtitleStyle?.fontSize ?? 22}px color=${p.subtitleStyle?.color ?? '#FFFFFF'}\n` +
    `Reply with ONLY a JSON object {"ops":[...]} using these op types (no prose, no markdown):\n` +
    `{"type":"split","at":seconds} | {"type":"trimClip","clipId":"...","start":s,"duration":s,"offset":s} | ` +
    `{"type":"moveClip","clipId":"...","start":seconds,"trackId":"v2"} (trackId optional, same kind only) | {"type":"deleteClip","clipId":"..."} | ` +
    `{"type":"setClipProps","clipId":"...","volume":0..4,"speed":0.1..8,"opacity":0..1,"scale":0.1..3,"posX":-50..50,"posY":-50..50,"rotate":-180..180,"brightness":0..2,"contrast":0..2,"saturation":0..3,"fadeIn":s,"fadeOut":s,"offset":s} (any subset) | ` +
    `{"type":"setTrack","trackId":"a1","muted":true,"hidden":false,"volume":0..4} (any subset) | {"type":"reorderTracks","order":["v2","v1","a1"]} (top-to-bottom) | ` +
    `{"type":"applyTransition","transitionName":"Fade to Black","at":seconds,"duration":0.8,"clipId":"optional incoming video clip id for overlay tracks"} | {"type":"applyTransitionAll","transitionName":"Cross Dissolve"} | {"type":"unlinkClip","clipId":"..."} | ` +
    `{"type":"setTransitionDuration","at":seconds,"duration":1.2} | {"type":"removeTransition","at":seconds} | {"type":"createTransition","request":"slow fade to black"} | ` +
    `{"type":"addSubtitle","start":seconds,"end":seconds,"text":"..."} | {"type":"updateSubtitle","subtitleId":"...","text":"...","start":s,"end":s} | ` +
    `{"type":"removeSubtitle","subtitleId":"..."} | {"type":"setSubtitleStyle","fontSize":28,"color":"#FFD44B"} | ` +
    `{"type":"setOverlay","clipId":"...","overlay":{...complete overlay object copied from that clip with requested text/font/color/geometry/animation changes...}}. Overlay units: composition pixels and source seconds. Linked clip groups automatically share moves, trims, speed, gain, fades, splits and deletion. Preserve all unrequested fields.`
  );
};

function findDefByName(name: string) {
  const defs = useStore.getState().allDefs();
  const n = name.toLowerCase().trim();
  return defs.find((d) => d.id === n || d.name.toLowerCase() === n)
    ?? defs.find((d) => d.name.toLowerCase().includes(n) || n.includes(d.name.toLowerCase()))
    ?? defs.find((d) => d.id.includes(n.replace(/\s+/g, '-')));
}

/** Boundaries = start times of video clips after the first. */
function boundaries(): number[] {
  const clips = useStore.getState().project.clips.filter((c) => c.trackId === 'v1').slice().sort((a, b) => a.start - b.start);
  return clips.slice(1).map((c) => c.start);
}

/**
 * Connected-provider dispatch: the model receives the full project state
 * and must answer with validated structured ops, applied as one undo step.
 * This is the ONLY path taken when a real provider is selected — the local
 * regex router below is deliberately constrained to the offline built-in
 * agent, because its broad keyword rules would otherwise swallow compound
 * free-form requests (e.g. "set the subtitle style…" matching "subtitle")
 * before the connected model ever sees them.
 */
async function dispatchToProvider(prompt: string): Promise<void> {
  const store = useStore.getState();
  const { settings } = store;
  const requestedProject = JSON.stringify(store.project);
  store.pushChat({ id: uid(), role: 'system', text: `Asking ${settings.provider}…` });
  try {
    const full = SYSTEM_CONTEXT() + '\n\nUser: ' + prompt;
    const res = settings.provider === 'codex' || settings.provider === 'claude' || settings.provider === 'muse'
      ? await window.cutwright!.runAgentCli(settings.provider, full)
      : await window.cutwright!.callLlm(settings.provider, settings.model, settings.apiKey, full);
    if (!res.ok) { store.pushChat({ id: uid(), role: 'agent', text: `Provider error: ${res.text}` }); return; }
    const { ops, errors } = parseAgentOps(res.text);
    if (ops.length === 0 || errors.length) {
      store.pushChat({ id: uid(), role: 'agent', text: `The provider replied without executable edits (${errors[0] ?? 'no ops'}). Its message:\n${res.text.slice(0, 600)}` });
      return;
    }
    const current = useStore.getState();
    if (JSON.stringify(current.project) !== requestedProject) {
      store.pushChat({ id: uid(), role: 'agent', text: 'The project changed while the provider was working. No edits were applied. Send the request again to use the current timeline.' });
      return;
    }
    const outcome = applyOpsToProject(current.project, current.allDefs(), ops);
    const notes = [...outcome.applied, ...outcome.rejected.map((r) => `Rejected: ${r}`)];
    if (outcome.applied.length > 0) current.setProject(outcome.project); // one commit = one Ctrl+Z step
    store.pushChat({
      id: uid(), role: 'agent',
      text: outcome.applied.length ? `Done via ${settings.provider} — ${outcome.applied.length} edit(s) applied. Ctrl+Z undoes them as one step.` : 'The provider suggested edits, but none validated against this project.',
      actions: notes.length ? notes : undefined,
    });
  } catch (err) {
    store.pushChat({ id: uid(), role: 'agent', text: `Couldn\u2019t reach ${settings.provider}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function runAgent(promptRaw: string): Promise<void> {
  const store = useStore.getState();
  const prompt = promptRaw.trim();
  if (!prompt) return;
  store.pushChat({ id: uid(), role: 'user', text: prompt });

  // A connected provider owns every request while it is selected. Local
  // keyword routing is the offline built-in agent only (provider 'local',
  // or the web build where no CLI bridge exists).
  if (store.settings.provider !== 'local') {
    if (typeof window === 'undefined' || !window.cutwright) {
      store.pushChat({ id: uid(), role: 'agent', text: `The ${store.settings.provider} connection requires the desktop app. Open CutWright desktop or choose the built-in agent in Settings.` });
    } else await dispatchToProvider(prompt);
    return;
  }
  const lower = prompt.toLowerCase();
  const actions: string[] = [];
  let reply: string | null = null;

  const createMatch = lower.match(/(?:create|make|generate|build|design)\b.*?(?:transition|effect)?\s*[:\-]?\s*(.+)/);
  const isCreate = /(create|make|generate|build|design)/.test(lower) && /(transition|fade|dissolve|wipe|slide|zoom|effect)/.test(lower);

  if (isCreate && createMatch) {
    const def = synthesizeTransition(createMatch[1]);
    store.addCustomTransition(def);
    actions.push(`Created transition “${def.name}” in Collections → My Creations (FFmpeg: xfade=${def.xfade}, ${def.duration}s)`);
    reply = `Done — “${def.name}” is now a reusable transition in your library. Say “apply ${def.name} at 0:06” or “apply ${def.name} everywhere” and I\u2019ll place it.`;
  } else if (/apply|add transition|put/.test(lower) && /(transition|fade|dissolve|wipe|slide|zoom|circle|pixel)/.test(lower)) {
    const timeMatch = prompt.match(/at\s+(\d+(?::\d+){0,2}(?:[.,]\d+)?|\d+(?:\.\d+)?s?)/i);
    const namePart = prompt
      .replace(/apply|add|put|use|transition/gi, '')
      .replace(/at\s+\S+/i, '')
      .replace(/everywhere|between clips/gi, '')
      .trim();
    const def = findDefByName(namePart) ?? findDefByName(lower);
    if (!def) {
      reply = `I couldn\u2019t find that transition yet. Say “create transition ${namePart || 'fade to black'}” and I\u2019ll generate it first.`;
    } else if (/everywhere|all cuts|between clips/.test(lower)) {
      const bs = boundaries();
      const outcome = applyOpsToProject(store.project, store.allDefs(), [{ type: 'applyTransitionAll', defId: def.id }]);
      if (outcome.applied.length) store.setProject(outcome.project);
      actions.push(`Applied “${def.name}” at ${bs.length} cut point(s): ${bs.map(fmtTime).join(', ')}`);
      reply = `Applied “${def.name}” at every cut. Scrub the preview to check the blends.`;
    } else {
      const at = timeMatch ? parseTimecode(timeMatch[1].replace(/s$/i, '')) : null;
      const target = at !== null && at !== undefined ? at : boundaries()[0] ?? store.playhead;
      store.applyTransition(def.id, target);
      store.setPlayhead(target);
      actions.push(`Applied “${def.name}” at ${fmtTime(target)} (${def.duration}s)`);
      reply = `Placed “${def.name}” at ${fmtTime(target)}. It renders in export via FFmpeg xfade=${def.xfade}.`;
    }
  } else if (/(add|write|create).*(subtitle|caption)|\bsubtitle\b|\bcaption\b/.test(lower)) {
    const timeMatch = prompt.match(/at\s+(\d+(?::\d+){0,2}(?:[.,]\d+)?)/i);
    const at = timeMatch ? parseTimecode(timeMatch[1]) : null;
    const text = prompt
      .replace(/.*?(subtitle|caption)\s*/i, '')
      .replace(/at\s+\d+(?::\d+){0,2}(?:[.,]\d+)?/i, '')
      .replace(/^[:\-"“]\s*/, '')
      .replace(/["”]$/, '')
      .trim() || 'New subtitle';
    const start = at ?? store.playhead;
    store.addSubtitle(start, start + 3, text);
    store.setPlayhead(start);
    actions.push(`Added subtitle at ${fmtTime(start)}: “${text}”`);
    reply = `Caption added at ${fmtTime(start)}. Edit it anytime in the Subtitles tab — it burns into the MP4 on export.`;
  } else if (/(cut|split|snip)/.test(lower)) {
    const timeMatch = prompt.match(/(?:at\s+)?(\d+:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?)/);
    if (/here|playhead/.test(lower) || !timeMatch) {
      const err = store.splitAtPlayhead();
      if (err) reply = err;
      else { actions.push(`Split clip at playhead ${fmtTime(store.playhead)}`); reply = `Cut made at ${fmtTime(useStore.getState().playhead)}. Both halves stay selected-ready for transitions.`; }
    } else {
      const at = parseTimecode(timeMatch![1]);
      if (at === null) reply = 'I couldn\u2019t read that time — try “cut at 0:12”.';
      else {
        store.setPlayhead(at);
        const err = useStore.getState().splitAtPlayhead();
        if (err) reply = err;
        else { actions.push(`Split clip at ${fmtTime(at)}`); reply = `Cut made at ${fmtTime(at)}.`; }
      }
    }
  } else if (/delete|remove/.test(lower) && /(selected|clip|subtitle|this)/.test(lower)) {
    store.deleteSelected();
    actions.push('Deleted the current selection');
    reply = 'Deleted. Ctrl+Z brings it back.';
  } else if (/(title|intro text|text overlay)/.test(lower)) {
    const text = prompt.replace(/.*?(title|intro text|text overlay)\s*[:\-]?\s*/i, '').trim() || 'Title';
    store.addSubtitle(store.playhead, store.playhead + 4, text.toUpperCase());
    actions.push(`Added title card text at ${fmtTime(store.playhead)}`);
    reply = `Title “${text}” added at the playhead. It lives on the text track and exports with the video.`;
  } else if (/export/.test(lower) && /(srt|subtitle)/.test(lower)) {
    reply = 'Use Subtitles tab → Export .srt, or File → Export in the top bar. Your captions also burn into the MP4 automatically.';
  } else if (/export|render/.test(lower)) {
    reply = 'Hit Export MP4 in the top bar — I\u2019ll render cuts, transitions and burned subtitles with FFmpeg to a real .mp4.';
  } else if (/list|show/.test(lower) && /(transition|collection)/.test(lower)) {
    const defs = store.allDefs();
    reply = `Your library (${defs.length}): ${defs.map((d) => `${d.name} [${d.collection}]`).join(' · ')}. Custom ones live under My Creations and persist between sessions.`;
  } else if (/^(hi|hello|hey)\b/.test(lower) || /help|what can you/.test(lower)) {
    reply = 'I can: create reusable transitions (“create a slow fade to black, 1.2s”), apply them (“apply fade to black everywhere”), cut (“cut at 0:12”), caption (“add subtitle at 0:05 We did it!”), add titles, and prep exports. Connect Codex / Claude / Muse in Settings for free-form LLM edits.';
  }

  if (reply) {
    store.pushChat({ id: uid(), role: 'agent', text: reply, actions: actions.length ? actions : undefined });
    return;
  }

  // Local mode only (connected providers returned earlier): a free-form
  // request the keyword router cannot handle needs a real model.
  store.pushChat({
    id: uid(), role: 'agent',
    text: 'I handled that locally as far as I could, but free-form requests need a connected model. Open Settings (top right) and pick Codex, Claude, Muse, or paste an API key — or phrase it as a direct edit like “create transition fade to black” and I\u2019ll do it instantly offline.',
  });
}
