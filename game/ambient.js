// Traffic, boats and aircraft: the things that move without you.
//
// A city where nothing moves but you reads as a photograph you are allowed to
// walk around in. That is the whole job of this file, and the brief on it was
// "I don't want to get super heavy" -- so it is deliberately the cheapest thing
// that does the job: every car, hull, wing and rotor in the world is boxes
// written into ONE merged geometry every frame, which is one draw call and
// about as much work as the crowd. There is no physics, no pathfinding and no
// collision; a vehicle is a silhouette on a line.
//
// THE LINES ARE REAL, AND THAT IS THE PART THAT MATTERS. The cars drive the
// carriageway centrelines the bake already wrote -- the same records the road
// ribbons are drawn from -- so they stay on the road round a corner and stop
// at the end of one. The boats follow a centreline MEASURED down the middle of
// the Willamette at bake time and carried in the manifest. Invented paths are
// what put a car through a shopfront, and a car through a shopfront is worse
// than no traffic at all.

import { Soup, hash01 } from './build.js';
import { Pavements } from './crowd.js';
import { TRAFFIC, BOATS, AIR, CAR_COLORS } from './tune.js';
import { tube } from './props.js';

const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mul = (c, k) => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0,
                       Math.min(255, c[2] * k) | 0];
const lerp = (a, b, t) => a + (b - a) * t;

export class Ambient {
  constructor(scene, THREE, manifest, world) {
    this.THREE = THREE;
    this.world = world;
    this.lanes = new Pavements(TRAFFIC.on);
    this.cars = [];
    this.netT = 99;
    this.water = manifest.world.waterLevel;
    this.river = (manifest.routes && manifest.routes.river) || [];
    // How far apart the route's points are, MEASURED off the route rather than
    // copied from the baker's step. A boat's speed is metres per second and
    // `t` is an index, so getting this from a constant that the bake could
    // change under it is a silent speed error nobody would ever look for.
    this.riverStep = 40;
    if (this.river.length > 2) {
      let sum = 0;
      for (let i = 1; i < this.river.length; i++)
        sum += Math.hypot(this.river[i][0] - this.river[i-1][0],
                          this.river[i][1] - this.river[i-1][1]);
      this.riverStep = sum / (this.river.length - 1);
    }
    this.boats = this.river.length > 5 ? this.makeBoats() : [];
    // The airport is a real place: project it through the same anchor the city
    // is baked against, so the approach points at where PDX actually is rather
    // than at a bearing somebody liked the look of.
    const a = manifest.anchor;
    this.airport = {
      x: (AIR.airport[1] - a.lon) * a.metresPerDegLon,
      z: -(AIR.airport[0] - a.lat) * a.metresPerDegLat,
    };
    this.plane = null;
    this.planeT = AIR.plane.every[0] * 0.35;   // one early, so the sky is not empty
    this.heliA = 0;
    this.t = 0;

    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo,
      new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.cap = 0;
    this.grow(4096 * 9);
  }

  grow(need) {
    this.cap = Math.max(need, (this.cap * 1.8) | 0, 8192);
    const B = this.THREE.BufferAttribute;
    this.geo.setAttribute('position', new B(new Float32Array(this.cap), 3));
    this.geo.setAttribute('normal', new B(new Float32Array(this.cap), 3));
    this.geo.setAttribute('color', new B(new Uint8Array(this.cap), 3, true));
  }

  // -- the fleet ------------------------------------------------------------
  spawnCar(i) {
    const h = (n) => hash01(i * 5.71 + n * 2.13, i * 3.31 - n * 1.77);
    const big = h(1) < TRAFFIC.bigOdds;
    const body = big ? TRAFFIC.bigColors : null;
    return {
      si: -1, t: 0, dir: 1, live: false, seed: i + 1,
      speed: TRAFFIC.speed[0] + h(2) * (TRAFFIC.speed[1] - TRAFFIC.speed[0]),
      big,
      len: big ? TRAFFIC.bigLen : TRAFFIC.len * (0.9 + h(3) * 0.25),
      wide: TRAFFIC.wide * (big ? 1.12 : 0.94 + h(4) * 0.16),
      tall: big ? TRAFFIC.bigTall : TRAFFIC.tall * (0.88 + h(5) * 0.3),
      col: rgb((body || CAR_COLORS)[((body ? h(6) : h(7)) * (body || CAR_COLORS).length) | 0]),
      x: 0, y: 0, z: 0, yaw: 0,
    };
  }

  makeBoats() {
    const out = [];
    for (let i = 0; i < BOATS.count; i++) {
      const h = (n) => hash01(i * 9.17 + n * 1.63, i * 2.51 - n * 4.09);
      const big = h(1);
      out.push({
        // `t` is an index into the river polyline, fractional between points.
        t: h(2) * (this.river.length - 1), dir: h(3) < 0.5 ? -1 : 1,
        speed: lerp(BOATS.speed[0], BOATS.speed[1], 1 - big),  // big boats are slow
        len: lerp(BOATS.len[0], BOATS.len[1], big),
        beam: lerp(BOATS.beam[0], BOATS.beam[1], big),
        side: (h(4) * 2 - 1) * BOATS.lane,
        hull: rgb(BOATS.hull[(h(5) * BOATS.hull.length) | 0]),
        deck: rgb(BOATS.deck[(h(6) * BOATS.deck.length) | 0]),
        big, x: 0, y: 0, z: 0, yaw: 0,
      });
    }
    return out;
  }

  // -- the step -------------------------------------------------------------
  step(dt, px, py, pz, live, classNames) {
    this.t += dt;
    this.netT += dt;
    if (this.netT > 1.4) { this.netT = 0; this.lanes.rebuild(live, classNames); }
    this.stepCars(dt, px, pz);
    this.stepBoats(dt, px, pz);
    this.stepAir(dt, px, pz);
    this.draw(px, py, pz);
  }

  stepCars(dt, px, pz) {
    const segs = this.lanes.seg;
    while (this.cars.length < TRAFFIC.count) this.cars.push(this.spawnCar(this.cars.length));
    if (!segs.length) { for (const c of this.cars) c.live = false; return; }
    const keep2 = TRAFFIC.keep * TRAFFIC.keep;
    for (const c of this.cars) {
      if (!c.live || c.si < 0 || c.si >= segs.length) { this.placeCar(c, px, pz, segs); continue; }
      const s = segs[c.si];
      // A residential street is not a highway. Scaling by the width the bake
      // measured is one number doing what a per-class table would do worse.
      const v = c.speed * (s.w < 8 ? TRAFFIC.slow : 1);
      c.t += v * c.dir * dt / s.L;
      if (c.t > 1 || c.t < 0) {
        const nx = this.lanes.next(c.si, c.dir > 0 ? 1 : 0, hash01(c.seed * 2.7 + c.t, c.x - c.z));
        // A dead end is a car that turns round, which is wrong and is still
        // better than a car that drives into the pavement. It happens at the
        // edge of the loaded chunks, where the network genuinely stops.
        if (nx < 0) { c.dir = -c.dir; c.t = Math.max(0, Math.min(1, c.t)); }
        else { c.si = nx >> 1; c.dir = (nx & 1) ? -1 : 1; c.t = (nx & 1) ? 1 : 0; }
      }
      const q = segs[c.si];
      const t = Math.max(0, Math.min(1, c.t));
      const ux = (q.bx - q.ax) / q.L * c.dir, uz = (q.bz - q.az) / q.L * c.dir;
      // Keep RIGHT of the centreline. The right of a heading (ux, uz) is
      // (-uz, ux) in this basis -- +X east, +Z south -- so this is the side a
      // car drives on in the United States, and the sign is the whole feature.
      const off = Math.min(3.2, q.w * TRAFFIC.lane);
      c.x = q.ax + (q.bx - q.ax) * t - uz * off;
      c.z = q.az + (q.bz - q.az) * t + ux * off;
      c.y = q.ay + (q.by - q.ay) * t;
      c.yaw = Math.atan2(ux, -uz);
      // How far the wheels have turned. A wheel that is drawn round and does
      // not ROTATE is worse than a slab: the eye reads the circle, expects the
      // spin, and the car then reads as sliding. It is one number and it is
      // the actual arc length over the actual radius, so it cannot drift out
      // of step with the speed however that is retuned.
      c.roll = (c.roll || 0) + v * dt / (TRAFFIC.wheelR * c.tall / TRAFFIC.tall);
      if ((c.x - px) ** 2 + (c.z - pz) ** 2 > keep2) c.live = false;
    }
  }

  placeCar(c, px, pz, segs) {
    const roll = hash01(c.seed * 13.7 + this.t, c.seed * 4.3);
    for (let k = 0; k < 10; k++) {
      const i = ((roll * 7919 + k * 331) | 0) % segs.length;
      const s = segs[i];
      const d = (s.ax - px) ** 2 + (s.az - pz) ** 2;
      // Never in front of his face. A car materialising ten metres away is a
      // worse artefact than an empty street.
      if (d > TRAFFIC.spawn * TRAFFIC.spawn || d < 45 * 45) continue;
      if (s.L < 6) continue;
      c.si = i; c.t = hash01(i, c.seed); c.dir = hash01(c.seed, i) < 0.5 ? -1 : 1;
      c.live = true;
      return;
    }
  }

  stepBoats(dt, px, pz) {
    const R = this.river;
    if (R.length < 2) return;
    for (const b of this.boats) {
      // A RIVER IS FIVE KILOMETRES LONG AND HE IS STANDING ON ONE BRIDGE.
      // Five boats seeded once and left there means an empty river most of the
      // time, wherever he happens to be -- so a boat too far away to be seen
      // gives its seat back and is re-seated somewhere he can see it, which is
      // exactly what the crowd and the traffic already do. Never inside the
      // near ring: a barge fading up two hundred metres away is worse than an
      // empty river.
      const far = Math.hypot(b.x - px, b.z - pz);
      if (far > BOATS.draw * 1.2 || (b.x === 0 && b.z === 0)) {
        const seat = this.seatBoat(px, pz);
        if (seat >= 0) { b.t = seat; b.dir = seat > R.length * 0.5 ? -1 : 1; }
      }
      b.t += b.dir * b.speed * dt / this.riverStep;
      if (b.t >= R.length - 1) { b.t = R.length - 1.001; b.dir = -1; }
      if (b.t <= 0) { b.t = 0.001; b.dir = 1; }
      const i = b.t | 0, f = b.t - i;
      const a = R[i], c = R[Math.min(R.length - 1, i + 1)];
      const cx = lerp(a[0], c[0], f), cz = lerp(a[1], c[1], f);
      const hw = lerp(a[2], c[2], f);
      let ux = (c[0] - a[0]), uz = (c[1] - a[1]);
      const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
      ux *= b.dir; uz *= b.dir;
      // Keep right here too: a river has rules of the road and a tug coming
      // straight at a runabout down the middle reads as a mistake.
      const off = b.side * hw;
      b.x = cx - uz * off; b.z = cz + ux * off;
      b.y = this.water;
      b.yaw = Math.atan2(ux, -uz);
    }
  }

  /** An index into the river route that is in view but not in his lap. */
  seatBoat(px, pz) {
    const R = this.river;
    let best = -1, bd = 1e18;
    for (let i = 0; i < R.length; i++) {
      const d = Math.hypot(R[i][0] - px, R[i][1] - pz);
      if (d < 260 || d > BOATS.draw * 0.9) continue;
      // Spread them: prefer a seat far from whatever other boats already hold.
      let near = 1e18;
      for (const o of this.boats) near = Math.min(near, Math.hypot(o.x - R[i][0], o.z - R[i][1]));
      const score = d * 0.4 - Math.min(near, 800);
      if (score < bd) { bd = score; best = i; }
    }
    return best < 0 ? -1 : best + Math.random() * 0.9;
  }

  stepAir(dt, px, pz) {
    const P = AIR.plane;
    this.heliA += AIR.heli.speed / AIR.heli.radius * dt;
    if (this.plane) {
      this.plane.s += P.speed * dt;
      if (this.plane.s > P.span) this.plane = null;
    } else {
      this.planeT -= dt;
      if (this.planeT <= 0) {
        this.planeT = P.every[0] + Math.random() * (P.every[1] - P.every[0]);
        // Aimed at the airport, which is where an arrival is going. It is
        // offset sideways by a few hundred metres so it crosses the sky near
        // him rather than through him, and it starts far enough back that it
        // is already high and small when it appears.
        let hx = this.airport.x - px, hz = this.airport.z - pz;
        const L = Math.hypot(hx, hz) || 1; hx /= L; hz /= L;
        const off = (Math.random() * 2 - 1) * 900;
        const back = P.span * 0.55;
        this.plane = {
          x0: px - hx * back - hz * off, z0: pz - hz * back + hx * off,
          hx, hz, s: 0,
        };
      }
    }
  }

  // -- the picture ----------------------------------------------------------
  draw(px, py, pz) {
    const s = new Soup(1024);
    const draw2 = TRAFFIC.draw * TRAFFIC.draw;
    const hero2 = TRAFFIC.hero * TRAFFIC.hero;
    for (const c of this.cars) {
      if (!c.live) continue;
      const d = (c.x - px) ** 2 + (c.z - pz) ** 2;
      if (d > draw2) continue;
      car(s, c, d < hero2);
    }
    const bd2 = BOATS.draw * BOATS.draw;
    for (const b of this.boats) {
      if ((b.x - px) ** 2 + (b.z - pz) ** 2 > bd2) continue;
      boat(s, b);
    }
    if (this.plane) {
      const P = AIR.plane, p = this.plane, f = p.s / P.span;
      plane(s, p.x0 + p.hx * p.s, lerp(P.y0, P.y1, f), p.z0 + p.hz * p.s,
            Math.atan2(p.hx, -p.hz));
    }
    const H = AIR.heli, sk = (this.world && this.world.skyline) || { x: 0, z: 0 };
    heli(s, sk.x + Math.cos(this.heliA) * H.radius, H.y,
            sk.z + Math.sin(this.heliA) * H.radius,
            // Tangent to the orbit, nose first.
            Math.atan2(-Math.sin(this.heliA), -Math.cos(this.heliA)), this.t);

    const g = s.done();
    if (g.tris * 9 > this.cap) this.grow(g.tris * 9);
    const A = this.geo.attributes;
    A.position.array.set(g.position); A.position.needsUpdate = true;
    A.normal.array.set(g.normal); A.normal.needsUpdate = true;
    A.color.array.set(g.color); A.color.needsUpdate = true;
    this.geo.setDrawRange(0, g.tris * 3);
    if (!this.geo.boundingSphere) this.geo.boundingSphere = new this.THREE.Sphere();
    this.geo.boundingSphere.set(new this.THREE.Vector3(0, 0, 0), 1e6);
    this.live = g.tris;
  }
}

/**
 * A closed box, centred on `at`, yawed about +Y.
 *
 * SIX FACES, unlike the crowd's -- a car is seen from a balcony and a plane is
 * seen from directly underneath, so the bottom is not a face you get to skip.
 * The winding of each is what `Soup.tri` derives its normal from, so a face
 * listed the other way round is lit from inside; every one of these is checked
 * by enclosed volume in tests/runtime.test.mjs (the divergence theorem:
 * the integral of n.x over a closed surface is +3V outward and -3V in).
 */
export function prism(s, at, hx, hy, hz, yaw, col, shade = 1) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const P = (dx, dy, dz) => [at[0] + dx * ca - dz * sa, at[1] + dy, at[2] + dx * sa + dz * ca];
  const c = mul(col, shade), dk = mul(col, shade * 0.78), lt = mul(col, shade * 1.08),
        bt = mul(col, shade * 0.6);
  const a = P(-hx, -hy, -hz), b = P(hx, -hy, -hz), cc = P(hx, -hy, hz), d = P(-hx, -hy, hz);
  const e = P(-hx, hy, -hz), f = P(hx, hy, -hz), g = P(hx, hy, hz), hh = P(-hx, hy, hz);
  s.quad(hh, g, f, e, lt, lt, lt, lt);      // top
  s.quad(a, b, cc, d, bt, bt, bt, bt);      // bottom
  s.quad(e, f, b, a, c, c, c, c);           // -Z, the nose in a local frame
  s.quad(f, g, cc, b, dk, dk, dk, dk);      // +X
  s.quad(g, hh, d, cc, c, c, c, c);         // +Z
  s.quad(hh, e, a, d, dk, dk, dk, dk);      // -X
}

/**
 * A car: wheels, a body, a glasshouse and two lamp patches.
 *
 * The heights are stacked so the WHEELS SHOW UNDER THE BODY. The first version
 * put the body's underside at six centimetres, which buried them -- and a box
 * sitting flat on the road with no gap under it reads as a skip, not a car, at
 * every distance. The glasshouse is DARK rather than body-coloured for the
 * same kind of reason: glass is the one part of a car that is a different
 * value from the paint, and at forty metres that contrast is the whole read.
 */
export function car(s, c, hero) {
  const L = c.len * 0.5, Wd = c.wide * 0.5, H = c.tall;
  const glass = mul([28, 34, 40], 1), ca = Math.cos(c.yaw), sa = Math.sin(c.yaw);
  // Local -Z is the NOSE, matching the yaw convention used everywhere here:
  // a heading h has forward (sin h, -cos h), which is local -Z under `prism`.
  const at = (fwd, up, side = 0) => [c.x + fwd * sa + side * ca, c.y + up,
                                     c.z - fwd * ca + side * sa];
  if (hero) {
    // CLOSE ENOUGH TO SEE THE WHEEL, so it is a wheel: a round tyre on an
    // axle, TURNING, with a hub that shows the turn (a plain black disc spins
    // invisibly -- the spoke is what makes the rotation readable at all).
    const R = TRAFFIC.wheelR * H / TRAFFIC.tall;
    for (const fz of [0.62, -0.62]) {
      const axle = TRAFFIC.axle;
      prism(s, at(fz * L, R, 0), Wd * 0.99, axle, axle, c.yaw, [52, 54, 58]);
      for (const sx of [-1, 1]) {
        const cx = c.x + (fz * L) * sa + (sx * Wd * 0.96) * ca;
        const cz = c.z - (fz * L) * ca + (sx * Wd * 0.96) * sa;
        wheel(s, cx, c.y + R, cz, ca, sa, R, c.roll || 0);
      }
    }
  } else {
    for (const sx of [-1, 1]) for (const fz of [0.62, -0.62])
      prism(s, at(fz * L, H * 0.16, sx * Wd * 0.98), 0.09, H * 0.16, c.len * 0.14,
            c.yaw, [32, 32, 34]);
  }
  prism(s, at(0, H * 0.46), Wd, H * 0.26, L, c.yaw, c.col);
  if (c.big) {
    // A van is one box the whole length, with a screen across the front of it.
    prism(s, at(0, H * 0.70), Wd * 0.97, H * 0.30, L * 0.94, c.yaw, c.col, 0.96);
    prism(s, at(L * 0.9, H * 0.72), Wd * 0.88, H * 0.20, 0.07, c.yaw, glass);
  } else {
    prism(s, at(-L * 0.1, H * 0.80), Wd * 0.86, H * 0.20, L * 0.44, c.yaw, glass);
    prism(s, at(-L * 0.1, H * 0.98), Wd * 0.80, H * 0.03, L * 0.40, c.yaw,
          mul(c.col, 0.94));                                  // the roof panel
  }
  prism(s, at(L * 0.99, H * 0.42), Wd * 0.72, H * 0.09, 0.05, c.yaw, [250, 240, 205]);
  prism(s, at(-L * 0.99, H * 0.42), Wd * 0.72, H * 0.09, 0.05, c.yaw, [170, 42, 34]);
}

/**
 * A rolling wheel: a closed tyre about the car's own lateral axis, plus a
 * spoke bar across the hub.
 *
 * THE SPOKE IS THE WHOLE POINT. A tyre is rotationally symmetric, so a black
 * disc spinning and a black disc standing still are the same picture -- the
 * rotation only exists on screen if something on the wheel is NOT symmetric.
 */
export function wheel(s, x, y, z, ca, sa, r, roll) {
  const ax = ca, az = sa;                         // the car's lateral axis
  const hw = r * 0.34;
  tube(s, x, y, z, ax, 0, az, hw, r, 10, [24, 24, 26]);
  tube(s, x + ax * hw * 0.55, y, z + az * hw * 0.55, ax, 0, az, hw * 0.5, r * 0.52, 8,
       [150, 155, 162]);
  // Two bars across the hub, turning with the wheel. In the wheel's own plane
  // the two axes across the axle are world UP and the car's FORWARD.
  const fx = -az, fz = ax;
  for (const k of [0, 1]) {
    const a = roll + k * Math.PI / 2;
    const ux = fx * Math.cos(a), uy = Math.sin(a), uz = fz * Math.cos(a);
    tube(s, x + ax * hw * 0.8, y, z + az * hw * 0.8, ux, uy, uz, r * 0.86, r * 0.09, 4,
         [92, 96, 102]);
  }
}

/**
 * A closed extrusion of a ring, from y0 to y1, in a yawed local frame.
 *
 * THE RING'S WINDING IS NORMALISED HERE rather than trusted, because it is the
 * single easiest thing in this file to get backwards and a hull wound the
 * wrong way is lit from inside and looks merely "a bit dark" -- which is the
 * worst kind of bug, since nothing on screen disagrees with anything. The rule
 * is the one the whole project uses: anticlockwise SEEN FROM ABOVE, which is a
 * positive signed area in (x, -z).
 */
export function closed(s, P, ring, y0, y1, top, side, bot) {
  let A = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    A += a[0] * -b[1] - b[0] * -a[1];
  }
  const r = A < 0 ? ring.slice().reverse() : ring;
  const T = r.map((p) => P(p[0], y1, p[1]));
  const B = r.map((p) => P(p[0], y0, p[1]));
  for (let i = 1; i < r.length - 1; i++) {
    s.triC(T[0][0], T[0][1], T[0][2], T[i][0], T[i][1], T[i][2],
           T[i+1][0], T[i+1][1], T[i+1][2], top, top, top);
    s.triC(B[0][0], B[0][1], B[0][2], B[i+1][0], B[i+1][1], B[i+1][2],
           B[i][0], B[i][1], B[i][2], bot, bot, bot);
  }
  for (let i = 0; i < r.length; i++) {
    const j = (i + 1) % r.length;
    s.quad(T[i], B[i], B[j], T[j], side, side, side, side);
  }
}

/**
 * A boat: a hull that comes to a point, a deckhouse, and a wake.
 *
 * The taper at the bow is most of what says BOAT rather than shipping
 * container, and it is the only reason the hull is a ring rather than a
 * prism. Everything above the waterline is boxes.
 */
export function boat(s, b) {
  const L = b.len * 0.5, Wd = b.beam * 0.5;
  const ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
  const P = (dx, dy, dz) => [b.x + dx * ca - dz * sa, b.y + dy, b.z + dx * sa + dz * ca];
  const free = Math.max(0.5, b.beam * 0.34);       // freeboard
  // Local -Z is the bow, the same convention every yaw in this file uses.
  closed(s, P, [[0, -L], [Wd, L * 0.62], [Wd * 0.84, L], [-Wd * 0.84, L], [-Wd, L * 0.62]],
         -free * 0.5, free, mul(b.hull, 1.05), mul(b.hull, 0.8), mul(b.hull, 0.6));
  const dh = Math.max(0.9, b.beam * 0.6);
  prism(s, P(0, free + dh * 0.5, L * 0.2), Wd * 0.6, dh * 0.5, L * 0.3, b.yaw, b.deck);
  if (b.big) {
    // A wheelhouse and a mast. A tug is recognisable at four hundred metres
    // entirely by having something standing up in the middle of it.
    prism(s, P(0, free + dh * 1.24, L * 0.2), Wd * 0.32, dh * 0.26, L * 0.13, b.yaw,
          mul(b.deck, 0.9));
    prism(s, P(0, free + dh * 1.95, L * 0.12), 0.10, dh * 0.5, 0.10, b.yaw, [180, 176, 168]);
  }
  // The wake: a flat pale triangle off the stern, on the water. It is the one
  // thing that separates a boat that is MOVING from a boat that is moored, and
  // it costs one triangle. Wound so its face is UP -- (x, -z) positive.
  const wl = b.len * (1.4 + b.speed * 0.22), ww = b.beam * 0.9;
  const w0 = P(0, 0.06, L * 0.9), w1 = P(-ww, 0.06, L * 0.9 + wl),
        w2 = P(ww, 0.06, L * 0.9 + wl);
  const wc = rgb(BOATS.wake);
  s.triC(w0[0], w0[1], w0[2], w1[0], w1[1], w1[2], w2[0], w2[1], w2[2], wc, wc, wc);
}

/**
 * An airliner on the approach: a tube, a wing, a tailplane and a fin.
 *
 * Wing DIHEDRAL is deliberate and is not detail. A flat plank wing on a box
 * fuselage reads as a paper dart; two degrees of lift at the tips is the whole
 * difference, and it costs nothing because the wing is one prism either side.
 */
export function plane(s, x, y, z, yaw) {
  const P = AIR.plane, L = P.len * 0.5, r = P.len * 0.055;
  const body = rgb(P.body), tail = rgb(P.tail);
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const at = (dx, dy, dz) => [x + dx * ca - dz * sa, y + dy, z + dx * sa + dz * ca];
  prism(s, at(0, 0, 0), r, r, L, yaw, body);
  prism(s, at(0, -r * 0.2, -L * 0.86), r * 0.62, r * 0.62, L * 0.16, yaw, body, 0.94);
  for (const sx of [-1, 1]) {
    const half = P.wing * 0.5;
    prism(s, at(sx * half * 0.5, r * 0.1, L * 0.06), half * 0.5, r * 0.16, L * 0.2, yaw, body, 0.9);
    prism(s, at(sx * half * 0.55, -r * 0.5, L * 0.06), r * 0.5, r * 0.42, L * 0.14, yaw,
          [96, 100, 106]);                                  // engine
    prism(s, at(sx * L * 0.26, r * 0.5, L * 0.86), L * 0.26, r * 0.12, L * 0.1, yaw, body, 0.9);
  }
  prism(s, at(0, r * 1.5, L * 0.88), r * 0.14, r * 1.5, L * 0.12, yaw, tail);
}

/**
 * A helicopter, with skids and a rotor disc that is actually turning.
 *
 * THE SKIDS ARE NOT DETAIL. At three hundred metres this is a silhouette, and
 * a fuselage with a boom on it reads as a lump with a stick; a fuselage with
 * two rails under it reads as a helicopter before you have looked at the
 * rotor. They are two thin prisms and they are the cheapest legibility in
 * this file.
 */
export function heli(s, x, y, z, yaw, t) {
  const H = AIR.heli, L = H.len * 0.5;
  const body = rgb(H.body), rot = rgb(H.rotor), glass = [26, 32, 38];
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const at = (dx, dy, dz) => [x + dx * ca - dz * sa, y + dy, z + dx * sa + dz * ca];
  // Local -Z is the nose, as everywhere else here.
  prism(s, at(0, 0, -L * 0.34), L * 0.22, L * 0.24, L * 0.40, yaw, body);
  prism(s, at(0, -L * 0.04, -L * 0.80), L * 0.17, L * 0.17, L * 0.18, yaw, glass);
  prism(s, at(0, L * 0.08, L * 0.42), L * 0.06, L * 0.06, L * 0.48, yaw, body, 0.94);
  prism(s, at(0, L * 0.28, L * 0.86), L * 0.035, L * 0.20, L * 0.09, yaw, body, 0.88);
  for (const sx of [-1, 1]) {
    prism(s, at(sx * L * 0.18, -L * 0.30, -L * 0.34), L * 0.03, L * 0.03, L * 0.44,
          yaw, rot, 0.75);                                     // skid
    prism(s, at(sx * L * 0.13, -L * 0.16, -L * 0.34), L * 0.02, L * 0.14, L * 0.02,
          yaw, rot, 0.75);                                     // its leg
  }
  prism(s, at(0, L * 0.30, -L * 0.34), L * 0.05, L * 0.08, L * 0.05, yaw, rot, 0.9);
  const spin = t * H.rpm;
  // Two prisms crossed give four arms, which at any distance this is seen from
  // reads as a rotor turning -- the eye takes the ROTATION, not the blade
  // count. A disc would have to be transparent to read, and transparency here
  // is a second material and a second draw call for the whole ambient layer.
  for (const k of [0, 1]) {
    const a = spin + k * Math.PI * 0.5;
    prism(s, at(0, L * 0.40, -L * 0.34), L * 1.05, L * 0.010, L * 0.09, yaw + a, rot, 1.0);
  }
  prism(s, at(0, L * 0.28, L * 0.86), L * 0.02, L * 0.26, L * 0.02, yaw + spin * 1.6, rot, 1.0);
}
