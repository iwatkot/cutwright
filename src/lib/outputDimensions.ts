/** Fit an export preset to the shorter project edge, preserving portrait and
 * landscape orientation. Presets never upscale. Both renderers use the same
 * nearest-even rounding for encoder-compatible output, including legacy odd
 * project dimensions (which may round up by one pixel). */
export function exportDimensions(
  project: { width: number; height: number },
  maxShortEdge?: number,
): { width: number; height: number } {
  if (![project.width, project.height].every((value) => Number.isFinite(value) && value >= 2)) {
    throw new RangeError('Export dimensions must be at least 2 pixels');
  }
  if (maxShortEdge !== undefined && (!Number.isFinite(maxShortEdge) || maxShortEdge < 2)) {
    throw new RangeError('Export preset size must be at least 2 pixels');
  }
  const scale = maxShortEdge === undefined ? 1 : Math.min(1, maxShortEdge / Math.min(project.width, project.height));
  const even = (value: number) => Math.max(2, Math.round(value * scale / 2) * 2);
  return { width: even(project.width), height: even(project.height) };
}
