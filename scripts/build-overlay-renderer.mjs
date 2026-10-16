// Bundle the shared SVG renderer for the isolated Electron export renderer.
import { build } from 'esbuild';
await build({ entryPoints: ['src/lib/overlay.ts'], outfile: 'dist-electron/overlay-browser.js',
  bundle: true, format: 'iife', globalName: 'CutWrightOverlay', platform: 'browser', logLevel: 'silent' });
