"""Build FlameID demo v2 from fresh live screenshots (browser task).

v2 vs v1 (per Diệt 25/11 15:18 — "video đơn giản vậy, thêm hiệu ứng,
quay lúc làm, hiệu ứng chạy chữ, hiệu ứng qua trang, nhạc nền"):
  - Ken Burns slow zoom on every shot (no more static stills).
  - xfade cross-dissolves between shots (hiệu ứng qua trang).
  - Animated captions: fade in + drift up over the first 1.2s of each shot
    (hiệu ứng chạy chữ), gold step label + white line.
  - Quiet ambient music bed (synthesised chord pad, no copyright issue),
    faded in/out, mixed low under the video.
  - End card: scrolling marquee line with site + contract.
  - No mrchrismast.ai anywhere: profile shot is the stranger wallet
    0x4d50...a29b (same rule as v1).

Usage: python3 scripts/make_demo_video_v2.py <hero.jpg> <season.jpg> \
         <invite.jpg> <profile.jpg>
Output: frontend/demo_v2.mp4 (NOT demo.mp4 — delivery swaps it in only
after Diệt approves, so the live form link never points at an unapproved cut).
Requires: ffmpeg with libfreetype (drawtext), PIL for the end card.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
GOLD = "0xF0B90B"
WHITE = "white"
ROOT = "/home/hatch/workspace/agent-daily-streak"
OUT = f"{ROOT}/frontend/demo_assets"
os.makedirs(OUT, exist_ok=True)
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

SHOTS = [
    # (source, duration, step label, caption)
    (sys.argv[1], 9, "STEP 1",
     "Daily on-chain check-ins for Agent ID holders."),
    (sys.argv[2], 11, "STEP 2",
     "Season 1: 14 days. Survivor for a 7-day clean run, Champion for the top 3."),
    (sys.argv[3], 11, "STEP 3",
     "Invite friends to earn shields that protect your streak."),
    (sys.argv[4], 12, "STEP 4",
     "A shareable profile for every streak - no wallet needed to view."),
]


def cover_crop(path, out_png):
    """Crop/resize a screenshot to 1280x720 cover, no caption (captions are
    animated in ffmpeg, not baked into the still)."""
    img = Image.open(path).convert("RGB")
    iw, ih = img.size
    scale = max(W / iw, H / ih)
    ni = img.resize((int(iw * scale), int(ih * scale)))
    x = (ni.width - W) // 2
    y = (ni.height - H) // 2
    ni.crop((x, y, x + W, y + H)).save(out_png)
    print("wrote", out_png)


def end_card(out_png):
    img = Image.new("RGB", (W, H), (11, 14, 17))
    d = ImageDraw.Draw(img)
    try:
        # Transparent PNG (white exterior removed by make_logo_transparent.py)
        # so no white corners show on the dark card.
        logo = Image.open(f"{OUT}/logo_transparent.png").convert("RGBA")
        logo = logo.resize((180, 180))
        img.paste(logo, ((W - 180) // 2, 80), logo)
    except Exception:
        try:
            logo = Image.open(f"{ROOT}/frontend/logo.webp").convert("RGB")
            logo = logo.resize((180, 180))
            img.paste(logo, ((W - 180) // 2, 80))
        except Exception as e:
            print("logo skipped:", e)
    def font(size, bold=True):
        return ImageFont.truetype(FB if bold else FR, size)
    d.text((W // 2, 290), "FlameID", font=font(64), fill=(240, 185, 11), anchor="mt")
    d.text((W // 2, 380), "Keep the fire alive.", font=font(32, bold=False),
           fill=(255, 255, 255), anchor="mt")
    d.text((W // 2, 440), "flame-id.xyz", font=font(30),
           fill=(170, 178, 188), anchor="mt")
    img.save(out_png)
    print("wrote", out_png)


def esc(s):
    return s.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:")


def main():
    stills = []
    for i, (src, dur, step, cap) in enumerate(SHOTS, 1):
        png = f"{OUT}/v2_s{i}.png"
        cover_crop(src, png)
        stills.append((png, dur, step, cap))
    end_png = f"{OUT}/v2_end.png"
    end_card(end_png)
    stills.append((end_png, 7, "", ""))  # end card, marquee only

    # --- ffmpeg filter graph ---
    # Per shot: zoompan Ken Burns (slow zoom 1.00 -> 1.08) + caption bar +
    # animated drawtext (alpha fade-in + y drift up). Then xfades chained.
    inputs = []
    for png, _, _, _ in stills:
        inputs += ["-loop", "1", "-t", "60", "-i", png]
    # music bed (pre-generated, see make_music_bed.sh) or silence fallback
    music = f"{OUT}/music_bed.wav"
    have_music = os.path.isfile(music) and os.path.getsize(music) > 1000
    if have_music:
        inputs += ["-i", music]
    n = len(stills)
    total = sum(d for _, d, _, _ in stills)
    xf = 1.0  # crossfade duration (s)

    parts = []
    vlabels = []
    for i, (png, dur, step, cap) in enumerate(stills):
        # zoompan: 25fps, zoom from 1.00 to 1.08 across the shot
        frames = int(dur * 25)
        zp = (f"[{i}:v]scale=2560:1440,zoompan=z='1+0.08*on/{frames}':"
              f"d={frames}:s=1280x720:fps=25,format=yuv420p[vz{i}]")
        parts.append(zp)
        # caption bar (static, drawn once) + animated text
        bar = (f"[vz{i}]drawbox=x=0:y=624:w=1280:h=96:color=black@0.8:t=fill,"
               f"drawbox=x=0:y=624:w=1280:h=4:color={GOLD}:t=fill[vc{i}]")
        parts.append(bar)
        if step:
            # fade in over 1.2s, drift up 8px: y = 648 - 8*(1 - t/1.2)
            t1 = (f"[vc{i}]drawtext=fontfile={FB}:text='{esc(step)}':fontsize=30:"
                  f"fontcolor={GOLD}:x=48:y='656-8*max(0\\,1-t/1.2)':"
                  f"alpha='min(1\\,t/1.2)'[vt{i}a]")
            t2 = (f"[vt{i}a]drawtext=fontfile={FR}:text='{esc(cap)}':fontsize=26:"
                  f"fontcolor={WHITE}:x=48:y='694-8*max(0\\,1-t/1.2)':"
                  f"alpha='min(1\\,t/1.2)'[v{i}]")
            parts.append(t1)
            parts.append(t2)
        else:
            # end card: scrolling marquee (contract + site) at the bottom
            mq = ("flame-id.xyz   -   Contract: "
                  "0xa68B69AF101E4262F651119c9830BfBd1603EC97   -   "
                  "Season 1 ends 09 Dec 2026   -   ")
            m = (f"[vc{i}]drawtext=fontfile={FR}:text='{esc(mq)}':fontsize=26:"
                 f"fontcolor={WHITE}:x='1280-mod(90*t\\,2560)':y=672[v{i}]")
            parts.append(m)
        vlabels.append(f"[v{i}]")

    # chain xfades: shot i fades into shot i+1 over xf seconds
    cur = vlabels[0]
    offset = stills[0][1] - xf
    for i in range(1, n):
        out = f"[x{i}]" if i < n - 1 else "[vout]"
        parts.append(f"{cur}{vlabels[i]}xfade=transition=fade:duration={xf}:"
                     f"offset={offset:.2f}{out}")
        cur = out
        offset += stills[i][1] - xf
    total_out = total - xf * (n - 1)

    cmd = ["ffmpeg", "-y"] + inputs + [
        "-filter_complex", ";".join(parts),
        "-map", "[vout]",
    ]
    if have_music:
        cmd += ["-map", f"{n}:a", "-t", str(total_out),
                "-af", "volume=0.9,afade=t=in:st=0:d=2,afade=t=out:st="
                       f"{total_out - 3:.1f}:d=3",
                "-c:a", "aac", "-b:a", "96k", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26",
            "-preset", "medium", "-movflags", "+faststart",
            f"{ROOT}/frontend/demo_v2.mp4"]
    print("running ffmpeg ...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-3000:])
        sys.exit(1)
    print("done: frontend/demo_v2.mp4")
    subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                    "format=duration,size", "-of",
                    "default=noprint_wrappers=1",
                    f"{ROOT}/frontend/demo_v2.mp4"], check=False)


if __name__ == "__main__":
    main()
