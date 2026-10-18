import { describe, expect, it } from 'vitest';
import { browserVideoBitrate, exportQualitySettings } from '../src/lib/exportQuality';

describe('export quality independent of resolution', () => {
  it('preserves the previous high-quality browser target by default', () => {
    expect(browserVideoBitrate(1920, 1080, 30)).toBe(19906560);
    expect(browserVideoBitrate(640, 360, 30)).toBe(2211840);
    expect(exportQualitySettings().crf).toBe(18);
  });
  it('offers decreasing video bitrate and increasing native CRF without changing dimensions or audio', () => {
    expect(['high', 'balanced', 'compact'].map(q => browserVideoBitrate(1920, 1080, 30, q as 'high' | 'balanced' | 'compact'))).toEqual([19906560, 9953280, 4976640]);
    expect(exportQualitySettings('balanced').crf).toBe(23);
    expect(exportQualitySettings('compact').crf).toBe(28);
    expect(browserVideoBitrate(160, 90, 30, 'compact')).toBe(500000);
  });
});
