/** A download basename keeps the person's script while excluding filename separators. */
export function projectDownloadBasename(name: string): string {
  const safe=name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'-').replace(/^[. ]+|[. ]+$/g,'');
  const shortened=Array.from(safe).slice(0,120).join('') || 'CutWright';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(shortened) ? `_${shortened}` : shortened;
}
