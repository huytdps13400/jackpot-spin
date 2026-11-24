"""Jackpot Spin background music: an original, seamless 32 s casino-arcade loop, synthesised.

120 BPM, C major, 16 bars (A: C Am F G ×2, B: F G Em Am Dm G C G) — the bright, bouncy
"lights and coins" register of a slot floor without imitating any real game's theme:

  - four-on-the-floor soft kick, claps on 2 & 4, off-beat hats + 16th shaker
  - plucked bass bouncing root → octave → fifth
  - detuned-saw chord pad, side-chained to the kick (the pump keeps it moving)
  - FM bell arpeggio in 16ths, panned left/right (the "glitter")
  - marimba-ish lead hook; a rising coin chime at every 4th bar's end

Everything is deterministic (fixed seed). The tail (reverb, releases) past the 32 s mark is
folded back onto the start, so the loop has no seam.

Run from the repo root:

    python3 scripts/make-music.py
    # → assets/sounds/music_jackpot.m4a (AAC 160 kbps, stereo)
"""
import os
import subprocess

import numpy as np
from scipy.signal import fftconvolve, lfilter

SR = 44100
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
LOOP = BARS * BAR
TAIL = 4.0
N = int((LOOP + TAIL) * SR)
rng = np.random.default_rng(7)

L = np.zeros(N)
R = np.zeros(N)
side = np.zeros(N)  # pad bus (side-chained)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def at(t):
    return int(round(t * SR))


def add(buf, t, sig, gain=1.0):
    i = at(t)
    j = min(N, i + len(sig))
    buf[i:j] += sig[: j - i] * gain


def stereo(t, sig, gain=1.0, pan=0.0):
    """pan -1 (left) .. 1 (right), equal power."""
    a = (pan + 1) * np.pi / 4
    add(L, t, sig, gain * np.cos(a))
    add(R, t, sig, gain * np.sin(a))


def env_adsr(n, a, d, s, r_, total):
    """Sample envelope of `total` seconds: attack a, decay d to level s, release r_ at the end."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel_start = total - r_
    e = np.where(t > rel_start, e * np.clip(1 - (t - rel_start) / max(r_, 1e-4), 0, 1), e)
    return e


def onepole_lp(x, fc):
    k = np.exp(-2 * np.pi * fc / SR)
    return lfilter([1 - k], [1, -k], x)


def onepole_hp(x, fc):
    return x - onepole_lp(x, fc)


# ───────────────────────── harmony ─────────────────────────
CH = {
    'C': ([60, 64, 67, 72], 36),
    'Am': ([57, 60, 64, 69], 45),
    'F': ([57, 60, 65, 69], 41),
    'G': ([55, 59, 62, 67], 43),
    'Em': ([55, 59, 64, 67], 40),
    'Dm': ([57, 62, 65, 69], 38),
}
PROG = ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G', 'F', 'G', 'Em', 'Am', 'Dm', 'G', 'C', 'G']

# lead hook: (bar, beat, beats, midi) — written an octave up, played an octave down
HOOK_A = [
    [(0, .5, 76), (.5, .5, 79), (1, 1, 84), (2, .5, 79), (2.5, .5, 76), (3, 1, 79)],
    [(0, 1, 81), (1, .5, 79), (1.5, .5, 76), (2, 1.5, 72)],
    [(0, .5, 77), (.5, .5, 81), (1, 1, 84), (2, .5, 81), (2.5, .5, 77), (3, 1, 81)],
    [(0, 1.5, 79), (1.5, .5, 83), (2, 1, 86), (3, .5, 83), (3.5, .5, 79)],
]
HOOK_A2_END = [(0, .5, 79), (.5, .5, 81), (1, .5, 83), (1.5, .5, 86), (2, 2, 91)]
HOOK_B = [
    [(0, 1, 84), (1, .5, 81), (1.5, .5, 84), (2, 1.5, 89)],
    [(0, 1, 86), (1, .5, 83), (1.5, .5, 86), (2, 1.5, 91)],
    [(0, .5, 88), (.5, .5, 86), (1, 1, 83), (2, 1, 79), (3, 1, 83)],
    [(0, 1.5, 84), (1.5, .5, 81), (2, 2, 76)],
    [(0, .5, 77), (.5, .5, 81), (1, 1, 86), (2, .5, 84), (2.5, .5, 81), (3, 1, 77)],
    [(0, .5, 79), (.5, .5, 83), (1, .5, 86), (1.5, .5, 89), (2, 1, 91), (3, .5, 89), (3.5, .5, 86)],
    [(0, 1, 88), (1, 1, 84), (2, 1, 79), (3, 1, 84)],
    [(0, .5, 83), (.5, .5, 86), (1, 1.5, 79)],
]
MELODY = HOOK_A + HOOK_A[:3] + [HOOK_A2_END] + HOOK_B


# ───────────────────────── voices ─────────────────────────
def kick():
    n = at(0.32)
    t = np.arange(n) / SR
    f = 45 + 95 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.16)
    click = rng.standard_normal(n) * np.exp(-t / 0.003) * 0.25
    return body + onepole_lp(click, 3000)


def clap():
    n = at(0.25)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    e = np.zeros(n)
    for k, d in enumerate([0, 0.011, 0.022]):
        e += np.where(t >= d, np.exp(-(t - d) / (0.008 if k < 2 else 0.07)), 0)
    x = onepole_hp(onepole_lp(noise, 5000), 900) * e
    return x


def hat(decay):
    n = at(decay * 6)
    t = np.arange(n) / SR
    x = onepole_hp(rng.standard_normal(n), 7000) * np.exp(-t / decay)
    return x


def bass(m, dur):
    n = at(dur)
    t = np.arange(n) / SR
    f = hz(m)
    saw = 2 * ((t * f) % 1) - 1
    sq = np.sign(np.sin(2 * np.pi * f * t))
    x = 0.6 * saw + 0.4 * sq
    # pluck: filter sweeps down fast
    cut = 300 + 2200 * np.exp(-t / 0.05)
    y = np.zeros(n)
    s = 0.0
    for i in range(n):  # time-varying one-pole
        k = np.exp(-2 * np.pi * cut[i] / SR)
        s = (1 - k) * x[i] + k * s
        y[i] = s
    sub = np.sin(2 * np.pi * f * t)
    return (0.7 * y + 0.5 * sub) * env_adsr(n, 0.004, 0.12, 0.55, 0.03, dur)


def pad_note(m, dur):
    n = at(dur + 0.35)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for cents in (-8, 0, 7):
        f = hz(m) * 2 ** (cents / 1200)
        x += 2 * ((t * f + rng.random()) % 1) - 1
    x = onepole_lp(onepole_lp(x / 3, 2200), 2200)
    return x * env_adsr(n, 0.08, 0.6, 0.75, 0.35, dur + 0.35)


def bell(m, dur=0.5):
    """FM bell: carrier 1, modulator 3.5, index decaying fast — glassy, coin-like."""
    n = at(dur)
    t = np.arange(n) / SR
    f = hz(m)
    idx = 2.2 * np.exp(-t / 0.08)
    x = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * 3.5 * t))
    return x * np.exp(-t / 0.22) * np.minimum(1, t / 0.002)


def marimba(m, dur):
    n = at(max(dur, 0.25) + 0.3)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / (0.25 + 0.2 * dur))
    x += 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t / 0.05)
    x += 0.15 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.12)
    # a soft square layer so the hook carries on phone speakers
    sq = np.sign(np.sin(2 * np.pi * f * t))
    x += 0.18 * onepole_lp(sq, 2500) * env_adsr(n, 0.005, 0.15, 0.4, 0.08, dur + 0.05)
    return x * np.minimum(1, t / 0.003)


# ───────────────────────── arrangement ─────────────────────────
K, CL, HC, HO = kick(), clap(), hat(0.012), hat(0.06)
kick_times = []
for b in range(BARS):
    t0 = b * BAR
    name = PROG[b]
    notes, root = CH[name]
    # drums
    for q in range(4):
        tk = t0 + q * BEAT
        stereo(tk, K, 0.5)
        kick_times.append(tk)
        if q in (1, 3):
            stereo(tk, CL, 0.4, 0.1)
        stereo(tk + BEAT / 2, HO if (q == 3 and b % 2 == 1) else HC, 0.34, 0.35)
        for s16 in (1, 3):
            stereo(tk + s16 * BEAT / 4, HC, 0.14, -0.4)
    # bass: root, octave, fifth, octave per beat in 8ths
    pat = [0, 12, 7, 12, 0, 12, 7, 10 if name == 'G' else 12]
    for e8, iv in enumerate(pat):
        stereo(t0 + e8 * BEAT / 2, bass(root + iv, BEAT / 2 * 0.9), 0.19)
    # pad
    for m in notes:
        add(side, t0, pad_note(m, BAR), 0.11)
    # bell arpeggio in 16ths: chord tones climbing two octaves
    arp = [notes[0] + 12, notes[1] + 12, notes[2] + 12, notes[3] + 12, notes[1] + 24, notes[2] + 24, notes[3] + 12, notes[2] + 12]
    for s in range(16):
        m = arp[s % 8]
        vel = 0.75 if s % 4 == 0 else 0.5
        stereo(t0 + s * BEAT / 4, bell(m), 0.14 * vel, -0.55 if s % 2 == 0 else 0.55)
    # lead hook
    for beat, beats, m in MELODY[b]:
        stereo(t0 + beat * BEAT, marimba(m - 12, beats * BEAT), 0.36, 0.05)
    # coin chime: a quick pentatonic run up at the end of every 4th bar
    if b % 4 == 3:
        run = [84, 86, 88, 91, 93, 96, 98, 100]
        for k, m in enumerate(run):
            stereo(t0 + 3 * BEAT + k * BEAT / 8, bell(m, 0.6), 0.1, -0.6 + 1.2 * k / 7)

# side-chain the pad to the kick
duck = np.ones(N)
for tk in kick_times:
    i = at(tk)
    n = at(BEAT)
    t = np.arange(n) / SR
    j = min(N, i + n)
    duck[i:j] = np.minimum(duck[i:j], (1 - 0.6 * np.exp(-t / 0.12))[: j - i])
pad = side * duck
L += pad
R += pad

# room: short synthetic plate on the melodic content (whole mix, light)
ir_n = at(1.6)
ir_t = np.arange(ir_n) / SR
irL = rng.standard_normal(ir_n) * np.exp(-ir_t / 0.35)
irR = rng.standard_normal(ir_n) * np.exp(-ir_t / 0.35)
irL, irR = onepole_lp(irL, 6000), onepole_lp(irR, 6000)
irL /= np.sqrt((irL ** 2).sum())
irR /= np.sqrt((irR ** 2).sum())
wetL = fftconvolve(onepole_hp(L, 250), irL)[:N]
wetR = fftconvolve(onepole_hp(R, 250), irR)[:N]
L = L + 0.16 * wetL
R = R + 0.16 * wetR

# fold the tail onto the start → seamless loop
n_loop = at(LOOP)
for ch in (L, R):
    ch[: N - n_loop] += ch[n_loop:]
L, R = L[:n_loop], R[:n_loop]

# master: low cut, gentle soft clip, peak -4 dBFS
L, R = onepole_hp(L, 45), onepole_hp(R, 45)
mix = np.stack([L, R], axis=1)
mix /= np.abs(mix).max()
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
# background bed: about -16 LUFS with true-peak headroom for the AAC encoder (the game's
# effects sit on top of it; the app plays it at reduced volume on top of that)
mix *= 10 ** (-4 / 20)

out_dir = os.path.join('assets', 'sounds')
wav = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'music_jackpot.wav')
from scipy.io import wavfile  # noqa: E402

wavfile.write(wav, SR, (mix * 32767).astype(np.int16))
dst = os.path.join(out_dir, 'music_jackpot.m4a')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '160k', dst], check=True)
print('wrote', dst, f'{LOOP:.1f}s')
