/** Outgoing detail only decreases; incoming uses the reversed curve. Blur
 * belongs to each image before blending, never to the mixed image. The 18px
 * midpoint is retained, with a smooth 0..36px travel through disappearance. */
export function defocusSigma(progress: number, width: number, height: number): number {
  const p = Math.max(0, Math.min(1, progress));
  return 36 * Math.min(width, height) / 1080 * p * p * (3 - 2 * p);
}

/** Reference Gaussian with clamped edges and premultiplied alpha. Browser
 * export uses the canvas Gaussian filter for the same kernel efficiently. */
export function gaussianRgba(input: Uint8ClampedArray, width: number, height: number, sigma: number): Uint8ClampedArray {
  if (input.length !== width * height * 4) throw new Error('Gaussian frame dimensions do not match');
  if (!(sigma > .001)) return input.slice();
  const radius = Math.ceil(sigma * 3), kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-.5 * ((i - radius) / sigma) ** 2));
  const sum = kernel.reduce((a, b) => a + b, 0); kernel.forEach((v, i) => { kernel[i] = v / sum; });
  const src = new Float32Array(input.length), horizontal = new Float32Array(input.length), output = new Uint8ClampedArray(input.length);
  for (let i = 0; i < input.length; i += 4) { const alpha = input[i + 3] / 255; for (let c = 0; c < 3; c++) src[i + c] = input[i + c] * alpha; src[i + 3] = input[i + 3]; }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    let value = 0; for (let k = -radius; k <= radius; k++) value += src[(y * width + Math.max(0, Math.min(width - 1, x + k))) * 4 + c] * kernel[k + radius];
    horizontal[(y * width + x) * 4 + c] = value;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgba = [0, 0, 0, 0], i = (y * width + x) * 4;
    for (let k = -radius; k <= radius; k++) for (let c = 0; c < 4; c++) rgba[c] += horizontal[(Math.max(0, Math.min(height - 1, y + k)) * width + x) * 4 + c] * kernel[k + radius];
    for (let c = 0; c < 3; c++) output[i + c] = rgba[3] > 0 ? rgba[c] * 255 / rgba[3] : 0;
    output[i + 3] = rgba[3];
  }
  return output;
}
