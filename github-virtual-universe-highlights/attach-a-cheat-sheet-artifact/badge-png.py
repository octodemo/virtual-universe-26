"""Rewrite PNGs with a single IDAT chunk so the Badger PNG decoder can load them.

Usage: python3 badge-png.py image.png [more.png ...]
"""
import struct
import sys
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


for path in sys.argv[1:]:
    raw = open(path, "rb").read()
    pos, header, idat = 8, None, b""
    while pos < len(raw):
        size, = struct.unpack(">I", raw[pos:pos + 4])
        kind = raw[pos + 4:pos + 8]
        data = raw[pos + 8:pos + 8 + size]
        if kind == b"IHDR":
            header = data
        elif kind == b"IDAT":
            idat += data
        pos += 12 + size
    pixels = zlib.compress(zlib.decompress(idat), 9)
    with open(path, "wb") as out:
        out.write(raw[:8] + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b""))
