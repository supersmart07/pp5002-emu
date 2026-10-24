"""Compare emulator audio (PCM line from tools/boot.js rec) with a reference decode: audiocmp.py rec.log ref.raw"""
import sys, numpy as np
line = [l for l in open(sys.argv[1]) if l.startswith('PCM ')][0].split()[1]
v = np.array([int(line[i:i+4], 16) for i in range(0, len(line), 4)], dtype=np.uint16).view(np.int16)
emu = v[:len(v) // 2 * 2].reshape(-1, 2).astype(float)
ref = np.fromfile(sys.argv[2], dtype='<i2').reshape(-1, 2).astype(float)
nz = np.nonzero(np.abs(emu).sum(1) > 0)[0][0]; e = emu[nz:]
n = 20000; s = e[44100:44100 + n, 0]
c, off = max((np.dot(s, ref[44100 + o:44100 + o + n, 0]) / (np.linalg.norm(s) * np.linalg.norm(ref[44100 + o:44100 + o + n, 0]) + 1e-9), o) for o in range(-3000, 5000))
print('alignment corr %.5f at offset %d' % (c, off))
lo = max(1000, 1000 - off); hi = min(len(e), len(ref) - off) - 100
for k, name in ((0, 'L'), (1, 'R')):
    a = e[lo:hi, k]; b = ref[lo + off:hi + off, k]; err = a - b
    print('%s SNR %.1f dB, max error %d, rms error %.1f' % (name, 10 * np.log10((b ** 2).sum() / ((err ** 2).sum() + 1e-9)), np.abs(err).max(), np.sqrt((err ** 2).mean())))
