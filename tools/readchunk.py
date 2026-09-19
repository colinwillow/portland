"""Read the baked chunk format back. Mirrors game/chunk.js.

This exists so the bake can be CHECKED against what a reader actually sees
rather than against what the writer believes it wrote -- the two are the same
only when somebody has run them against each other.
"""
import struct

def read(path):
    b = open(path, "rb").read()
    assert b[:4] == b"PDXC", path
    ver, nsect = struct.unpack_from("<HH", b, 4)
    secs = {}
    for k in range(nsect):
        tag, off, ln, cnt = struct.unpack_from("<IIII", b, 8 + 16*k)
        secs[struct.pack("<I", tag).decode()] = (off, ln, cnt)
    out = {}
    if "TERR" in secs:
        off, ln, n = secs["TERR"]
        m = n + 1
        out["terr"] = (m, [v/10.0 for v in struct.unpack_from(f"<{m*m}h", b, off)])
    if "BLDG" in secs:
        off, ln, n = secs["BLDG"]; p = off; L = []
        for _ in range(n):
            nv, cls, roof, flags = struct.unpack_from("<BBBB", b, p); p += 4
            base, top, rh = struct.unpack_from("<hhh", b, p); p += 6
            ridge = struct.unpack_from("<hhhh", b, p); p += 8
            ring = [struct.unpack_from("<hh", b, p + 4*i) for i in range(nv)]; p += 4*nv
            nt = (nv-2)*3
            tri = list(b[p:p+nt]); p += nt
            L.append(dict(cls=cls, roof=roof, flags=flags, base=base/10, top=top/10,
                          roofH=rh/10, ridge=[v/10 for v in ridge],
                          ring=[(x/10, z/10) for x, z in ring], tri=tri))
        out["bldg"] = L
    if "ROAD" in secs:
        off, ln, n = secs["ROAD"]; p = off; L = []
        for _ in range(n):
            cls, flags, w4, np_ = struct.unpack_from("<BBBB", b, p); p += 4
            pts = [struct.unpack_from("<hhh", b, p + 6*i) for i in range(np_)]; p += 6*np_
            L.append(dict(cls=cls, flags=flags, w=w4/4.0,
                          pts=[(x/10, z/10, y/10) for x, z, y in pts]))
        out["road"] = L
    if "AREA" in secs:
        off, ln, n = secs["AREA"]; p = off; L = []
        for _ in range(n):
            cls, _pad, nv, nt = struct.unpack_from("<BBHH", b, p); p += 6
            v = [struct.unpack_from("<hhh", b, p + 6*i) for i in range(nv)]; p += 6*nv
            idx = list(struct.unpack_from(f"<{nt*3}H", b, p)); p += 2*nt*3
            L.append(dict(cls=cls, verts=[(x/10, z/10, y/10) for x, z, y in v], idx=idx))
        out["area"] = L
    if "PROP" in secs:
        off, ln, n = secs["PROP"]; p = off; L = []
        for _ in range(n):
            kind, yaw, sc, tint = struct.unpack_from("<BBBB", b, p); p += 4
            x, z, y = struct.unpack_from("<hhh", b, p); p += 6
            L.append(dict(kind=kind, yaw=yaw/256*6.283185, scale=0.5+sc/255*1.5,
                          tint=tint, x=x/10, z=z/10, y=y/10))
        out["prop"] = L
    # ONE name table, SHARED by SHOP and SGNS. Reading it once here is also the
    # check that the writer built it once: two sections indexing two tables
    # would still decode, and would decode the wrong strings.
    names = []
    if "NAME" in secs:
        off, ln, n = secs["NAME"]; p = off
        for _ in range(n):
            k = b[p]; p += 1
            names.append(b[p:p+k].decode("utf-8")); p += k
    out["name"] = names
    if "SHOP" in secs:
        off, ln, n = secs["SHOP"]; p = off; L = []
        for _ in range(n):
            cat, flags, yaw, w4 = struct.unpack_from("<BBBB", b, p); p += 4
            x, z, y, h = struct.unpack_from("<hhhh", b, p); p += 8
            ni, = struct.unpack_from("<H", b, p); p += 2
            L.append(dict(cat=cat, flags=flags, yaw=yaw/256*6.283185, w=w4/4.0,
                          x=x/10, z=z/10, y=y/10, h=h/10,
                          name=names[ni] if ni < len(names) else ""))
        out["shop"] = L
    if "SGNS" in secs:
        off, ln, n = secs["SGNS"]; p = off; L = []
        for _ in range(n):
            flags, yaw = struct.unpack_from("<BB", b, p); p += 2
            x, z, y = struct.unpack_from("<hhh", b, p); p += 6
            ni, = struct.unpack_from("<H", b, p); p += 2
            L.append(dict(post=flags & 1, blade=(flags >> 1) & 1,
                          yaw=yaw/256*6.283185, x=x/10, z=z/10, y=y/10,
                          name=names[ni] if ni < len(names) else ""))
        out["sign"] = L
    return out
