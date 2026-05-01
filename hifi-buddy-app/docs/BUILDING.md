# Building HiFi Buddy

This document covers producing the standalone macOS `.app` and Windows
`.exe` from source. End users don't need any of this — they download
from the [GitHub Releases](https://github.com/hifibuddy/hifi-buddy/releases)
page. This is for contributors and self-builders.

For just running from source: [SETUP.md](./SETUP.md).

---

## macOS (`HiFi Buddy.app`)

### Prerequisites

- Python 3.11+ (3.13 recommended)
- ffmpeg + ffprobe (only required at runtime if users want ABX / source-quality;
  not needed for the build itself):
  ```
  brew install ffmpeg
  ```

### One-time setup

```bash
cd hifi-buddy-app
pip3 install -r requirements-build.txt
```

This installs `pyinstaller`, `pystray`, and `Pillow` — packaging tools
that are NOT needed at runtime. Runtime users only need Python stdlib
(plus optional `mutagen` via `requirements.txt`).

### Build

```bash
./build-mac.sh
```

Output: `dist/HiFi Buddy.app`. Built for your current architecture
(arm64 on Apple Silicon, x86_64 on Intel). About 90 MB.

> **Why not universal2?** PyInstaller's `--target-architecture universal2`
> requires every bundled native dep (Pillow, etc.) to be a fat binary,
> and `pip` installs single-arch wheels matching the host Python. The
> path of least friction is to build for the current arch and ship two
> separate binaries if you need both Intel and Apple Silicon coverage.
> In 2026, arm64-only is fine for ~95% of Mac users — Intel users
> shrink every quarter.

### Test the build

```bash
open 'dist/HiFi Buddy.app'
```

You should see a small wave-shaped icon appear in the menu bar (top-right
of the screen) and your default browser should auto-open to
`http://127.0.0.1:8090/` (or 8092..8099 if 8090 is taken).

The menu bar item has:
- **Open in Browser** — re-opens the tab in case you closed it
- **Reveal config folder** — Finder window for `~/.hifi-buddy/`
- **Quit HiFi Buddy** — stops the server, exits cleanly

The bundled `.app` runs as a **menu-bar-only utility** (no Dock icon,
no app-switcher entry — `LSUIElement = true` in `Info.plist`). This is
the correct model for an always-on background server with a tray menu.
When running from source via `python3 launcher.py`, you will see a
Python rocket in the Dock — that's expected for dev mode, and goes
away in the bundled app.

### First-launch on a friend's Mac

The build is **unsigned** (we haven't paid for an Apple Developer
Program membership yet). macOS Gatekeeper will refuse to open a
double-clicked app on most modern macOS versions:

> "HiFi Buddy" cannot be opened because the developer cannot be verified.

Workaround for the user:

1. **Right-click** the app → **Open**
2. Click **Open** in the warning dialog
3. (macOS 14+ may also require) System Settings → Privacy & Security →
   scroll to bottom → **Open Anyway**

After this one-time confirmation, double-clicking works normally.

We'll add Apple notarization in a future release once download volume
justifies the $99/yr cost.

### Distribution

`build-mac.sh` automatically produces both `dist/HiFi Buddy.app` (the
runnable bundle) and `dist/HiFi Buddy.dmg` (a compressed disk image
with a `/Applications` symlink for drag-to-install). Ship the `.dmg`
on GitHub Releases.

To skip the DMG step during dev iteration:

```bash
BUILD_DMG=0 ./build-mac.sh
```

Equivalent zip alternative if you ever need it:

```bash
cd dist
ditto -c -k --keepParent 'HiFi Buddy.app' 'HiFi Buddy.zip'
```

---

## Windows (`HiFiBuddy.exe`) — coming via CI

We don't have a Windows machine in the dev loop, so the Windows build
runs on a `windows-latest` GitHub Actions runner (see
`.github/workflows/release.yml` once M4.4 lands).

For local Windows builds, the equivalent of `build-mac.sh` is:

```powershell
pyinstaller --noconfirm --windowed --name "HiFiBuddy" `
  --add-data "index.html;." --add-data "styles.css;." `
  --add-data "manifest.json;." --add-data "service-worker.js;." `
  --add-data "server.py;." --add-data "js;js" --add-data "data;data" `
  --add-data "assets;assets" --add-data "docs;docs" `
  launcher.py
```

Note the `;` separator on Windows (vs `:` on macOS/Linux).

Output: `dist/HiFiBuddy/HiFiBuddy.exe` (with sidecar files; PyInstaller's
single-file mode is slower-starting and more antivirus-suspicious).

### Windows Defender

PyInstaller-built executables sometimes trip Windows Defender's
heuristic detection. Code-signing helps; submitting the binary to
Microsoft for whitelisting helps more. For unsigned releases, document
the `Run anyway` flow in the user-facing release notes.

---

## Troubleshooting

### `pyinstaller: command not found`

The pip install put it in your user site-packages but the directory
isn't in PATH. Either:

```bash
python3 -m PyInstaller --version   # invoke as a module instead
```

Or add `~/Library/Python/3.X/bin` to your PATH.

### "ModuleNotFoundError: No module named 'X'" inside the bundle

PyInstaller's analysis missed an import. Add it explicitly:

```bash
./build-mac.sh --hidden-import=X
```

Common culprits: imports done via `getattr` or behind a `try`/`except`
ImportError. Edit `build-mac.sh` to inject the flag.

### "Failed to execute script 'launcher'" with no further info

Run the bundled binary directly to see the real error:

```bash
'dist/HiFi Buddy.app/Contents/MacOS/HiFi Buddy'
```

This bypasses the `--windowed` flag's stdout suppression and shows
the underlying Python traceback.

### Browser doesn't open

PyInstaller's `--windowed` flag detaches stdout/stderr on macOS, so
`webbrowser.open()` can fail silently. Verify the server is up by
visiting `http://127.0.0.1:8090/` manually. If it loads, the launcher
worked but the browser-open call didn't — likely a `LSUIElement`
behavior issue. File an issue.

### Server already running

If you see "Already running on port 8090" but no browser tab opens,
another process is holding the port. Either:

```bash
lsof -i :8090    # find the PID
kill <PID>
```

…or click the menu bar icon → **Open in Browser** to surface the
existing instance.

---

## Why PyInstaller and not [alternative]?

We considered alternatives — see the design decision in `prancy-meandering-widget.md`:

| Tool | Why we said no |
|---|---|
| Tauri / Wails (Rust shell) | Would still need a Python sidecar for `server.py`. Adds Rust toolchain to contributor onboarding. |
| Electron | 200+ MB bundles, double runtime (Node + Python). |
| PyWebView (embedded webview) | Spotify PKCE redirect breaks in webview; extensions (1Password etc.) don't work. |
| Native rewrite (Swift / .NET) | Throws away the codebase. Months of work. |
| `.pkg` installer with system Python | Still requires Terminal under the hood — same audience as today. |

PyInstaller + default browser is the right call for an audiophile tool
where users care about a real browser's audio fidelity and existing
extensions.

---

## Versioning

Bump version in two places when releasing:

1. `manifest.json` `"version"` field
2. The git tag (`git tag v1.X.Y`)

The build script doesn't yet read either — version stamping is on the
M4.4 / release-pipeline TODO list.
