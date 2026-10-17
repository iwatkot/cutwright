<p align="center">
  <a href="https://app.cutwright.cc"><img alt="Launch in browser" src="https://img.shields.io/badge/Launch-Browser-149ee8?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white"></a>
  <a href="https://github.com/iwatkot/cutwright/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download-Windows-3678c8?style=for-the-badge"></a>
  <a href="#docker"><img alt="Run with Docker" src="https://img.shields.io/badge/Run-Docker-2496ed?style=for-the-badge&amp;logo=docker&amp;logoColor=white"></a>
</p>

<p align="center">
  <a href="https://cutwright.cc"><img src="docs/assets/cutwright-banner.png" alt="CutWright — Agentic video editing." width="100%"></a>
</p>

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#how-to-launch">How to launch</a> ·
  <a href="https://cutwright.cc/docs/">User guide</a> ·
  <a href="#agent-connections">Agent connections</a> ·
  <a href="#development">Development</a> ·
  <a href="https://buymeacoffee.com/iwatkot">Donate</a>
</p>

<p align="center">
  <a href="https://github.com/iwatkot/cutwright/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/iwatkot/cutwright?style=flat-square&amp;color=149ee8"></a>
  <a href="https://github.com/iwatkot/cutwright/actions/workflows/release.yml"><img alt="Release pipeline" src="https://img.shields.io/github/actions/workflow/status/iwatkot/cutwright/release.yml?style=flat-square&amp;label=release"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/iwatkot/cutwright?style=flat-square"></a>
  <a href="https://hub.docker.com/r/iwatkot/cutwright"><img alt="Docker pulls" src="https://img.shields.io/docker/pulls/iwatkot/cutwright?style=flat-square&amp;logo=docker&amp;logoColor=white"></a>
  <a href="https://github.com/iwatkot/cutwright/releases"><img alt="Release downloads" src="https://img.shields.io/github/downloads/iwatkot/cutwright/total?style=flat-square"></a>
  <a href="https://github.com/iwatkot/cutwright/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/iwatkot/cutwright?style=flat-square"></a>
</p>

## Overview

**CutWright is a free, open-source video editor for your browser and Windows, with optional agent control.** Edit by hand or connect a compatible agent to work on your live project. Editing and export run on your device. No account, media upload, render server, or subscription is required for the editor.

- **Build your edit:** multitrack video and audio, trimming, splitting, speed and picture adjustments.
- **Finish the frame:** titles, graphic elements, captions, transitions, and project sizing.
- **Stay precise:** timeline markers, snapping, rulers, guides, a grid, and preview zoom/pan.
- **Work your way:** configurable shortcuts, light/dark/automatic appearance, project save/open/recovery, and local MP4 export.
- **Bring your agent:** validated project edits, undo/redo, and export through local MCP on Windows or WebMCP in compatible browsers.

Start with the [first-video guide](https://cutwright.cc/docs/getting-started/), or browse the [complete manual](https://cutwright.cc/docs/).

## How to launch

| Option | What you need | Start here |
| --- | --- | --- |
| **Browser** | A current desktop browser | [Open CutWright](https://app.cutwright.cc) |
| **Windows** | Windows x64 | [Download the installer](https://github.com/iwatkot/cutwright/releases/latest) |
| **Docker** | Docker with Linux containers, x86-64 | [Run the browser editor locally](#docker) |
| **Source** | Git, Node.js 24 LTS, npm | [Start from source](#from-source) |

### Browser

Open **[app.cutwright.cc](https://app.cutwright.cc)**. Use a current desktop Chrome or Edge for the best-supported editing/export path; available media codecs depend on your browser and device.

Click **Import**, add your media, and start editing. **Save** downloads an editable project; **Export** creates the finished video. Keep your original media alongside saved projects. Browser storage belongs to the address you opened, so the hosted editor and localhost have separate local state.

### Windows

1. Open the [latest release](https://github.com/iwatkot/cutwright/releases/latest).
2. Download `CutWright-Setup-<version>.exe` and run the installer.
3. Launch **CutWright** from the Start menu or desktop shortcut.

Docker and Node.js are not needed. Releases also include `SHA256SUMS` and build manifests. The version appears beside the app logo.

### Docker

```sh
docker run -d --name cutwright -p 8080:80 iwatkot/cutwright:0.0.2
```

Open **[localhost:8080](http://localhost:8080)**. This image serves the browser editor; your browser still performs editing and export locally.

Stop and restart the same container:

```sh
docker stop cutwright
docker start cutwright
```

Use an exact [release tag](https://github.com/iwatkot/cutwright/releases) when choosing a version. Published tags have no `v` prefix. The image includes the headers and runtime notices needed by the browser build.

### From source

Install **Git** and **Node.js 24 LTS**, which includes npm. These commands check out the matching stable release:

```sh
git clone --branch 0.0.2 --depth 1 https://github.com/iwatkot/cutwright.git
cd cutwright
npm ci
npm run dev:web
```

Open **[localhost:5173](http://localhost:5173)**, or the local address printed in the terminal. Keep that terminal open; Ctrl+C stops the development server. To work on the newest development code instead, clone the default branch without `--branch 0.0.2`.

On Windows, start the desktop editor from the same checkout with:

```sh
npm run dev
```

## Agent connections

Click **Agent** at the bottom of the editor's left rail, then follow the connection instructions.

| Edition | Connection |
| --- | --- |
| **Windows app** | Enable local MCP and copy the displayed configuration into a compatible MCP client. Keep the editor open. |
| **Browser** | Requires an agent browser/client that exposes WebMCP. Ordinary browsers can edit and export, but may show the connection as unavailable. |

Agent access is optional and starts disabled. Your agent runs in its own app; its provider may have separate accounts or costs. Disconnect from the editor to revoke access. See the [user connection guide](https://cutwright.cc/docs/agents/) and [developer tool contract](EXTERNAL_AGENTS.md).

## Development

### Build

```sh
npm ci
npm run build:web
```

The static browser build is written to `dist/`. Serve the complete directory, including `third-party/`, over HTTPS with the headers in [deployment/nginx.conf](deployment/nginx.conf); localhost is supported for development. The included Docker image supplies this configuration.

On Windows, build an installer with:

```sh
npm run dist
```

Output: `release/CutWright-Setup-<version>.exe`. Use `npm run dist:dir` for an unpacked app. Keep the checked, version-specific postinstall codec corrections enabled when installing dependencies.

### Check changes

```sh
npm run typecheck
npm test
node scripts/audit-rc-widgets.mjs
```

After building, `node scripts/verify-runtime-notices.mjs` checks bundled dependency notices. The release pipeline also installs the Windows package and checks import, controls, local export, and full video/audio decode using generated fixtures.

Contributors should read [AGENTS.md](AGENTS.md). Every user-facing change includes the corresponding update to the website's detailed manual; its source lives in a separate private repository. Keep personal media, projects, credentials, and build outputs out of commits.

### Release

Publish **one GitHub release in this repository**, using an unprefixed semantic version such as `0.0.3`. The release tag supplies the browser, Windows, and website versions.

1. The Linux job tests, publishes the Docker image, and deploys the browser editor.
2. The Windows runner builds and verifies the installed app, then attaches the installer, checksums, and manifests to that release.
3. After both succeed, the pipeline creates the same-tag release in the private website repository and deploys its matching version and verified download link.

Push website changes to its `main` branch before creating the app release. The deployed browser and website expose `/version.json`; app release manifests record the source commit and image/installer identity. Use a new tag for source changes after a release ships.

## License

CutWright source is licensed under the **[MIT License](LICENSE)**. Third-party dependencies retain their own licenses. Keep the bundled `third-party/` notices with redistributed browser and desktop builds.

Made by [iwatkot](https://github.com/iwatkot) · [Website](https://cutwright.cc) · [Buy me a coffee](https://buymeacoffee.com/iwatkot)
