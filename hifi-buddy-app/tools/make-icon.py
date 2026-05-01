#!/usr/bin/env python3
"""Generate HiFi Buddy's macOS .icns from the brand soundwave.

Renders the same 5-bar gradient soundwave the app uses in the menu bar
and dashboard hero, but big — onto a 1024×1024 dark squircle. Then
spins up the macOS-required iconset (10 PNG sizes) and runs `iconutil`
to compile a single .icns file.

Run from the hifi-buddy-app directory:

    python3 tools/make-icon.py

Outputs:
    assets/icon.icns

The build script (build-mac.sh) calls this automatically before
invoking PyInstaller, so you rarely need to run it by hand.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print('ERROR: Pillow not installed. Run: pip3 install Pillow', file=sys.stderr)
    sys.exit(1)


HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
ASSETS = APP_DIR / 'assets'
ICONSET = ASSETS / 'icon.iconset'
ICNS = ASSETS / 'icon.icns'

# macOS-required icon sizes for a complete .icns. Names must match the
# Apple convention exactly; iconutil errors on missing/extra files.
ICON_SIZES = [
    (16,   'icon_16x16.png'),
    (32,   'icon_16x16@2x.png'),
    (32,   'icon_32x32.png'),
    (64,   'icon_32x32@2x.png'),
    (128,  'icon_128x128.png'),
    (256,  'icon_128x128@2x.png'),
    (256,  'icon_256x256.png'),
    (512,  'icon_256x256@2x.png'),
    (512,  'icon_512x512.png'),
    (1024, 'icon_512x512@2x.png'),
]

# Brand colors — keep in sync with the in-app SVG and the welcome wave.
BAR_GRAD_START = (155,  89, 182)   # #9b59b6 — purple
BAR_GRAD_END   = (102, 126, 234)   # #667eea — indigo
BG_TOP         = ( 26,  13,  46)   # #1a0d2e — deep purple-black
BG_BOTTOM      = ( 10,  10,  20)   # #0a0a14 — near-black


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render_master(size=1024):
    """Render the icon at `size` px and return the RGBA image. We render
    big and downscale for sharper edges than rendering at each size."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Squircle background (rounded rectangle approximating the macOS
    #    icon mask — close enough for a non-template icon).
    radius = int(size * 0.22)
    # Vertical gradient: paint as horizontal bands then composite onto
    # the squircle via a mask.
    bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for y in range(size):
        t = y / (size - 1)
        bg.putpixel((0, y), lerp(BG_TOP, BG_BOTTOM, t) + (255,))
    bg = bg.resize((size, size))  # ensures interpolation
    # Faster: paint band by band
    bg2 = Image.new('RGB', (1, size))
    for y in range(size):
        bg2.putpixel((0, y), lerp(BG_TOP, BG_BOTTOM, y / (size - 1)))
    bg = bg2.resize((size, size)).convert('RGBA')

    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1),
                                            radius=radius, fill=255)
    img.paste(bg, (0, 0), mask)

    # 2. Five vertical bars matching the SVG geometry. The SVG is on a
    #    32-unit canvas with bars at x=3,8,13,18,23 and heights 6,14,22,
    #    14,6 (centered vertically). We scale that to our pixel canvas
    #    with a margin so the bars don't crowd the rounded corners.
    margin = int(size * 0.20)
    inner = size - 2 * margin
    # SVG bars in the original 32-unit space (x_center, height_units):
    SVG_BARS = [(4.25, 6), (9.25, 14), (14.25, 22), (19.25, 14), (24.25, 6)]
    SVG_W = 32
    bar_thickness = int(inner * (2.5 / SVG_W))   # 2.5/32 of inner
    cx_canvas = size // 2

    # Per-bar gradient color. We lerp left→right across all 5 bars so
    # the icon as a whole has the brand gradient even though each bar
    # is solid.
    for i, (sx, h_units) in enumerate(SVG_BARS):
        t = i / (len(SVG_BARS) - 1)
        color = lerp(BAR_GRAD_START, BAR_GRAD_END, t)
        # Position relative to canvas center
        x_offset = (sx - SVG_W / 2) / SVG_W * inner
        x = int(cx_canvas + x_offset - bar_thickness / 2)
        h_px = int(inner * (h_units / 28))   # tallest bar is 22/28 of inner height
        y = (size - h_px) // 2
        # Rounded rect for that "audiophile bar" feel
        bar_radius = max(2, bar_thickness // 2)
        bar_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(bar_layer).rounded_rectangle(
            (x, y, x + bar_thickness, y + h_px),
            radius=bar_radius, fill=color + (255,)
        )
        img = Image.alpha_composite(img, bar_layer)

    # 3. Subtle inner glow under the bars — paint a blurred copy of the
    #    bars at low alpha behind the sharp ones for a slight luminance
    #    halo. Skipped at very small sizes where it muddies the bars.
    if size >= 256:
        glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for i, (sx, h_units) in enumerate(SVG_BARS):
            t = i / (len(SVG_BARS) - 1)
            color = lerp(BAR_GRAD_START, BAR_GRAD_END, t)
            x_offset = (sx - SVG_W / 2) / SVG_W * inner
            x = int(cx_canvas + x_offset - bar_thickness / 2)
            h_px = int(inner * (h_units / 28))
            y = (size - h_px) // 2
            gd.rounded_rectangle(
                (x, y, x + bar_thickness, y + h_px),
                radius=max(2, bar_thickness // 2),
                fill=color + (90,),
            )
        glow = glow.filter(ImageFilter.GaussianBlur(radius=size * 0.012))
        img = Image.alpha_composite(glow, img)

    return img


def main():
    if shutil.which('iconutil') is None:
        print('ERROR: iconutil not found. This script requires macOS.', file=sys.stderr)
        sys.exit(1)

    ASSETS.mkdir(parents=True, exist_ok=True)
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir()

    print('Rendering master icon at 1024×1024…')
    master = render_master(1024)

    for px, name in ICON_SIZES:
        # Resampling from the master gives sharper anti-aliased edges
        # than rendering each size from scratch.
        img = master.resize((px, px), Image.LANCZOS)
        out = ICONSET / name
        img.save(out, format='PNG')
        print(f'  {name}  ({px}×{px})')

    print(f'Compiling {ICNS.relative_to(APP_DIR)}…')
    subprocess.run(
        ['iconutil', '-c', 'icns', str(ICONSET), '-o', str(ICNS)],
        check=True,
    )
    print(f'\n✅ Wrote {ICNS}')

    # Clean up the intermediate iconset; the .icns is what we ship.
    shutil.rmtree(ICONSET)


if __name__ == '__main__':
    main()
