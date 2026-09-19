// People, walking on the pavements that are actually there.
//
// NOT SKINNED CHARACTERS. One rigged GLB is five megabytes, ten thousand
// triangles and a skeleton to update every frame; forty of them on a phone is
// the whole frame budget for something you mostly see from twenty metres. These
// are six boxes each -- sixty triangles -- rebuilt into ONE merged geometry
// every frame, so the entire crowd is one draw call and costs about a
// millisecond of array writes. At twenty metres a person is a silhouette, a
// gait and a colour, and all three of those survive the simplification.
//
// They walk the REAL pavement network: the sidewalk, footway, crossing and path
// centrelines the bake already carries, taken from whichever chunks are loaded.
// A crowd on invented paths walks through walls and across the middle of roads,
// which is the thing that would make it worse than no crowd at all.

import { Soup, hash01 } from './build.js';
import { CROWD } from './tune.js';

const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mul = (c, k) => [Math.min(255, c[0]*k)|0, Math.min(255, c[1]*k)|0, Math.min(255, c[2]*k)|0];

/** The walkable network, rebuilt from whatever chunks are live. */
export class Pavements {
  /** `on` is the set of class names that count as walkable -- or, for the
   *  traffic in ambient.js, drivable. It is the SAME network builder either
   *  way: a road is a road is a chain of centrelines, and having two of these
   *  would be two places for a corner to go wrong. */
  constructor(on = CROWD.on) { this.seg = []; this.node = new Map(); this.on = on; }

  rebuild(live, classNames) {
    const seg = [];
    for (const rec of live) {
      const raw = rec.raw;
      if (!raw || !raw.road) continue;
      for (const r of raw.road) {
        const name = classNames[r.cls];
        if (!this.on.has(name)) continue;
        for (let k = 0; k < r.np - 1; k++) {
          const ax = rec.ox + r.pts[k*3], az = rec.oz + r.pts[k*3+1], ay = r.pts[k*3+2];
          const bx = rec.ox + r.pts[(k+1)*3], bz = rec.oz + r.pts[(k+1)*3+1],
                by = r.pts[(k+1)*3+2];
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 1.2) continue;
          seg.push({ ax, ay, az, bx, by, bz, L, w: Math.max(1.2, r.w) });
        }
      }
    }
    this.seg = seg;
    // Endpoints hashed to a two-metre cell: that is how a walker finds what to
    // step onto next, and it is what keeps them on the pavement round a corner
    // instead of carrying straight on into the road.
    const node = new Map();
    const key = (x, z) => ((x / 2) | 0) + ',' + ((z / 2) | 0);
    for (let i = 0; i < seg.length; i++) {
      for (const [x, z, end] of [[seg[i].ax, seg[i].az, 0], [seg[i].bx, seg[i].bz, 1]]) {
        const k = key(x, z);
        let a = node.get(k);
        if (!a) node.set(k, a = []);
        a.push(i * 2 + end);
      }
    }
    this.node = node;
    this.key = key;
    return seg.length;
  }

  /** Where to go from the end of `si`, or -1 to turn round. */
  next(si, end, roll) {
    const s = this.seg[si];
    const x = end ? s.bx : s.ax, z = end ? s.bz : s.az;
    const a = this.node.get(this.key(x, z));
    if (!a || a.length < 2) return -1;
    const opts = a.filter((v) => (v >> 1) !== si);
    if (!opts.length) return -1;
    return opts[(roll * opts.length) | 0];
  }
}

export class Crowd {
  constructor(scene, THREE) {
    this.pav = new Pavements();
    this.people = [];
    this.soup = null;
    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.THREE = THREE;
    this.netT = 99;
    this.cap = 0;
    // Allocated up front, not on the first frame that has somebody on it: the
    // draw path writes into these unconditionally, and an empty first frame is
    // the common case while the pavement network is still being found.
    this.grow(CROWD.count * 26 * 9);
  }

  grow(need) {
    this.cap = Math.max(need, (this.cap * 1.8) | 0, 4096);
    this.geo.setAttribute('position', new this.THREE.BufferAttribute(new Float32Array(this.cap), 3));
    this.geo.setAttribute('normal', new this.THREE.BufferAttribute(new Float32Array(this.cap), 3));
    this.geo.setAttribute('color', new this.THREE.BufferAttribute(new Uint8Array(this.cap), 3, true));
  }

  /** Deterministic on the index: the same seat in the pool is the same person. */
  spawn(i, seed) {
    const h = (n) => hash01(seed * 7.13 + n * 3.77, seed * 1.91 - n * 2.31);
    const pick = (a, n) => rgb(a[(h(n) * a.length) | 0]);
    const build = h(1);
    // COLOURS ARE UNPACKED ONCE, HERE. Soup takes [r, g, b] and the palettes are
    // hex, and a hex handed to `mul` indexes a number -- which is `undefined`,
    // which a Uint8Array writes as zero. The whole crowd came out black.
    return {
      si: -1, t: 0, dir: 1, side: h(2) < 0.5 ? -1 : 1,
      speed: CROWD.speed[0] + h(3) * (CROWD.speed[1] - CROWD.speed[0]),
      height: 1.56 + build * 0.36,
      wide: 0.86 + h(4) * 0.4,
      skin: pick(CROWD.skin, 5),
      top: pick(CROWD.tops, 6),
      leg: pick(CROWD.legs, 7),
      hair: pick(CROWD.hair, 8),
      hat: h(9) < CROWD.hatOdds ? pick(CROWD.tops, 10) : null,
      bag: h(11) < CROWD.bagOdds ? pick(CROWD.bags, 12) : null,
      // Portland. A tenth of the pavement is carrying an umbrella and a
      // twentieth has a dog, and both are more recognisable than any amount of
      // extra polygon on the person.
      brolly: h(13) < CROWD.brollyOdds ? pick(CROWD.brollies, 14) : null,
      dog: h(15) < CROWD.dogOdds ? pick(CROWD.dogs, 16) : null,
      phase: h(17) * 6.283, seed,
      x: 0, y: 0, z: 0, yaw: 0, live: false,
    };
  }

  step(dt, px, pz, live, classNames) {
    this.netT += dt;
    if (this.netT > CROWD.netEvery) {
      this.netT = 0;
      this.pav.rebuild(live, classNames);
    }
    const segs = this.pav.seg;
    if (!segs.length) { this.geo.setDrawRange(0, 0); return; }

    const want = CROWD.count;
    while (this.people.length < want) this.people.push(this.spawn(this.people.length, this.people.length + 1));
    const keep2 = CROWD.keep * CROWD.keep;

    for (const p of this.people) {
      if (!p.live || p.si < 0 || p.si >= segs.length) { this.place(p, px, pz, segs); continue; }
      const s = segs[p.si];
      p.t += p.speed * p.dir * dt / s.L;
      if (p.t > 1 || p.t < 0) {
        const end = p.t > 1 ? 1 : 0;
        const nx = this.pav.next(p.si, p.dir > 0 ? 1 : 0, hash01(p.seed * 3.1 + p.t, p.x + p.z));
        if (nx < 0) { p.dir = -p.dir; p.t = Math.max(0, Math.min(1, p.t)); }
        else { p.si = nx >> 1; p.dir = (nx & 1) ? -1 : 1; p.t = (nx & 1) ? 1 : 0; }
      }
      const q = segs[p.si];
      const t = Math.max(0, Math.min(1, p.t));
      const ux = (q.bx - q.ax) / q.L, uz = (q.bz - q.az) / q.L;
      // Keep right, a body's width off the centreline, so two walkers meeting
      // pass rather than merge.
      const off = p.side * Math.min(0.55, q.w * 0.22);
      p.x = q.ax + (q.bx - q.ax) * t - uz * off;
      p.z = q.az + (q.bz - q.az) * t + ux * off;
      p.y = q.ay + (q.by - q.ay) * t;
      p.yaw = Math.atan2(ux * p.dir, -uz * p.dir);
      p.phase += p.speed * dt * CROWD.stride / p.height;
      if ((p.x - px) ** 2 + (p.z - pz) ** 2 > keep2) p.live = false;
    }
    this.draw(px, pz);
  }

  /** Put a walker on a segment near the player, if there is one. */
  place(p, px, pz, segs) {
    const roll = hash01(p.seed * 11.3 + performance.now() * 0.001, p.seed * 5.1);
    for (let tries = 0; tries < 8; tries++) {
      const i = ((roll * 7919 + tries * 271) | 0) % segs.length;
      const s = segs[i];
      const d = (s.ax - px) ** 2 + (s.az - pz) ** 2;
      if (d > CROWD.spawn * CROWD.spawn || d < 100) continue;
      p.si = i; p.t = hash01(i, p.seed); p.dir = hash01(p.seed, i) < 0.5 ? -1 : 1;
      p.live = true;
      return;
    }
  }

  draw(px, pz) {
    const s = new Soup(CROWD.count * 26);
    for (const p of this.people) {
      if (!p.live) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d > CROWD.draw) continue;
      figure(s, p, d);
    }
    const g = s.done();
    if (g.tris * 9 > this.cap) this.grow(g.tris * 9);
    const A = this.geo.attributes;
    A.position.array.set(g.position); A.position.needsUpdate = true;
    A.normal.array.set(g.normal); A.normal.needsUpdate = true;
    A.color.array.set(g.color); A.color.needsUpdate = true;
    this.geo.setDrawRange(0, g.tris * 3);
    // The mesh is never frustum culled -- the crowd is always near the player --
    // so give it a bounding sphere rather than letting three recompute one over
    // the whole buffer, tail included, on every frame.
    if (!this.geo.boundingSphere) this.geo.boundingSphere = new this.THREE.Sphere();
    this.geo.boundingSphere.set(new this.THREE.Vector3(0, 0, 0), 1e6);
    this.live = g.tris;
  }
}

/** One person, six boxes and a gait. Exported so it can be measured in node. */
export function figure(s, p, dist) {
  const H = p.height, ca = Math.cos(p.yaw), sa = Math.sin(p.yaw);
  // Local frame: +X is his right, +Z is his back, so forward is -Z.
  const P = (lx, ly, lz) => [p.x + lx*ca - lz*sa, p.y + ly, p.z + lx*sa + lz*ca];
  const swing = Math.sin(p.phase) * CROWD.swing;
  const bob = Math.abs(Math.cos(p.phase)) * H * 0.012;
  // Proportions measured against a real body, not eyeballed: at the first
  // guess the shoulders were 0.23 of his height on each side -- a torso
  // seventy-four centimetres across -- and every walker read as a slab.
  // A 1.7 m person is about 0.40 m across the shoulders and 0.20 m deep.
  const legH = H * 0.46, torsoH = H * 0.31, headH = H * 0.13;
  const shoulder = H * 0.118 * p.wide;

  const limb = (lx, base, len, ang, w, c) => {
    // A limb is a box tilted about its TOP, which is what a leg swinging from
    // the hip does. Tilting about the middle makes everyone moonwalk.
    const dz = Math.sin(ang) * len, dy = Math.cos(ang) * len;
    slab(s, P(lx, base, 0), P(lx, base - dy, -dz), w, c);
  };
  limb(-shoulder * 0.52, legH, legH, swing, H * 0.033 * p.wide, p.leg);
  limb(shoulder * 0.52, legH, legH, -swing, H * 0.033 * p.wide, p.leg);
  box(s, P(0, legH, 0), shoulder, torsoH, H * 0.058 * p.wide, p.yaw, p.top, bob);
  limb(-shoulder - H * 0.024, legH + torsoH - H * 0.03, H * 0.34, -swing * 0.72, H * 0.026, p.top);
  limb(shoulder + H * 0.024, legH + torsoH - H * 0.03, H * 0.34, swing * 0.72, H * 0.026, p.top);
  const headY = legH + torsoH + bob;
  box(s, P(0, headY, 0), H * 0.048, headH, H * 0.046, p.yaw, p.skin, 0);
  if (dist < CROWD.detail) {
    box(s, P(0, headY + headH * 0.60, -0.004), H * 0.052, H * 0.034,
        H * 0.050, p.yaw, p.hat || p.hair, 0);
    if (p.bag) box(s, P(0, legH + torsoH * 0.34, H * 0.068), shoulder * 0.78,
                   torsoH * 0.36, H * 0.032, p.yaw, p.bag, bob);
    if (p.brolly) {
      // A shaft up the outside of the arm and a dome on top. Two boxes, and it
      // is the most Portland thing on the pavement.
      slab(s, P(shoulder * 1.6, legH + torsoH * 0.8, 0),
              P(shoulder * 1.7, H * 1.22, -0.04), H * 0.011, [70, 66, 62]);
      box(s, P(shoulder * 1.7, H * 1.22, -0.04), H * 0.20, H * 0.030, H * 0.20,
          p.yaw, p.brolly, 0);
    }
    if (p.dog) {
      const dx = -shoulder * 2.6, dz = -H * 0.26;
      const dh = H * 0.24, dw = H * 0.058;
      box(s, P(dx, dh * 0.7, dz), dw * 1.5, dh * 0.3, dw, p.yaw, p.dog, 0);
      box(s, P(dx, dh * 0.9, dz - dw * 2.0), dw * 0.9, dw * 0.9, dw * 0.9, p.yaw, p.dog, 0);
      for (const o of [-1, 1]) {
        limb(dx + o * dw * 0.7, dh * 0.7, dh * 0.7, swing * 0.8 * o, dw * 0.35, p.dog);
        limb(dx + o * dw * 0.7, dh * 0.7, dh * 0.7, -swing * 0.8 * o, dw * 0.35, p.dog);
      }
    }
  }
}

/** An axis-aligned box in the walker's own frame, base at `at`. */
function box(s, at, hx, h, hz, yaw, col, lift) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const P = (dx, dy, dz) => [at[0] + dx*ca - dz*sa, at[1] + dy + (lift || 0), at[2] + dx*sa + dz*ca];
  const c = col, dk = mul(col, 0.8), lt = mul(col, 1.06);
  const a=P(-hx,0,-hz), b=P(hx,0,-hz), cc=P(hx,0,hz), d=P(-hx,0,hz);
  const e=P(-hx,h,-hz), f=P(hx,h,-hz), g=P(hx,h,hz), hh=P(-hx,h,hz);
  s.quad(hh,g,f,e, lt,lt,lt,lt);
  s.quad(e,f,b,a, c,c,c,c);
  s.quad(f,g,cc,b, dk,dk,dk,dk);
  s.quad(g,hh,d,cc, c,c,c,c);
  s.quad(hh,e,a,d, dk,dk,dk,dk);
}

/** A limb: a square prism from `a` to `b`. */
function slab(s, a, b, r, col) {
  const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const ux = dx/L, uy = dy/L, uz = dz/L;
  // Any two vectors across the limb will do; a limb is a stick. But a leg at
  // the bottom of its swing is EXACTLY VERTICAL, and the obvious perpendicular
  // (-uz, 0, ux) collapses to zero there -- which makes both basis vectors zero,
  // every face degenerate, and the derived normal 0/0. One NaN vertex turns the
  // geometry's bounding sphere into NaN and three culls the entire crowd.
  let px, py = 0, pz;
  if (Math.abs(ux) + Math.abs(uz) < 1e-5) { px = 1; pz = 0; }
  else { const pl = Math.hypot(uz, ux); px = -uz / pl; pz = ux / pl; }
  const qx = uy*pz - uz*py, qy = uz*px - ux*pz, qz = ux*py - uy*px;
  const V = (t, i, j) => [a[0] + dx*t + px*i*r + qx*j*r,
                          a[1] + dy*t + py*i*r + qy*j*r,
                          a[2] + dz*t + pz*i*r + qz*j*r];
  const c = col, dk = mul(col, 0.78), lt = mul(col, 1.05);
  const A=V(0,-1,-1),B=V(0,1,-1),C=V(0,1,1),D=V(0,-1,1);
  const E=V(1,-1,-1),F=V(1,1,-1),G=V(1,1,1),H=V(1,-1,1);
  s.quad(A,B,F,E, c,c,c,c);
  s.quad(B,C,G,F, dk,dk,dk,dk);
  s.quad(C,D,H,G, lt,lt,lt,lt);
  s.quad(D,A,E,H, dk,dk,dk,dk);
  s.quad(H,G,F,E, lt,lt,lt,lt);
}
