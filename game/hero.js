// Per-prop LOD in a city whose furniture is MERGED.
//
// THE OBVIOUS ANSWER IS `THREE.LOD` AND IT DOES NOT APPLY HERE. That class
// switches between children of one Object3D by distance, which is exactly
// right for a thing that IS an object -- a landmark GLB, the ship -- and has
// nothing to attach to in a chunk where six hundred trees, lamps and parked
// cars are one buffer and one draw call. Giving each prop its own Object3D to
// hang levels off is the trade this whole renderer exists to avoid: it is six
// hundred draw calls a chunk to make a dozen of them look better.
//
// So the swap happens INSIDE the buffer. Every chunk's prop mesh is built with
// a note of which triangles belong to which prop (`ranges`), and this pass:
//
//   * picks the nearest few dozen props of the kinds that HAVE a better
//     version -- trees, lamps, benches, parked cars;
//   * COLLAPSES those props in the chunk's own mesh, by writing every one of
//     their vertices to a single point, which makes every triangle degenerate
//     and costs the rasteriser nothing;
//   * draws them again, at hero detail, into one merged dynamic mesh of its
//     own -- the crowd's trick, one draw call for the lot.
//
// A prop leaving the set is rebuilt into the chunk buffer from the chunk's own
// record, at the same level it was built with. NOTHING IS CACHED: keeping the
// original vertices to restore would be a second copy of every prop buffer in
// the city, and `oneProp` is deterministic on the record, so the cheapest
// place to keep them is the record they came from.

import { Soup } from './build.js';
import { oneProp, buildProps } from './props.js';
import { PROP, PROP_DEFAULT, HERO } from './tune.js';

export class Hero {
  constructor(scene, THREE, classNames) {
    this.THREE = THREE;
    this.names = classNames;
    this.on = new Map();          // "chunk:index" -> { rec, i, name, look, ... }
    this.t = 99;
    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo,
      new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.cap = 0;
    this.grow(4096 * 9);
    this.live = 0;
  }

  grow(need) {
    this.cap = Math.max(need, (this.cap * 1.8) | 0, 8192);
    const B = this.THREE.BufferAttribute;
    this.geo.setAttribute('position', new B(new Float32Array(this.cap), 3));
    this.geo.setAttribute('normal', new B(new Float32Array(this.cap), 3));
    this.geo.setAttribute('color', new B(new Uint8Array(this.cap), 3, true));
  }

  step(dt, px, pz, live) {
    this.t += dt;
    if (this.t < HERO.every) return;
    this.t = 0;

    // Who deserves the better model. Scored on distance alone -- a tree and a
    // car at the same range are equally worth it, and a priority between kinds
    // is a rule with no answer.
    const want = [];
    const r2 = HERO.range * HERO.range;
    for (const rec of live) {
      const p = rec.props;
      if (!p || !rec.ranges) continue;
      for (let i = 0; i < p.n; i++) {
        const name = this.names[p.kind[i]];
        if (!HERO.on.has(name)) continue;
        const x = rec.ox + p.pos[i*3], z = rec.oz + p.pos[i*3+1];
        const d = (x - px) ** 2 + (z - pz) ** 2;
        if (d > r2) continue;
        want.push({ d, rec, i, name, key: rec.id + ':' + i });
      }
    }
    want.sort((a, b) => a.d - b.d);
    want.length = Math.min(want.length, HERO.count);

    const next = new Map();
    for (const w of want) next.set(w.key, w);

    // A KEY IS NOT ENOUGH: THE RECORD HAS TO BE THE SAME RECORD. A chunk that
    // crosses the LOD boundary is dropped and rebuilt with a FRESH buffer, and
    // `chunk:index` names the same prop in both -- so a set diff on the key
    // alone decides nothing changed, never collapses it in the new buffer, and
    // the car is then drawn twice, once low and once hero, in the same place.
    for (const [k, was] of this.on) {
      const now = next.get(k);
      if (now && now.rec === was.rec) continue;
      this.restore(was);
    }
    for (const [k, w] of next) {
      const was = this.on.get(k);
      if (was && was.rec === w.rec) { next.set(k, was); continue; }
      this.collapse(w);
    }
    this.on = next;
    this.draw();
  }

  /** The triangles this prop owns in its chunk's buffer. */
  span(w) {
    const r = w.rec.ranges;
    // A dropped chunk's geometry has been disposed. Its JS arrays are still
    // there, so writing into one does not throw -- it just does nothing, for
    // ever, which is the kind of no-op that survives every test.
    if (w.rec.dead || !r || !w.rec.propGeo) return null;
    const at = r[w.i*2], n = r[w.i*2+1];
    if (!n) return null;
    return { at, n, pos: w.rec.propGeo.attributes.position };
  }

  /**
   * Take one prop out of a merged mesh without rebuilding it.
   *
   * Every vertex goes to the SAME point, which makes each of its triangles
   * zero-area. A degenerate triangle is discarded before rasterisation on
   * every GPU worth the name, so this costs the draw call nothing at all --
   * and it is reversible, which deleting the triangles would not be.
   */
  collapse(w) {
    const s = this.span(w);
    if (!s) return;
    const A = s.pos.array;
    const at = s.at * 9, end = at + s.n * 9;
    // Somewhere the prop actually is, not the origin: a degenerate triangle
    // still contributes to a bounding sphere, and parking every hidden prop at
    // (0,0,0) grows the chunk's sphere to reach the middle of the city, which
    // turns off its frustum culling in every direction at once.
    const ax = A[at], ay = A[at + 1], az = A[at + 2];
    for (let k = at; k < end; k += 3) { A[k] = ax; A[k+1] = ay; A[k+2] = az; }
    s.pos.needsUpdate = true;
    s.pos.addUpdateRange(at, end - at);
  }

  /** Put it back, rebuilt from the chunk's own record. */
  restore(w) {
    const s = this.span(w);
    if (!s) return;
    const p = w.rec.props;
    const look = PROP[w.name] || PROP_DEFAULT;
    const soup = new Soup(Math.max(8, s.n));
    oneProp(soup, w.name, look, p.pos[w.i*3], p.pos[w.i*3+2], p.pos[w.i*3+1],
            p.scale[w.i], p.yaw[w.i], p.tint[w.i],
            w.rec.lod === 'full' ? 1 : 0);
    const g = soup.done();
    // The rebuild has to be the SAME triangles, or it writes over a neighbour.
    // It is, because `oneProp` is a pure function of the record -- and if a
    // future edit ever makes it not, this is where it shows rather than as a
    // corrupted lamp post two streets away.
    if (g.tris !== s.n) return;
    s.pos.array.set(g.position, s.at * 9);
    s.pos.needsUpdate = true;
    s.pos.addUpdateRange(s.at * 9, s.n * 9);
  }

  draw() {
    const s = new Soup(2048);
    for (const [, w] of this.on) {
      const p = w.rec.props;
      const look = PROP[w.name] || PROP_DEFAULT;
      oneProp(s, w.name, look,
              w.rec.ox + p.pos[w.i*3], p.pos[w.i*3+2], w.rec.oz + p.pos[w.i*3+1],
              p.scale[w.i], p.yaw[w.i], p.tint[w.i], 2);
    }
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
