# CutWright

A free video editor for your browser and Windows. Editing and export run on your device, with no account, media upload, render server, or subscription required for the editor.

[Website](https://cutwright.cc) · [Open the browser editor](https://app.cutwright.cc) · [Windows release candidate](https://github.com/iwatkot/cutwright-dist/releases/tag/v0.2.0-rc.4)

Custom-domain setup is pending. The browser editor is already available at https://iwatkot.github.io/cutwright-dist/.

CutWright includes a multitrack timeline, titles and graphics, captions, transitions, project sizing, canvas guides, markers, and local MP4 export. Optional external agent connections let a compatible agent client work with the editor; those clients may have their own accounts or costs. See [EXTERNAL_AGENTS.md](EXTERNAL_AGENTS.md) and [RC_SHORTCUTS.md](RC_SHORTCUTS.md).

## Build from source

Use Node.js 24 LTS and npm. Windows is required for the supported desktop build. Install the exact locked dependencies:

```sh
npm ci
```

Installation applies the included version and hash checked AAC timing and MP3 sample-entry corrections. Keep these postinstall scripts enabled.

For browser development:

```sh
npm run dev:web
```

Open the local address printed by Vite, normally `http://localhost:5173`. The browser editor uses WebCodecs, local browser storage, and a local FFmpeg WebAssembly worker. Use a current desktop Chrome or Edge; media codec support depends on the browser and device.

Build the static browser app:

```sh
npm run build:web
```

Serve the complete `dist/` directory, including `third-party/`, over HTTPS. Localhost is supported for development. No application server is needed in production.

## Windows app

Start the desktop editor in development:

```sh
npm run dev
```

Build the Windows installer:

```sh
npm run dist
```

The installer is written to `release/CutWright-Setup-<version>.exe`. `npm run dist:dir` produces an unpacked Windows app instead.

To package the browser app together with that version's installer and a distribution manifest, first build the installer, then run:

```sh
npm run dist:web
```

The complete static package is written to `release/browser/`. This packaging command requires the matching local installer even when `CW_DESKTOP_DOWNLOAD_URL` points to an external HTTPS release download. Published installers and browser distribution artifacts live in [cutwright-dist releases](https://github.com/iwatkot/cutwright-dist/releases).

## Checks

```sh
npm run typecheck
npm test
node scripts/audit-rc-widgets.mjs
node scripts/verify-runtime-notices.mjs
```

The unit suite uses synthetic fixtures; personal projects and original media are not included. Passing these checks does not certify an installer or every browser and codec combination.

## License

CutWright source is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses. Builds include dependency notices, source records, and the included codec corrections under `dist/third-party/`; keep that directory with redistributed browser and desktop builds. The notice preparation scripts and license texts are retained in `scripts/`.
