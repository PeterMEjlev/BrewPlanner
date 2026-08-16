#!/usr/bin/env python3
"""Generate every Konfus app icon from one geometric definition of the K mark.

This is the source of truth for the browser favicon, the PWA / home-screen
icons and the Android launcher icons -- they are all the same mark, so drawing
them from shared geometry is what keeps them from drifting apart. The committed
files are the output; re-run this only when the mark itself changes.

    pip install pillow
    python apps/web/scripts/generate-icons.py

Writes apps/web/public/* (Vite copies these to the dist root, which Fastify
serves) and apps/web/android/app/src/main/res/mipmap-*/*.

The mark: a bold grotesque K, white on the app's zinc-950 background, matching
the "KONFUS" wordmark in the dashboard header. Weight and proportions were
chosen at a 16px render -- the arms have to stay open at favicon size, which is
why the K is lighter than the header's font-bold and the counters are wide.
"""

import math
import os
from PIL import Image, ImageDraw

# --- palette -----------------------------------------------------------------

BG = (9, 9, 11, 255)          # zinc-950 #09090b, the app's body background
FG = (255, 255, 255, 255)
BG_HEX = '#09090b'

# --- glyph geometry ----------------------------------------------------------
# Drawn in a local space with the stem at x=0 spanning y=0..CAP; `normalised()`
# centres and scales it into the 64-unit tile the renderers work in.

CAP = 32.0        # cap height
WEIGHT = 7.8      # stroke weight, uniform across stem and arms
REACH = 20.5      # horizontal run of each arm measured from the vertex
VERTEX_LIFT = 1.0  # arms meet slightly above centre, as they do in most type


def _band(p0, p1, w):
    """Rectangle polygon around segment p0->p1, with perpendicular butt ends."""
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy)
    ox, oy = -dy / n * w / 2, dx / n * w / 2
    return [(x0 + ox, y0 + oy), (x1 + ox, y1 + oy), (x1 - ox, y1 - oy), (x0 - ox, y0 - oy)]


def _clip(poly, inside):
    """Sutherland-Hodgman clip of a convex polygon against one half-plane;
    `inside(pt)` is positive within the kept side and edges are cut at zero."""
    out = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        da, db = inside(a), inside(b)
        if da >= 0:
            out.append(a)
        if (da >= 0) != (db >= 0):
            t = da / (da - db)
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return out


def polygons():
    """The K as three convex polygons: stem, upper arm, lower leg.

    Each arm is deliberately run past the cap line and then sliced along it, so
    it ends in a horizontal terminal flush with the top and bottom of the stem.
    Ending the arms with a plain perpendicular cap instead leaves a slanted,
    tapered tip that turns to mush below about 32px.
    """
    top, bot = 0.0, CAP
    vy = CAP / 2 - VERTEX_LIFT
    parts = [[(-WEIGHT / 2, top), (WEIGHT / 2, top), (WEIGHT / 2, bot), (-WEIGHT / 2, bot)]]
    for cap_y in (top, bot):
        overshoot = 1.35            # any value past 1 works; the slice defines the tip
        end = (REACH * overshoot, vy + (cap_y - vy) * overshoot)
        sign = 1 if cap_y == bot else -1
        parts.append(_clip(_band((0.0, vy), end, WEIGHT),
                           lambda p, s=sign, c=cap_y: (c - p[1]) * s))
    return parts


def normalised(glyph_frac):
    """The glyph centred in the 64-unit tile, scaled so its largest dimension is
    `glyph_frac` of the tile."""
    parts = polygons()
    xs = [p[0] for part in parts for p in part]
    ys = [p[1] for part in parts for p in part]
    scale = 64.0 * glyph_frac / max(max(xs) - min(xs), max(ys) - min(ys))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    return [[((x - cx) * scale + 32, (y - cy) * scale + 32) for x, y in part]
            for part in parts]


# --- renderers ---------------------------------------------------------------

SS = 8              # supersampling factor; Pillow's polygon fill has no antialiasing
CORNER = 14 / 64    # tile corner radius, shared with the SVG's rx so both match


def render(size, *, glyph_frac, bg=BG, shape='rounded'):
    """One square icon. `shape` is 'rounded' (tile with soft corners), 'square'
    (full bleed, for masks that are applied by the OS) or 'circle'."""
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg is not None:
        if shape == 'rounded':
            d.rounded_rectangle([0, 0, n - 1, n - 1], radius=CORNER * n, fill=bg)
        elif shape == 'circle':
            d.ellipse([0, 0, n - 1, n - 1], fill=bg)
        else:
            d.rectangle([0, 0, n - 1, n - 1], fill=bg)
    u = n / 64.0
    for part in normalised(glyph_frac):
        d.polygon([(x * u, y * u) for x, y in part], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


def svg(glyph_frac=0.64):
    parts = normalised(glyph_frac)
    paths = '\n'.join(
        '    <path d="M ' + ' L '.join(f'{x:.3f} {y:.3f}' for x, y in part) + ' Z" />'
        for part in parts)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"
     aria-label="Konfus">
  <rect width="64" height="64" rx="{CORNER * 64:g}" fill="{BG_HEX}" />
  <g fill="#ffffff">
{paths}
  </g>
</svg>
'''


# --- outputs -----------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
PUBLIC = os.path.join(WEB, 'public')
RES = os.path.join(WEB, 'android', 'app', 'src', 'main', 'res')

# Android density buckets: legacy square/round icon size, adaptive foreground size.
DENSITIES = {
    'mdpi': (48, 108),
    'hdpi': (72, 162),
    'xhdpi': (96, 216),
    'xxhdpi': (144, 324),
    'xxxhdpi': (192, 432),
}


def main():
    os.makedirs(PUBLIC, exist_ok=True)
    written = []

    def save(img, path):
        img.save(path)
        written.append(os.path.relpath(path, os.path.dirname(WEB)))

    with open(os.path.join(PUBLIC, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg())
    written.append('web/public/favicon.svg')

    # Legacy .ico for browsers that ignore the SVG (and for Windows shortcuts).
    ico = render(64, glyph_frac=0.64)
    ico.save(os.path.join(PUBLIC, 'favicon.ico'),
             sizes=[(16, 16), (32, 32), (48, 48)])
    written.append('web/public/favicon.ico')

    save(render(96, glyph_frac=0.64), os.path.join(PUBLIC, 'favicon-96.png'))

    # iOS applies its own rounded mask, so this one is full bleed.
    save(render(180, glyph_frac=0.60, shape='square'),
         os.path.join(PUBLIC, 'apple-touch-icon.png'))

    for s in (192, 512):
        save(render(s, glyph_frac=0.64), os.path.join(PUBLIC, f'icon-{s}.png'))

    # purpose="maskable": the platform may crop to a circle of 80% diameter, so
    # the mark has to stay inside that, well short of the edges.
    save(render(512, glyph_frac=0.50, shape='square'),
         os.path.join(PUBLIC, 'icon-512-maskable.png'))

    for density, (legacy, fg) in DENSITIES.items():
        d = os.path.join(RES, f'mipmap-{density}')
        os.makedirs(d, exist_ok=True)
        save(render(legacy, glyph_frac=0.60), os.path.join(d, 'ic_launcher.png'))
        save(render(legacy, glyph_frac=0.58, shape='circle'),
             os.path.join(d, 'ic_launcher_round.png'))
        # Adaptive foreground: transparent, drawn over @color/ic_launcher_background,
        # and only the centre 72/108 of the canvas is guaranteed to stay visible.
        save(render(fg, glyph_frac=0.44, bg=None, shape='square'),
             os.path.join(d, 'ic_launcher_foreground.png'))

    print(f'wrote {len(written)} files')
    for p in written:
        print('  ' + p.replace(os.sep, '/'))


if __name__ == '__main__':
    main()
