/** Resolution and quality are independent export choices. High preserves the
 * existing browser target and source/1080/720 native quality. Audio stays at
 * 192 kbit/s across presets so smaller pictures do not degrade narration. */
export type ExportQuality = 'high' | 'balanced' | 'compact';
export const EXPORT_QUALITIES: readonly ExportQuality[] = ['high', 'balanced', 'compact'];

const profiles = {
  high: { bitsPerPixel: .32, minimumBitrate: 2e6, crf: 18 },
  balanced: { bitsPerPixel: .16, minimumBitrate: 1e6, crf: 23 },
  compact: { bitsPerPixel: .08, minimumBitrate: .5e6, crf: 28 },
} as const;

export function exportQualitySettings(quality: ExportQuality = 'high') {
  const profile = profiles[quality];
  if (!profile) throw new Error('Unknown export quality.');
  return profile;
}

export function browserVideoBitrate(width: number, height: number, fps: number, quality: ExportQuality = 'high'): number {
  const profile = exportQualitySettings(quality);
  return Math.max(profile.minimumBitrate, Math.round(width * height * fps * profile.bitsPerPixel));
}
