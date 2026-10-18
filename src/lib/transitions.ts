import type { TransitionDef } from './types';
import { normalizeTransitionDescription } from './transitionLanguage';

/** `gaussian` is our uniform focus/crossfade; other xfade values retain FFmpeg semantics. */
export const BUILTIN_TRANSITIONS: TransitionDef[] = [
  { id: 'cut', name: 'Cut (none)', description: 'Hard cut, no blend', xfade: 'fade', preview: 'dissolve', duration: 0, collection: 'Essentials' },
  { id: 'cross-dissolve', name: 'Cross Dissolve', description: 'Classic soft blend between shots', xfade: 'fade', preview: 'dissolve', duration: 0.6, collection: 'Essentials' },
  { id: 'fade-to-black', name: 'Fade to Black', description: 'Dip through black — chapter breaks, endings', xfade: 'fadeblack', preview: 'fade', color: '#000000', duration: 0.8, collection: 'Essentials' },
  { id: 'fade-to-white', name: 'Fade to White', description: 'Dip through white — flashbacks, dream beats', xfade: 'fadewhite', preview: 'fade', color: '#ffffff', duration: 0.8, collection: 'Essentials' },
  { id: 'slide-left', name: 'Slide Left', description: 'Next shot pushes in from the right', xfade: 'slideleft', preview: 'slide', duration: 0.5, collection: 'Movement' },
  { id: 'slide-up', name: 'Slide Up', description: 'Next shot rises from below', xfade: 'slideup', preview: 'slide', duration: 0.5, collection: 'Movement' },
  { id: 'wipe-left', name: 'Wipe Left', description: 'Clean edge sweeps across the frame', xfade: 'wipeleft', preview: 'wipe', duration: 0.5, collection: 'Movement' },
  { id: 'smooth-zoom', name: 'Smooth Zoom', description: 'Punch-in zoom blend (preview approx.)', xfade: 'smoothleft', preview: 'zoom', duration: 0.6, collection: 'Movement' },
  { id: 'circle-open', name: 'Circle Open', description: 'Iris opens on the next shot', xfade: 'circleopen', preview: 'wipe', duration: 0.7, collection: 'Stylized' },
  { id: 'pixelize', name: 'Pixelize', description: 'Blocky digital breakdown', xfade: 'pixelize', preview: 'dissolve', duration: 0.6, collection: 'Stylized' },
  { id: 'blur-inout', name: 'Directional Smear', description: 'Horizontal forward smear blend between shots', xfade: 'hblur', preview: 'blur', duration: 2.0, collection: 'Stylized' },
  { id: 'gaussian-defocus', name: 'Camera Defocus', description: 'Outgoing shot defocuses while the incoming shot comes into focus', xfade: 'gaussian', preview: 'defocus', duration: 1, collection: 'Stylized' },
];

const XFADES = ['fade', 'fadeblack', 'fadewhite', 'fadegrays', 'slideleft', 'slideright', 'slideup', 'slidedown', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'circleopen', 'circleclose', 'pixelize', 'smoothleft', 'smoothright', 'dissolve', 'radial', 'hblur'];

/** Turn a free-text request like "fade to black" into a TransitionDef. */
export function synthesizeTransition(request: string): TransitionDef {
  const r = normalizeTransitionDescription(request);
  let preview: TransitionDef['preview'] = 'dissolve';
  let xfade = 'fade';
  let color: string | undefined;

  if (/black/.test(r)) { xfade = 'fadeblack'; preview = 'fade'; color = '#000000'; }
  else if (/white/.test(r)) { xfade = 'fadewhite'; preview = 'fade'; color = '#ffffff'; }
  else if (/slide/.test(r)) { xfade = /up/.test(r) ? 'slideup' : /down/.test(r) ? 'slidedown' : /right/.test(r) ? 'slideright' : 'slideleft'; preview = 'slide'; }
  else if (/wipe/.test(r)) { xfade = /up/.test(r) ? 'wipeup' : /down/.test(r) ? 'wipedown' : /right/.test(r) ? 'wiperight' : 'wipeleft'; preview = 'wipe'; }
  else if (/zoom|punch/.test(r)) { xfade = 'smoothleft'; preview = 'zoom'; }
  else if (/circle|iris/.test(r)) { xfade = /close/.test(r) ? 'circleclose' : 'circleopen'; preview = 'wipe'; }
  else if (/pixel/.test(r)) { xfade = 'pixelize'; preview = 'dissolve'; }
  else if (/hblur|smear|directional|horizontal.*blur/.test(r)) { xfade = 'hblur'; preview = 'blur'; }
  else if (/blur|gauss|defocus|focus/.test(r)) { xfade = 'gaussian'; preview = 'defocus'; }
  else if (/dissolve|cross/.test(r)) { xfade = 'fade'; preview = 'dissolve'; }

  const explicit = r.trim().match(/^([a-z]+)(?:\s+\d+(?:\.\d+)?\s*(?:s|sec|seconds|ms))?$/)?.[1];
  const named = XFADES.find((x) => x === explicit);
  if (named) xfade = named;

  const name = request
    .replace(/^(create|make|generate|add|new)\s+(a\s+|an\s+)?(transition\s+)?/i, '')
    .trim()
    .replace(/^\p{L}/u, (c) => c.toUpperCase()) || 'Custom Transition';

  const durMatch = r.match(/(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms)/);
  const duration = durMatch ? (durMatch[2] === 'ms' ? Number(durMatch[1]) / 1000 : Number(durMatch[1])) : 0.7;

  return {
    id: 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).slice(2, 6),
    name,
    description: `Generated from: “${request}”`,
    xfade, preview, color, duration,
    generated: true,
    collection: 'My Creations',
  };
}
