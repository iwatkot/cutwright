import { t as uiText } from '../i18n/core';
import { Field, PopoverControl, ToggleGroup } from './ui/Controls';
import { exportDimensions } from '../lib/outputDimensions';
import type { Project } from '../lib/types';
import type { EditorExportPreset } from '../lib/editorTools';
import type { ExportQuality } from '../lib/exportQuality';

export default function ExportSettings({ project, preset, quality, onPreset, onQuality }: { project: Project; preset: EditorExportPreset; quality: ExportQuality; onPreset(value: EditorExportPreset): void; onQuality(value: ExportQuality): void }) {
  const qualities = [
    { value: 'high', label: uiText("High"), description: uiText("More detail, larger file.") },
    { value: 'balanced', label: uiText("Balanced"), description: uiText("Good detail with a smaller file.") },
    { value: 'compact', label: uiText("Smaller file"), description: uiText("Less detail, smallest file.") },
  ];
  const resolution = preset === 'source' ? uiText("Source") : uiText("{0}p", { 0: preset });
  const currentQuality = qualities.find(q => q.value === quality)!;
  const size = exportDimensions(project, preset === 'source' ? undefined : Number(preset));
  return <PopoverControl className="export-preset" label={uiText("Export settings")} summary={resolution} hint={`${resolution} · ${currentQuality.label}`}>
    <Field label={uiText("Resolution")} hint={`${size.width} × ${size.height}${preset === 'source' ? uiText(" · Project size") : ''}`}>
      <ToggleGroup label={uiText("Export resolution")} value={preset} onChange={value => onPreset(value as EditorExportPreset)} options={['source', '1080', '720', '480'].map(value => ({ value, label: value === 'source' ? uiText("Source") : uiText("{0}p", { 0: value }) }))} />
    </Field>
    <Field label={uiText("Quality")} hint={currentQuality.description}>
      <ToggleGroup label={uiText("Export quality")} value={quality} options={qualities} onChange={value => onQuality(value as ExportQuality)} />
    </Field>
    <p className="export-settings-note">{uiText("Quality changes detail and file size. Export time also depends on your timeline.")}</p>
  </PopoverControl>;
}
