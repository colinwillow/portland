// Where the ground is, and what you cannot walk through.
//
// THE GROUND IS NOT A HEIGHTMAP, and that is the whole reason this file is more
// than ten lines. A heightmap has one answer per (x, z), and the Willamette
// bridges need two: the deck you are standing on and the water forty feet under
// it. So `groundAt` takes a HINT -- roughly where the body already is -- and
// returns the highest surface at or below it: terrain by default, a bridge deck
// when you are on one, terrain again the moment you step off. That one argument
// is the difference between a city you walk across and a city you walk over.
//
// The terrain sample is a bilinear lookup of the same grid the terrain MESH is
// built from, at the same 10 m spacing. Sampling a finer source here and a
// coarser one for the mesh is the obvious shortcut and it puts his feet a metre
// under the visible hillside.

import { MOVE } from './tune.js';

const BUCKET = 16;      // metres per spatial-hash cell

export class Ground {
  constructor(manifest) {
    const w = manifest.world;
    this.west = w.west; this.north = w.north;
    this.chunk = w.chunk; this.n = w.n;
    this.cell = w.terrainCell;
    this.waterLevel = w.waterLevel;
    this.terr = new Map();          // "i,j" -> {m, h, x0, z0}
    this.solids = new Map();        // bucket -> [building]
    this.decks = new Map();         // bucket -> [deck triangle]
    this.chunkBuckets = new Map();  // "i,j" -> [bucket keys] for teardown
  }

  key(x, z) { return ((x / BUCKET) | 0) + ',' + ((z / BUCKET) | 0); }

  addChunk(i, j, c, classNames) {
    const x0 = this.west + i * this.chunk, z0 = this.north + j * this.chunk;
    const id = i + ',' + j;
    if (c.terr) this.terr.set(id, { m: c.terr.m, h: c.terr.h, x0, z0 });
    const touched = new Set();
    // Every record is stamped with the chunk that made it: a bucket straddles
    // a chunk boundary and holds its neighbour's buildings too, so teardown has
    // to filter rather than drop, and it needs to know whose is whose.
    const push = (map, k, v) => {
      v._c = id;
      let a = map.get(k); if (!a) map.set(k, a = []);
      a.push(v); touched.add((map === this.solids ? 's' : 'd') + k);
    };

    for (const b of c.bldg) {
      const ring = new Float32Array(b.nv * 2);
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      for (let k = 0; k < b.nv; k++) {
        const x = b.ring[k*2] + x0, z = b.ring[k*2+1] + z0;
        ring[k*2] = x; ring[k*2+1] = z;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      }
      const rec = { ring, nv: b.nv, base: b.base, top: b.top, minx, maxx, minz, maxz, _c: id };
      for (let bx = (minx/BUCKET)|0; bx <= (maxx/BUCKET)|0; bx++)
        for (let bz = (minz/BUCKET)|0; bz <= (maxz/BUCKET)|0; bz++)
          push(this.solids, bx + ',' + bz, rec);
    }

    for (const r of c.road) {
      if (!(r.flags & 1)) continue;        // only bridges make a second surface
      addDeck(this, r, x0, z0, push);
    }
    this.chunkBuckets.set(id, [...touched]);
  }

  removeChunk(i, j) {
    const id = i + ',' + j;
    this.terr.delete(id);
    const keys = this.chunkBuckets.get(id);
    if (!keys) return;
    // Rebuild only the buckets this chunk touched. A bucket can hold records
    // from a neighbour, so it is filtered rather than dropped.
    for (const k of keys) {
      const map = k[0] === 's' ? this.solids : this.decks;
      const bk = k.slice(1);
      const a = map.get(bk);
      if (!a) continue;
      const kept = a.filter((rec) => rec._c !== id);
      if (kept.length) map.set(bk, kept); else map.delete(bk);
    }
    this.chunkBuckets.delete(id);
  }

  terrainAt(x, z) {
    const ci = Math.floor((x - this.west) / this.chunk);
    const cj = Math.floor((z - this.north) / this.chunk);
    const t = this.terr.get(ci + ',' + cj);
    if (!t) return 0;
    let u = (x - t.x0) / this.cell, v = (z - t.z0) / this.cell;
    const lim = t.m - 1.0001;
    u = u < 0 ? 0 : u > lim ? lim : u;
    v = v < 0 ? 0 : v > lim ? lim : v;
    const i = u | 0, j = v | 0, fu = u - i, fv = v - j, m = t.m, h = t.h;
    const a = h[j*m+i], b = h[j*m+i+1], c = h[(j+1)*m+i], d = h[(j+1)*m+i+1];
    return (a*(1-fu) + b*fu)*(1-fv) + (c*(1-fu) + d*fu)*fv;
  }

  /** Highest walkable surface at or a step above `hint`. */
  groundAt(x, z, hint) {
    let best = this.terrainAt(x, z);
    const list = this.decks.get(this.key(x, z));
    if (list) {
      const ceil = hint + MOVE.step;
      for (const t of list) {
        const y = triY(x, z, t);
        if (y !== null && y <= ceil && y > best) best = y;
      }
    }
    return best;
  }

  /** Is there deck overhead? Used to keep the camera from popping through one. */
  ceilingAt(x, z, from) {
    let best = Infinity;
    const list = this.decks.get(this.key(x, z));
    if (list) for (const t of list) {
      const y = triY(x, z, t);
      if (y !== null && y > from + 0.4 && y < best) best = y;
    }
    return best;
  }

  inWater(x, z) {
    return this.terrainAt(x, z) < this.waterLevel - 0.35;
  }

  /**
   * Push a circle out of any building it is inside.
   *
   * Resolved along the SHALLOWEST edge rather than along the vector to the
   * nearest point: pushing toward the nearest point flicks you diagonally
   * around a corner, where pushing out of the nearest EDGE slides you along the
   * wall. Big Don's collider learnt this and it is the same argument here.
   */
  resolve(x, z, y, r) {
    let hit = false;
    const bx = (x / BUCKET) | 0, bz = (z / BUCKET) | 0;
    for (let i = bx - 1; i <= bx + 1; i++) {
      for (let j = bz - 1; j <= bz + 1; j++) {
        const list = this.solids.get(i + ',' + j);
        if (!list) continue;
        for (const b of list) {
          if (y > b.top - 0.15 || y + MOVE.eye < b.base) continue;
          if (x < b.minx - r || x > b.maxx + r || z < b.minz - r || z > b.maxz + r) continue;
          const push = pushOut(x, z, r, b);
          if (push) { x += push[0]; z += push[1]; hit = true; }
        }
      }
    }
    return [x, z, hit];
  }
}

function addDeck(g, r, x0, z0, push) {
  const half = r.w * 0.5 + 0.35;
  const L = [], R = [];
  for (let i = 0; i < r.np; i++) {
    let dx, dz;
    if (i === 0) { dx = r.pts[3]-r.pts[0]; dz = r.pts[4]-r.pts[1]; }
    else if (i === r.np-1) { dx = r.pts[i*3]-r.pts[(i-1)*3]; dz = r.pts[i*3+1]-r.pts[(i-1)*3+1]; }
    else { dx = r.pts[(i+1)*3]-r.pts[(i-1)*3]; dz = r.pts[(i+1)*3+1]-r.pts[(i-1)*3+1]; }
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz/len*half, nz = dx/len*half;
    const x = r.pts[i*3] + x0, z = r.pts[i*3+1] + z0, y = r.pts[i*3+2];
    L.push([x+nx, y, z+nz]); R.push([x-nx, y, z-nz]);
  }
  for (let i = 0; i < r.np-1; i++) {
    for (const t of [[L[i], L[i+1], R[i+1]], [L[i], R[i+1], R[i]]]) {
      const rec = { ax: t[0][0], az: t[0][2], ay: t[0][1],
                    bx: t[1][0], bz: t[1][2], by: t[1][1],
                    cx: t[2][0], cz: t[2][2], cy: t[2][1] };
      const minx = Math.min(rec.ax, rec.bx, rec.cx), maxx = Math.max(rec.ax, rec.bx, rec.cx);
      const minz = Math.min(rec.az, rec.bz, rec.cz), maxz = Math.max(rec.az, rec.bz, rec.cz);
      for (let bx = (minx/BUCKET)|0; bx <= (maxx/BUCKET)|0; bx++)
        for (let bz = (minz/BUCKET)|0; bz <= (maxz/BUCKET)|0; bz++)
          push(g.decks, bx + ',' + bz, rec);
    }
  }
}

function triY(x, z, t) {
  const v0x = t.bx - t.ax, v0z = t.bz - t.az;
  const v1x = t.cx - t.ax, v1z = t.cz - t.az;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-9) return null;
  const px = x - t.ax, pz = z - t.az;
  const u = (px * v1z - v1x * pz) / den;
  const v = (v0x * pz - px * v0z) / den;
  if (u < -0.001 || v < -0.001 || u + v > 1.001) return null;
  return t.ay + (t.by - t.ay) * u + (t.cy - t.ay) * v;
}

function pushOut(x, z, r, b) {
  // Nearest point on each edge; if none is within r and the centre is outside,
  // there is no contact. Inside, the shallowest edge is the way out.
  let inside = false;
  let bestD = Infinity, bnx = 0, bnz = 0;
  const ring = b.ring, nv = b.nv;
  for (let i = 0, j = nv - 1; i < nv; j = i++) {
    const xi = ring[i*2], zi = ring[i*2+1], xj = ring[j*2], zj = ring[j*2+1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    const ex = xj - xi, ez = zj - zi;
    const L2 = ex*ex + ez*ez || 1;
    let t = ((x - xi) * ex + (z - zi) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = xi + ex*t, qz = zi + ez*t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < bestD) { bestD = d; bnx = x - qx; bnz = z - qz; }
  }
  if (!inside && bestD >= r) return null;
  const L = Math.hypot(bnx, bnz) || 1;
  const depth = inside ? bestD + r : r - bestD;
  const sx = inside ? -bnx / L : bnx / L;
  const sz = inside ? -bnz / L : bnz / L;
  return [sx * depth, sz * depth];
}
