"""Compose a better music bed for the FlameID demo (v2 music).

The v1 bed was a static C-major chord pad — flat and boring. v2 is a
real (synthesised, no-copyright) arrangement so it can ship in the
public demo without any licensing risk:

  - 112 BPM, 12 bars, progression C - G - Am - F x3 (uplifting, classic).
  - Warm detuned-saw pad under everything (quiet).
  - 8th-note plucked arpeggio cycling chord tones.
  - A simple pentatonic quarter-note melody on top (the hook).
  - Soft kick on beats 1 & 3 + light offbeat hats, kept low in the mix.

Output: frontend/demo_assets/music_bed.wav (stereo 44.1kHz, ~52s;
the video script fades it in/out and cuts it to the 46s video).
The v1 pad is kept as music_bed_v1.wav for reference.
"""
import numpy as np

SR = 44100
BPM = 112
BEAT = 60.0 / BPM
BAR = 4 * BEAT

# MIDI note numbers. Chords as (root, third, fifth) in octave 3/4.
CHORDS = [
    (48, 52, 55),  # C  (C E G)
    (43, 47, 50),  # G  (G B D)
    (45, 48, 52),  # Am (A C E)
    (41, 45, 48),  # F  (F A C)
]
PROG = CHORDS * 6  # 24 bars ~ 51s (video is 46s)

# Quarter-note pentatonic melody, 4 notes per bar (MIDI).
MELODY = [
    [76, 79, 81, 79],  # C:  E5 G5 A5 G5
    [74, 71, 74, 76],  # G:  D5 B4 D5 E5
    [72, 76, 81, 76],  # Am: C5 E5 A5 E5
    [69, 72, 77, 76],  # F:  A4 C5 F5 E5
    [76, 79, 81, 84],  # C:  E5 G5 A5 C6
    [71, 74, 79, 74],  # G:  B4 D5 G5 D5
    [69, 72, 76, 81],  # Am: A4 C5 E5 A5
    [72, 77, 81, 79],  # F:  C5 F5 A5 G5
    [76, 79, 76, 72],  # C:  E5 G5 E5 C5
    [74, 79, 83, 79],  # G:  D5 G5 B5 G5
    [84, 81, 76, 72],  # Am: C6 A5 E5 C5
    [77, 76, 74, 72],  # F:  F5 E5 D5 C5
]
MELODY = MELODY * 2  # 24 bars; second pass repeats the hook


def freq(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def saw(phase):
    return 2.0 * (phase - np.floor(phase + 0.5))


def one_pole_lowpass(x, alpha):
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += alpha * (v - acc)
        y[i] = acc
    return y


def add_note(mix, start, dur, f, amp, wave="sine", attack=0.01, decay=4.0):
    n = int(dur * SR)
    if n <= 0:
        return
    t = np.arange(n) / SR
    ph = f * t
    if wave == "sine":
        sig = np.sin(2 * np.pi * ph)
    elif wave == "triangle":
        sig = 2 * np.abs(saw(ph + 0.25)) - 1
    elif wave == "saw":
        sig = saw(ph)
    env = np.exp(-decay * t)
    a = min(attack, dur / 3)
    na = max(1, int(a * SR))
    env[:na] *= np.linspace(0, 1, na)
    s0 = int(start * SR)
    s1 = min(len(mix), s0 + n)
    mix[s0:s1] += amp * sig[: s1 - s0] * env[: s1 - s0]


def main():
    total = len(PROG) * BAR + 1.0
    mix = np.zeros(int(total * SR))
    rng = np.random.default_rng(7)

    for bar, chord in enumerate(PROG):
        t0 = bar * BAR
        # --- pad: detuned saws, slow attack, one-pole lowpass, quiet ---
        pad = np.zeros(int((BAR + 1.0) * SR))
        for midi in chord:
            f = freq(midi)
            for det in (-0.996, 1.004):
                n = len(pad)
                ph = np.arange(n) / SR * f * det
                pad += saw(ph)
        pad = one_pole_lowpass(pad, 0.02) * 0.05
        n = len(pad)
        env = np.ones(n)
        na = int(0.5 * SR)
        env[:na] = np.linspace(0, 1, na)
        env[-int(0.8 * SR):] = np.linspace(1, 0, int(0.8 * SR))
        s0 = int(t0 * SR)
        mix[s0:s0 + n] += pad * env
        # --- bass: root, sine, beats 1 & 3 ---
        for b in (0, 2):
            add_note(mix, t0 + b * BEAT, BEAT * 1.8, freq(chord[0] - 12),
                     0.30, "sine", attack=0.01, decay=1.6)
        # --- arpeggio: 8th notes cycling chord tones (octave 4) ---
        tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12,
                 chord[0] + 24, chord[2] + 12, chord[1] + 12,
                 chord[0] + 12, chord[2] + 12]
        for i, midi in enumerate(tones):
            add_note(mix, t0 + i * BEAT / 2, BEAT / 2 * 0.95,
                     freq(midi), 0.16, "triangle", attack=0.005, decay=9.0)
        # --- melody: quarter notes, sine + soft 2nd harmonic ---
        for i, midi in enumerate(MELODY[bar]):
            add_note(mix, t0 + i * BEAT, BEAT * 0.98, freq(midi),
                     0.22, "sine", attack=0.03, decay=2.2)
            add_note(mix, t0 + i * BEAT, BEAT * 0.98, freq(midi) * 2,
                     0.05, "sine", attack=0.03, decay=2.2)
        # --- beat: soft kick beats 1 & 3, hats on offbeat 8ths ---
        for b in (0, 2):
            ks = int((t0 + b * BEAT) * SR)
            kn = int(0.14 * SR)
            kt = np.arange(kn) / SR
            kf = 130 - (130 - 45) * (kt / 0.14)
            kick = np.sin(2 * np.pi * np.cumsum(kf) / SR) * np.exp(-28 * kt)
            mix[ks:ks + kn] += 0.45 * kick
        for i in (1, 3, 5, 7):
            hs = int((t0 + i * BEAT / 2) * SR)
            hn = int(0.04 * SR)
            noise = rng.standard_normal(hn)
            hat = np.diff(np.concatenate([[0], noise])) * np.exp(
                -np.arange(hn) / SR * 220)
            mix[hs:hs + hn] += 0.07 * hat

    # gentle master fades (video script adds its own fades too)
    n = len(mix)
    fi = int(1.0 * SR)
    mix[:fi] *= np.linspace(0, 1, fi)
    fo = int(3.0 * SR)
    mix[-fo:] *= np.linspace(1, 0, fo)
    # soft-clip + normalise
    mix = np.tanh(mix * 1.2)
    peak = np.max(np.abs(mix))
    mix = mix / peak * 0.55
    stereo = np.stack([mix, mix], axis=1)
    import wave
    out = "/home/hatch/workspace/agent-daily-streak/frontend/demo_assets/music_bed.wav"
    with wave.open(out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((stereo * 32767).astype(np.int16).tobytes())
    print("wrote", out, f"{len(mix)/SR:.1f}s peak {peak:.2f}")


if __name__ == "__main__":
    main()
