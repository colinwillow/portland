// Street name blades. One rectangle on a post at a corner, filled with the
// name of the street that is actually there.
//
// THIS IS THE CHEAPEST LEGIBILITY IN THE CITY. A grid of identical blocks is
// unnavigable however well it is modelled -- you cannot tell one corner from
// the next and you cannot answer "which way is Burnside". Two thousand two
// hundred and seventy-five junctions get a post, no model is authored for any
// of them, and the names come out of the map data, which is the one part a
// generator cannot invent.
//
// The board is merged into the chunk's own geometry, so a corner costs no draw
// call. The TEXT is a quad into the shared atlas in shops.js, and it is keyed
// on the string -- there are 435 distinct street names in the whole city and a
// junction has the same one on both its corners, so a name that repeats costs
// one cell however many blades say it.

import { Soup } from './build.js';
import { STREETSIGN as SS } from './tune.js';

const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mul = (c, k) => [Math.min(255, c[0]*k)|0, Math.min(255, c[1]*k)|0, Math.min(255, c[2]*k)|0];

/** How long a blade has to be to hold its name. Derived, never stored. */
export function bladeW(name) {
  return Math.max(SS.minW, Math.min(SS.maxW, name.length * SS.charW + SS.pad));
}

/** The height of a blade's centre above the post's foot. */
export function bladeY(sign) {
  return SS.postH - SS.bladeH * 0.5 - (sign.blade ? SS.drop : 0);
}

/**
 * Posts and blades for one chunk, merged into its geometry.
 *
 * A BLADE IS A CLOSED BOX AND ITS BACK MATTERS. You walk past a street sign
 * from both sides, and a single quad is invisible from one of them -- which
 * reads as the sign flickering out as you cross the road, not as a missing
 * face. Six faces, and the text goes on both.
 */
export function buildStreetSigns(list) {
  const s = new Soup(Math.max(32, list.length * 16));
  const post = rgb(SS.post), face = rgb(SS.face), edge = rgb(SS.edge);
  for (const sg of list) {
    if (sg.post) {
      // The post. Four sides only: its top is under a blade and its foot is in
      // the pavement, and neither is a face anybody ever sees.
      const r = SS.postR;
      const P = (dx, dz, up) => [sg.x + dx, sg.y + up, sg.z + dz];
      const c = mul(post, 1.0), dk = mul(post, 0.78);
      const q = (ax, az, bx, bz, col) => s.quad(
        P(ax, az, 0), P(bx, bz, 0), P(bx, bz, SS.postH), P(ax, az, SS.postH),
        col, col, col, col);
      q(-r, -r,  r, -r, c);
      q( r, -r,  r,  r, dk);
      q( r,  r, -r,  r, c);
      q(-r,  r, -r, -r, dk);
    }
    // The blade. Its long axis is PARALLEL TO THE STREET IT NAMES -- which is
    // how a street sign works, and is the reason it reads: that puts its face
    // square to somebody arriving along the CROSS street, who is the only
    // person that needs it. Mounted the other way it is edge-on to everybody.
    const fx = Math.sin(sg.yaw), fz = -Math.cos(sg.yaw);   // along the street
    const nx = -fz, nz = fx;                               // out of the face
    const hw = bladeW(sg.name) * 0.5, hh = SS.bladeH * 0.5, t = SS.bladeT;
    const y = sg.y + bladeY(sg);
    const P = (a, n, up) => [sg.x + fx*a + nx*n, y + up, sg.z + fz*a + nz*n];
    const A = P(-hw, t, -hh), B = P(hw, t, -hh), C = P(hw, t, hh), D = P(-hw, t, hh);
    const A2 = P(-hw, -t, -hh), B2 = P(hw, -t, -hh), C2 = P(hw, -t, hh), D2 = P(-hw, -t, hh);
    // THE WHOLE BOX IS WHITE AND THE GREEN IS A PANEL ON IT. A green rectangle
    // is a shape; a green rectangle with a white line round it is a SIGN, and
    // that border is doing more for legibility at forty metres than the
    // lettering is. Done the other way -- green box, white ends -- the caps
    // read as pale tabs stuck on the ends, which is what the first version
    // looked like.
    const rim = mul(edge, 0.94), rdk = mul(edge, 0.74);
    s.quad(A, B, C, D, rim, rim, rim, rim);      // front, white
    s.quad(B2, A2, D2, C2, rdk, rdk, rdk, rdk);  // back, white
    s.quad(D, C, C2, D2, rdk, rdk, rdk, rdk);    // top
    s.quad(A2, B2, B, A, rdk, rdk, rdk, rdk);    // bottom
    s.quad(B, B2, C2, C, rdk, rdk, rdk, rdk);    // ends
    s.quad(A, D, D2, A2, rdk, rdk, rdk, rdk);
    // The green panel, inset and proud, on both sides.
    const i = SS.border, o = t + 0.004;
    const lt = mul(face, 1.06), dkf = mul(face, 0.86);
    s.quad(P(-hw+i, o, -hh+i), P(hw-i, o, -hh+i), P(hw-i, o, hh-i), P(-hw+i, o, hh-i),
           lt, lt, lt, lt);
    s.quad(P(hw-i, -o, -hh+i), P(-hw+i, -o, -hh+i), P(-hw+i, -o, hh-i), P(hw-i, -o, hh-i),
           dkf, dkf, dkf, dkf);
  }
  return s.done();
}

/**
 * Text boards for the blades in range, for the shared atlas.
 *
 * TWO QUADS PER BLADE, one per side, sharing one atlas cell. A double-sided
 * quad shows the text MIRRORED from behind, which is worse than no text: it
 * reads as a rendering fault rather than as a sign. The back quad is the front
 * one wound the other way with its U reversed, which is the same fix the shop
 * signs needed for the same reason.
 */
export function streetBoards(rec, px, pz, out) {
  const list = rec.sign;
  if (!list || !list.length) return;
  const r2 = SS.range * SS.range;
  for (const sg of list) {
    if (!sg.name) continue;
    const x = rec.ox + sg.x, z = rec.oz + sg.z;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d > r2) continue;
    const fx = Math.sin(sg.yaw), fz = -Math.cos(sg.yaw);
    const nx = -fz, nz = fx;
    const hw = bladeW(sg.name) * 0.5 * 0.93, hh = SS.bladeH * 0.5 * 0.70;
    const y = sg.y + bladeY(sg), t = SS.bladeT + 0.008;
    const P = (a, n, up) => [x + fx*a + nx*n, y + up, z + fz*a + nz*n];
    out.push({
      // A blade ranks NEARER than it is: it is the thing you are looking for,
      // and losing it to a nail bar four metres closer is the one way this
      // feature fails.
      score: Math.sqrt(d) * SS.bias, name: sg.name, ink: SS.ink,
      quads: [
        // Front: the reader stands out along +n, so their right is -f and U
        // runs backwards along the blade. Same rule as the shop boards.
        [P(-hw, t, -hh), P(hw, t, -hh), P(hw, t, hh), P(-hw, t, hh)],
        [P(hw, -t, -hh), P(-hw, -t, -hh), P(-hw, -t, hh), P(hw, -t, hh)],
      ],
    });
  }
}
