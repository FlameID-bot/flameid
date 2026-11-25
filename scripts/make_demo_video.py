"""Build FlameID demo.mp4 from real browser screenshots of the live site.

Same method as project 1's make_demo_v2.py: caption real screenshots with
PIL, then stitch with ffmpeg. No slides, no mockups — every frame is the
real website with real on-chain data.

Shots (wallet mrchrismast.ai already checked in + claimed Genesis today,
so the video shows results, not the clicks — per demo_plan.md):
  1. hero (100 wallets)          8s
  2. season top 10              10s
  3. top inviters + leaderboard 10s
  4. profile mrchrismast.ai     12s  (Genesis badge earned)
  5. end card (PIL-made)         6s
Total ~46s, 1280x720, target < 2 MB.
"""
import os
import subprocess
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
BG = (11, 14, 17)
GOLD = (240, 185, 11)
WHITE = (255, 255, 255)
MUTED = (170, 178, 188)
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

ROOT = "/home/hatch/workspace/agent-daily-streak"
SNAP_OLD = "/home/hatch/workspace/.hatch-browser/snapshots/browser-task:3449d584-2549-52bc-a989-f36888bc0422"
SNAP_NEW = "/home/hatch/workspace/.hatch-browser/snapshots/browser-task:80c83872-8871-5300-9216-1cebce1deba4"
# NOTE (Diệt 25/11 15:08): the demo video must NOT show mrchrismast.ai —
# it links FlameID to the old project. Profile shot uses a stranger's
# wallet instead: 0x4d50DD3E57d1F4adade559Bd075BcA0496aaa29b (2nd check-in
# ever, Genesis claimed, streak 1, score 2), opened via agent.html?a=.
OUT = f"{ROOT}/frontend/demo_assets"
os.makedirs(OUT, exist_ok=True)

# Profile shot = newest look.0.jpg in the new task's snapshots.
def newest_jpg(task_dir):
    cands = []
    for d in os.listdir(task_dir):
        p = os.path.join(task_dir, d, "look.0.jpg")
        if os.path.isfile(p):
            cands.append((os.path.getmtime(p), p))
    cands.sort()
    return cands[-1][1] if cands else None

PROFILE = newest_jpg(SNAP_NEW)
print("profile shot:", PROFILE)

def font(size, bold=True):
    return ImageFont.truetype(FB if bold else FR, size)

def cover_crop(img, w=W, h=H):
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    ni = img.resize((int(iw * scale), int(ih * scale)))
    x = (ni.width - w) // 2
    y = (ni.height - h) // 2
    return ni.crop((x, y, x + w, y + h))

def caption_bar(img, step, text):
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle([0, H - 96, W, H], fill=(0, 0, 0, 200))
    d.rectangle([0, H - 96, W, H - 92], fill=GOLD)
    d.text((48, H - 78), step, font=font(30), fill=GOLD)
    d.text((48, H - 40), text, font=font(26, bold=False), fill=WHITE)
    return img

def save(img, name):
    img.save(f"{OUT}/{name}.png")
    print("wrote", name)

def shot(src, name, step, text):
    img = Image.open(src).convert("RGB")
    img = cover_crop(img)
    img = caption_bar(img, step, text)
    save(img, name)

# 1. hero — 100 wallets
shot(f"{SNAP_OLD}/20261125T080241.679971261Z/look.0.jpg",
     "s1_hero", "STEP 1", "Daily on-chain check-ins for Agent ID holders.")

# 2. season top 10
shot(f"{SNAP_OLD}/20261125T080037.893638411Z/look.0.jpg",
     "s2_season", "STEP 2", "Season 1: 14 days. Survivor for a 7-day clean run, Champion for the top 3.")

# 3. top inviters + leaderboard
shot(f"{SNAP_OLD}/20261125T080044.406493323Z/look.0.jpg",
     "s3_invite", "STEP 3", "Invite friends to earn shields that protect your streak.")

# 4. profile mrchrismast.ai — Genesis earned
shot(PROFILE,
     "s4_profile", "STEP 4", "A shareable profile for every streak — no wallet needed to view.")

# 5. end card
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
try:
    logo = Image.open(f"{ROOT}/frontend/logo.webp").convert("RGB")
    logo = logo.resize((180, 180))
    img.paste(logo, ((W - 180) // 2, 90))
except Exception as e:
    print("logo skipped:", e)
d.text((W // 2, 300), "FlameID", font=font(64), fill=GOLD, anchor="mt")
d.text((W // 2, 390), "Keep the fire alive.", font=font(32, bold=False), fill=WHITE, anchor="mt")
d.text((W // 2, 450), "flame-id.xyz", font=font(30), fill=MUTED, anchor="mt")
d.text((W // 2, 500), "Contract: 0xa68B69AF101E4262F651119c9830BfBd1603EC97", font=font(22, bold=False), fill=MUTED, anchor="mt")
save(img, "s5_end")

# ffmpeg: each still held for its duration, concat, h264.
segments = [
    ("s1_hero", 8),
    ("s2_season", 10),
    ("s3_invite", 10),
    ("s4_profile", 12),
    ("s5_end", 6),
]
inputs = []
filter_parts = []
for i, (name, dur) in enumerate(segments):
    inputs += ["-loop", "1", "-t", str(dur), "-i", f"{OUT}/{name}.png"]
    filter_parts.append(f"[{i}:v]format=yuv420p,fps=30,settb=AVTB[v{i}]")
concat = "".join(f"[v{i}]" for i in range(len(segments)))
filter_complex = ";".join(filter_parts) + f";{concat}concat=n={len(segments)}:v=1:a=0[v]"
out_mp4 = f"{ROOT}/frontend/demo.mp4"
cmd = ["ffmpeg", "-y"] + inputs + [
    "-filter_complex", filter_complex,
    "-map", "[v]", "-c:v", "libx264", "-crf", "23", "-preset", "medium",
    "-movflags", "+faststart", out_mp4,
]
print("running:", " ".join(cmd))
subprocess.run(cmd, check=True)
size = os.path.getsize(out_mp4)
print(f"demo.mp4: {size/1024:.0f} KB")
probe = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
     "-of", "default=noprint_wrappers=1:nokey=1", out_mp4],
    capture_output=True, text=True)
print("duration:", probe.stdout.strip(), "s")
