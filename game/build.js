// Chunk data -> vertex buffers. Pure functions: numbers in, typed arrays out,
// no three.js and no scene. That is deliberate -- it is the one seam that lets
// the whole builder move into a Worker later without a rewrite, and it is what
// makes the geometry testable in node (tests/build.test.mjs).
//
// Everything is NON-INDEXED and FLAT SHADED. A city of boxes wants hard edges,
// and sharing a vertex between two faces at ninety degrees would smear them;
// the cost is more vertices and the saving is not having to weld anything.
// Colours are Uint8 rather than float: three normalises them for free and it is
// a quarter of the memory on the single biggest attribute after position.

import { BUILDING, BUILDING_DEFAULT, WALL_AO, ROAD, ROAD_DEFAULT, AREA,
         AREA_DEFAULT, HIDE_AREA, TERRAIN, KERB } from './tune.js';

// ---------------------------------------------------------------------------
// a growable soup of triangles
// ---------------------------------------------------------------------------
export class Soup {
  constructor(hint = 4096) {
    this.pos = new Float32Array(hint * 9);
    this.nor = new Float32Array(hint * 9);
    this.col = new Uint8Array(hint * 9);
    // A per-vertex TAG: 255 on a building wall, 0 on everything else. It is one
    // byte and it buys the whole of the window banding in the shader -- gating
    // that on "is this face vertical" instead would band tree trunks, kerbs and
    // bridge parapets, which is how a clever trick becomes a visual bug.
    this.tag = new Uint8Array(hint * 3);
    this.t = 0;                      // tag applied to the next triangle
    this.n = 0;                      // triangles
  }
  _room(tris) {
    if ((this.n + tris) * 9 <= this.pos.length) return;
    let cap = this.pos.length / 9;
    while (cap < this.n + tris) cap = Math.ceil(cap * 1.8) + 64;
    const p = new Float32Array(cap * 9); p.set(this.pos); this.pos = p;
    const q = new Float32Array(cap * 9); q.set(this.nor); this.nor = q;
    const c = new Uint8Array(cap * 9); c.set(this.col); this.col = c;
    const g = new Uint8Array(cap * 3); g.set(this.tag); this.tag = g;
  }
  // One triangle. The normal is derived from the WINDING, never passed in --
  // a normal and a winding that disagree is a face that is lit from inside,
  // and it is the single easiest thing to get wrong here.
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    this._room(1);
    const i = this.n * 9;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    const P = this.pos, N = this.nor, C = this.col;
    P[i] = ax; P[i+1] = ay; P[i+2] = az;
    P[i+3] = bx; P[i+4] = by; P[i+5] = bz;
    P[i+6] = cx; P[i+7] = cy; P[i+8] = cz;
    for (let k = 0; k < 9; k += 3) { N[i+k] = nx; N[i+k+1] = ny; N[i+k+2] = nz; }
    for (let k = 0; k < 9; k += 3) { C[i+k] = r; C[i+k+1] = g; C[i+k+2] = b; }
    if (this.t) { const j = this.n * 3; this.tag[j] = this.tag[j+1] = this.tag[j+2] = this.t; }
    this.n++;
  }
  triC(ax, ay, az, bx, by, bz, cx, cy, cz, ca, cb, cc) {
    // Same, but a colour per corner -- used where a gradient carries the fake AO.
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, ca[0], ca[1], ca[2]);
    const i = (this.n - 1) * 9, C = this.col;
    C[i+3] = cb[0]; C[i+4] = cb[1]; C[i+5] = cb[2];
    C[i+6] = cc[0]; C[i+7] = cc[1]; C[i+8] = cc[2];
  }
  quad(a, b, c, d, ca, cb, cc, cd) {
    this.triC(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2], ca, cb, cc);
    this.triC(a[0],a[1],a[2], c[0],c[1],c[2], d[0],d[1],d[2], ca, cc, cd);
  }
  done() {
    return {
      position: this.pos.subarray(0, this.n * 9),
      normal: this.nor.subarray(0, this.n * 9),
      color: this.col.subarray(0, this.n * 9),
      tag: this.tag.subarray(0, this.n * 3),
      tris: this.n,
    };
  }
}

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/**
 * Shift a colour around the hue wheel and along saturation and lightness.
 *
 * Portland's residential stock is PAINTED, and the variety is most of what
 * makes a street of houses read as a street rather than as one house copied
 * forty times. Jittering brightness alone -- which is what `vary` did on its
 * own -- gives forty houses in one colour at forty exposures, which is the
 * thing it was meant to avoid.
 */
function jitter(c, dh, ds, dl) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, sat = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  h = (h + dh + 1) % 1;
  sat = Math.max(0, Math.min(0.92, sat + ds));
  const L = Math.max(0.05, Math.min(0.96, l + dl));
  const q = L < 0.5 ? L * (1 + sat) : L + sat - L * sat;
  const p = 2 * L - q;
  const hue = (t) => {
    t = (t + 1) % 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [hue(h + 1/3) * 255 | 0, hue(h) * 255 | 0, hue(h - 1/3) * 255 | 0];
}

// Which classes got painted by somebody who had a choice. A warehouse is the
// colour of its cladding; a bungalow is the colour its owner picked.
const PAINTED = new Set(['house', 'detached', 'residential', 'apartments',
                         'outbuilding', 'retail', 'commercial', 'other']);
const mul = (c, k) => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0,
                       Math.min(255, c[2] * k) | 0];

// Deterministic 0..1 from a position. The SAME expression as the baker's
// hash01, so a building's colour is a property of where it stands and not of
// when the chunk happened to load.
export function hash01(x, z) {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// ---------------------------------------------------------------------------
// terrain
// ---------------------------------------------------------------------------
export function buildTerrain(terr, size) {
  const { n, m, h } = terr;
  const cell = size / n;
  const s = new Soup(n * n * 2);
  const flat = rgb(TERRAIN.flat), steep = rgb(TERRAIN.steep), rock = rgb(TERRAIN.rock);
  const colAt = (slope) => {
    if (slope <= TERRAIN.steepAt) {
      const t = slope / TERRAIN.steepAt;
      return [flat[0]+(steep[0]-flat[0])*t|0, flat[1]+(steep[1]-flat[1])*t|0,
              flat[2]+(steep[2]-flat[2])*t|0];
    }
    const t = Math.min(1, (slope - TERRAIN.steepAt) / (TERRAIN.rockAt - TERRAIN.steepAt));
    return [steep[0]+(rock[0]-steep[0])*t|0, steep[1]+(rock[1]-steep[1])*t|0,
            steep[2]+(rock[2]-steep[2])*t|0];
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = i * cell, z0 = j * cell, x1 = x0 + cell, z1 = z0 + cell;
      const h00 = h[j*m+i], h10 = h[j*m+i+1], h01 = h[(j+1)*m+i], h11 = h[(j+1)*m+i+1];
      // Slope from the cell's own diagonals -- cheap, and what the eye reads.
      const dx = (h10 + h11 - h00 - h01) * 0.5 / cell;
      const dz = (h01 + h11 - h00 - h10) * 0.5 / cell;
      const c = colAt(Math.hypot(dx, dz));
      // BOTH TRIANGLES ANTICLOCKWISE FROM ABOVE, which in (x, -z) is a positive
      // signed area. The first version had them the other way round and the
      // entire terrain mesh was back-facing -- so it was CULLED, and invisible,
      // for the whole of the first day of this build. Nothing looked broken:
      // the roads and the land-cover polygons are drawn on top of it and they
      // carried the picture. The tell, missed at the time, was that changing
      // TERRAIN's colours changed nothing on screen.
      s.tri(x0, h00, z0, x1, h11, z1, x1, h10, z0, c[0], c[1], c[2]);
      s.tri(x0, h00, z0, x0, h01, z1, x1, h11, z1, c[0], c[1], c[2]);
    }
  }
  return s.done();
}

// ---------------------------------------------------------------------------
// buildings
// ---------------------------------------------------------------------------
export function buildBuildings(list, classNames, lod) {
  const s = new Soup(Math.max(256, list.length * 24));
  for (const b of list) {
    const look = BUILDING[classNames[b.cls]] || BUILDING_DEFAULT;
    const cname = classNames[b.cls];
    const seed = hash01(b.ring[0] + b.base, b.ring[1] - b.top);
    const seed2 = hash01(b.ring[1] * 3.7 + b.top, b.ring[0] * 1.9 - b.base);
    const k = 1 + (seed - 0.5) * 2 * look.vary;
    let wall = mul(rgb(look.wall), k);
    if (PAINTED.has(cname)) {
      const house = cname === 'house' || cname === 'detached' || cname === 'residential';
      wall = jitter(wall, (seed2 - 0.5) * (house ? 0.9 : 0.3),
                          (seed - 0.40) * (house ? 0.46 : 0.26),
                          (seed2 - 0.5) * (house ? 0.20 : 0.14));
    }
    const roofC = mul(rgb(look.roof), 0.90 + seed2 * 0.22);
    const nv = b.nv, ring = b.ring;
    const base = b.base, top = b.top;
    const footC = mul(wall, 1 - WALL_AO.depth);
    const ao = (y) => {
      const t = Math.min(1, (y - base) / WALL_AO.over);
      return mul(wall, (1 - WALL_AO.depth) + WALL_AO.depth * t);
    };
    const cTop = ao(top);
    // 5 m, not 7: at seven a two-storey house is a BLANK BOX, which is most of
    // the residential half of the city and reads as unfinished. The shader
    // fades the bands out with distance anyway, so the cost of including them
    // is nothing beyond the near view where they are the whole point.
    s.t = (top - base) > 5 ? 255 : 0;
    for (let i = 0; i < nv; i++) {
      const j = (i + 1) % nv;
      const ax = ring[i*2], az = ring[i*2+1], bx = ring[j*2], bz = ring[j*2+1];
      s.quad([ax, base, az], [bx, base, bz], [bx, top, bz], [ax, top, az],
             footC, footC, cTop, cTop);
    }
    s.t = 0;
    if (b.roof && b.roofH > 0.05) {
      // One ridge segment, every eaves edge lofted to its nearest point on it.
      // A ridge collapsed to a point is a pyramid, a ridge spanning the plan is
      // a gable, and a ridge inset from both ends is a hip -- one mechanism.
      const ry = top + b.roofH;
      const r0x = b.ridge[0], r0z = b.ridge[1], r1x = b.ridge[2], r1z = b.ridge[3];
      const dx = r1x - r0x, dz = r1z - r0z;
      const dd = dx * dx + dz * dz;
      const near = (px, pz) => {
        if (dd < 1e-6) return [r0x, r0z];
        let t = ((px - r0x) * dx + (pz - r0z) * dz) / dd;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        return [r0x + dx * t, r0z + dz * t];
      };
      const eave = mul(roofC, 0.88);
      for (let i = 0; i < nv; i++) {
        const j = (i + 1) % nv;
        const ax = ring[i*2], az = ring[i*2+1], bx = ring[j*2], bz = ring[j*2+1];
        const ra = near(ax, az), rb = near(bx, bz);
        if (Math.abs(ra[0]-rb[0]) < 1e-4 && Math.abs(ra[1]-rb[1]) < 1e-4) {
          s.triC(ax, top, az, bx, top, bz, ra[0], ry, ra[1], eave, eave, roofC);
        } else {
          s.quad([ax, top, az], [bx, top, bz], [rb[0], ry, rb[1]], [ra[0], ry, ra[1]],
                 eave, eave, roofC, roofC);
        }
      }
    } else {
      const t = b.tri;
      for (let i = 0; i < t.length; i += 3) {
        const a = t[i]*2, c = t[i+1]*2, d = t[i+2]*2;
        s.tri(ring[a], top, ring[a+1], ring[c], top, ring[c+1], ring[d], top, ring[d+1],
              roofC[0], roofC[1], roofC[2]);
      }
      if (lod !== 'mid') {
        // A parapet. Flat roofs read as open boxes without one, and it is the
        // cheapest thing on this list that makes a downtown block look built.
        const pc = mul(roofC, 1.12), ph = Math.min(0.7, 0.02 * (top - base) + 0.25);
        for (let i = 0; i < nv; i++) {
          const j = (i + 1) % nv;
          const ax = ring[i*2], az = ring[i*2+1], bx = ring[j*2], bz = ring[j*2+1];
          s.quad([ax, top, az], [bx, top, bz], [bx, top+ph, bz], [ax, top+ph, az],
                 cTop, cTop, pc, pc);
        }
      }
    }
  }
  return s.done();
}

// ---------------------------------------------------------------------------
// roads
// ---------------------------------------------------------------------------
export function buildRoads(list, classNames, lod) {
  const s = new Soup(Math.max(256, list.length * 24));
  for (const r of list) {
    const name = classNames[r.cls];
    const look = ROAD[name] || ROAD_DEFAULT;
    if (lod === 'mid' && (name === 'sidewalk' || name === 'footway' ||
                          name === 'path' || name === 'crosswalk' ||
                          name === 'driveway' || name === 'parking_aisle')) continue;
    const c = rgb(look.c);
    const half = r.w * 0.5;
    ribbon(s, r.pts, r.np, half, look.over, c, name, r.flags);
  }
  return s.done();
}

function ribbon(s, pts, np, half, over, c, name, flags) {
  // Mitred quad strip. A per-segment quad is the obvious build and it cracks
  // open at every bend, which on a street grid is every corner.
  const L = [], R = [];
  for (let i = 0; i < np; i++) {
    let dx, dz;
    if (i === 0) { dx = pts[3]-pts[0]; dz = pts[4]-pts[1]; }
    else if (i === np-1) { dx = pts[i*3]-pts[(i-1)*3]; dz = pts[i*3+1]-pts[(i-1)*3+1]; }
    else { dx = pts[(i+1)*3]-pts[(i-1)*3]; dz = pts[(i+1)*3+1]-pts[(i-1)*3+1]; }
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz/len, nz = dx/len;
    // Mitre scale, clamped: a hairpin would otherwise throw the edge kilometres out.
    let k = 1;
    if (i > 0 && i < np-1) {
      const ax = pts[i*3]-pts[(i-1)*3], az = pts[i*3+1]-pts[(i-1)*3+1];
      const bx = pts[(i+1)*3]-pts[i*3], bz = pts[(i+1)*3+1]-pts[i*3+1];
      const la = Math.hypot(ax,az)||1, lb = Math.hypot(bx,bz)||1;
      const cosHalf = Math.sqrt(Math.max(0.04, 0.5*(1 + (ax*bx+az*bz)/(la*lb))));
      // Clamped at 2: a mitre is a spike on a hairpin, and at 2.6 a footpath
      // switchback came out three and a half times its own width -- a blob on
      // every bend. Past this the joint is allowed to open slightly rather than
      // to bulge, which nobody sees and everybody would see the bulge.
      k = Math.min(2.0, 1/cosHalf);
    }
    const x = pts[i*3], z = pts[i*3+1], y = pts[i*3+2] + over;
    L.push([x + nx*half*k, y, z + nz*half*k]);
    R.push([x - nx*half*k, y, z - nz*half*k]);
  }
  // Anticlockwise from above for an upward normal: left edge, then right.
  for (let i = 0; i < np-1; i++) {
    s.quad(L[i], L[i+1], R[i+1], R[i], c, c, c, c);
  }
  // A raised pavement needs a visible edge or it reads as paint on the road.
  const raised = (name === 'sidewalk' || name === 'pedestrian' || name === 'plaza');
  if (raised) {
    const side = mul(c, 0.72), lip = KERB.h;
    for (let i = 0; i < np-1; i++) {
      s.quad([L[i][0], L[i][1]-lip, L[i][2]], [R[i][0], R[i][1]-lip, R[i][2]],
             [R[i+1][0], R[i+1][1]-lip, R[i+1][2]], [L[i+1][0], L[i+1][1]-lip, L[i+1][2]],
             side, side, side, side);
      s.quad([L[i][0], L[i][1]-lip, L[i][2]], [L[i+1][0], L[i+1][1]-lip, L[i+1][2]],
             L[i+1], L[i], side, side, c, c);
      s.quad([R[i+1][0], R[i+1][1]-lip, R[i+1][2]], [R[i][0], R[i][1]-lip, R[i][2]],
             R[i], R[i+1], side, side, c, c);
    }
  }
  // A bridge is not painted on the ground: it needs an underside and a parapet,
  // or from the riverbank it reads as a road floating with nothing holding it.
  if (flags & 1) {
    const deck = 0.55, rail = 0.95, under = mul(c, 0.55), railc = mul(c, 1.25);
    for (let i = 0; i < np-1; i++) {
      s.quad([L[i+1][0], L[i+1][1]-deck, L[i+1][2]], [L[i][0], L[i][1]-deck, L[i][2]],
             [R[i][0], R[i][1]-deck, R[i][2]], [R[i+1][0], R[i+1][1]-deck, R[i+1][2]],
             under, under, under, under);
      s.quad([L[i][0], L[i][1]-deck, L[i][2]], [L[i+1][0], L[i+1][1]-deck, L[i+1][2]],
             L[i+1], L[i], under, under, c, c);
      s.quad([R[i+1][0], R[i+1][1]-deck, R[i+1][2]], [R[i][0], R[i][1]-deck, R[i][2]],
             R[i], R[i+1], under, under, c, c);
      s.quad(L[i], L[i+1], [L[i+1][0], L[i+1][1]+rail, L[i+1][2]],
             [L[i][0], L[i][1]+rail, L[i][2]], railc, railc, railc, railc);
      s.quad([R[i][0], R[i][1]+rail, R[i][2]], [R[i+1][0], R[i+1][1]+rail, R[i+1][2]],
             R[i+1], R[i], railc, railc, railc, railc);
    }
  }
}

// ---------------------------------------------------------------------------
// ground cover
// ---------------------------------------------------------------------------
export function buildAreas(list, classNames, wantWater) {
  const s = new Soup(1024);
  for (const a of list) {
    const name = classNames[a.cls];
    const isWater = name === 'water' || name === 'river' || name === 'pond';
    if (isWater !== !!wantWater) continue;
    if (HIDE_AREA.has(name)) continue;
    const look = AREA[name] || AREA_DEFAULT;
    const c = rgb(look.c);
    const v = a.verts, idx = a.idx;
    for (let i = 0; i < idx.length; i += 3) {
      const p = idx[i]*3, q = idx[i+1]*3, r = idx[i+2]*3;
      s.tri(v[p], v[p+2] + look.y, v[p+1],
            v[q], v[q+2] + look.y, v[q+1],
            v[r], v[r+2] + look.y, v[r+1], c[0], c[1], c[2]);
    }
  }
  return s.done();
}
