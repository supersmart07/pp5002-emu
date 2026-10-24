"""Build a 1st-gen-iPod-style disk image: Apple partition map, Apple_MDFW firmware partition, Apple_HFS data partition.
usage: mkdisk.py <Firmware image> <raw HFS+ volume> <out.img>"""
import struct, sys, pathlib

fw = pathlib.Path(sys.argv[1]).read_bytes()
hfs = pathlib.Path(sys.argv[2]).read_bytes()
out = pathlib.Path(sys.argv[3])
BS = 512
map_start, map_blocks = 1, 63
fw_start, fw_blocks = 64, 8 * 1024 * 1024 // BS
hfs_start, hfs_blocks = fw_start + fw_blocks, len(hfs) // BS
total = hfs_start + hfs_blocks
assert len(fw) <= fw_blocks * BS

def entry(count, start, blocks, name, ptype, status):
    e = struct.pack('>2sHIII32s32sIII', b'PM', 0, count, start, blocks, name.encode(), ptype.encode(), 0, blocks, status)
    return e.ljust(BS, b'\0')

disk = bytearray(total * BS)
disk[0:BS] = struct.pack('>2sHI', b'ER', BS, total).ljust(BS, b'\0')
parts = [
    (map_start, map_blocks, 'Apple', 'Apple_partition_map', 0x37),
    (fw_start, fw_blocks, 'firmware', 'Apple_MDFW', 0x37),
    (hfs_start, hfs_blocks, 'disk', 'Apple_HFS', 0x40000033),
]
for i, p in enumerate(parts):
    disk[(1 + i) * BS:(2 + i) * BS] = entry(len(parts), *p)
disk[fw_start * BS:fw_start * BS + len(fw)] = fw
disk[hfs_start * BS:hfs_start * BS + len(hfs)] = hfs
out.write_bytes(disk)
print(f'{out}: {total} blocks ({len(disk) / 1e6:.1f} MB); firmware @ {fw_start}, HFS+ @ {hfs_start}')
