// Street furniture, built as merged low-poly geometry rather than instanced.
//
// Instancing is the reflex answer and it is the wrong one HERE: there are
// twenty-two kinds, and one InstancedMesh per kind per chunk is twenty-two
// draw calls for a few hundred triangles each. Merged, a whole chunk's
// furniture -- six hundred objects -- is ONE call. The trade is that a prop
// cannot move, and none of these do.
//
// Every prop is built to be read at twenty metres from a phone. A tree is
// fourteen triangles because at that distance the silhouette is the whole of
// what you see, and a thousand-triangle tree is nine hundred and eighty-six
// triangles of nothing.

import { Soup } from './build.js';
import { PROP, PROP_DEFAULT, LEAF_TINTS, CAR_COLORS } from './tune.js';

const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mul = (c, k) => [Math.min(255, c[0]*k)|0, Math.min(255, c[1]*k)|0, Math.min(255, c[2]*k)|0];

// EVERY FACE IN HERE IS WOUND SO ITS DERIVED NORMAL POINTS OUT OF THE SOLID,
// and all three primitives below had it backwards in the first build. Nothing
// LOOKED broken: a back-faced post is culled on the near side and you see its
// far side instead, which for a thin cylinder is the same silhouette -- so what
// it actually costs is the LIGHTING, every lamp post and tree trunk and parked
// car in the city lit from the inside. `Soup.tri` derives the normal from the
// winding precisely so there is one thing to get right; getting it right needs
// a test that cannot be satisfied by a plausible picture, which is why
// tests/runtime.test.mjs measures the enclosed VOLUME (the divergence
// theorem: a closed surface with outward normals integrates to +3V, and an
// inside-out one to -3V). A count or a bounding box cannot see it at all.
function box(s, x, y, z, hx, hy, hz, yaw, c) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const P = (dx, dy, dz) => [x + dx*ca - dz*sa, y + dy, z + dx*sa + dz*ca];
  const a=P(-hx,0,-hz), b=P(hx,0,-hz), cc=P(hx,0,hz), d=P(-hx,0,hz);
  const e=P(-hx,hy*2,-hz), f=P(hx,hy*2,-hz), g=P(hx,hy*2,hz), h=P(-hx,hy*2,hz);
  const dk = mul(c, 0.84), lt = mul(c, 1.03);
  s.quad(h,g,f,e, lt,lt,lt,lt);                    // top
  s.quad(e,f,b,a, c,c,c,c);                        // -z
  s.quad(f,g,cc,b, dk,dk,dk,dk);                   // +x
  s.quad(g,h,d,cc, c,c,c,c);                       // +z
  s.quad(h,e,a,d, dk,dk,dk,dk);                    // -x
}

function cylinder(s, x, y, z, r, h, sides, c) {
  const dk = mul(c, 0.8);
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const x0 = x + Math.cos(a0)*r, z0 = z + Math.sin(a0)*r;
    const x1 = x + Math.cos(a1)*r, z1 = z + Math.sin(a1)*r;
    const shade = 0.78 + 0.32 * (0.5 + 0.5*Math.cos(a0 - 0.9));
    const cs = mul(c, shade);
    s.quad([x1,y,z1], [x0,y,z0], [x0,y+h,z0], [x1,y+h,z1], cs, cs, cs, cs);
  }
}

function cone(s, x, y, z, r, h, sides, c) {
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const shade = 0.72 + 0.4 * (0.5 + 0.5*Math.cos(a0 - 0.9));
    const cs = mul(c, shade);
    s.tri(x + Math.cos(a1)*r, y, z + Math.sin(a1)*r,
          x + Math.cos(a0)*r, y, z + Math.sin(a0)*r,
          x, y + h, z, cs[0], cs[1], cs[2]);
  }
}

// A CROWN IS SEEN FROM UNDERNEATH, and that is the whole design constraint.
// The eye is at 1.7 m and the canopy starts at five: what you look at all day
// is the UNDERSIDE. A squashed octahedron -- the obvious cheap blob -- has a
// point down there, so from the pavement every street tree read as a cone
// hanging nose-down, which is exactly what the first build looked like. The
// bottom is nearly FLAT now and the silhouette is carried by two irregular
// rings instead: twenty triangles, and it reads as a tree from below, from
// across the street and from a roof.
function blob(s, x, y, z, rx, ry, c, seed) {
  const top = [x, y + ry, z];
  const bot = [x, y - ry * 0.18, z];
  const N = 5;
  const lo = [], hi = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2 + seed * 3.1;
    // Irregular radii, deterministic on the seed: a crown that is a perfect
    // pentagon reads as a prop, and a street of them reads as wallpaper.
    const j = 0.78 + 0.44 * ((Math.sin(a * 3 + seed * 11) + 1) * 0.5);
    lo.push([x + Math.cos(a) * rx * j * 0.82, y - ry * 0.06, z + Math.sin(a) * rx * j * 0.82]);
    hi.push([x + Math.cos(a + 0.35) * rx * j, y + ry * 0.42, z + Math.sin(a + 0.35) * rx * j]);
  }
  const shade = (i) => 0.72 + 0.42 * (0.5 + 0.5 * Math.cos(i / N * 6.283 - 0.9));
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const m = mul(c, shade(i));
    // Angle INCREASES with i, and in (x, -z) -- the frame "seen from above" --
    // that runs CLOCKWISE, so the ring has to be walked backwards for an
    // outward normal. triC takes FLAT coordinates and quad() takes points;
    // passing arrays to triC is a silent `undefined[0]` five frames into boot.
    s.quad(lo[j], lo[i], hi[i], hi[j], mul(m, 0.8), mul(m, 0.8), m, m);
    s.triC(hi[j][0], hi[j][1], hi[j][2], hi[i][0], hi[i][1], hi[i][2],
           top[0], top[1], top[2], m, m, mul(c, 1.2));
    s.triC(lo[i][0], lo[i][1], lo[i][2], lo[j][0], lo[j][1], lo[j][2],
           bot[0], bot[1], bot[2], mul(c, 0.52), mul(c, 0.52), mul(c, 0.46));
  }
}

/** A closed disc fan, so a wheel seen end-on is a wheel and not a hole. */
function disc(s, cx, cy, cz, ax, ay, az, r, sides, c, out) {
  // Any two vectors across the axis will do; a wheel is a stick. The obvious
  // perpendicular collapses when the axis is vertical, which is the same trap
  // the crowd's limbs hit -- one NaN vertex turns a bounding sphere into NaN
  // and three culls the whole mesh.
  let px, py = 0, pz;
  if (Math.abs(ax) + Math.abs(az) < 1e-5) { px = 1; pz = 0; }
  else { const L = Math.hypot(ax, az); px = -az / L; pz = ax / L; }
  const qx = ay*pz - az*py, qy = az*px - ax*pz, qz = ax*py - ay*px;
  const V = (a) => [cx + (px*Math.cos(a) + qx*Math.sin(a)) * r,
                    cy + (py*Math.cos(a) + qy*Math.sin(a)) * r,
                    cz + (pz*Math.cos(a) + qz*Math.sin(a)) * r];
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const A = V(a0), B = V(a1);
    if (out) s.triC(cx, cy, cz, A[0], A[1], A[2], B[0], B[1], B[2], c, c, c);
    else s.triC(cx, cy, cz, B[0], B[1], B[2], A[0], A[1], A[2], c, c, c);
  }
}

/** A closed cylinder about an arbitrary axis: a wheel, an axle, a bollard. */
export function tube(s, cx, cy, cz, ax, ay, az, half, r, sides, c) {
  const L = Math.hypot(ax, ay, az) || 1;
  ax /= L; ay /= L; az /= L;
  let px, py = 0, pz;
  if (Math.abs(ax) + Math.abs(az) < 1e-5) { px = 1; pz = 0; }
  else { const l = Math.hypot(ax, az); px = -az / l; pz = ax / l; }
  const qx = ay*pz - az*py, qy = az*px - ax*pz, qz = ax*py - ay*px;
  const V = (a, t) => [cx + ax*half*t + (px*Math.cos(a) + qx*Math.sin(a)) * r,
                       cy + ay*half*t + (py*Math.cos(a) + qy*Math.sin(a)) * r,
                       cz + az*half*t + (pz*Math.cos(a) + qz*Math.sin(a)) * r];
  for (let i = 0; i < sides; i++) {
    const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
    const sh = mul(c, 0.74 + 0.38 * (0.5 + 0.5 * Math.cos(a0 - 0.9)));
    s.quad(V(a0, 1), V(a1, 1), V(a1, -1), V(a0, -1), sh, sh, sh, sh);
  }
  disc(s, cx + ax*half, cy + ay*half, cz + az*half, ax, ay, az, r, sides, mul(c, 1.05), true);
  disc(s, cx - ax*half, cy - ay*half, cz - az*half, ax, ay, az, r, sides, mul(c, 0.72), false);
}

/**
 * One prop. Extracted from the loop so the HERO pass can rebuild exactly one
 * of them, at a different level, into a different buffer -- which is what
 * makes per-prop LOD possible at all in a city whose furniture is merged.
 *
 * `level` is 0 mid, 1 full, 2 hero. It is a number and not a string because it
 * is compared, not switched on: hero is full plus more, never instead of.
 */
export function oneProp(s, name, look, x, y, z, sc, yaw, tint, level) {
  const near = level >= 1, hero = level >= 2;
  const c = rgb(look.c);
  const h = look.h * sc;
  switch (look.kind) {
      case 'broadleaf': {
        // Trunk to just under the crown, crown OVERLAPPING it. A crown that
        // starts where the trunk stops leaves a visible gap of daylight, and a
        // street tree read from six metres is mostly that join.
        const leaf = rgb(LEAF_TINTS[tint % LEAF_TINTS.length]);
        if (!hero) {
          cylinder(s, x, y, z, 0.13 * sc, h * 0.52, 5, rgb(look.trunk));
          blob(s, x, y + h * 0.72, z, h * 0.29, h * 0.30, leaf, yaw);
          break;
        }
        // HERO. Standing under it, the two things that give a fourteen-triangle
        // tree away are the trunk's pentagon and the crown's single mass. So:
        // an eight-sided trunk that TAPERS, three boughs going up and out of
        // it, and three overlapping crown blobs at different sizes and tints.
        // Still under a hundred and forty triangles, and only ever a handful of
        // trees are in the set at once.
        const bark = rgb(look.trunk);
        tube(s, x, y + h * 0.27, z, 0, 1, 0, h * 0.27, 0.15 * sc, 8, bark);
        tube(s, x, y + h * 0.62, z, 0, 1, 0, h * 0.10, 0.105 * sc, 7, mul(bark, 1.04));
        for (let b = 0; b < 3; b++) {
          const a = yaw + b * 2.094, lean = 0.42;
          tube(s, x + Math.cos(a) * h * 0.11, y + h * 0.60, z + Math.sin(a) * h * 0.11,
               Math.cos(a) * lean, 1, Math.sin(a) * lean, h * 0.12, 0.055 * sc, 5,
               mul(bark, 0.92));
        }
        blob(s, x, y + h * 0.74, z, h * 0.30, h * 0.30, leaf, yaw);
        blob(s, x + Math.cos(yaw + 1.9) * h * 0.13, y + h * 0.63,
             z + Math.sin(yaw + 1.9) * h * 0.13, h * 0.20, h * 0.19,
             mul(leaf, 0.86), yaw + 1.1);
        blob(s, x + Math.cos(yaw - 1.2) * h * 0.12, y + h * 0.86,
             z + Math.sin(yaw - 1.2) * h * 0.12, h * 0.17, h * 0.16,
             mul(leaf, 1.12), yaw + 2.4);
        break;
      }
      case 'conifer': {
        // A Douglas fir is TALL AND NARROW -- a quarter of its height in radius
        // is a Christmas tree, and a street of them reads as a garden centre.
        // Three stacked cones, each narrower and shorter than the one below.
        const leaf = rgb(look.c);
        if (!hero) {
          cylinder(s, x, y, z, 0.11 * sc, h * 0.26, 5, rgb(look.trunk));
          cone(s, x, y + h * 0.17, z, h * 0.150, h * 0.40, 6, mul(leaf, 0.9));
          cone(s, x, y + h * 0.43, z, h * 0.120, h * 0.38, 6, leaf);
          cone(s, x, y + h * 0.67, z, h * 0.085, h * 0.35, 6, mul(leaf, 1.14));
          break;
        }
        // HERO: five whorls instead of three and nine sides instead of six.
        // A fir is a STACK, and what reads as cheap from underneath is the
        // number of steps in it, not the number of sides on each.
        tube(s, x, y + h * 0.14, z, 0, 1, 0, h * 0.14, 0.13 * sc, 8, rgb(look.trunk));
        for (let k = 0; k < 5; k++) {
          const t = k / 4;
          cone(s, x, y + h * (0.16 + t * 0.56), z, h * (0.158 - t * 0.082),
               h * (0.40 - t * 0.09), 9, mul(leaf, 0.88 + t * 0.30));
        }
        break;
      }
      case 'conifer_far':
        cone(s, x, y, z, h * 0.26, h, 4, rgb(look.c));
        break;
      case 'lamp': {
        if (!near) { cylinder(s, x, y, z, 0.09*sc, h, 4, c); break; }
        const ax = Math.cos(yaw) * 1.05 * sc, az = Math.sin(yaw) * 1.05 * sc;
        if (!hero) {
          cylinder(s, x, y, z, 0.10 * sc, h, 5, c);
          box(s, x + ax*0.5, y + h - 0.16, z + az*0.5, 0.55*sc, 0.07, 0.07, yaw, mul(c,1.1));
          box(s, x + ax, y + h - 0.34, z + az, 0.26*sc, 0.10, 0.14*sc, yaw, [236, 228, 186]);
          break;
        }
        // HERO: a base flange, a ten-sided column and an arm that CURVES --
        // three short tubes leaning further over, which is the shape of every
        // lamp standard in the city and the thing a straight arm gets wrong.
        tube(s, x, y + 0.14 * sc, z, 0, 1, 0, 0.14 * sc, 0.17 * sc, 8, mul(c, 0.86));
        tube(s, x, y + h * 0.5, z, 0, 1, 0, h * 0.5, 0.10 * sc, 10, c);
        for (let k = 0; k < 3; k++) {
          const t = (k + 0.5) / 3, rise = 0.30 - t * 0.26;
          tube(s, x + ax * t, y + h - 0.02 - t * 0.16, z + az * t,
               ax, rise, az, 0.20 * sc, 0.055 * sc, 6, mul(c, 1.05));
        }
        box(s, x + ax, y + h - 0.40, z + az, 0.26*sc, 0.055, 0.15*sc, yaw, mul(c, 1.1));
        box(s, x + ax, y + h - 0.51, z + az, 0.22*sc, 0.05, 0.12*sc, yaw, [242, 234, 196]);
        break;
      }
      case 'signal': {
        cylinder(s, x, y, z, 0.09 * sc, h, 5, c);
        if (!near) break;
        box(s, x, y + h - 0.85, z, 0.16*sc, 0.42*sc, 0.16*sc, yaw, mul(c, 0.9));
        box(s, x, y + h - 0.35, z, 0.09*sc, 0.07, 0.09*sc, yaw, [214, 82, 56]);
        break;
      }
      case 'sign': {
        cylinder(s, x, y, z, 0.055 * sc, h, 4, [116, 118, 120]);
        box(s, x, y + h - 0.44, z, 0.33*sc, 0.30*sc, 0.035, yaw, c);
        break;
      }
      case 'bench': {
        if (!hero) {
          box(s, x, y, z, 0.86*sc, h*0.5, 0.26*sc, yaw, c);
          if (near) box(s, x - Math.sin(yaw)*0.22*sc, y + h*0.5, z + Math.cos(yaw)*0.22*sc,
                        0.86*sc, h*0.42, 0.06, yaw, mul(c, 0.92));
          break;
        }
        // HERO: slats and cast legs. A park bench is READ as the gaps between
        // its slats -- a solid block of the same colour and size is a crate.
        const sx = Math.sin(yaw), cz = Math.cos(yaw);
        for (let k = 0; k < 3; k++)
          box(s, x - sx * (k - 1) * 0.17 * sc, y + h * 0.48, z + cz * (k - 1) * 0.17 * sc,
              0.86*sc, 0.022, 0.065*sc, yaw, mul(c, 1 - k * 0.05));
        for (let k = 0; k < 3; k++)
          box(s, x - sx * (0.22 + k * 0.02) * sc, y + h * 0.52 + k * 0.13 * sc,
              z + cz * (0.22 + k * 0.02) * sc,
              0.86*sc, 0.022, 0.055*sc, yaw, mul(c, 0.94 - k * 0.03));
        for (const e of [-1, 1])
          box(s, x + cz * e * 0.74 * sc, y, z + sx * e * 0.74 * sc,
              0.05*sc, h*0.24, 0.26*sc, yaw, [74, 76, 78]);
        break;
      }
      case 'car': {
        // Two boxes and a dark strip. A parked car is read as a SILHOUETTE at
        // the kerb and as a splash of colour in a grey street -- wheels, mirrors
        // and glass are triangles that nobody at eye height ever resolves, and
        // there are thousands of these.
        const body = rgb(CAR_COLORS[tint % CAR_COLORS.length]);
        const len = 4.20 * sc, wid = 1.75 * sc;
        const bx = Math.cos(yaw) * len * 0.10, bz = Math.sin(yaw) * len * 0.10;
        if (!hero) {
          // A dark sill under the body instead of wheels: four cylinders is
          // forty triangles nobody resolves, and a car with a gap under it
          // floats.
          box(s, x, y + 0.06, z, len * 0.47, 0.13, wid * 0.44, yaw, [38, 38, 40]);
          box(s, x, y + 0.32, z, len * 0.5, 0.27, wid * 0.5, yaw, body);
          box(s, x - bx, y + 0.86, z - bz, len * 0.27, 0.21, wid * 0.42, yaw,
              mul(body, 0.80));
          break;
        }
        // HERO. Standing beside one, the three things that give the box away
        // are that it has no wheels, no glass and no lights -- in that order.
        //
        // EVERY HEIGHT IN HERE IS A FRACTION OF THE CAR, not a number of
        // metres. The low version's heights are fixed while its LENGTH scales
        // with `sc`, which is invisible under a dark sill and is not invisible
        // once there are wheels: at `sc` 0.7 the body sat above the top of the
        // tyre and the car came out on castors, and at 1.5 the wheels
        // disappeared inside it.
        const CH = 1.45 * sc;             // roof height, and the unit for the rest
        const R = 0.205 * CH;             // wheel radius
        const sill = 0.235 * CH, belt = 0.635 * CH, roofY = 0.952 * CH;
        const fw = Math.cos(yaw), fz2 = Math.sin(yaw);   // along the car
        const rw = -fz2, rz2 = fw;                        // across it
        // A TYRE IS NOT BLACK, IT IS DARK GREY THAT CATCHES LIGHT. At 26/26/28
        // on a road at 46/46/48 the wheel was invisible and what read was the
        // hub -- one pale sliver poking out of nothing, which is exactly what
        // a car on castors looks like.
        const tyre = [48, 48, 52], hub = [176, 180, 186], glass = [30, 38, 46];
        for (const along of [-0.60, 0.60]) for (const side of [-1, 1]) {
          const wx = x + fw * len * 0.5 * along + rw * wid * 0.41 * side;
          const wz = z + fz2 * len * 0.5 * along + rz2 * wid * 0.41 * side;
          // TWELVE SIDES, not nine. A hero prop is by definition the one you
          // are standing next to, and at three metres a nine-sided tyre is
          // visibly a nonagon -- which is a worse artefact than the slab it
          // replaced, because a slab at least does not claim to be round.
          tube(s, wx, y + R, wz, rw, 0, rz2, 0.075 * CH, R, 12, tyre);
          tube(s, wx + rw * 0.062 * CH * side, y + R, wz + rz2 * 0.062 * CH * side,
               rw, 0, rz2, 0.03 * CH, R * 0.54, 8, hub);
        }
        box(s, x, y + sill - 0.03 * CH, z, len * 0.47, 0.02 * CH, wid * 0.46, yaw,
            [40, 40, 44]);                                          // undertray
        box(s, x, y + sill, z, len * 0.5, (belt - sill) * 0.5, wid * 0.5, yaw, body);
        // The greenhouse: set BACK, narrower than the body and tapered in at
        // the top. That taper is most of what separates a saloon from a van,
        // and it is two boxes.
        box(s, x - bx, y + belt, z - bz, len * 0.29, (roofY - belt) * 0.5, wid * 0.45,
            yaw, glass);
        box(s, x - bx, y + roofY, z - bz, len * 0.26, 0.024 * CH, wid * 0.40, yaw,
            mul(body, 0.97));
        for (const side of [-1, 1])                                 // mirrors
          box(s, x + fw * len * 0.15 + rw * wid * 0.53 * side,
              y + belt - 0.04 * CH, z + fz2 * len * 0.15 + rz2 * wid * 0.53 * side,
              0.055 * CH, 0.03 * CH, 0.045 * CH, yaw, mul(body, 0.78));
        for (const [end, col] of [[1, [250, 242, 208]], [-1, [168, 44, 36]]])
          for (const side of [-1, 1])
            box(s, x + fw * len * 0.495 * end + rw * wid * 0.31 * side,
                y + sill + (belt - sill) * 0.42,
                z + fz2 * len * 0.495 * end + rz2 * wid * 0.31 * side,
                0.02, 0.035 * CH, wid * 0.13, yaw, col);
        break;
      }
      case 'post':  cylinder(s, x, y, z, 0.11 * sc, h, 5, c); break;
      case 'pole':  cylinder(s, x, y, z, 0.15 * sc, h, 5, c); break;
      case 'rack':
        if (near) { box(s, x, y, z, 0.5*sc, h*0.5, 0.05, yaw, c); }
        break;
      default:      box(s, x, y, z, 0.27*sc, h*0.5, 0.22*sc, yaw, c);
  }
}

/**
 * A whole chunk's furniture, merged.
 *
 * `ranges` is what makes per-prop LOD possible: the triangle span each prop
 * occupies in the buffer, so the hero pass can COLLAPSE one of them without
 * rebuilding the chunk. Without it the only way to take a single car out of a
 * merged mesh is to rebuild the mesh, which is milliseconds every time you
 * walk past one.
 */
export function buildProps(prop, classNames, lod, wantRanges) {
  const s = new Soup(2048);
  if (!prop) return s.done();
  const level = lod === 'full' ? 1 : 0;
  const ranges = wantRanges ? new Int32Array(prop.n * 2) : null;
  for (let i = 0; i < prop.n; i++) {
    const name = classNames[prop.kind[i]];
    const look = PROP[name] || PROP_DEFAULT;
    const at = s.n;
    oneProp(s, name, look, prop.pos[i*3], prop.pos[i*3+2], prop.pos[i*3+1],
            prop.scale[i], prop.yaw[i], prop.tint[i], level);
    if (ranges) { ranges[i*2] = at; ranges[i*2+1] = s.n - at; }
  }
  const out = s.done();
  out.ranges = ranges;
  return out;
}
