#!/usr/bin/env python3
"""Regenerate the extension icons into src/public/icon/.

    python3 scripts/generate-icons.py      (needs Pillow)

The icons are committed, so this does not run in the build. It exists because
a set of PNGs with no source is un-editable: changing the mark by a pixel later
means redrawing it by hand. Change the constants here and re-run instead.

**Design.** A shield carrying a warning mark. The shield says the extension
protects you from manipulation; the warning mark says it *flags* rather than
blocks, which is the honest description of what it does. Deliberately not an
eye (reads as surveillance -- the opposite of the point) and not a magnifying
glass (turns to mush at 16px).

**Why render at 1024 and downsample.** The shield's identity is in its
diagonal edges, and those come out ragged if drawn directly at 16px. LANCZOS
from a large master keeps them clean.

**Why the mark is so chunky.** At 16px the whole shield is about 11 pixels
wide. A proportionally-scaled exclamation collapses into an indistinct smear,
and the gap between bar and dot is the first thing lost -- the first version of
this icon had exactly that problem. The bar/dot weights and the gap below are
tuned against the 16px render, not the 1024px one.
"""

from pathlib import Path

from PIL import Image, ImageDraw

MASTER = 1024
OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "public" / "icon"
SIZES = (16, 32, 48, 96, 128)

#: Matches the on-page badge palette in src/ui/overlay.ts, so the toolbar icon
#: and the badges it produces read as the same product.
BG = (194, 65, 12, 255)
SHIELD = (255, 251, 235, 255)
MARK = (194, 65, 12, 255)

# All fractions. Tuned against the 16px output -- see the module docstring.
PLATE_RADIUS = 0.22
SHIELD_LEFT, SHIELD_RIGHT = 0.20, 0.80
SHIELD_TOP, SHIELD_BOTTOM = 0.175, 0.855
SHOULDER = 0.42  # where the straight sides give way to the taper
BAR_WIDTH = 0.20  # of shield width
BAR_TOP, BAR_BOTTOM = 0.17, 0.47  # of shield height
DOT_CENTER_Y = 0.635
DOT_RADIUS = 0.072


def render() -> Image.Image:
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # A bare glyph on transparency vanishes against a same-coloured toolbar,
    # so the mark sits on an opaque plate.
    draw.rounded_rectangle(
        [0, 0, MASTER - 1, MASTER - 1], radius=int(MASTER * PLATE_RADIUS), fill=BG
    )

    left, right = MASTER * SHIELD_LEFT, MASTER * SHIELD_RIGHT
    top, bottom = MASTER * SHIELD_TOP, MASTER * SHIELD_BOTTOM
    cx = MASTER * 0.5
    height = bottom - top
    shoulder = top + height * SHOULDER

    steps = 220
    points = [(left, top), (right, top)]
    for i in range(steps + 1):  # right edge, tapering to the point
        t = i / steps
        points.append(
            (right - (right - cx) * (t**2.0), shoulder + t * (bottom - shoulder))
        )
    for i in range(steps, -1, -1):  # left edge, mirrored, back up
        t = i / steps
        points.append(
            (left + (cx - left) * (t**2.0), shoulder + t * (bottom - shoulder))
        )
    draw.polygon(points, fill=SHIELD)

    bar_w = (right - left) * BAR_WIDTH
    draw.rounded_rectangle(
        [
            cx - bar_w / 2,
            top + height * BAR_TOP,
            cx + bar_w / 2,
            top + height * BAR_BOTTOM,
        ],
        radius=bar_w / 2,
        fill=MARK,
    )
    dot_r = height * DOT_RADIUS
    dot_cy = top + height * DOT_CENTER_Y
    draw.ellipse([cx - dot_r, dot_cy - dot_r, cx + dot_r, dot_cy + dot_r], fill=MARK)
    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = render()
    for size in SIZES:
        path = OUT_DIR / f"{size}.png"
        master.resize((size, size), Image.LANCZOS).save(path)
        print(f"wrote {path.relative_to(OUT_DIR.parent.parent.parent)}")


if __name__ == "__main__":
    main()
