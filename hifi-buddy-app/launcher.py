#!/usr/bin/env python3
"""HiFi Buddy launcher.

Wraps server.py in a desktop-app shell:
  - Starts the HTTP server in a background thread
  - Auto-picks an available port in 8090..8099
  - Opens the user's default browser at the right URL
  - Shows a system-tray / menu-bar icon for "Open in Browser",
    "Reveal config folder", and "Quit"
  - Detects an already-running instance (just opens the browser, doesn't
    spawn a second server)

Bundled into HiFi Buddy.app / HiFiBuddy.exe via PyInstaller. Can also be
run directly as a Python script for development:

    python3 launcher.py

Optional dependencies:
  - pystray + Pillow  → real menu-bar icon
  - (without them)    → headless mode, prints URL and waits for Ctrl+C
"""
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

# When PyInstaller bundles us into a one-file or one-folder app, it
# extracts to a temp directory and exposes the path as sys._MEIPASS. We
# need server.py to find its sibling data files (index.html, js/, etc.)
# from there. server.DIRECTORY is computed from __file__ at import time,
# so doing this BEFORE the import is the cleanest fix.
if getattr(sys, '_MEIPASS', None):
    BUNDLE_DIR = Path(sys._MEIPASS)
    # server.py uses os.path.dirname(__file__) which works correctly
    # inside _MEIPASS because PyInstaller puts server.py in the bundle
    # root. No additional patching needed — just don't chdir away.
else:
    BUNDLE_DIR = Path(__file__).resolve().parent

import server  # noqa: E402 — sys.path adjustment must happen first


APP_NAME = 'HiFi Buddy'
DEFAULT_PORT = 8090
PORT_RANGE = range(DEFAULT_PORT, DEFAULT_PORT + 9)  # 8090..8099 inclusive

_server_instance = None
_server_thread = None


def _port_is_free(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('127.0.0.1', port))
            return True
    except OSError:
        return False


def _find_open_port():
    for port in PORT_RANGE:
        if _port_is_free(port):
            return port
    return None


def _is_hifibuddy_running(port):
    """Probe a port to see if there's already a HiFi Buddy listening.
    Uses /api/local/probe — a cheap GET that returns a tiny JSON object
    with our specific shape, so we can tell HiFi Buddy apart from some
    other random server that happens to be on the same port."""
    try:
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/local/probe',
            method='GET',
        )
        with urllib.request.urlopen(req, timeout=1.0) as r:
            if r.status != 200:
                return False
            body = r.read()
            return b'ffmpeg' in body  # cheap shape check
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _start_server(port):
    """Bind and serve in a daemon thread. Returns once the server is
    actually accepting connections."""
    global _server_instance, _server_thread
    _server_instance = server.make_server(port=port, host='127.0.0.1')
    _server_thread = threading.Thread(
        target=_server_instance.serve_forever,
        name='HiFiBuddyServer',
        daemon=True,
    )
    _server_thread.start()

    # Wait briefly for bind. Without this, webbrowser.open() can race the
    # server's first accept() and the user gets a momentary "can't connect".
    deadline = time.time() + 3.0
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.05)


def _stop_server():
    """Gracefully shut the server down. shutdown() blocks until all
    in-flight requests finish, so we cap it with a short timeout via
    server_close on a separate thread."""
    global _server_instance
    if _server_instance is None:
        return
    try:
        # shutdown() requests the serve_forever loop to exit
        threading.Thread(target=_server_instance.shutdown, daemon=True).start()
        _server_instance.server_close()
    except Exception as e:
        print(f'[{APP_NAME}] Shutdown error: {e}')
    finally:
        _server_instance = None


def _open_browser(port):
    webbrowser.open(f'http://127.0.0.1:{port}/')


def _reveal_config_folder():
    """Open ~/.hifi-buddy/ in Finder/Explorer/xdg. Best-effort."""
    home = server.HIFIBUDDY_HOME
    try:
        os.makedirs(home, exist_ok=True)
    except OSError:
        pass
    try:
        if sys.platform == 'darwin':
            os.system(f'open {home!r}')
        elif sys.platform.startswith('win'):
            os.startfile(home)  # type: ignore[attr-defined]
        else:
            os.system(f'xdg-open {home!r}')
    except Exception as e:
        print(f'[{APP_NAME}] Could not reveal {home}: {e}')


def _make_tray_icon():
    """Generate a small in-memory icon — five vertical bars approximating
    the marketing-site logo, gradient purple→indigo. Avoids needing to
    ship a separate .icns/.ico file for the tray (the macOS dock icon
    is a different concern, set via PyInstaller's --icon flag)."""
    from PIL import Image, ImageDraw  # type: ignore
    size = 64
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Five bars: tallest in the middle, tapering. Coords are
    # (x1, y1, x2, y2) in pixels.
    bars = [
        (8,  26, 14, 38),
        (18, 18, 24, 46),
        (28, 10, 34, 54),
        (38, 18, 44, 46),
        (48, 26, 54, 38),
    ]
    for x1, y1, x2, y2 in bars:
        draw.rounded_rectangle((x1, y1, x2, y2), radius=2, fill=(155, 89, 182, 255))
    return img


def _run_tray(port):
    """Show the tray icon and block. Quitting from the menu unblocks and
    returns. If pystray/Pillow aren't installed, falls back to a CLI
    "press Ctrl+C to stop" loop so dev runs without those deps still work."""
    try:
        import pystray  # type: ignore
    except ImportError:
        print(f'[{APP_NAME}] (pystray not installed — running headless)')
        print(f'[{APP_NAME}] Open: http://127.0.0.1:{port}/')
        print(f'[{APP_NAME}] Press Ctrl+C to stop.')
        try:
            while True:
                time.sleep(60)
        except KeyboardInterrupt:
            return
        return

    icon_image = _make_tray_icon()
    label_url = f'http://127.0.0.1:{port}/'

    def on_open(_icon, _item):
        _open_browser(port)

    def on_reveal(_icon, _item):
        _reveal_config_folder()

    def on_quit(icon, _item):
        _stop_server()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem('Open in Browser', on_open, default=True),
        pystray.MenuItem(label_url, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Reveal config folder', on_reveal),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(f'Quit {APP_NAME}', on_quit),
    )
    icon = pystray.Icon(APP_NAME.replace(' ', '_'), icon_image, APP_NAME, menu)
    icon.run()  # blocks until icon.stop()


def main():
    # If another HiFi Buddy is already on the default port, hand it the tab.
    if _is_hifibuddy_running(DEFAULT_PORT):
        print(f'[{APP_NAME}] Already running on port {DEFAULT_PORT}. Opening browser.')
        _open_browser(DEFAULT_PORT)
        return 0

    port = _find_open_port()
    if port is None:
        print(f'[{APP_NAME}] No free port in range {PORT_RANGE.start}..{PORT_RANGE.stop - 1}.')
        return 2

    print(f'[{APP_NAME}] Starting server on port {port}…')
    _start_server(port)
    print(f'[{APP_NAME}] Config:  {server.CONFIG_PATH}')
    print(f'[{APP_NAME}] Open:    http://127.0.0.1:{port}/')
    _open_browser(port)
    try:
        _run_tray(port)
    finally:
        _stop_server()
    return 0


if __name__ == '__main__':
    sys.exit(main())
