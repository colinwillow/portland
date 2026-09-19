// Shopfronts: an awning, a sign board, and -- for the ones close enough to
// read -- the REAL NAME of the business that is actually there.
//
// This is the single biggest thing between a block of boxes and a street. A
// corner with Powell's on it is a different corner from an identical corner
// with nothing on it, and the names are the one part no generator can invent.
// Overture's places theme has 16,900 of them over this city; 4,833 are snapped
// to the wall they occupy at bake time.
//
// THE TEXT IS A SHARED ATLAS AND NOT A TEXTURE PER SIGN. A canvas texture per
// business is 4,833 textures and a draw call each. One 1024-px canvas holds 48
// names at a size you can read from across the street, every visible sign is a
// quad into it, and the whole lot is ONE draw call. The set is rebuilt only
// when the nearest 48 actually change -- which, walking, is every second or so.

import * as THREE from 'three';
import { Soup } from './build.js';
import { SHOP, SHOP_DEFAULT, SIGN } from './tune.js';

const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mul = (c, k) => [Math.min(255, c[0]*k)|0, Math.min(255, c[1]*k)|0, Math.min(255, c[2]*k)|0];

/**
 * The fixed part: a board and an awning on every shopfront in the chunk.
 *
 * Merged into the chunk's own geometry, so a storefront costs no draw call of
 * its own and a street of forty of them costs none either.
 */
export function buildShops(list, classNames) {
  const s = new Soup(Math.max(64, list.length * 12));
  for (const sh of list) {
    const look = SHOP[classNames[sh.cat]] || SHOP_DEFAULT;
    const c = rgb(look.c);
    // The bake stores the facade's OUTWARD bearing; forward is (sin, -cos) of
    // it and the board runs along the wall, which is that turned a quarter.
    const fx = Math.sin(sh.yaw), fz = -Math.cos(sh.yaw);
    const rx = -fz, rz = fx;
    const hw = sh.w * 0.5, y = sh.y + sh.h;
    const P = (a, b, up) => [sh.x + rx*a + fx*b, y + up, sh.z + rz*a + fz*b];

    // The board. Proud of the wall by a few centimetres so it never z-fights
    // with the facade it is bolted to.
    const d = 0.07, bh = SIGN.boardH * 0.5;
    const A = P(-hw, 0, -bh), B = P(hw, 0, -bh), C = P(hw, 0, bh), D = P(-hw, 0, bh);
    const A2 = P(-hw, d, -bh), B2 = P(hw, d, -bh), C2 = P(hw, d, bh), D2 = P(-hw, d, bh);
    const face = mul(c, 1.0), edge = mul(c, 0.7);
    s.quad(A2, B2, C2, D2, face, face, face, face);      // the face, outward
    s.quad(A, A2, D2, D, edge, edge, edge, edge);
    s.quad(B, C, C2, B2, edge, edge, edge, edge);
    s.quad(D2, C2, C, D, edge, edge, edge, edge);
    s.quad(A, B, B2, A2, edge, edge, edge, edge);

    if (sh.flags & 1) {
      // An awning: out and DOWN from above the board. It is the thing that reads
      // as a shopfront from fifty metres, before any sign is legible.
      const out = SIGN.awning, top = sh.h + bh + 0.10, lip = top - SIGN.awningDrop;
      const t = (a, b, up) => [sh.x + rx*a + fx*b, sh.y + up, sh.z + rz*a + fz*b];
      const aw = hw + 0.15;
      const U0 = t(-aw, 0.02, top), U1 = t(aw, 0.02, top);
      const L0 = t(-aw, out, lip), L1 = t(aw, out, lip);
      const stripe = mul(c, 1.18), shade = mul(c, 0.62);
      s.quad(U0, U1, L1, L0, stripe, stripe, face, face);           // the canopy
      s.quad(L0, L1, t(aw, out, lip - SIGN.valance), t(-aw, out, lip - SIGN.valance),
             shade, shade, shade, shade);                            // the valance
      s.triC(U0[0], U0[1], U0[2], L0[0], L0[1], L0[2],
             t(-aw, 0.02, lip)[0], t(-aw, 0.02, lip)[1], t(-aw, 0.02, lip)[2],
             shade, shade, shade);
      s.triC(L1[0], L1[1], L1[2], U1[0], U1[1], U1[2],
             t(aw, 0.02, lip)[0], t(aw, 0.02, lip)[1], t(aw, 0.02, lip)[2],
             shade, shade, shade);
    }
  }
  return s.done();
}

/**
 * Text boards for the shops in range, for the shared atlas.
 *
 * One quad each: a shopfront is on a wall and there is nothing behind it to
 * read it from.
 */
export function shopBoards(rec, px, pz, out, classNames) {
  const list = rec.shops;
  if (!list || !list.length) return;
  const r2 = SIGN.range * SIGN.range;
  for (const sh of list) {
    if (!sh.name) continue;
    const x = rec.ox + sh.x, z = rec.oz + sh.z;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d > r2) continue;
    const look = SHOP[classNames[sh.cat]] || SHOP_DEFAULT;
    const fx = Math.sin(sh.yaw), fz = -Math.cos(sh.yaw);
    const rx = -fz, rz = fx;
    const hw = sh.w * 0.5 * 0.94, bh = SIGN.boardH * 0.5 * 0.82;
    const y = sh.y + sh.h, out_ = 0.10;
    const P = (a, up) => [x + rx*a + fx*out_, y + up, z + rz*a + fz*out_];
    out.push({
      score: Math.sqrt(d), name: sh.name, ink: look.ink,
      // U RUNS BACKWARDS ALONG THE BOARD, and that is not a typo.
      // `(rx, rz) = (-fz, fx)` is the board's own right-hand vector, but a
      // reader STANDS IN FRONT of the sign looking back along -f, and their
      // right is the other way: facing south with up +Y, right is west.
      // Mapped straight across, every shop name in Portland read backwards.
      // Anticlockwise from the READER'S bottom left. Their right is the
      // NEGATIVE of the board's own `a` axis -- facing south with up +Y, right
      // is west -- so `+hw` is where their eye starts, not `-hw`.
      quads: [[P(hw, -bh), P(-hw, -bh), P(-hw, bh), P(hw, bh)]],
    });
  }
}

/**
 * Every readable name in the world: one canvas, one material, one draw call.
 *
 * IT IS NOT ONE CELL PER SIGN, IT IS ONE CELL PER STRING. A junction has
 * "SE HAWTHORNE BLVD" on both its corners and the next junction along has it
 * again; drawing that into its own atlas cell each time spends the whole atlas
 * on four copies of one street. Cells are keyed on the text and the ink, so a
 * name that repeats costs one cell however many boards say it -- which is what
 * lets 48 cells carry a street of shops AND every blade around it.
 */
export class SignText {
  constructor(scene) {
    const S = SIGN.atlas;
    this.cols = SIGN.cols;
    this.rows = SIGN.rows;
    this.slots = this.cols * this.rows;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = S;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.geo = new THREE.BufferGeometry();
    // Quads, not slots: a cell is shared by every board that says the same
    // thing, so there are far more quads on screen than there are cells.
    this.pos = new Float32Array(SIGN.quads * 6 * 3);
    this.uv = new Float32Array(SIGN.quads * 6 * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
      map: this.tex, transparent: true, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    this.key = '';
    this.t = 0;
    this.cells = 0;
  }

  /**
   * Gather every board in range, keep the best, redraw only when the SET of
   * STRINGS changes.
   *
   * `collect` is handed the list and pushes whatever it owns, which is how one
   * atlas serves shopfronts and street blades without either knowing the other
   * exists.
   */
  update(dt, px, pz, live, collect) {
    this.t += dt;
    if (this.t < SIGN.every) return;
    this.t = 0;
    const boards = [];
    for (const rec of live) collect(rec, px, pz, boards);
    boards.sort((a, b) => a.score - b.score);

    // Allocate cells in that order. A board whose string is already in the
    // atlas is free, so the cut is made on CELLS and on QUADS -- not on the
    // number of boards, which is what lets a street of blades all saying
    // "SE HAWTHORNE BLVD" cost one cell between them.
    const cell = new Map();
    const keep = [];
    let quads = 0;
    for (const b of boards) {
      const k = b.name + '\u0000' + b.ink;
      let ci = cell.get(k);
      if (ci === undefined) {
        if (cell.size >= this.slots) continue;
        ci = cell.size;
        cell.set(k, ci);
      }
      if (quads + b.quads.length > SIGN.quads) continue;
      quads += b.quads.length;
      keep.push({ b, ci });
    }
    const key = [...cell.keys()].join('|') + '#' + keep.length;
    if (key === this.key) { this.place(keep); return; }
    this.key = key;
    this.cells = cell.size;
    this.paint([...cell.keys()]);
    this.place(keep);
  }

  /**
   * One string per cell, and the INK IS MEASURED, not assumed to fill it.
   *
   * A cell is 256 x 85 and a street blade is 1.0 x 0.19 m. Mapping the whole
   * cell onto the whole board stretches every letter to the ratio between
   * those two, which came out 1.7x wide -- legible, and plainly wrong, and
   * wrong differently for every name because the font is shrunk to fit. What
   * is stored instead is the box the glyphs actually occupy and the shape of
   * it, and `place` fits that shape inside whatever space the board offers.
   */
  paint(keys) {
    const S = SIGN.atlas, cw = S / this.cols, ch = S / this.rows;
    const g = this.ctx;
    g.clearRect(0, 0, S, S);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.cell = [];
    for (let i = 0; i < keys.length; i++) {
      const cut = keys[i].indexOf('\u0000');
      const name = keys[i].slice(0, cut);
      // Ink chosen against the board it sits on, not a fixed white: a cream
      // awning with white lettering is a blank awning, and a green street
      // blade with dark lettering is a green smear.
      g.fillStyle = keys[i].slice(cut + 1);
      let size = Math.round(ch * 0.62);
      const font = (n) => `700 ${n}px 'Barlow Condensed','Arial Narrow',system-ui,sans-serif`;
      g.font = font(size);
      let m = g.measureText(name);
      while (m.width > cw * 0.94 && size > 9) {
        size -= 1;
        g.font = font(size);
        m = g.measureText(name);
      }
      const col = i % this.cols, row = (i / this.cols) | 0;
      const cx = col * cw + cw / 2, cy = row * ch + ch / 2;
      g.fillText(name, cx, cy);
      // The real ink box. `actualBoundingBox*` is exact where the em box is a
      // guess, and the two differ by most of a line on a condensed face.
      const pad = 1.5;
      const x0 = cx - (m.actualBoundingBoxLeft || m.width / 2) - pad;
      const x1 = cx + (m.actualBoundingBoxRight || m.width / 2) + pad;
      const y0 = cy - (m.actualBoundingBoxAscent || size * 0.72) - pad;
      const y1 = cy + (m.actualBoundingBoxDescent || 0) + pad;
      this.cell.push({
        u0: x0 / S, u1: x1 / S, v0: 1 - y1 / S, v1: 1 - y0 / S,
        aspect: (x1 - x0) / Math.max(1, y1 - y0),
      });
    }
    this.tex.needsUpdate = true;
  }

  /**
   * The quads. Rebuilt every tick -- the boards move as he walks.
   *
   * A BOARD GIVES THE SPACE AVAILABLE, NOT THE QUAD. Its corners are A, B, C,
   * D anticlockwise from the READER'S BOTTOM LEFT -- which is the one rule
   * every producer here has to get right, and getting it backwards writes the
   * name in mirror image. (The shop boards and the street blades genuinely
   * disagree about which way that is: a shop's board runs along `(-fz, fx)`
   * with its face out along `(fx, fz)`, and a blade's runs along `(fx, fz)`
   * with its face out along `(-fz, fx)` -- a quarter turn apart, so one of
   * them has to list its corners the other way round. Stating the rule here is
   * what makes that a property of the board rather than a flag in the atlas.)
   * The ink's own shape is then fitted CENTRED inside it, so a short name on a
   * wide board is short rather than stretched.
   */
  place(keep) {
    let v = 0, u = 0, n = 0;
    for (const { b, ci } of keep) {
      const m = this.cell && this.cell[ci];
      if (!m) continue;
      for (const q of b.quads) {
        const [P0, P1, P2, P3] = q;
        // The board's own axes and half extents.
        const ex = [P1[0]-P0[0], P1[1]-P0[1], P1[2]-P0[2]];
        const ey = [P3[0]-P0[0], P3[1]-P0[1], P3[2]-P0[2]];
        const W = Math.hypot(ex[0], ex[1], ex[2]) || 1;
        const H = Math.hypot(ey[0], ey[1], ey[2]) || 1;
        let w = W, h = W / m.aspect;
        if (h > H) { h = H; w = H * m.aspect; }
        const cx = (P0[0]+P1[0]+P2[0]+P3[0]) / 4;
        const cy = (P0[1]+P1[1]+P2[1]+P3[1]) / 4;
        const cz = (P0[2]+P1[2]+P2[2]+P3[2]) / 4;
        const ux = ex[0]/W, uy = ex[1]/W, uz = ex[2]/W;
        const vx = ey[0]/H, vy = ey[1]/H, vz = ey[2]/H;
        const C4 = (sw, sh) => [cx + ux*sw*w/2 + vx*sh*h/2,
                                cy + uy*sw*w/2 + vy*sh*h/2,
                                cz + uz*sw*w/2 + vz*sh*h/2];
        const a = C4(-1, -1), bq = C4(1, -1), c = C4(1, 1), d = C4(-1, 1);
        const push = (p, uu, vv) => {
          this.pos[v++] = p[0]; this.pos[v++] = p[1]; this.pos[v++] = p[2];
          this.uv[u++] = uu; this.uv[u++] = vv;
        };
        push(a, m.u0, m.v0); push(bq, m.u1, m.v0); push(c, m.u1, m.v1);
        push(a, m.u0, m.v0); push(c, m.u1, m.v1); push(d, m.u0, m.v1);
        n++;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.setDrawRange(0, n * 6);
    this.quads = n;
  }
}
