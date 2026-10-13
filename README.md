# Kitsune Download Manager

<p align="center">
  <img src="extension/icons/icon_transparent_rembg.png" alt="Kitsune Download Manager" width="520" />
</p>

<p align="center">
  <img src="extension/icons/icon128.png" alt="Kitsune icon" width="68" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6feb.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/built%20with-Rust-f74c00.svg" alt="Rust" />
  <img src="https://img.shields.io/badge/frontend-Electron-47848f.svg" alt="Electron" />
  <img src="https://img.shields.io/badge/ui-React%20TypeScript-149eca.svg" alt="React" />
</p>

**Kitsune** is a cross-platform download manager focused on native performance and seamless browser integration. It pairs a Rust download engine, running as a sidecar process, with an Electron desktop app and a browser extension bridge.

## Highlights

- **Native performance** with Rust (`kitsune-core`) for efficient I/O and concurrency.
- **Direct browser integration** via Native Messaging for Chromium, Chrome, and Edge.
- **Cross-platform installers** for Linux (`.deb` and `.pkg.tar.zst`) and Windows.
- **Smart setup** that registers native host manifests automatically during installation.
- **Deep-link support** for `kitsune://` protocol triggers.
- **Safer resume and expired-link repair** with server file-version checks.
- **Adaptive parallel downloads**, a shared speed cap, and one-click Slow mode.
- **Download schedules and queues** that keep running when the window is hidden.
- **Built-in BitTorrent downloads** from magnet links, torrent URLs, and local `.torrent` files.

## Transfer controls

In **Settings**, choose a total download cap in MiB/s (zero is unlimited), the
Slow mode cap (2 MiB/s by default), and how many downloads may run at once.
The header's **Slow mode** button applies immediately. Direct downloads and
torrents share the total budget; when both engines are active, the budget is
divided in proportion to their active download counts.

Enable **Download schedule** to choose local start/stop times, repeat days, and
an optional end date. Downloads outside the window wait in **Queued**. At the
stop time, active transfers close their connections and keep their progress;
they resume at the next window. Manually paused downloads stay paused. Overnight
windows belong to the day they start. Keep Kitsune running and the PC awake;
the schedule does not wake it. Fetching link details can use data outside the
window, but torrent payloads and peer discovery start only when queued work runs.

For a failed or paused direct download, choose **More actions → Repair expired
link**, paste the fresh URL, and resume after verification. Kitsune checks the
size and a strong ETag, or Last-Modified when no strong ETag is available, before
reusing bytes. If the server cannot prove the file version, the file changed,
the partial file is missing/truncated, or ranges are unavailable, resume fails
without overwriting the partial file. Older checkpoints without version metadata
cannot safely resume; start a new download with a different filename or explicitly
delete the old partial download first.

Direct transfers use a shared queue of blocks up to 8 MiB. Connection counts are
ceilings: the engine starts with up to eight, increases on healthy responses,
backs off on refused connections (403, 429, 503) and connection errors, respects
numeric Retry-After, and recovers one connection per quiet minute.

Paste a **magnet link** or **torrent URL**, or choose **Open .torrent file** in
the new-download dialog. Torrents use WebTorrent in Electron's main process,
verify existing pieces on resume, and save into a dedicated folder. They upload
to peers while downloading; pausing, completing, or leaving the schedule window
closes the torrent's peer connections. Completion does not continue seeding.
Deleting a torrent removes only files recorded as belonging to that download,
leaving user-added files and directories intact. Magnet links must use BitTorrent
v1 (`btih`); v2-only magnets are not supported. Torrent support adds the
`node-datachannel` native runtime dependency; installers must include its N-API binary.

Verification: `cargo test -p kitsune-core -p kitsune-daemon`,
`cargo build -p kitsune-daemon`, `npm test --prefix app`, and
`npm run build --prefix app`. Build the debug daemon before the app tests to
include the sidecar protocol integration test. Torrent tests also run in
Electron's Node runtime with `ELECTRON_RUN_AS_NODE=1
./node_modules/electron/dist/electron --import tsx --test tests/torrents.test.mts`
from `app/`.

Dependency audit: WebTorrent's tracker dependency currently brings in the
unpatched `ip` advisory GHSA-2p57-rm9w-gvfp (`isPublic` address classification).
Kitsune uses the torrent client, not the tracker server, and does not call that
function; npm still flags the dependency chain. Installer builds on Windows
and macOS have not been exercised by these local Linux checks.

---

## Installation

### Linux

<img src="extension/icons/linux_icon.png" alt="Linux icon" width="48" />

#### Debian / Ubuntu / Mint

Download the `.deb` package and install it. Post-install scripts handle browser host registration.

```bash
sudo apt install ./Kitsune_Download_Manager_0.1.0_amd64.deb
```

#### Arch Linux / Manjaro

Download the `.pkg.tar.zst` package and install it. Install hooks generate and register manifests automatically.

```bash
sudo pacman -U kitsune-dm-v0.1.0-linux-x86_64.pkg.tar.zst
```

### Windows

<img src="extension/icons/icon128.png" alt="Kitsune app icon" width="48" />

1. Download and run the **installer** (`.exe`).
2. The installer configures `HKCU\Software\...\NativeMessagingHosts\com.kitsune.dm` automatically.

### Browser Extension (Developer Mode)

1. Open your extensions page (for example `chrome://extensions`).
2. Enable **Developer Mode**.
3. Click **Load unpacked** and select the `extension/` directory.
4. The extension connects to the installed Kitsune desktop app.

---

## Development

### Prerequisites

#### General

- **Rust**: `rustup` (stable)
- **Node.js**: v18+ (managed via `npm`)

#### Linux

Electron ships its own Chromium, so no WebKit or GTK development packages are
needed. Packaging the `.deb` and `.pkg.tar.zst` locally needs:

```bash
# Debian / Ubuntu
sudo apt install build-essential fakeroot dpkg libarchive-tools

# Arch Linux
sudo pacman -S base-devel fakeroot
```

#### Windows

No extra tooling. electron-builder downloads NSIS itself.

> **Note:** the Windows installer cannot be built on Linux — electron-builder
> runs `rcedit` under wine and its bundled `makensis.exe` is a Windows binary.
> Build it on Windows or in CI.

### Build

1. **Clone the repository:**

   ```bash
   git clone https://github.com/OliverMarcusson/Kitsune-Download-Manager.git
   cd Kitsune-Download-Manager
   ```

2. **Install dependencies:**

   ```bash
   npm run install:app
   ```

3. **Build the Rust sidecar** (the app will not start without it):

   ```bash
   npm run build:rust
   ```

4. **Run development mode:**

   ```bash
   npm run dev
   ```

5. **Build production packages:**

   **Linux (deb, pacman, AppImage):**

   ```bash
   npm run dist:linux
   ```

   **Windows (NSIS installer):**

   ```bash
   npm run dist:win
   ```

   Output for both: `app/dist/`

---

## Release Process

- **Trigger:** GitHub Actions release workflow runs on tag pushes that match `v*` (enforced tag format: `vMAJOR.MINOR.PATCH` with an optional `-<prerelease>` suffix; examples: `v1.4.2`, `v1.5.0-rc.1`).
- **Version sync guardrail:** Release fails fast unless tag version (including any prerelease suffix) exactly matches all configured versions in `package.json` and `app/package.json`.
- **Prerelease handling:** Prerelease status is derived from the tag by `scripts/detect-release-prerelease.mjs`; prerelease tags (for example `v1.5.0-rc.1`) are published as GitHub prereleases.
- **Required release assets:** the workflow normalizes the final GitHub release assets to exactly: `kitsune-dm-v{version}-windows-x64.exe`, `kitsune-dm-v{version}-linux-amd64.deb`, `kitsune-dm-v{version}-linux-x86_64.pkg.tar.zst`, plus `SHA256SUMS` (sha256 checksums for each normalized asset).
- **Deterministic publish set:** normalized assets are validated so the publish directory and final GitHub release contain exactly those four assets, with no extras.
- **Idempotent reruns:** rerunning the same tag updates or reuses the release, removes unmanaged old assets, and re-uploads managed assets using overwrite semantics (`gh release upload --clobber`).
- **Out of scope:** artifact signing and publishing to external package repositories are not performed by this workflow.

---

## Architecture

The project is a Cargo workspace plus an Electron app. The Rust engine runs as a
sidecar process; Electron's main process talks to it over newline-delimited JSON
on stdio. See [app/README.md](app/README.md) for the details.

| Component | Path | Description |
| ----------- | ------ | ------------- |
| **kitsune-core** | `crates/core` | Shared business logic, download engine, and session management. |
| **kitsune-daemon** | `crates/daemon` | Sidecar process wrapping `kitsune-core` behind a JSON stdio protocol. |
| **kitsune-shim** | `crates/shim` | Native messaging host that receives browser messages on `stdio` and forwards them via IPC. |
| **kitsune-cli** | `crates/cli` | CLI tools, including the `native-host-manifest` generator used by installers. |
| **app** | `app` | Electron desktop app (React/TypeScript renderer + main process). |

---

## License

MIT License. See [LICENSE](LICENSE).
