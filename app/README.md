# Kitsune Desktop (Electron)

The desktop app. It replaced a Tauri build, which rendered through whatever
WebKitGTK the host distro shipped — a large and untestable variable on Linux. On
NVIDIA + Wayland that build died at startup with `Gdk-Message: Error 71
(Protocol error) dispatching to Wayland display` unless
`WEBKIT_DISABLE_DMABUF_RENDERER=1` was set. Electron bundles its own Chromium,
so the renderer is the same everywhere.

The Tauri app and its `PKGBUILD` were removed once this reached parity; this is
now the only frontend, and the only thing the release workflow builds.

## Architecture

`kitsune-core` runs as a **sidecar
process** (`crates/daemon`), and Electron's main process speaks newline-delimited
JSON to it over stdio:

```
renderer (React)
  │  window.kitsune.*        preload, contextIsolation on
main process
  │  JSON lines over stdio
kitsune-daemon ── kitsune-core
```

Requests are `{"id","cmd",...}` and are answered with `{"id","ok"}` or
`{"id","error"}`. Progress arrives unsolicited as `{"event":...}`. Only
HTTP metadata, start/cancel, file-version validation, URL replacement, and rate
updates reach Rust; file deletion,
folder reveal, the downloads directory and state persistence are plain Electron
main-process calls that never needed it.

### Deliberately unchanged

- **`kitsune-shim` is untouched.** The localhost socket and
  `<config>/kitsune-dm/ipc.port` handshake work exactly as before, so browser
  integration keeps working across the migration.
- **`state.json` keeps its snake_case shape** at the same path, so an existing
  download list survives the upgrade.

`src/main/paths.ts` reimplements Rust's `dirs::config_dir()` rather than using
Electron's `app.getPath('userData')` — the latter resolves to a product-named
directory the shim does not know about.

## UI

shadcn/ui components (`src/renderer/src/components/ui`) over Tailwind, in a
dark-only violet palette. The palette lives as HSL triples on `:root` in
`index.css` and is mapped to Tailwind tokens in `tailwind.config.js`; there is no
`.dark` class and no light theme, so colours belong in tokens (`bg-primary`,
`text-muted-foreground`) rather than as literal `zinc-800`/`blue-600` classes.

The shell is a status sidebar plus a filtered list. UI preferences live in
`localStorage` (`useSettings`). Transfer settings are sent through the preload
bridge and also persisted as `transfers.json` in the Kitsune config directory.
`main/transfers.ts` owns scheduling and the queue, independently of the renderer.
`main/torrents.ts` lazily loads WebTorrent and preserves its owned-file manifest
beside torrent payloads. The Rust and torrent engines share one speed budget.

Two things worth knowing:

- **Asset URLs must be imported, not absolute.** Production loads the renderer
  with `loadFile`, so a `src="/logo.png"` resolves against the filesystem root
  and silently 404s. Import assets (`import logoUrl from "@/assets/logo.png"`)
  and let Vite emit a relative URL.
- **`connections` and `activeConnections` are different things.** The former is
  the count a download was started with and is what resume replays; the latter is
  whatever the daemon currently reports live. Persisting the live value would
  change the connection count on resume.

## Development

```bash
npm run install:app
npm run build:rust   # sidecar must exist before the app will start
npm run dev
```

Set `KITSUNE_DAEMON_PATH` to point at a daemon binary somewhere else.

## Packaging

```bash
npm run dist:linux    # deb, pacman, AppImage — runs the cargo build first
```

`electron-builder.yml` copies the daemon, the shim, the manifest generator and
the extension ID into `resources/`, which lands at
`/opt/Kitsune Download Manager/resources` for deb and pacman.

### Install hooks

`build/linux-after-install.sh` and `build/linux-after-remove.sh` register and
unregister the Chromium native messaging host. The manifest embeds the shim's
absolute path, so it is generated on the target machine rather than shipped.
Failures are non-fatal: the app works without browser integration.

Three things to know before editing them:

1. **Setting `afterInstall` REPLACES electron-builder's default template**, it
   does not extend it. The top half of each hook is a verbatim copy of
   `app-builder-lib/templates/linux/after-{install,remove}.tpl`. Drop it and you
   silently lose the `/usr/bin` symlink, the `chrome-sandbox` permissions and
   the AppArmor profile that Ubuntu 24+ needs. Re-sync on electron-builder
   upgrades.
2. **`${...}` is substituted at build time** and an undefined macro aborts the
   build — `${sanitizedProductName}` and `${executable}` are provided, but a
   shell variable like `${RESOURCES}` would be treated as a macro and fail.
   Local variables therefore use underscored names.
3. **pacman needs `post_upgrade`, which electron-builder never emits.** pacman
   calls it instead of `post_install` when replacing a package, so
   `build/linux-after-upgrade.sh` is passed straight to fpm via `pacman.fpm`.
   Because fpm gets it directly it receives no macro substitution and hardcodes
   the product name and executable — keep those in sync.

### Windows

`build/installer.nsh` provides `customInstall` / `customUnInstall`, which
electron-builder appends to its own sections — unlike the Linux hooks, these
extend rather than replace. It generates the manifest and writes
`HKCU\Software\...\NativeMessagingHosts\com.kitsune.dm` for Chrome, Chromium and
Edge.

The manifest is generated at install time rather than shipped. The Tauri MSI
shipped one hardcoded to `C:\Program Files\Kitsune Download Manager\...`, which
pointed at nothing whenever the user chose a different directory —
`allowToChangeInstallationDirectory` is on.

**The Windows installer cannot be built on Linux.** electron-builder runs
`rcedit` under wine to stamp exe metadata, and its bundled `makensis.exe` is a
Windows binary. Build it on Windows (or CI), where `npm run dist:win` also picks
up `target/release/*.exe` from a native cargo build.

## Status

Done: download start/cancel/resume, progress and speed, metadata lookup, state
persistence, tray with show/quit, close-to-tray, single instance, `kitsune://`
deep links, the shim socket, folder reveal, file deletion, and the native-host
install hooks for deb, pacman and NSIS.

Known gaps:

- **`build/installer.nsh` has never been through a real NSIS compile.** It is
  wired in and its inputs are verified, but the script itself is untested, and
  the Windows installer cannot be built on Linux. The first Windows release
  build is the real test.
- **The pacman package is electron-builder's `pacman` target, not a source
  PKGBUILD.** The release workflow renames its `.pacman` output to
  `.pkg.tar.zst` for publishing — the file is already a zstd tarball, so this is
  a rename only. There is no AUR-style build-from-source path anymore.
- CI builds and type checks the renderer on every push, but does not produce
  installers; those are only built on a release tag.
