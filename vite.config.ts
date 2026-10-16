import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
let checkoutTag = '';
try { checkoutTag = execFileSync('git', ['describe', '--tags', '--exact-match'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const version = process.env.RELEASE_TAG || (/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(checkoutTag) ? checkoutTag : pkg.version);
const commit = process.env.CW_SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

export default defineConfig({
  plugins: [react(), { name: 'release-identity', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version, commit }) });
  } }],
  define: { __APP_VERSION__: JSON.stringify(version) },
  base: './',
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/release/**', '**/screenshots/**', '**/dist/**', '**/dist-electron/**'] } },
  build: { outDir: 'dist' },
});
