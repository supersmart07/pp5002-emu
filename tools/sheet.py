"""Tile PNG frames (work/s_*.png by default) into one contact sheet: sheet.py out.png [glob] [cols]"""
import zlib, struct, glob, sys
def readpng(p):
    d = open(p, 'rb').read(); i = 8; idat = b''
    while i < len(d):
        n = struct.unpack('>I', d[i:i+4])[0]; t = d[i+4:i+8]; c = d[i+8:i+8+n]
        if t == b'IHDR': w, h = struct.unpack('>II', c[:8])
        if t == b'IDAT': idat += c
        i += 12 + n
    raw = zlib.decompress(idat); return w, h, [raw[y*(w*3+1)+1:(y+1)*(w*3+1)] for y in range(h)]
out = sys.argv[1]; pat = sys.argv[2] if len(sys.argv) > 2 else 'work/s_*.png'; cols = int(sys.argv[3]) if len(sys.argv) > 3 else 4
files = sorted(glob.glob(pat), key=lambda p: int(p.split('_')[-1].split('.')[0]))
imgs = [readpng(f) for f in files]; w, h = imgs[0][0], imgs[0][1]; gap = 6
rn = (len(imgs) + cols - 1) // cols; W = cols*w + (cols-1)*gap; H = rn*h + (rn-1)*gap
cv = [bytearray(b'\xff' * W * 3) for _ in range(H)]
for k, (iw, ih, rows) in enumerate(imgs):
    ox = (k % cols) * (w + gap); oy = (k // cols) * (h + gap)
    for y in range(ih): cv[oy+y][ox*3:ox*3+iw*3] = rows[y]
raw = b''.join(b'\0' + bytes(r) for r in cv)
ch = lambda t, dd: struct.pack('>I', len(dd)) + t + dd + struct.pack('>I', zlib.crc32(t + dd) & 0xffffffff)
open(out, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))
print('wrote', out, len(imgs), 'frames')
