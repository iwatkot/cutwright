import { describe, expect, it } from 'vitest';
import { clampFade, fadeEnvelope } from '../src/lib/audioEnv';

describe('shared fade envelope (preview == export rules)', () => {
  it('clamps fades to half the clip duration', () => {
    expect(clampFade(4, 2)).toBe(1);
    expect(clampFade(0.5, 4)).toBe(0.5);
  });
  it('ramps in and out symmetrically', () => {
    expect(fadeEnvelope(0, 4, 1, 1)).toBe(0);
    expect(fadeEnvelope(0.5, 4, 1, 1)).toBeCloseTo(0.5);
    expect(fadeEnvelope(2, 4, 1, 1)).toBe(1);
    expect(fadeEnvelope(3.5, 4, 1, 1)).toBeCloseTo(0.5);
    expect(fadeEnvelope(4, 4, 1, 1)).toBe(0);
  });
  it('oversized fadeIn (4s on a 2s clip) behaves as a half-clip ramp', () => {
    expect(fadeEnvelope(0.5, 2, 4, 0)).toBeCloseTo(0.5);
    expect(fadeEnvelope(1, 2, 4, 0)).toBe(1);
  });
});
