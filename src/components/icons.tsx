import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useShortcutLabel } from '../lib/shortcutPreferences';
import type { ShortcutAction } from '../lib/shortcuts';

export function IconButton({ label, shortcut, action, children, className = '', title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; shortcut?: string; action?: ShortcutAction }) {
  const configured = useShortcutLabel(action);
  const hint = action ? configured : shortcut;
  const tooltip = `${title ?? label}${hint ? ` (${hint})` : ''}`;
  return <button type="button" className={`icon-button ${className}`} aria-label={label} data-tooltip={tooltip} {...props}>{children}</button>;
}

/** Consistent 24px stroke icon set (rendered 16–18px in 28–32px targets). */
function base(children: ReactNode, filled = false) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const IconSplit = () => base(<><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><path d="M8.1 7.6 20 19M8.1 16.4 20 5" /></>);
export const IconDelete = () => base(<><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6" /></>);
export const IconUndo = () => base(<><path d="M8.5 5.5 4.5 9.5l4 4" /><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3" /></>);
export const IconRedo = () => base(<><path d="m15.5 5.5 4 4-4 4" /><path d="M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3" /></>);
export const IconSnap = () => base(<><path d="M12 3v18" /><path d="M5 8l4 4-4 4M19 8l-4 4 4 4" /></>);
export const IconRipple = () => base(<><path d="M3 5v14M8 5v14" /><path d="M12 9h9M12 15h6" /><path d="m18 6.5 3 2.5-3 2.5" /></>);
export const IconPlay = () => base(<path d="M8 5.2v13.6L19 12z" />, true);
export const IconPause = () => base(<><rect x="6.5" y="5" width="3.6" height="14" rx="1" /><rect x="13.9" y="5" width="3.6" height="14" rx="1" /></>, true);
export const IconSkipStart = () => base(<><path d="M6 5v14" /><path d="M19 5.2v13.6L9.5 12z" fill="currentColor" /></>);
export const IconSkipEnd = () => base(<><path d="M18 5v14" /><path d="M5 5.2v13.6L14.5 12z" fill="currentColor" /></>);
export const IconStepBack = () => base(<><path d="M15 5.5 8.5 12l6.5 6.5" /></>);
export const IconStepFwd = () => base(<><path d="m9 5.5 6.5 6.5L9 18.5" /></>);
export const IconFolderOpen = () => base(<><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h9.5A1.5 1.5 0 0 1 22 9.5l-1.6 8A2 2 0 0 1 18.4 19H5.6a2 2 0 0 1-2-2.4z" /></>);
export const IconSave = () => base(<><path d="M5 3.5h11L20.5 8v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1z" /><path d="M7.5 3.5V9h8V3.5M7.5 20.5v-7h9v7" /></>);
export const IconFilePlus = () => base(<><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" /><path d="M13.5 3.5v4h5M12 11v6M9 14h6" /></>);
export const IconImport = () => base(<><path d="M12 4v10.5M7.5 10 12 14.5 16.5 10" /><path d="M4.5 19.5h15" /></>);
export const IconDots = () => base(<><circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none" /></>);
export const IconEye = () => base(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>);
export const IconEyeOff = () => base(<><path d="M4.5 4.5l15 15" /><path d="M9.9 6.2A9.4 9.4 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.4M6 8A16.4 16.4 0 0 0 2.5 12S6 18 12 18c1.2 0 2.3-.3 3.3-.7" /></>);
export const IconVolume = () => base(<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M15.5 9.5a4 4 0 0 1 0 5M18 7a7.5 7.5 0 0 1 0 10" /></>);
export const IconMuted = () => base(<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="m15.5 9.5 5 5M20.5 9.5l-5 5" /></>);
export const IconCollapse = () => base(<><path d="m10 5.5 6.5 6.5L10 18.5" /></>);
export const IconChat = () => base(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><circle cx="19" cy="17" r="2" /></>);
export const IconConnection = () => base(<><path d="m9 15 6-6M8 12l-2 2a4 4 0 0 0 6 6l2-2M10 6l2-2a4 4 0 0 1 6 6l-2 2" /></>);
export const IconTerminal = () => base(<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>);
export const IconAsterisk = () => base(<><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></>);
export const IconGlobe = () => base(<><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>);
export const IconCopy = () => base(<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>);
export const IconChevronRight = () => base(<path d="m9 5 7 7-7 7"/>);
export const IconPlus = () => base(<><path d="M12 5v14M5 12h14" /></>);
export const IconClose = () => base(<path d="m6 6 12 12M18 6 6 18" />);
export const IconUnlink = () => base(<><path d="m9 8 3-3a4 4 0 0 1 6 6l-2 2M15 16l-3 3a4 4 0 0 1-6-6l2-2M3 3l18 18" /></>);
export const IconHelp = () => base(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1.5-1.5 2.5M12 17h.01" /></>);
export const IconKeyboard = () => base(<><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/></>);
export const IconFit = () => base(<><path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6"/><rect x="7" y="7" width="10" height="10" rx="1"/></>);
export const IconHand = () => base(<><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 4-2 7-6 7h-2c-2 0-3-1-4-3l-4-6a1.8 1.8 0 0 1 3-2l3 4"/></>);
export const IconSun = () => base(<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></>);
export const IconMoon = () => base(<path d="M20 14a8 8 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z"/>);
export const IconAutoTheme = () => base(<><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></>);
export const IconExport = () => base(<><path d="M12 16V4m-4 4 4-4 4 4M5 14v6h14v-6" /></>);
export const IconVideoPlus = () => base(<><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 9 4-2v10l-4-2M7 12h6M10 9v6" /></>);
export const IconAudioPlus = () => base(<><path d="M5 6v8M2 10h6M14 18V5l7-2v13M14 8l7-2" /><ellipse cx="11" cy="18" rx="3" ry="2" /><ellipse cx="18" cy="16" rx="3" ry="2" /></>);
export const IconZoomOut = () => base(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6" /></>);
export const IconZoomIn = () => base(<><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6M10.5 7.5v6" /></>);
export const IconTrackHeight = () => base(<><path d="M4 4h16M4 20h16M12 7v10m-3-7 3-3 3 3m-6 4 3 3 3-3" /></>);
export const IconVideo = () => base(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9v6l5-3z" fill="currentColor" stroke="none" /></>);
export const IconImage = () => base(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 3-3 6 6" /></>);
export const IconAudio = () => base(<><path d="M10 18V5l10-2v13M10 8l10-2" /><ellipse cx="7" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></>);
export const IconSettings = () => base(<><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>);
export const IconText = () => base(<path d="M5 6h14M12 6v12M9 18h6M5 6v3M19 6v3" />);
export const IconTransition = () => base(<><path d="M4 7h9M4 12h13M4 17h7M17 4l3 3-3 3M20 14l-3 3 3 3" /></>);
export const IconCheck = () => base(<path d="m5 12 4 4L19 6" />);
export const IconElements = () => base(<><rect x="3" y="3" width="7" height="7" rx="1" /><circle cx="17" cy="7" r="4" /><path d="m7 14 4 7H3zM14 14h7v7h-7z" /></>);
export const IconGrid = () => base(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>);
export const IconCaptions = () => base(<><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M10 10a2.5 2.5 0 1 0 0 4M18 10a2.5 2.5 0 1 0 0 4" /></>);
export const IconSend = () => base(<><path d="m3 3 18 9-18 9 4-9zM7 12h14" /></>);
export const IconMarker = () => base(<><path d="m12 3 5 6-5 6-5-6zM12 15v6" /><path d="M18 17h4M20 15v4" /></>);
export const IconMarkers = () => base(<><path d="m7 3 4 5-4 5-4-5zM7 13v8M14 5h7M14 10h7M14 15h7M14 20h7" /></>);
export const IconRuler = () => base(<><path d="M3 4h18v6H9v10H3zM7 4v3M11 4v2M15 4v3M19 4v2M3 12h3M3 16h2" /></>);
export const IconGuides = () => base(<><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M12 2v20M2 12h20" strokeDasharray="2 3" /></>);
export const IconGridSnap = () => base(<><path d="M8 3v18M16 3v18M3 8h18M3 16h18" opacity=".5" /><path d="m9.5 12 2 2 4-4" /></>);
export const IconLock = () => base(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>);
export const IconGuideVerticalPlus = () => base(<><path d="M4 4h9M4 4v16h16v-9M11 5v14" strokeDasharray="2 3" /><path d="M18 2v6M15 5h6" /></>);
export const IconGuideHorizontalPlus = () => base(<><path d="M4 4h9M4 4v16h16v-9M5 12h14" strokeDasharray="2 3" /><path d="M18 2v6M15 5h6" /></>);
