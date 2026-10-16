import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../src/lib/store';
import { runAgent } from '../src/lib/agent';
import type { Project } from '../src/lib/types';

const project: Project = {
  version: 1, name: 'Routing fixture', width: 1920, height: 1080, fps: 30,
  media: [{ id: 'm1', name: 'a.mp4', kind: 'video', src: 'a.mp4', duration: 40, color: '#111' }],
  clips: [
    { id: 'c1', mediaId: 'm1', trackId: 'v1', name: 'A', start: 0, duration: 10, offset: 0, color: '#111' },
    { id: 'c2', mediaId: 'm1', trackId: 'a2', name: 'Music', start: 0, duration: 10, offset: 0, color: '#222', volume: 0.5 },
  ],
  transitions: [], subtitles: [], customTransitions: [],
};

const FINISHING_PASS = 'Do a finishing pass on this imported episode: set the subtitle style to 30px in #FFD44B, duck every music track (a2 and a3) to volume 0.01 on their clips by lowering clip volume, and make the first v1 clip slightly punchier with saturation 1.2. Use the structured ops.';

let runAgentCli: ReturnType<typeof vi.fn>;

beforeEach(() => {
  runAgentCli = vi.fn(async () => ({
    ok: true,
    text: JSON.stringify({
      ops: [
        { type: 'setSubtitleStyle', fontSize: 30, color: '#FFD44B' },
        { type: 'setClipProps', clipId: 'c2', volume: 0.01 },
        { type: 'setClipProps', clipId: 'c1', saturation: 1.2 },
      ],
    }),
  }));
  (globalThis as { window?: unknown }).window = {
    cutwright: { runAgentCli, callLlm: vi.fn(async () => ({ ok: false, text: 'unused' })) },
  };
  useStore.setState({
    project: JSON.parse(JSON.stringify(project)) as Project,
    chat: [], past: [], future: [],
    settings: { provider: 'muse', model: '', apiKey: '' },
  });
});

describe('agent routing', () => {
  it('a compound finishing-pass prompt reaches the connected provider, not the local keyword router', async () => {
    await runAgent(FINISHING_PASS);
    expect(runAgentCli).toHaveBeenCalledTimes(1);
    expect(runAgentCli.mock.calls[0][0]).toBe('muse');
    expect(String(runAgentCli.mock.calls[0][1])).toContain('finishing pass');
    const p = useStore.getState().project;
    // No unintended local title/subtitle was created on the way.
    expect(p.subtitles).toHaveLength(0);
    expect(p.subtitleStyle).toEqual({ fontSize: 30, color: '#FFD44B' });
    expect(p.clips.find((c) => c.id === 'c2')?.volume).toBe(0.01);
    expect(p.clips.find((c) => c.id === 'c1')?.saturation).toBe(1.2);
    const last = useStore.getState().chat.at(-1);
    expect(last?.text).toContain('Done via muse');
  });

  it('local provider mode still handles exact offline intents without any CLI call', async () => {
    useStore.setState({ settings: { provider: 'local', model: '', apiKey: '' } });
    await runAgent('add subtitle at 0:01 Cold open');
    expect(runAgentCli).not.toHaveBeenCalled();
    expect(useStore.getState().project.subtitles).toHaveLength(1);
    expect(useStore.getState().project.subtitles[0].text).toBe('Cold open');
  });

  it('provider failures surface as a fast provider error, not a local edit', async () => {
    runAgentCli.mockResolvedValue({ ok: false, text: 'muse exploded' });
    await runAgent(FINISHING_PASS);
    const last = useStore.getState().chat.at(-1);
    expect(last?.text).toContain('Provider error');
    expect(useStore.getState().project.subtitles).toHaveLength(0);
    expect(useStore.getState().project.subtitleStyle).toBeUndefined();
  });
  it('rejects the entire provider batch when a member is malformed', async () => {
    runAgentCli.mockResolvedValue({ ok: true, text: '{"ops":[{"type":"setSubtitleStyle","fontSize":30},{"type":"deleteClip","clipId":42}]}' });
    const before = JSON.stringify(useStore.getState().project);
    await runAgent(FINISHING_PASS);
    expect(JSON.stringify(useStore.getState().project)).toBe(before);
    expect(useStore.getState().past).toHaveLength(0);
    expect(useStore.getState().chat.at(-1)?.text).not.toContain('Done via');
  });
  it('does not apply a delayed reply after a manual edit or project switch', async () => {
    let reply: (value: { ok: boolean; text: string }) => void = () => {};
    runAgentCli.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const running = runAgent(FINISHING_PASS);
    useStore.getState().updateClip('c1', { saturation: .5 });
    reply({ ok: true, text: '{"ops":[{"type":"setSubtitleStyle","fontSize":30}]}' });
    await running;
    expect(useStore.getState().project.subtitleStyle).toBeUndefined();
    expect(useStore.getState().project.clips[0].saturation).toBe(.5);
    expect(useStore.getState().chat.at(-1)?.text).toContain('project changed');
  });
});
