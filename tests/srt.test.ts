import { describe, expect, it } from 'vitest';
import { fmtSrtTime, parseTimecode, srtToSubtitles, subtitlesToSrt } from '../src/lib/srt';

describe('caption files', () => {
  it('keeps numeric caption lines and multiline Unicode text through a round trip', () => {
    const text = '\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n2026\r\nПривет!\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,000\r\n123\r\n';
    const subs = srtToSubtitles(text);
    expect(subs.map((s) => s.text)).toEqual(['2026\nПривет!', '123']);
    expect(srtToSubtitles(subtitlesToSrt(subs)).map(({ id: _id, ...s }) => s)).toEqual(subs.map(({ id: _id, ...s }) => s));
  });
  it('skips invalid cue timing and accepts end-cue display settings', () => {
    expect(srtToSubtitles('1\n00:00:02,000 --> 00:00:01,000\nBad\n\n2\n00:00:60,000 --> 00:01:03,000\nBad\n\n3\n00:00:01,000 --> 00:00:03,000 align:start\nGood').map((s) => s.text)).toEqual(['Good']);
    expect(parseTimecode('-2')).toBeNull();
  });
  it('rounds milliseconds with a carry across the minute boundary', () => {
    expect(fmtSrtTime(59.9998)).toBe('00:01:00,000');
    expect(fmtSrtTime(1.001)).toBe('00:00:01,001');
  });
});
