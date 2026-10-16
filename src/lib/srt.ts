import type { Subtitle } from './types';

export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function fmtSrtTime(sec: number): string {
  const total = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 1000);
  const h = Math.floor(total / 3600000);
  const m = Math.floor(total / 60000) % 60;
  const ss = Math.floor(total / 1000) % 60;
  const ms = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function parseTimecode(tc: string): number | null {
  const m = tc.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/);
  if (!m) {
    const plain = Number(tc);
    return Number.isFinite(plain) && plain >= 0 && tc.trim() !== '' ? plain : null;
  }
  const h = m[1] ? Number(m[1]) : 0;
  if (Number(m[3]) >= 60 || (m[1] && Number(m[2]) >= 60)) return null;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
}

export function subtitlesToSrt(subs: Subtitle[]): string {
  return subs
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((s, i) => `${i + 1}\n${fmtSrtTime(s.start)} --> ${fmtSrtTime(s.end)}\n${s.text}\n`)
    .join('\n');
}

export function srtToSubtitles(text: string): Subtitle[] {
  const out: Subtitle[] = [];
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    const timeLine = lines[timingIndex];
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const start = parseTimecode(a.replace(',', '.'));
    const end = parseTimecode(b.replace(',', '.'));
    if (start === null || end === null || end <= start) continue;
    const body = lines.slice(timingIndex + 1).join('\n').trim();
    if (!body) continue;
    out.push({ id: 'sub-' + Math.random().toString(36).slice(2, 8), start, end, text: body });
  }
  return out;
}
