"""Make FlameID logo background transparent.

logo.webp is a dark rounded-square tile (shield + flame) on a WHITE
background: the white only exists outside the tile's rounded corners.
Flood-fill from the image border removes exactly that exterior white
(near-white pixels connected to the edge), leaving the tile and the
flame/shield artwork untouched. Alpha is feathered 1px so the
anti-aliased tile edge blends cleanly onto a dark end card.

Output: frontend/demo_assets/logo_transparent.png (RGBA).
logo.webp itself is NOT touched (it is also the site favicon/hero logo).
"""
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

ROOT = "/home/hatch/workspace/agent-daily-streak"
SRC = f"{ROOT}/frontend/logo.webp"
OUT = f"{ROOT}/frontend/demo_assets/logo_transparent.png"

img = Image.open(SRC).convert("RGB")
arr = np.asarray(img).astype(np.int16)
h, w, _ = arr.shape

# Near-white: all channels bright (the exterior is ~247-255).
white = (arr[:, :, 0] > 235) & (arr[:, :, 1] > 235) & (arr[:, :, 2] > 235)

# BFS from every border pixel that is white.
seen = np.zeros((h, w), dtype=bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if white[y, x] and not seen[y, x]:
            seen[y, x] = True
            q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if white[y, x] and not seen[y, x]:
            seen[y, x] = True
            q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and white[ny, nx]:
            seen[ny, nx] = True
            q.append((ny, nx))

alpha = np.where(seen, 0, 255).astype(np.uint8)
# Feather the cut edge by 1px so anti-aliased tile borders blend.
am = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1))
out = img.convert("RGBA")
out.putalpha(am)
out.save(OUT)
print("wrote", OUT, out.size, out.mode,
      "| transparent px:", int((np.asarray(am) == 0).sum()),
      "| total px:", h * w)
