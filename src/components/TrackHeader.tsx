import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/core';
import type { TrackSettings } from '../lib/types';
import { IconButton, IconCollapse, IconDots, IconEye, IconEyeOff, IconMuted, IconVolume } from './icons';

/** Mobile controls unfold over their row; the timeline's time origin stays fixed. */
export default function TrackHeader({ trackId, compact, slim, settings, menuOpen, onSettings, onMenu }: {
  trackId: string; compact: boolean; slim: boolean; settings: TrackSettings; menuOpen: boolean;
  onSettings: (patch: Partial<TrackSettings>) => void;
  onMenu: (button: HTMLButtonElement, returnFocus: HTMLButtonElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const controlsId = useId(), label = trackId.toUpperCase(), video = trackId.startsWith('v');
  const expanded = compact && open;
  const toggleLabel = expanded ? t("Collapse {0} track controls", {0:label}) : t("Expand {0} track controls", {0:label});
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus && root.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => { setOpen(false); }, [compact]);
  useEffect(() => {
    if (!compact || !open) return;
    const outside = (event: Event) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', outside, true);
    };
  }, [compact, open]);
  const change = (patch: Partial<TrackSettings>) => { onSettings(patch); if (compact) close(true); };
  const tabIndex = compact && !open ? -1 : undefined;

  return <div ref={root} className={`tracklabel${slim ? ' slim' : ''}${expanded ? ' controls-open' : ''}`} role="group" aria-label={t("{0} track actions", {0:label})} data-track-kind={video ? 'video' : 'audio'} data-muted={settings.muted || undefined} data-hidden={settings.hidden || undefined} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    if (expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    {compact ? <button ref={trigger} type="button" className="track-expand" aria-label={toggleLabel} data-tooltip={toggleLabel} aria-expanded={expanded} aria-controls={controlsId} onClick={() => setOpen(!open)}><span className="trackname">{label}</span><IconCollapse /></button> : <span className="trackname">{label}</span>}
    <span id={controlsId} className="trackbtns" aria-hidden={compact && !open || undefined}>
      {video && <IconButton tabIndex={tabIndex} className="trackbtn" label={`${settings.hidden ? t("Show") : t("Hide")} ${label}`} aria-pressed={!settings.hidden} onClick={() => change({hidden: !settings.hidden})}>{settings.hidden ? <IconEyeOff /> : <IconEye />}</IconButton>}
      <IconButton tabIndex={tabIndex} className={`trackbtn ${settings.muted ? 'off' : ''}`} label={`${settings.muted ? t("Unmute") : t("Mute")} ${label}`} aria-pressed={!!settings.muted} onClick={() => change({muted: !settings.muted})}>{settings.muted ? <IconMuted /> : <IconVolume />}</IconButton>
      <IconButton tabIndex={tabIndex} className="trackbtn" label={t("{0} track actions", {0:label})} aria-haspopup="menu" aria-expanded={menuOpen} onClick={event => {
        event.stopPropagation();
        const button = event.currentTarget;
        onMenu(button, compact ? trigger.current! : button);
        if (compact) close();
      }}><IconDots /></IconButton>
    </span>
  </div>;
}
