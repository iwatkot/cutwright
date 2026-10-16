# CutWright

A free video editor for your browser and Windows. Editing and export run on your device, with no account, media upload, render server, or subscription required for the editor.

[Website](https://cutwright.cc) · [Open the browser editor](https://app.cutwright.cc) · [Windows download](https://github.com/iwatkot/cutwright/releases/latest)

The website and browser editor run on their own domains. The old https://iwatkot.github.io/cutwright-dist/ editor remains a fallback; its browser storage is separate, so save projects and retain original media before changing origins.

The detailed user manual lives at https://cutwright.cc/docs/ and is maintained in a separate private website repository. Contributors must read `AGENTS.md` and `.agents/skills/cutwright-user-docs/SKILL.md`; every feature or user-facing change includes its matching manual update. Website source changes require access to that repository.

CutWright includes a multitrack timeline, titles and graphics, captions, transitions, project sizing, canvas guides, markers, and local MP4 export. Optional external agent connections let a compatible agent client work with the editor; those clients may have their own accounts or costs. See [EXTERNAL_AGENTS.md](EXTERNAL_AGENTS.md) and [RC_SHORTCUTS.md](RC_SHORTCUTS.md).

## Build from source

The canonical app repository is https://github.com/iwatkot/cutwright. Use one app checkout; a separate public-source mirror is no longer maintained. Keep personal projects in `projects/`, design explorations in `design/`, and other private development material in `.local/`. These directories and generated build outputs are ignored by Git. Ignore rules do not remove files that are already tracked.

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

The complete static package is written to `release/browser/`. This packaging command requires the matching local installer even when `CW_DESKTOP_DOWNLOAD_URL` points to an external HTTPS release download. New installers, checksums and build manifests live in [CutWright releases](https://github.com/iwatkot/cutwright/releases); the old distribution repository retains historical builds.

## Docker and releases

Run the first release locally with Docker:

```sh
docker run --rm -p 8080:80 iwatkot/cutwright:0.0.1
```

Open `http://localhost:8080`. The image serves the browser editor; editing and export still happen on your device. The website also offers compact Docker and source-start command panels beside the Windows download.

Publish one GitHub release in this repository with an unprefixed semantic version, such as `0.0.2`. The release tag supplies the browser UI and Windows package/installer version. The Linux job tests, publishes and deploys the browser image; the Windows runner on `acemagic` tests and packages the installer, then verifies installation, import and native export before uploading it. After both jobs pass, the pipeline creates the same-tag release in the private website repository, which deploys its matching version and verified download link. Website source changes must be on its `main` branch before publishing the app release.

The browser and website expose `/version.json`; app releases include source/image identity and installer checksums. No `v` prefix or manual package-version bump is needed. Rerun failed Actions jobs when appropriate; use a new version for source changes after a release has shipped.

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
