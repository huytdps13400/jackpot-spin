"""Synthesise the game's UI sounds so the repo ships no third-party audio.

Run: python3 scripts/generate-sounds.py  (writes assets/sounds/*.wav, 44.1 kHz mono 16-bit)
"""
import math, random, struct, wave, os

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sounds')


def write(name, samples):
    peak = max(1e-9, max(abs(s) for s in samples))
    data = b''.join(struct.pack('<h', int(max(-1, min(1, s / peak * 0.9)) * 32767)) for s in samples)
    with wave.open(os.path.join(OUT, name), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data)


def env(t, attack, decay):
    return (t / attack if t < attack else math.exp(-(t - attack) / decay))


def tick():  # crisp mechanical detent: short noise burst + 2.4 kHz ping
    n = int(SR * 0.035); rnd = random.Random(7)
    return [(rnd.uniform(-1, 1) * 0.5 * math.exp(-i / SR / 0.003)
             + math.sin(2 * math.pi * 2400 * i / SR) * env(i / SR, 0.0005, 0.008)) for i in range(n)]


def lock():  # heavy latch: low thump + metallic partials
    n = int(SR * 0.32)
    out = []
    for i in range(n):
        t = i / SR
        thump = math.sin(2 * math.pi * (95 - 40 * t) * t) * env(t, 0.002, 0.06)
        metal = sum(a * math.sin(2 * math.pi * f * t) for f, a in ((1320, .35), (1980, .22), (2770, .14))) * env(t, 0.001, 0.09)
        out.append(thump * 1.2 + metal)
    return out


def win():  # warm gold shimmer: arpeggiated major-9 bell tones + airy sparkle
    n = int(SR * 1.4); rnd = random.Random(11)
    notes = [(0.00, 523.25), (0.07, 659.25), (0.14, 783.99), (0.21, 987.77), (0.30, 1174.66)]
    out = [0.0] * n
    for start, f in notes:
        s0 = int(start * SR)
        for i in range(s0, n):
            t = (i - s0) / SR
            e = env(t, 0.004, 0.45)
            out[i] += e * (math.sin(2 * math.pi * f * t) + 0.3 * math.sin(2 * math.pi * f * 2.01 * t) + 0.12 * math.sin(2 * math.pi * f * 3.98 * t))
    for i in range(n):
        t = i / SR
        out[i] += rnd.uniform(-1, 1) * 0.06 * env(t, 0.05, 0.35) * (0.5 + 0.5 * math.sin(2 * math.pi * 23 * t))
    return out


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    write('tick.wav', tick()); write('lock.wav', lock()); write('win.wav', win())
    print('sounds written to', os.path.abspath(OUT))
