"""Fallback music variants for the FlameID demo, in case no licensed
real track can be fetched. Each variant is a ~20s preview so Diệt can
pick a direction by ear; the chosen one gets rendered full-length
(52s) with the same recipe.

Variants:
  A soi-dong   — 128 BPM, Am-F-C-G, four-on-the-floor kick, 16th arp.
  B nhe-nhang  — 96 BPM, C-Am-F-G, no drums, warm pad + soft sine melody.
  C dien-tu    — 120 BPM, Cm-Ab-Eb-Bb, chord stabs + pulsing 8th bass.
All synthesised (no copyright), stereo 44.1kHz.
"""
import sys
import numpy as np

sys.path.insert(0, "/home/hatch/workspace/agent-daily-streak/scripts")
from make_music_bed_v2 import freq, saw, one_pole_lowpass, add_note  # noqa: E402

SR = 44100
OUT = "/home/hatch/workspace/agent-daily-streak/frontend/demo_assets"

# (name, bpm, chords midi triads, melody midi per bar, drums, arp_step, arp_amp, pad_amp)
VARIANTS = {
    "A": dict(
        name="soi-dong", bpm=128,
        chords=[(45, 48, 52), (41, 45, 48), (48, 52, 55), (43, 47, 50)],
        melody=[[81, 81, 79, 76], [77, 76, 74, 72], [76, 79, 81, 84], [79, 78, 74, 71]],
        drums="four", arp_div=4, arp_amp=0.20, pad_amp=0.04, mel_amp=0.24),
    "B": dict(
        name="nhe-nhang", bpm=96,
        chords=[(48, 52, 55), (45, 48, 52), (41, 45, 48), (43, 47, 50)],
        melody=[[76, 72, 76, 79], [72, 76, 81, 76], [77, 76, 74, 72], [74, 71, 74, 76]],
        drums="none", arp_div=2, arp_amp=0.10, pad_amp=0.08, mel_amp=0.20),
    "C": dict(
        name="dien-tu", bpm=120,
        chords=[(48, 51, 55), (44, 48, 51), (51, 55, 58), (46, 50, 53)],
        melody=[[79, 82, 79, 75], [75, 79, 82, 79], [82, 79, 75, 72], [74, 77, 79, 82]],
        drums="pulse", arp_div=2, arp_amp=0.14, pad_amp=0.05, mel_amp=0.22),
}


def render(key, bars=10, full=False):
    v = VARIANTS[key]
    bpm = v["bpm"]
    beat = 60.0 / bpm
    bar = 4 * beat
    total = bars * bar + 1.0
    mix = np.zeros(int(total * SR))
    rng = np.random.default_rng(11)
    for b in range(bars):
        chord = v["chords"][b % len(v["chords"])]
        t0 = b * bar
        # pad
        pad = np.zeros(int((bar + 1.0) * SR))
        for midi in chord:
            f = freq(midi)
            for det in (-0.996, 1.004):
                pad += saw(np.arange(len(pad)) / SR * f * det)
        pad = one_pole_lowpass(pad, 0.02) * v["pad_amp"]
        n = len(pad)
        env = np.ones(n)
        na = int(0.5 * SR)
        env[:na] = np.linspace(0, 1, na)
        env[-int(0.8 * SR):] = np.linspace(1, 0, int(0.8 * SR))
        s0 = int(t0 * SR)
        mix[s0:s0 + n] += pad * env
        # bass
        if v["drums"] == "pulse":
            for i in range(8):
                add_note(mix, t0 + i * beat / 2, beat / 2 * 0.9,
                         freq(chord[0] - 12), 0.28, "sine", attack=0.005, decay=6.0)
        else:
            for bb in (0, 2):
                add_note(mix, t0 + bb * beat, beat * 1.8,
                         freq(chord[0] - 12), 0.30, "sine", attack=0.01, decay=1.6)
        # arp
        div = v["arp_div"]
        tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24,
                 chord[2] + 12, chord[1] + 12, chord[0] + 12, chord[2] + 12]
        steps = 4 * div
        for i in range(steps):
            add_note(mix, t0 + i * beat / div, beat / div * 0.95,
                     freq(tones[i % len(tones)]), v["arp_amp"], "triangle",
                     attack=0.005, decay=9.0)
        # melody
        mel = v["melody"][b % len(v["melody"])]
        for i, midi in enumerate(mel):
            add_note(mix, t0 + i * beat, beat * 0.98, freq(midi),
                     v["mel_amp"], "sine", attack=0.03, decay=2.2)
        # drums
        if v["drums"] == "four":
            for bb in range(4):
                ks = int((t0 + bb * beat) * SR)
                kn = int(0.14 * SR)
                kt = np.arange(kn) / SR
                kf = 130 - (130 - 45) * (kt / 0.14)
                kick = np.sin(2 * np.pi * np.cumsum(kf) / SR) * np.exp(-28 * kt)
                mix[ks:ks + kn] += 0.5 * kick
        elif v["drums"] == "pulse":
            for bb in (0, 2):
                ks = int((t0 + bb * beat) * SR)
                kn = int(0.14 * SR)
                kt = np.arange(kn) / SR
                kf = 130 - (130 - 45) * (kt / 0.14)
                kick = np.sin(2 * np.pi * np.cumsum(kf) / SR) * np.exp(-28 * kt)
                mix[ks:ks + kn] += 0.45 * kick
        if v["drums"] != "none":
            for i in (1, 3, 5, 7):
                hs = int((t0 + i * beat / 2) * SR)
                hn = int(0.04 * SR)
                noise = rng.standard_normal(hn)
                hat = np.diff(np.concatenate([[0], noise])) * np.exp(
                    -np.arange(hn) / SR * 220)
                mix[hs:hs + hn] += 0.07 * hat
    n = len(mix)
    fi = int(0.8 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)
    fo = int(2.0 * SR)
    mix[-fo:] *= np.linspace(1, 0, fo)
    mix = np.tanh(mix * 1.2)
    mix = mix / np.max(np.abs(mix)) * 0.55
    stereo = np.stack([mix, mix], axis=1)
    import wave
    path = f"{OUT}/music_variant_{key}_{v['name']}.wav"
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    print("wrote", path, f"{len(mix)/SR:.1f}s")


if __name__ == "__main__":
    for key in ("A", "B", "C"):
        render(key)
