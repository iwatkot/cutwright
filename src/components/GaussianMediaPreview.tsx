import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Clip } from '../lib/types';
import { defocusSigma } from '../lib/defocus';
import { paintClampedGaussian } from '../lib/defocusCanvas';

/** Keep the original media node for the shared playback/audio readiness clock.
 * Only its picture is painted here, using the export's clamped Gaussian kernel. */
export function GaussianMediaPreview({ width, height, sigma, clip, base, children }: { width: number; height: number; sigma: number; clip: Clip; base: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const buffers = useRef<{ image: HTMLCanvasElement; transformed: HTMLCanvasElement; edges: HTMLCanvasElement } | null>(null);
  useLayoutEffect(() => {
    const make = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const pad = Math.ceil(defocusSigma(1, width, height) * 3);
    const pool = { image: make(width, height), transformed: make(width, height), edges: make(width + 2 * pad, height + 2 * pad) };
    buffers.current = pool;
    return () => { for (const c of Object.values(pool)) c.width = c.height = 1; buffers.current = null; };
  }, [width, height]);
  useLayoutEffect(() => {
    const source = root.current?.querySelector('video,img') as HTMLVideoElement | HTMLImageElement | null, output = canvas.current, pool = buffers.current;
    if (!source || !output || !pool) return;
    const paint = () => {
      const video = source instanceof HTMLVideoElement, sw = video ? source.videoWidth : source.naturalWidth, sh = video ? source.videoHeight : source.naturalHeight;
      if (!sw || !sh || video && source.readyState < 2) return;
      const image = pool.image.getContext('2d')!, transformed = pool.transformed.getContext('2d')!;
      for (const context of [image, transformed]) { context.resetTransform(); context.clearRect(0, 0, width, height); if (base) { context.fillStyle = '#000'; context.fillRect(0, 0, width, height); } }
      const fit = Math.min(width / sw, height / sh), dw = sw * fit, dh = sh * fit;
      image.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
      transformed.save(); transformed.translate(width / 2 + Math.round((clip.posX ?? 0) / 100 * width), height / 2 + Math.round((clip.posY ?? 0) / 100 * height));
      transformed.scale(clip.scale ?? 1, clip.scale ?? 1); transformed.rotate((clip.rotate ?? 0) * Math.PI / 180); transformed.translate(-width / 2, -height / 2);
      transformed.filter = `brightness(${clip.brightness ?? 1}) contrast(${clip.contrast ?? 1}) saturate(${clip.saturation ?? 1})`;
      transformed.drawImage(pool.image, 0, 0); transformed.restore();
      paintClampedGaussian(pool.transformed, output.getContext('2d')!, pool.edges, width, height, Math.ceil(defocusSigma(1, width, height) * 3), sigma);
    };
    paint(); for (const event of ['loadeddata', 'load', 'seeked']) source.addEventListener(event, paint);
    let frame = 0; const tick = () => { paint(); frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); for (const event of ['loadeddata', 'load', 'seeked']) source.removeEventListener(event, paint); };
  }, [width, height, sigma, clip, base]);
  return <div ref={root} style={{ position: 'absolute', inset: 0 }}>{children}<canvas ref={canvas} width={width} height={height} data-gaussian-sigma={sigma} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} /></div>;
}
