"""Turn 'FRAME w h hexpixels' lines from tools/run.js output into PNG files (2-bpp grayscale, 0 = light)."""
import sys, zlib, struct, pathlib
out = pathlib.Path(sys.argv[1]); scale = int(sys.argv[2]) if len(sys.argv) > 2 else 3
shades = [(0xB8, 0xC4, 0xA4), (0x8C, 0x96, 0x7E), (0x55, 0x5C, 0x4C), (0x1D, 0x22, 0x1C)]
frames = [l for l in sys.stdin if l.startswith('FRAME ')]
for n, line in enumerate(frames):
    parts = line.split(); _, w, h, hx = parts[:4]
    w, h = int(w), int(h)
    rows = []
    for y in range(h * scale):
        row = bytearray([0])
        for x in range(w * scale):
            row += bytes(shades[int(hx[(y // scale) * w + x // scale], 16)])
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w * scale, h * scale, 8, 2, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
    p = out if len(frames) == 1 else out.with_name(f'{out.stem}_{n}{out.suffix}')
    p.write_bytes(png); print('wrote', p)
