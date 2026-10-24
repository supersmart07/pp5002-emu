"""Expand an early UDIF disk image (koly header first, blkx tables in an embedded resource fork) to a raw disk."""
import struct, sys, zlib, pathlib

img = pathlib.Path(sys.argv[1]).read_bytes()
out_path = pathlib.Path(sys.argv[2])
koly = img.find(b'koly')
k = img[koly:koly + 512]
ver, hsize, flags = struct.unpack('>III', k[4:16])
running, doff, dlen, roff, rlen = struct.unpack('>QQQQQ', k[16:56])
print(f'koly@{koly} ver={ver} data off={doff:#x} len={dlen:#x} rsrc off={roff:#x} len={rlen:#x}')

def resources(fork):
    data_off, map_off, data_len, map_len = struct.unpack('>IIII', fork[:16])
    m = fork[map_off:map_off + map_len]
    tl_off, nl_off = struct.unpack('>HH', m[24:28])
    ntypes = struct.unpack('>H', m[tl_off:tl_off + 2])[0] + 1
    for t in range(ntypes):
        e = tl_off + 2 + t * 8
        rtype = m[e:e + 4].decode('mac_roman')
        n, ref = struct.unpack('>HH', m[e + 4:e + 8])
        for i in range(n + 1):
            r = tl_off + ref + i * 12
            rid, name_off = struct.unpack('>hH', m[r:r + 4])
            attr_off = struct.unpack('>I', m[r + 4:r + 8])[0]
            off = attr_off & 0xFFFFFF
            name = ''
            if name_off != 0xFFFF:
                p = nl_off + name_off
                name = m[p + 1:p + 1 + m[p]].decode('mac_roman')
            ln = struct.unpack('>I', fork[data_off + off:data_off + off + 4])[0]
            yield rtype, rid, name, fork[data_off + off + 4:data_off + off + 4 + ln]

def adc(src):
    out = bytearray(); i = 0
    while i < len(src):
        b = src[i]
        if b & 0x80:
            n = (b & 0x7F) + 1; out += src[i + 1:i + 1 + n]; i += 1 + n; continue
        if b & 0x40:
            if i + 2 >= len(src): break
            n = (b & 0x3F) + 4; off = ((src[i + 1] << 8) | src[i + 2]) + 1; i += 3
        else:
            n = ((b >> 2) & 0xF) + 3; off = (((b & 3) << 8) | src[i + 1]) + 1; i += 2
        for _ in range(n):
            out.append(out[-off])
    return bytes(out)

base = int(sys.argv[3], 0) if len(sys.argv) > 3 else doff
fork = img[roff:roff + rlen]
chunks_out = {}
total_sectors = 0
for rtype, rid, name, body in resources(fork):
    print(rtype, rid, repr(name), len(body))
    if rtype != 'blkx':
        continue
    assert body[:4] == b'mish', body[:4]
    first_sector, sector_count, data_start = struct.unpack('>QQQ', body[8:32])
    nchunks = struct.unpack('>I', body[200:204])[0]
    for c in range(nchunks):
        e = body[204 + c * 40:244 + c * 40]
        ctype, _, sec, cnt, coff, clen = struct.unpack('>IIQQQQ', e)
        if ctype == 0xFFFFFFFF:
            break
        abs_sec = first_sector + sec
        total_sectors = max(total_sectors, abs_sec + cnt)
        blob = img[base + data_start + coff:base + data_start + coff + clen]
        if ctype == 0x80000005:
            raw = zlib.decompress(blob)
        elif ctype == 0x80000004:
            raw = adc(blob)
        elif ctype == 1:
            raw = blob
        elif ctype in (0, 2):
            raw = None
        elif ctype == 0x7FFFFFFE:
            continue
        else:
            raise SystemExit(f'unsupported chunk type {ctype:#x}')
        if raw is not None:
            if len(raw) != cnt * 512:
                print(f'  chunk at sector {abs_sec}: got {len(raw)} bytes, expected {cnt * 512}')
            chunks_out[abs_sec] = raw

disk = bytearray(total_sectors * 512)
for sec, raw in chunks_out.items():
    disk[sec * 512:sec * 512 + len(raw)] = raw
out_path.write_bytes(disk)
print('wrote', out_path, len(disk), 'bytes')
