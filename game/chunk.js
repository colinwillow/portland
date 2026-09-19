// Reading the baked chunk format. The writer is tools/chunkfmt.py and the two
// are checked against each other by tools/readchunk.py, which reads the same
// bytes in Python -- a format described in two places and verified in neither is
// how a silent off-by-one ships.
//
// Everything is little-endian and NOTHING IS ALIGNED: records pack tight and are
// read through a DataView, which does not care. Lengths are decimetres in an
// int16 (+/-3276.7 m), which covers a 500 m chunk's local coordinates and every
// height in Oregon, at a 10 cm quantisation no walking camera resolves.

const DM = 0.1;

function tag(n) {
  return String.fromCharCode(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
}

export function parseChunk(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x43584450) throw new Error('not a PDXC chunk');
  const nsect = v.getUint16(6, true);
  const sec = {};
  for (let k = 0; k < nsect; k++) {
    const o = 8 + 16 * k;
    sec[tag(v.getUint32(o, true))] = {
      off: v.getUint32(o + 4, true),
      len: v.getUint32(o + 8, true),
      count: v.getUint32(o + 12, true),
    };
  }
  const out = { terr: null, bldg: [], road: [], area: [], prop: null,
                shop: [], sign: [] };
  if (sec.TERR) out.terr = readTerrain(v, sec.TERR);
  if (sec.BLDG) out.bldg = readBuildings(v, sec.BLDG);
  if (sec.ROAD) out.road = readRoads(v, sec.ROAD);
  if (sec.AREA) out.area = readAreas(v, sec.AREA);
  if (sec.PROP) out.prop = readProps(v, sec.PROP);
  // ONE name table, read once, indexed by both. Reading it per section would
  // decode every string twice for a chunk that has shops and blades in it.
  const names = sec.NAME ? readNames(v, sec.NAME) : [];
  if (sec.SHOP) out.shop = readShops(v, sec.SHOP, names);
  if (sec.SGNS) out.sign = readSigns(v, sec.SGNS, names);
  return out;
}

function readTerrain(v, s) {
  const n = s.count, m = n + 1;
  const h = new Float32Array(m * m);
  for (let i = 0; i < m * m; i++) h[i] = v.getInt16(s.off + i * 2, true) * DM;
  return { n, m, h };
}

function readBuildings(v, s) {
  let p = s.off;
  const out = new Array(s.count);
  for (let k = 0; k < s.count; k++) {
    const nv = v.getUint8(p), cls = v.getUint8(p + 1),
          roof = v.getUint8(p + 2), flags = v.getUint8(p + 3);
    p += 4;
    const base = v.getInt16(p, true) * DM, top = v.getInt16(p + 2, true) * DM,
          roofH = v.getInt16(p + 4, true) * DM;
    p += 6;
    const ridge = [v.getInt16(p, true) * DM, v.getInt16(p + 2, true) * DM,
                   v.getInt16(p + 4, true) * DM, v.getInt16(p + 6, true) * DM];
    p += 8;
    const ring = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      ring[i * 2] = v.getInt16(p, true) * DM;
      ring[i * 2 + 1] = v.getInt16(p + 2, true) * DM;
      p += 4;
    }
    const nt = (nv - 2) * 3;
    const tri = new Uint8Array(v.buffer, p, nt).slice();
    p += nt;
    out[k] = { nv, cls, roof, flags, base, top, roofH, ridge, ring, tri };
  }
  return out;
}

function readRoads(v, s) {
  let p = s.off;
  const out = new Array(s.count);
  for (let k = 0; k < s.count; k++) {
    const cls = v.getUint8(p), flags = v.getUint8(p + 1),
          w = v.getUint8(p + 2) * 0.25, np = v.getUint8(p + 3);
    p += 4;
    const pts = new Float32Array(np * 3);
    for (let i = 0; i < np; i++) {
      pts[i * 3] = v.getInt16(p, true) * DM;
      pts[i * 3 + 1] = v.getInt16(p + 2, true) * DM;
      pts[i * 3 + 2] = v.getInt16(p + 4, true) * DM;
      p += 6;
    }
    out[k] = { cls, flags, w, np, pts };
  }
  return out;
}

function readAreas(v, s) {
  let p = s.off;
  const out = new Array(s.count);
  for (let k = 0; k < s.count; k++) {
    const cls = v.getUint8(p), nv = v.getUint16(p + 2, true), nt = v.getUint16(p + 4, true);
    p += 6;
    const verts = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      verts[i * 3] = v.getInt16(p, true) * DM;
      verts[i * 3 + 1] = v.getInt16(p + 2, true) * DM;
      verts[i * 3 + 2] = v.getInt16(p + 4, true) * DM;
      p += 6;
    }
    const idx = new Uint16Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) { idx[i] = v.getUint16(p, true); p += 2; }
    out[k] = { cls, nv, nt, verts, idx };
  }
  return out;
}

function readProps(v, s) {
  const n = s.count;
  const kind = new Uint8Array(n), tint = new Uint8Array(n);
  const yaw = new Float32Array(n), scale = new Float32Array(n);
  const pos = new Float32Array(n * 3);
  let p = s.off;
  for (let i = 0; i < n; i++) {
    kind[i] = v.getUint8(p);
    yaw[i] = v.getUint8(p + 1) / 256 * Math.PI * 2;
    scale[i] = 0.5 + v.getUint8(p + 2) / 255 * 1.5;
    tint[i] = v.getUint8(p + 3);
    pos[i * 3] = v.getInt16(p + 4, true) * DM;
    pos[i * 3 + 1] = v.getInt16(p + 6, true) * DM;
    pos[i * 3 + 2] = v.getInt16(p + 8, true) * DM;
    p += 10;
  }
  return { n, kind, yaw, scale, tint, pos };
}

function readNames(v, ns) {
  const names = [];
  let p = ns.off;
  const dec = new TextDecoder();
  for (let i = 0; i < ns.count; i++) {
    const n = v.getUint8(p); p += 1;
    names.push(dec.decode(new Uint8Array(v.buffer, p, n))); p += n;
  }
  return names;
}

function readSigns(v, s, names) {
  let p = s.off;
  const out = new Array(s.count);
  for (let k = 0; k < s.count; k++) {
    const flags = v.getUint8(p), yaw = v.getUint8(p + 1) / 256 * Math.PI * 2;
    p += 2;
    const x = v.getInt16(p, true) * DM, z = v.getInt16(p + 2, true) * DM,
          y = v.getInt16(p + 4, true) * DM;
    p += 6;
    const ni = v.getUint16(p, true); p += 2;
    out[k] = { post: flags & 1, blade: (flags >> 1) & 1, yaw, x, z, y,
               name: names[ni] || '' };
  }
  return out;
}

function readShops(v, s, names) {
  let p = s.off;
  const out = new Array(s.count);
  for (let k = 0; k < s.count; k++) {
    const cat = v.getUint8(p), flags = v.getUint8(p + 1);
    const yaw = v.getUint8(p + 2) / 256 * Math.PI * 2, w = v.getUint8(p + 3) * 0.25;
    p += 4;
    const x = v.getInt16(p, true) * DM, z = v.getInt16(p + 2, true) * DM;
    const y = v.getInt16(p + 4, true) * DM, h = v.getInt16(p + 6, true) * DM;
    p += 8;
    const ni = v.getUint16(p, true); p += 2;
    out[k] = { cat, flags, yaw, w, x, z, y, h, name: names[ni] || '' };
  }
  return out;
}

export function parseFar(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== 0x46584450) throw new Error('not a PDXF file');
  const n = v.getUint32(4, true);
  const out = { n, x: new Float32Array(n), z: new Float32Array(n),
                base: new Float32Array(n), top: new Float32Array(n),
                rx: new Float32Array(n), rz: new Float32Array(n), cls: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const p = 8 + i * 14;
    out.x[i] = v.getInt16(p, true);
    out.z[i] = v.getInt16(p + 2, true);
    out.base[i] = v.getInt16(p + 4, true);
    out.top[i] = v.getInt16(p + 6, true);
    out.rx[i] = v.getInt16(p + 8, true);
    out.rz[i] = v.getInt16(p + 10, true);
    out.cls[i] = v.getUint8(p + 12);
  }
  return out;
}
