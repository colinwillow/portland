"""The chunk file format, written here and read in game/chunk.js.

WHY A CUSTOM BINARY AND NOT glTF. What the runtime needs per chunk is not a
mesh, it is a DESCRIPTION: footprints and heights, centrelines and widths,
props and their kinds. Baking triangles would be four to six times bigger, and
it would throw away the one thing the description buys -- the runtime picks its
own level of detail, and the same footprints feed the collider.

Everything is little-endian and NOTHING IS ALIGNED. Records pack tight and are
read through a DataView, which does not care; an aligned format would cost
padding for a property no reader here needs.

Lengths are decimetres in a signed 16-bit int. That is +/-3276.7 m, which
covers a 500 m chunk's local coordinates with room to spare and covers absolute
heights up to Mount Hood. The quantisation is 10 cm: below what a walking
camera resolves, and it halves the file against float32.

  magic   'PDXC'                              4 bytes
  version u16
  nsect   u16
  nsect x { tag u32(4cc), offset u32, length u32, count u32 }

Sections, each described where it is built in bake.py:

  TERR  (count = N)      (N+1)^2 int16 heights in dm, row-major from the chunk's
                         NORTH-WEST corner, +X east then +Z south.

  BLDG  (count = n)      per building, packed:
                           u8  nv           ring vertices, 3..250
                           u8  cls          palette index
                           u8  roof         0 flat, else a pitched roof
                           u8  flags        bit0 landmark
                           i16 baseDm       ground under the footprint
                           i16 topDm        eaves
                           i16 roofDm       ridge above eaves, 0 when flat
                           i16 ridge[4]     ridge segment x0,z0,x1,z1 (chunk-local dm)
                           i16 xz[nv*2]     ring, chunk-local dm, anticlockwise
                           u8  tri[(nv-2)*3]  roof cap triangulation, indices into the ring

  ROAD  (count = n)      per centreline:
                           u8  cls
                           u8  flags        bit0 bridge, bit1 tunnel, bit2 steps
                           u8  w4           width in quarter-metres
                           u8  np           points, 2..255
                           i16 xzy[np*3]    chunk-local x,z and ABSOLUTE y, all dm

  AREA  (count = n)      per polygon, already clipped to the chunk and draped:
                           u8  cls
                           u8  _pad
                           u16 nv
                           u16 nt
                           i16 xzy[nv*3]
                           u16 idx[nt*3]

  SHOP  (count = n)      a business, already projected onto a building facade:
                           u8  cat          palette bucket
                           u8  flags        bit0 awning, bit1 landmark
                           u8  yaw          the facade's OUTWARD normal, 0..255
                           u8  w4           sign width in quarter-metres
                           i16 x, z         chunk-local dm, on the wall
                           i16 y            absolute dm, the pavement at the wall
                           i16 h            sign centre above y, dm
                           u16 name         index into NAME

  SGNS  (count = n)      a street name blade at a junction, 9 bytes each:
                           u8  flags        bit0 draw the post, bit1 which blade
                           u8  yaw          bearing of the street NAMED, 0..255
                           i16 x, z         chunk-local dm, the post's foot
                           i16 y            absolute dm, the ground there
                           u16 name         index into NAME
                         One record per BLADE and up to two blades share a
                         post, which is why the post is a flag on the first of
                         them rather than a record of its own: a junction's two
                         blades are the same object and splitting them into two
                         sections would let them drift apart.

  NAME  (count = n)      u8 length + UTF-8, repeated. Names are clamped to 48
                         bytes: a sign nobody can read at 40 characters is a
                         sign nobody can read at 80, and the length is a u8.
                         ONE TABLE PER CHUNK, SHARED by SHOP and SGNS -- a
                         chunk with "SE HAWTHORNE BLVD" on four corners stores
                         the string once.

  PROP  (count = n)      10 bytes each:
                           u8  kind
                           u8  yaw          0..255 over a full turn
                           u8  scale        0..255 over 0.5..2.0
                           u8  tint         variation index
                           i16 x, z         chunk-local dm
                           i16 y            absolute dm
"""
import struct

DM = 10.0                      # decimetres per metre
def dm(v):  return max(-32768, min(32767, int(round(v * DM))))

def fourcc(s):
    return struct.unpack("<I", s.encode())[0]

class ChunkWriter:
    def __init__(self):
        self.sections = []     # (tag, count, bytes)
    def add(self, tag, count, payload):
        if count:
            self.sections.append((fourcc(tag), count, bytes(payload)))
    def bytes(self):
        head = 8 + 16 * len(self.sections)
        out = bytearray()
        out += b"PDXC" + struct.pack("<HH", 1, len(self.sections))
        off = head
        for tag, count, payload in self.sections:
            out += struct.pack("<IIII", tag, off, len(payload), count)
            off += len(payload)
        for _, _, payload in self.sections:
            out += payload
        return bytes(out)
