type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** The preview and browser export extend the same edge pixels before Gaussian
 * filtering. Filtering transparency outside the frame would darken its border. */
export function paintClampedGaussian(source: CanvasImageSource, destination: Context, scratch: HTMLCanvasElement | OffscreenCanvas, width: number, height: number, pad: number, sigma: number) {
  const edges = scratch.getContext('2d') as Context;
  edges.resetTransform(); edges.globalAlpha = 1; edges.globalCompositeOperation = 'source-over'; edges.filter = 'none';
  edges.clearRect(0, 0, scratch.width, scratch.height);
  const xs = [[0, 1, 0, pad], [0, width, pad, width], [width - 1, 1, pad + width, pad]];
  const ys = [[0, 1, 0, pad], [0, height, pad, height], [height - 1, 1, pad + height, pad]];
  for (const [sx, sw, dx, dw] of xs) for (const [sy, sh, dy, dh] of ys) edges.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  destination.save(); destination.resetTransform(); destination.globalAlpha = 1; destination.globalCompositeOperation = 'source-over';
  destination.clearRect(0, 0, width, height); destination.filter = `blur(${sigma}px)`;
  destination.drawImage(scratch, -pad, -pad); destination.restore();
}
