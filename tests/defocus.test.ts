import { describe, expect, it } from 'vitest';
import { defocusSigma, gaussianRgba } from '../src/lib/defocus';
import { BUILTIN_TRANSITIONS, synthesizeTransition } from '../src/lib/transitions';
import { transitionRgba } from '../src/lib/browserComposition';
import { transitionPreviewStyles } from '../src/lib/previewComposition';

describe('uniform Gaussian camera focus', () => {
  it('keeps legacy IDs/effect and routes ordinary blur requests to the new camera effect', () => {
    expect(BUILTIN_TRANSITIONS.find(d => d.id === 'blur-inout')).toMatchObject({ name: 'Directional Smear', xfade: 'hblur' });
    expect(synthesizeTransition('blur 1s')).toMatchObject({ xfade: 'gaussian', preview: 'defocus', duration: 1 });
    expect(synthesizeTransition('directional smear 1s').xfade).toBe('hblur');
    expect(synthesizeTransition('hblur 1s').xfade).toBe('hblur');
  });
  it.each(['Kameraunschärfe','Kamerauskarphed','Zamućenje fokusa','Rozostření kamery','Camera-onscherpte','Défocalisation','Desenfoque de cámara','Расфокусировка камеры','Розфокусування камери'])('recognizes the localized camera effect: %s', request => {
    expect(synthesizeTransition(request).xfade).toBe('gaussian');
  });
  it('is centered, isotropic, position independent and cannot become a side wipe', () => {
    const W = 65, H = 65;
    const impulse = (x: number, y: number) => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 3; i < a.length; i += 4) a[i] = 255; a[(y * W + x) * 4] = 255; return gaussianRgba(a, W, H, 2); };
    const center = impulse(32, 32), corner = impulse(16, 16);
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const get = (a: Uint8ClampedArray, x: number, y: number) => a[(y * W + x) * 4];
      expect(get(center, 32 + dx, 32 + dy)).toBe(get(center, 32 + dy, 32 + dx));
      expect(get(center, 32 + dx, 32 + dy)).toBe(get(center, 32 - dx, 32 - dy));
      expect(get(center, 32 + dx, 32 + dy)).toBe(get(corner, 16 + dx, 16 + dy));
    }
    const constant = new Uint8ClampedArray(W * H * 4).fill(180);
    expect(gaussianRgba(constant, W, H, 2)).toEqual(constant);
  });
  it('uses the same smooth focus radius in preview and export, with exact sharp endpoints', () => {
    const def = BUILTIN_TRANSITIONS.find(d => d.id === 'gaussian-defocus')!;
    expect(defocusSigma(0, 1920, 1080)).toBe(0); expect(defocusSigma(1, 1920, 1080)).toBe(36);
    expect(defocusSigma(.5, 1920, 1080)).toBe(18);
    expect(transitionPreviewStyles(def, .5, .5).outgoing.filter).toBe('blur(9px)');
    expect(transitionPreviewStyles(def, .5).outgoing.filter).toBe(transitionPreviewStyles(def, .5).incoming.filter);
    const a = new Uint8ClampedArray(16).fill(80), b = new Uint8ClampedArray(16).fill(200);
    expect(transitionRgba(a, b, 2, 2, 'gaussian', 0)).toEqual(a); expect(transitionRgba(a, b, 2, 2, 'gaussian', 1)).toEqual(b);
  });
  it('never restores outgoing detail before disappearance, or loses incoming detail while appearing', () => {
    const W = 96, H = 96, a = new Uint8ClampedArray(W * H * 4), b = a.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      a.set([128 + 90 * Math.cos(x * Math.PI / 4), 128, 128, 255], i);
      b.set([128, 128, 128 + 90 * Math.cos(y * Math.PI / 4), 255], i);
    }
    let previousOut = Infinity, previousIn = -Infinity, previousSigma = -1;
    const amplitude = (pixels: Uint8ClampedArray, channel: number) => {
      let sum = 0; for (let y = 16; y < 80; y++) for (let x = 16; x < 80; x++) sum += (pixels[(y * W + x) * 4 + channel] - 128) * Math.cos((channel === 0 ? x : y) * Math.PI / 4);
      return sum / 2048;
    };
    for (let frame = 0; frame <= 30; frame++) {
      const p = frame / 30, sigma = defocusSigma(p, W, H), pixels = transitionRgba(a, b, W, H, 'gaussian', p);
      const outgoing = amplitude(pixels, 0), incoming = amplitude(pixels, 2);
      expect(sigma).toBeGreaterThanOrEqual(previousSigma);
      expect(outgoing).toBeLessThanOrEqual(previousOut + .3);
      expect(incoming).toBeGreaterThanOrEqual(previousIn - .3);
      const style = transitionPreviewStyles(BUILTIN_TRANSITIONS.find(d => d.id === 'gaussian-defocus')!, p, 1, H);
      expect(style.outgoing.filter).toBe(`blur(${sigma}px)`);
      expect(style.incoming.filter).toBe(`blur(${defocusSigma(1 - p, W, H)}px)`);
      expect(style.outgoing.opacity).toBeCloseTo(1 - p); expect(style.incoming.opacity).toBeCloseTo(p);
      previousOut = outgoing; previousIn = incoming; previousSigma = sigma;
    }
  });
});
