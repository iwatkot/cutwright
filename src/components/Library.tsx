import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';
import { BUILTIN_TRANSITIONS, synthesizeTransition } from '../lib/transitions';
import { fmtTime, subtitlesToSrt, srtToSubtitles } from '../lib/srt';
import { download, pickFile, toast } from './TopBar';
import { mediaUrl } from '../lib/mediaUrl';
import { IconAudio, IconConnection, IconCheck, IconClose, IconImage, IconText, IconTransition, IconVideo, IconElements, IconGrid, IconCaptions, IconButton } from './icons';
import OverlayLibrary from './OverlayLibrary';
import { overlaySvg } from '../lib/overlay';
import type { Clip, Subtitle } from '../lib/types';
import { applyOpsToProject } from '../lib/agentOps';
import { Field, NumberControl, RangeControl } from './ui/Controls';
import { useShortcutLabel } from '../lib/shortcutPreferences';

type Tab = 'media' | 'text' | 'elements' | 'transitions' | 'subtitles';

const I = {
  media: <IconVideo />,
  trans: <IconTransition />,
  text: <IconText />,
  agent: <IconConnection />,
};

export default function Library({ onOpenSettings }: { onOpenSettings: () => void }) {
  const agentShortcut = useShortcutLabel('agent');
  const [tab, setTab] = useState<Tab>('media');
  return (
    <>
      <nav className="rail" aria-label="Tools">
        <RailBtn id="media" active={tab} onSelect={setTab} icon={I.media} label="Media" />
        <RailBtn id="text" active={tab} onSelect={setTab} icon={<IconText />} label="Text" />
        <RailBtn id="elements" active={tab} onSelect={setTab} icon={<IconElements />} label="Elements" />
        <RailBtn id="transitions" active={tab} onSelect={setTab} icon={I.trans} label="Transitions" />
        <RailBtn id="subtitles" active={tab} onSelect={setTab} icon={<IconCaptions />} label="Captions" />
        <div className="spacer" />
        <button className="railbtn" aria-haspopup="dialog" onClick={onOpenSettings} data-tooltip={`Agent connection${agentShortcut ? ` (${agentShortcut})` : ''}`}>{I.agent}<span>Agent</span></button>
      </nav>
      <div className="library">
        {tab === 'media' && <MediaPanel />}
        {tab === 'text' && <OverlayLibrary key="text" />}
        {tab === 'elements' && <OverlayLibrary key="elements" elements />}
        {tab === 'transitions' && <TransitionsPanel />}
        {tab === 'subtitles' && <SubtitlesPanel />}
      </div>
    </>
  );
}

function RailBtn({ id, active, onSelect, icon, label }: { id: Tab; active: Tab; onSelect: (tab: Tab) => void; icon: ReactNode; label: string }) {
  return <button className={`railbtn ${active === id ? 'on' : ''}`} aria-pressed={active === id} onClick={() => onSelect(id)}>{icon}<span>{label}</span></button>;
}

function Head({ title, sub, action }: { title: string; sub: string; action?: ReactNode }) {
  return (
    <div className="galleryhead">
      <div><h2>{title}</h2><p>{sub}</p></div>
      {action}
    </div>
  );
}

function MediaPanel() {
  const [buildingPreviews, setBuildingPreviews] = useState(0);
  useEffect(() => {
    if (!window.cutwright) return;
    let alive = true;
    let active = 0;
    const attempted = new Set<string>();
    const checked = new Set<string>();
    const deferred: (() => void)[] = [];
    const providerBusy = () => {
      const last = useStore.getState().chat.at(-1);
      return last?.role === 'user' || (last?.role === 'system' && last.text.startsWith('Asking '));
    };
    const schedule = () => {
      if (!alive) return;
      setBuildingPreviews(active);
      if (providerBusy()) return;
      for (const apply of deferred.splice(0)) apply();
      const unchecked = useStore.getState().project.media.filter((m) => m.src && !m.src.startsWith('blob:') && !m.overlay && !checked.has(`${m.id}:${m.src}`));
      if (unchecked.length && window.cutwright?.checkMediaFiles) {
        unchecked.forEach((m) => checked.add(`${m.id}:${m.src}`));
        void window.cutwright.checkMediaFiles(unchecked.map((m) => m.src)).then((statuses) => {
          if (!alive) return;
          const apply = () => {
            for (const original of unchecked) {
              const status = statuses.find((r) => r.src === original.src);
              const current = useStore.getState().project.media.find((m) => m.id === original.id && m.src === original.src);
              if (status && current && current.offline !== !status.exists) useStore.getState().updateMedia(current.id, { offline: !status.exists });
            }
          };
          if (providerBusy()) deferred.push(apply); else apply();
        }).catch(() => { /* Availability errors do not block editing. */ });
      }
      for (const item of useStore.getState().project.media) {
        if (active >= 2) break;
        if (!item.src || item.src.startsWith('blob:') || item.overlay || item.offline) continue;
        const kind = !item.thumb && item.kind !== 'audio' && !attempted.has(`${item.id}:${item.src}:thumb`) ? 'thumb'
          : !item.peaks?.length && item.kind !== 'image' && !attempted.has(`${item.id}:${item.src}:peaks`) ? 'peaks' : null;
        if (!kind) continue;
        const key = `${item.id}:${item.src}:${kind}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        active++;
        setBuildingPreviews(active);
        const task = kind === 'thumb' ? window.cutwright!.mediaThumb(item.src) : window.cutwright!.mediaPeaks(item.src);
        void task.then((result) => {
          if (!alive || !result.ok) return;
          const apply = () => {
            const current = useStore.getState();
            if (!current.project.media.some((m) => m.id === item.id && m.src === item.src)) return;
            if ('url' in result && result.url) current.updateMedia(item.id, { thumb: result.url });
            if ('peaks' in result && result.peaks?.length) current.updateMedia(item.id, { peaks: result.peaks });
          };
          if (providerBusy()) deferred.push(apply); else apply();
        }).catch(() => { /* A missing file stays available for relinking. */ }).finally(() => { active--; schedule(); });
      }
    };
    const unsubscribe = useStore.subscribe(schedule);
    schedule();
    return () => { alive = false; unsubscribe(); };
  }, []);
  const media = useStore((s) => s.project.media);
  const clips = useStore((s) => s.project.clips);
  const projectWidth = useStore((s) => s.project.width);
  const projectHeight = useStore((s) => s.project.height);
  const addClipFromMedia = useStore((s) => s.addClipFromMedia);
  const [filter, setFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [query, setQuery] = useState('');
  const used = useMemo(() => new Set(clips.map((c) => c.mediaId)), [clips]);
  const counts = useMemo(() => ({
    all: media.length,
    video: media.filter((m) => m.kind === 'video').length,
    image: media.filter((m) => m.kind === 'image').length,
    audio: media.filter((m) => m.kind === 'audio').length,
  }), [media]);
  const shown = media.filter((m) =>
    (filter === 'all' || m.kind === filter || (filter === 'image' && m.kind === 'image')) &&
    m.name.toLowerCase().includes(query.toLowerCase()));
  const chips: ['all' | 'video' | 'image' | 'audio', string, ReactNode][] = [['all', 'All media', <IconGrid />], ['video', 'Videos', <IconVideo />], ['image', 'Photos', <IconImage />], ['audio', 'Audio', <IconAudio />]];
  return (
    <>
      <Head title="Project files" sub={`${media.length} files · ${buildingPreviews ? 'preparing previews…' : 'drag or click to add'}`} />
      <div className="tabbody">
        <div className="mediafilters" role="group" aria-label="Filter project files">
          {chips.map(([id, label, icon]) => (
            <IconButton key={id} label={label} shortcut={`${counts[id]} files`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{icon}</IconButton>
          ))}
        </div>
        <input className="mediasearch" aria-label="Search project files" placeholder="Search files…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="mediagrid" aria-busy={buildingPreviews > 0}>
          {shown.map((m) => (
            <div key={m.id} className="mediacell" draggable role="button" tabIndex={0} aria-label={`Add ${m.name} to timeline`}
              onDragStart={(e) => e.dataTransfer.setData('cutwright/media', m.id)}
              onClick={() => addClipFromMedia(m.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); addClipFromMedia(m.id); } }}
              data-tooltip={(m.src && !m.offline) || m.overlay ? `${m.name} — drag to timeline or click to add` : `${m.name} — media missing. Import the file with this exact name to relink it.`}>
              <div className="mediathumb" style={{ background: `linear-gradient(135deg, ${m.color}cc, ${m.color}55)` }}>
                {m.overlay ? <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(overlaySvg(m.overlay, projectWidth, projectHeight, 1))}`} alt="" className="native-thumb" /> : !m.offline && (m.thumb || (m.kind === 'image' && m.src)) && <img src={mediaUrl(m.thumb || m.src)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />}
                {m.kind === 'audio' && !!m.peaks?.length && <div className="mediawave" aria-hidden="true">{m.peaks.filter((_, i) => i % Math.max(1, Math.ceil(m.peaks!.length / 36)) === 0).map((p, i) => <i key={i} style={{ height: `${Math.max(4, p * 90)}%` }} />)}</div>}
                <span className="playbadge">{m.kind === 'audio' ? <IconAudio /> : m.kind === 'image' ? <IconImage /> : <IconVideo />}</span>
                {used.has(m.id) && <span className="usedcheck" role="img" aria-label="Used on timeline" data-tooltip="Used on timeline"><IconCheck /></span>}
                <span className="dur">{m.duration.toFixed(0)}s</span>
                {(!m.src || m.offline) && !m.overlay && <span className="unlinked">missing</span>}
              </div>
              <div className="medianame">{m.name}</div>
            </div>
          ))}
        </div>
        {shown.length === 0 && <div className="empty">{media.length ? 'Nothing matches this filter.' : 'Start your project.'}<br />Use <b>Import</b> above to add videos, photos and music.</div>}
      </div>
    </>
  );
}

function TransitionsPanel() {
  const customTransitions = useStore((s) => s.project.customTransitions);
  const defs = useMemo(() => [...BUILTIN_TRANSITIONS, ...customTransitions], [customTransitions]);
  const addCustomTransition = useStore((s) => s.addCustomTransition);
  const [draft, setDraft] = useState('');

  const groups = useMemo(() => {
    const g = new Map<string, typeof defs>();
    defs.forEach((d) => g.set(d.collection, [...(g.get(d.collection) ?? []), d]));
    return [...g.entries()];
  }, [defs]);

  const transitionTarget = () => {
    const state = useStore.getState();
    const selected = state.project.clips.find((c) => c.id === state.selectedClipId && c.trackId.startsWith('v'));
    const videoIds = [...new Set(state.project.clips.filter((c) => c.trackId.startsWith('v')).map((c) => c.trackId))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const track = selected?.trackId ?? (videoIds.includes('v1') ? 'v1' : videoIds[0]);
    const clips = state.project.clips.filter((c) => c.trackId === track).slice().sort((a, b) => a.start - b.start);
    const boundaries = clips.length > 1 ? clips.slice(1) : clips;
    const anchor = selected ?? boundaries.reduce<Clip | undefined>((best, c) => !best || Math.abs(c.start - state.playhead) < Math.abs(best.start - state.playhead) ? c : best, undefined);
    return { state, clips, track, anchor };
  };
  const applyOne = (defId: string, name: string) => {
    const { state, track, anchor } = transitionTarget();
    if (!anchor) { toast('Add a video clip before applying a transition.'); return; }
    state.applyTransition(defId, anchor.start, undefined, anchor.id);
    toast(`“${name}” placed on ${track.toUpperCase()} at ${fmtTime(anchor.start)}.`);
  };
  const applyAll = (defId: string, name: string) => {
    const { state, clips, track } = transitionTarget();
    if (clips.length < 2) { toast('This video track needs at least two clips for All cuts.'); return; }
    const result = applyOpsToProject(state.project, state.allDefs(), clips.slice(1).map((clip) => ({ type: 'applyTransition' as const, defId, at: clip.start, clipId: clip.id })));
    if (!result.applied.length) { toast(result.rejected[0] ?? 'No transitions could be applied.'); return; }
    state.setProject(result.project);
    toast(`“${name}” added at ${result.applied.length} cut(s) on ${track.toUpperCase()}. Use Undo to reverse them together.`);
  };
  const create = () => {
    if (!draft.trim()) return;
    addCustomTransition(synthesizeTransition(draft));
    toast('Saved to My Creations — drag it onto any cut.');
    setDraft('');
  };

  return (
    <>
      <Head title="Transitions" sub="Drag one between two clips, or click Apply." />
      <div className="tabbody">
        <div className="createbox">
          <div className="createbox-t">Create with AI</div>
          <div className="row">
            <input style={{ flex: 1, minWidth: 0 }} placeholder="Describe it — e.g. slow fade to black" value={draft}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
            <button className="primary" onClick={create}>Create</button>
          </div>
          <p>It becomes a reusable transition in My Creations, for every project.</p>
        </div>
        {groups.map(([name, list]) => (
          <div key={name}>
            <div className="grouplabel">{name}</div>
            <div className="transgrid">
              {list.map((d) => (
                <div key={d.id} className="transcard" draggable
                  onDragStart={(e) => e.dataTransfer.setData('cutwright/transition', d.id)}
                  onClick={() => useStore.getState().setPreviewDef(d.id)}
                  data-tooltip="Click to preview in the player · drag onto a cut on the timeline">
                  <div className={`transprev ${d.preview}`}>
                    <span className="tp-a" />
                    <span className="tp-b" />
                    {d.preview === 'fade' && <span className="tp-dip" style={{ background: d.color ?? '#000' }} />}
                  </div>
                  <div className="name">{d.name} {d.generated && <span className="badge">AI</span>}</div>
                  <div className="transbtns">
                    <button onClick={(e) => { e.stopPropagation(); applyOne(d.id, d.name); }} data-tooltip="Apply at the selected video clip, or the cut nearest the playhead">Apply</button>
                    <button onClick={(e) => { e.stopPropagation(); applyAll(d.id, d.name); }} data-tooltip="Apply to all cuts on the selected video track as one undo step">All cuts</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SubtitlesPanel() {
  const subtitles = useStore((s) => s.project.subtitles);
  const selectedSubId = useStore((s) => s.selectedSubId);
  const playhead = useStore((s) => s.playhead);
  const selectSub = useStore((s) => s.selectSub);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const addSubtitle = useStore((s) => s.addSubtitle);
  const removeSubtitle = useStore((s) => s.removeSubtitle);
  const setProject = useStore((s) => s.setProject);
  const project = useStore((s) => s.project);
  const sizeCommitted = useRef(false);
  const beginSizeGesture = () => { sizeCommitted.current = false; };

  return (
    <>
      <Head title="Captions" sub="Click a line to jump there and edit it."
        action={<button className="primary" aria-label="Add caption" onClick={() => addSubtitle(playhead, playhead + 3, 'New caption')}>+ Add</button>} />
      <div className="tabbody">
        <div className="row wrap" style={{ marginBottom: 10, alignItems: 'center' }}>
          <RangeControl label="Caption font size" min={14} max={40} step={1}
            value={project.subtitleStyle?.fontSize ?? 22} onGestureStart={beginSizeGesture}
            onChange={(fontSize) => {
              const store = useStore.getState();
              if (!sizeCommitted.current) { store.commit(); sizeCommitted.current = true; }
              store.setSubtitleStyle({ fontSize }, false);
            }} />          {['#FFFFFF', '#FFE066', '#7DF9FF', '#FF8FA3'].map((c) => (
            <button key={c} className="trackbtn" data-tooltip={`Subtitle color ${c}`} aria-label={`Caption color ${c}`} aria-pressed={(project.subtitleStyle?.color ?? '#FFFFFF').toUpperCase() === c}
              style={{ background: 'transparent', width: 28, height: 28, borderRadius: 5, border: (project.subtitleStyle?.color ?? '#FFFFFF').toUpperCase() === c ? '1px solid var(--accent)' : '1px solid transparent' }}
              onClick={() => { if ((useStore.getState().project.subtitleStyle?.color ?? '#FFFFFF').toUpperCase() !== c) useStore.getState().setSubtitleStyle({ color: c }); }}><span style={{ background: c, width: 16, height: 16, borderRadius: '50%' }} /></button>
          ))}
        </div>
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <button onClick={() => download(`${project.name}.srt`, subtitlesToSrt(subtitles), 'text/plain')}>Export .srt</button>
          <button onClick={() => pickFile('.srt', async (f) => {
            try {
            const subs = srtToSubtitles(await f.text());
            if (!subs.length) { toast('No valid captions found. Check the SRT timestamps and try again.'); return; }
            setProject({ ...useStore.getState().project, subtitles: subs });
            toast(`Imported ${subs.length} caption(s).`);
            } catch (err) { toast(`Could not import captions: ${err instanceof Error ? err.message : String(err)}`); }
          })}>Import .srt</button>
        </div>
        {subtitles.slice().sort((a, b) => a.start - b.start).map((s) => (
          <div key={s.id} className={`subitem ${s.id === selectedSubId ? 'sel' : ''}`}
            onClick={() => { selectSub(s.id); setPlayhead(s.start); }}>
            <div className="subtime">{fmtTime(s.start)}<span> → {fmtTime(s.end)}</span>
              <button className="icon-button ghost" data-tooltip="Delete caption" aria-label="Delete caption" onClick={(e) => { e.stopPropagation(); removeSubtitle(s.id); }}><IconClose /></button></div>
            {s.id === selectedSubId ? (
              <div onClick={(e) => e.stopPropagation()}>
                <CaptionFields subtitle={s} />
              </div>
            ) : <div className="subtext">{s.text}</div>}
          </div>
        ))}
        {subtitles.length === 0 && <div className="empty">No captions yet.<br />Add one here, import an .srt, or ask the Agent:<br />“add subtitle at 0:05 Hello!”</div>}
      </div>
    </>
  );
}

function CaptionFields({ subtitle }: { subtitle: Subtitle }) {
  const committed = useRef(false);
  const minDuration = useStore((s) => 1 / s.project.fps);
  const begin = () => { committed.current = false; };
  const edit = (patch: Partial<Subtitle>) => {
    const store = useStore.getState();
    if (Object.entries(patch).every(([key, value]) => subtitle[key as keyof Subtitle] === value)) return;
    if (!committed.current) { store.commit(); committed.current = true; }
    store.updateSubtitle(subtitle.id, patch, false);
  };
  return <>
    <textarea rows={2} aria-label="Caption text" value={subtitle.text} onFocus={begin} onBlur={begin} onChange={(e) => edit({ text: e.target.value })} />
    <div className="row mt" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
      <Field label="Start"><NumberControl label="Caption start time" min={0} max={Math.max(0,subtitle.end-minDuration)} step={.1} value={subtitle.start} unit="s" onGestureStart={begin} onBlur={begin} onChange={start=>edit({start})} /></Field>
      <Field label="End"><NumberControl label="Caption end time" min={subtitle.start+minDuration} step={.1} value={subtitle.end} unit="s" onGestureStart={begin} onBlur={begin} onChange={end=>edit({end})} /></Field>    </div>
  </>;
}
