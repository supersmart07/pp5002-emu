"""Split a MacBinary II file into its data and resource forks."""
import struct, sys, pathlib

src, outdir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
b = src.read_bytes()
name = b[2:2 + b[1]].decode('mac_roman')
dlen, rlen = struct.unpack('>II', b[0x53:0x5B])
d0 = 128
r0 = d0 + ((dlen + 127) // 128) * 128
(outdir / 'data.bin').write_bytes(b[d0:d0 + dlen])
(outdir / 'rsrc.bin').write_bytes(b[r0:r0 + rlen])
print(name, 'data', dlen, 'rsrc', rlen)
