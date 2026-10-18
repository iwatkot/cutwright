export type TrackKind = 'video' | 'audio' | 'text';

/** Editable overlays use composition pixels and source seconds. Media entries
 * hold reusable templates; a clip may override its template independently. */
interface OverlayAnimation {
  /** Signed source phase from an imported preset; ordinary trims use Clip.offset. */
  animationOffset?: number;
  animationDuration?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface ArrowOverlay extends OverlayAnimation {
  kind: 'arrow';
  x1: number; y1: number; x2: number; y2: number;
  color: string;
  width: number;
  head: boolean;
  drawDuration?: number;
}

export interface TitleOverlay extends OverlayAnimation {
  kind: 'title';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  /** Optional contrast stroke in project pixels; zero preserves plain text. */
  outlineWidth?: number;
  outlineColor?: string;
  x: number; y: number;
  blockWidth: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  /** Translation shared by all items in a rolling credit group. */
  scroll?: { fromY: number; toY: number; duration: number };
}

export type NativeOverlay = ArrowOverlay | TitleOverlay;

export interface MediaItem {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** Absolute path in Electron; durable cutwright-local: reference for browser imports. */
  src: string;
  duration: number; // seconds (0 until probed)
  color: string; // synthetic preview hue when no real frames are available
  width?: number;
  height?: number;
  hasAudio?: boolean; // from metadata probe; false = silent video (export must not map its audio)
  thumb?: string; // file:// URL or data URL of a generated thumbnail
  filmstrip?: { time: number; url: string }[]; // derived source-time samples, never export media
  peaks?: number[]; // normalized audio waveform peaks (0..1)
  offline?: boolean; // derived local availability; checked when the media panel opens
  overlay?: NativeOverlay;
}

export interface ClipFadeEnvelope {
  offset: number; duration: number; fadeIn: number; fadeOut: number;
  fadeInCurve?: number; fadeOutCurve?: number;
  fadeInStart?: number; fadeInWindow?: number;
  fadeOutEnd?: number; fadeOutWindow?: number;
}

export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  name: string;
  start: number; // timeline position, seconds
  duration: number;
  offset: number; // in-point inside source
  color: string;
  opacity?: number; // 0..1, overlays (default 1)
  volume?: number; // audio gain 0..4 (default 1); Movavi imports use 3.0 for boosted voice, 0.02 for music beds
  speed?: number; // playback rate 0.1..8 (default 1); Movavi imports can exceed 4x
  /** Embedded video audio is carried by a separate clip. This stays true
   * after detaching or deleting sound: preview/export never restore or double it. */
  mutedAudio?: boolean;
  /** Linked picture/voice edits share timing and one undo transaction. */
  linkGroup?: string | null; // null explicitly unlinks and survives older-project migration
  /** A split crops an existing fade envelope rather than restarting it.
   * Times are in the clip's timeline-rate seconds, including inherited phase. */
  audioEnvelope?: ClipFadeEnvelope;
  visualEnvelope?: ClipFadeEnvelope;
  /** Native, editable content. PNG media remains a portable thumbnail/fallback. */
  overlay?: NativeOverlay;
  /** Import provenance, retained for older project files and conversion audits. */
  generatedOverlay?: { kind: 'arrow' | 'title'; text?: string; preset?: string };
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
  /** Audio curve: -1 slower rise, 0 linear, +1 faster rise. */
  fadeInCurve?: number;
  fadeOutCurve?: number;
  /** Picture fades are independent of sound and overlay source animation. */
  visualFadeIn?: number;
  visualFadeOut?: number;
  visualFadeInCurve?: number;
  visualFadeOutCurve?: number;
  scale?: number; // 0.1..3 (default 1)
  posX?: number; // percent of frame width, -50..50 (default 0)
  posY?: number; // percent of frame height, -50..50 (default 0)
  rotate?: number; // degrees (default 0)
  brightness?: number; // 0..2 (default 1)
  contrast?: number; // 0..2 (default 1)
  saturation?: number; // 0..3 (default 1)
}

export interface SubtitleStyle {
  fontSize: number; // px at 1080p
  color: string; // #RRGGBB
}

export interface TrackSettings {
  muted?: boolean;
  hidden?: boolean;
  volume?: number; // 0..2
}

export interface AppliedTransition {
  id: string;
  defId: string;
  /** Boundary time on the video track, seconds. */
  at: number;
  duration: number;
  /** Clip whose start this transition is anchored to; edits re-anchor or drop it. */
  anchorClipId?: string;
  /** Entrance transition (Movavi clipFrom=null): plays at the anchored
   * clip's start even when it is the first clip on its track. */
  entrance?: boolean;
}

export interface Subtitle {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface TransitionDef {
  id: string;
  name: string;
  description: string;
  /** FFmpeg xfade transition name, or 'fadeblack' style custom handling. */
  xfade: string;
  /** How the web preview approximates it: fade | dissolve | slide | zoom | wipe | blur */
  preview: 'fade' | 'dissolve' | 'slide' | 'zoom' | 'wipe' | 'blur';
  color?: string;
  duration: number; // default seconds
  generated?: boolean;
  collection: string;
}

export interface ProjectFont { family: string; weight: number; dataUrl: string }

export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Local font bytes travel with the editable project; no system installation. */
  fonts?: ProjectFont[];
  media: MediaItem[];
  clips: Clip[];
  transitions: AppliedTransition[];
  subtitles: Subtitle[];
  customTransitions: TransitionDef[];
  trackSettings?: Record<string, TrackSettings>;
  trackOrder?: string[];
  subtitleStyle?: SubtitleStyle;
  /** Timeline annotations; never alter composition duration or exported pixels. */
  markers?: TimelineMarker[];
  /** Editor-only aids, serialized for save/open/recovery and exact history. */
  editorCanvas?: CanvasSettings;
}

export interface TimelineMarker { id: string; time: number; label: string; color: string }
export interface CanvasGuide { id: string; axis: 'x' | 'y'; position: number }
export interface CanvasSettings {
  rulers: boolean;
  guidesVisible: boolean;
  guidesLocked: boolean;
  snap: boolean;
  grid: { visible: boolean; snap: boolean; spacingX: number; spacingY: number; originX: number; originY: number };
  guides: CanvasGuide[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  actions?: string[];
}

export type AgentProviderId = 'local' | 'codex' | 'claude' | 'muse' | 'openai' | 'anthropic';

export interface AgentSettings {
  provider: AgentProviderId;
  model: string;
  apiKey: string;
}
