#!/usr/bin/env python3
"""Render public/icon.svg into mac-app/Resources/AppIcon.png (1024 x 1024, transparent margin).

macOS cannot rasterize SVG with sips, and this server has no SVG tool, so this draws the icon's few shapes itself.
It understands only what icon.svg uses: <rect x y width height rx fill> and <circle cx cy r fill> inside an
optional <g fill>, in a square viewBox. Anti-aliased with 4 sub-rows and exact horizontal coverage.

The artwork goes in the middle 824 px, the size of the rounded square in Apple's macOS icon grid, so the Dock shows
it at the same size as other apps. build.sh turns the PNG into AppIcon.icns with sips and iconutil.

    python3 mac-app/scripts/render-icon.py            # from the repository root
"""
import math
import struct
import sys
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "public" / "icon.svg"
OUT = ROOT / "mac-app" / "Resources" / "AppIcon.png"
SIZE = 1024
ART = 824
SUB = 4


def color(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))


def shapes(svg_path):
    tree = ET.parse(svg_path)
    root = tree.getroot()
    vb = [float(v) for v in root.get("viewBox", "0 0 32 32").split()]
    out = []

    def walk(el, inherited):
        fill = el.get("fill", inherited)
        tag = el.tag.split("}")[-1]
        if tag == "rect":
            w, h = float(el.get("width")), float(el.get("height"))
            rx = float(el.get("rx", el.get("ry", 0)))
            out.append(("rect", float(el.get("x", 0)), float(el.get("y", 0)), w, h, min(rx, w / 2, h / 2), color(fill)))
        elif tag == "circle":
            out.append(("circle", float(el.get("cx")), float(el.get("cy")), float(el.get("r")), color(fill)))
        for child in el:
            walk(child, fill)

    walk(root, "#000")
    return vb, out


def interval(shape, y):
    """x range the shape covers on the horizontal line at y (viewBox units), or None"""
    if shape[0] == "rect":
        _, x, top, w, h, rx, _ = shape
        if y < top or y > top + h:
            return None
        d = (top + rx - y) if y < top + rx else (y - (top + h - rx)) if y > top + h - rx else 0
        inset = rx - math.sqrt(max(rx * rx - d * d, 0)) if d > 0 else 0
        return x + inset, x + w - inset
    _, cx, cy, r, _ = shape
    dy = y - cy
    if abs(dy) >= r:
        return None
    half = math.sqrt(r * r - dy * dy)
    return cx - half, cx + half


def render():
    (vx, vy, vw, vh), items = shapes(SRC)
    scale = ART / vw
    off = (SIZE - ART) / 2
    rows = []
    for py in range(SIZE):
        # premultiplied RGBA
        acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(SIZE)]
        for shape in items:
            fill = shape[-1]
            cov = {}
            for s in range(SUB):
                y = vy + ((py + (s + 0.5) / SUB) - off) / scale
                iv = interval(shape, y)
                if not iv:
                    continue
                x0, x1 = off + (iv[0] - vx) * scale, off + (iv[1] - vx) * scale
                for px in range(max(0, int(math.floor(x0))), min(SIZE, int(math.ceil(x1)))):
                    c = min(x1, px + 1) - max(x0, px)
                    if c > 0:
                        cov[px] = cov.get(px, 0.0) + c / SUB
            for px, c in cov.items():
                c = min(c, 1.0)
                a = acc[px]
                acc[px] = [fill[0] * c + a[0] * (1 - c), fill[1] * c + a[1] * (1 - c), fill[2] * c + a[2] * (1 - c), c + a[3] * (1 - c)]
        row = bytearray([0])  # filter: none
        for r, g, b, a in acc:
            if a > 0:
                row += bytes([round(min(r / a, 1) * 255), round(min(g / a, 1) * 255), round(min(b / a, 1) * 255), round(a * 255)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return b"".join(rows)


def png(raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(png(render()))
    print(f"wrote {OUT.relative_to(ROOT)}", file=sys.stderr)
