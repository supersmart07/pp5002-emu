"""Split an iPod (1G-3G, '[hi]' v2) firmware partition image into its sub-images, verifying checksums."""
import struct, sys, pathlib

src, outdir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
fw = src.read_bytes()
assert fw[0x100:0x104] == b']ih[', 'not an iPod firmware image'
dir_off = struct.unpack('<I', fw[0x104:0x108])[0] + 0x200  # the copy whose offsets are file-relative
outdir.mkdir(parents=True, exist_ok=True)
for i in range(0, 10):
    e = fw[dir_off + i * 40:dir_off + (i + 1) * 40]
    if e[:4] in (b'\0\0\0\0', b''):
        break
    typ, ident = e[:4][::-1].decode(), e[4:8][::-1].decode()
    _, off, length, addr, entry, csum, vers, load = struct.unpack('<8I', e[8:40])
    img = fw[off:off + length]
    ok = (sum(img) & 0xFFFFFFFF) == csum
    print(f'{typ} {ident}: off={off:#x} len={length:#x} addr={addr:#010x} entry={entry:#x} vers={vers:#x} load={load:#x} checksum {"OK" if ok else "BAD"}')
    (outdir / f'{ident}.bin').write_bytes(img)
