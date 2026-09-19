// Chunk streaming. Fetch by distance, build one chunk per frame, drop what is
// behind you.
//
// ONE CHUNK PER FRAME is the rule that matters. Building a 500 m square of
// Portland is fifteen to thirty milliseconds of array work; doing two in a frame
// is a visible hitch and doing nine at once -- which is what happens the first
// time you cross a diagonal -- is a freeze. Spread, the cost disappears into the
// frame it was always going to cost.
//
// The builders are PURE (build.js, props.js: numbers in, typed arrays out), so
// the day this needs a Worker the move is to post the ArrayBuffer and keep the
// same functions. That seam is why they look the way they do.

import * as THREE from 'three';
import { parseChunk, parseFar } from './chunk.js';
import { buildTerrain, buildBuildings, buildRoads, buildAreas } from './build.js';
import { buildProps } from './props.js';
import { buildShops } from './shops.js';
import { buildStreetSigns } from './streets.js';
import { STREAM, WATER, BUILDING, BUILDING_DEFAULT } from './tune.js';

/**
 * Floor lines on tall walls, in the shader, for one byte a vertex.
 *
 * This is the single biggest thing between "a city of boxes" and "a city".
 * Doing it as GEOMETRY is the obvious build and it is unaffordable: a 40 m
 * tower is twelve floor bands on every wall, so downtown alone would be tens of
 * thousands of extra triangles for something a fragment can compute from its
 * own world height.
 *
 * It FADES OUT WITH DISTANCE, and that is not a saving, it is the whole reason
 * it is usable: a 3.3 m band under a metre of screen space aliases into moire,
 * and moire on every building in a skyline is worse than no bands at all.
 */
function wallShader(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aTag;
        varying float vTag; varying float vWy; varying float vWx; varying float vWz;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTag = aTag;
        vec4 wp = modelMatrix * vec4(transformed, 1.0);
        vWy = wp.y; vWx = wp.x; vWz = wp.z;`)
      // VERTEX COLOURS ARE sRGB AND THREE ASSUMES THEY ARE LINEAR. Every palette
      // value in tune.js is a hex an eye picked, which is an sRGB number; three
      // converts `material.color` for you and does NOT convert a vertex colour,
      // because a vertex colour is normally computed data already in working
      // space. Handed sRGB bytes as linear, every mid-tone comes out a stop and
      // a half too light and the saturation goes with it -- which is exactly
      // what "the whole city is grey" looked like, through three separate
      // palette rewrites that could never have fixed it.
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
          vColor = pow(vColor, vec3(2.2));
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTag; varying float vWy; varying float vWx; varying float vWz;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (vTag > 0.5) {
          float fade = 1.0 - smoothstep(70.0, 260.0, length(vViewPosition));
          if (fade > 0.01) {
            // One band per storey, and a light mullion across it. The vertical
            // term uses whichever horizontal axis this face actually runs along,
            // so a wall facing east and a wall facing north get the same pitch.
            float f = fract(vWy / 3.35);
            float band = smoothstep(0.10, 0.20, f) * (1.0 - smoothstep(0.62, 0.74, f));
            // Darken the GLASS, not the mullion. Inverted, this draws a narrow
            // vertical line at every bay edge and the facade reads as a row of
            // dashes rather than a row of windows -- which is what the first
            // version did, and it is only obvious once you look at it.
            float across = abs(dFdx(vWx)) > abs(dFdx(vWz)) ? vWx : vWz;
            float mull = 1.0 - smoothstep(0.30, 0.46, abs(fract(across / 2.45) - 0.5));
            float k = 1.0 - 0.34 * band * mull * fade;
            gl_FragColor.rgb *= k;
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'pdx-wall';
  return mat;
}

function geom(g) {
  const b = new THREE.BufferGeometry();
  b.setAttribute('position', new THREE.BufferAttribute(g.position.slice(), 3));
  b.setAttribute('normal', new THREE.BufferAttribute(g.normal.slice(), 3));
  b.setAttribute('color', new THREE.BufferAttribute(g.color.slice(), 3, true));
  if (g.tag) b.setAttribute('aTag', new THREE.BufferAttribute(g.tag.slice(), 1, true));
  b.computeBoundingSphere();
  return b;
}

export class World {
  constructor(scene, manifest, ground, base, overrides) {
    this.scene = scene;
    this.m = manifest;
    this.ground = ground;
    this.base = base;                       // url prefix for data/
    this.ov = overrides;
    this.names = manifest.classes;
    this.live = new Map();                  // "i,j" -> {group, lod, meshes}
    this.pending = new Map();               // "i,j" -> parsed chunk, waiting to build
    this.fetching = new Set();
    this.queue = [];
    this.tris = 0;
    this.opaque = wallShader(new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.water = new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: true, opacity: WATER.opacity, depthWrite: false });
    this.root = new THREE.Group();
    scene.add(this.root);
  }

  async loadFar() {
    const buf = await (await fetch(this.base + 'far.bin')).arrayBuffer();
    const f = parseFar(buf);
    // The skyline is ONE mesh of boxes with no roofs and no detail: past 1.5 km
    // a building is a silhouette and a fog value, and everything else in it is
    // triangles nobody can see. 544 towers cost one draw call.
    const pos = [], nor = [], col = [];
    const q = (ax,ay,az,bx,by,bz,cx,cy,cz,c) => {
      const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
      let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      const L=Math.hypot(nx,ny,nz)||1; nx/=L;ny/=L;nz/=L;
      pos.push(ax,ay,az,bx,by,bz,cx,cy,cz);
      for(let k=0;k<3;k++){nor.push(nx,ny,nz);col.push(c[0],c[1],c[2]);}
    };
    for (let i = 0; i < f.n; i++) {
      const look = BUILDING[this.names.building[f.cls[i]]] || BUILDING_DEFAULT;
      const c = [(look.wall>>16)&255, (look.wall>>8)&255, look.wall&255];
      const dk = [c[0]*0.82|0, c[1]*0.82|0, c[2]*0.82|0];
      const x = f.x[i], z = f.z[i], y0 = f.base[i], y1 = f.top[i];
      const rx = Math.max(3, f.rx[i]), rz = Math.max(3, f.rz[i]);
      const P = (sx, sy, sz) => [x + sx*rx, sy ? y1 : y0, z + sz*rz];
      const A=P(-1,0,-1),B=P(1,0,-1),C=P(1,0,1),D=P(-1,0,1);
      const E=P(-1,1,-1),F=P(1,1,-1),G=P(1,1,1),H=P(-1,1,1);
      const face = (a,b,bb,d,cc)=>{ q(a[0],a[1],a[2],b[0],b[1],b[2],bb[0],bb[1],bb[2],cc);
                                    q(a[0],a[1],a[2],bb[0],bb[1],bb[2],d[0],d[1],d[2],cc); };
      face(E,F,G,H,[c[0]*1.06|0,c[1]*1.06|0,c[2]*1.06|0]);
      face(A,B,F,E,c); face(B,C,G,F,dk); face(C,D,H,G,c); face(D,A,E,H,dk);
    }
    // Where downtown is, measured rather than typed: the skyline boxes weighted
    // by how tall they are. The helicopter orbits this, and a number derived
    // from the city survives the play area being moved or grown, which a pair
    // of coordinates in tune.js would not.
    let wx = 0, wz = 0, wsum = 0;
    for (let i = 0; i < f.n; i++) {
      const w = Math.max(0, f.top[i] - f.base[i]) ** 2;
      wx += f.x[i] * w; wz += f.z[i] * w; wsum += w;
    }
    this.skyline = wsum > 0 ? { x: wx / wsum, z: wz / wsum } : { x: 0, z: 0 };

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Uint8BufferAttribute(col, 3, true));
    g.computeBoundingSphere();
    this.farMesh = new THREE.Mesh(g, this.opaque);
    this.farMesh.renderOrder = -1;
    this.root.add(this.farMesh);
    return f.n;
  }

  /** Which chunks should exist, nearest first. */
  want(px, pz) {
    const w = this.m.world;
    const out = [];
    const ci = Math.floor((px - w.west) / w.chunk), cj = Math.floor((pz - w.north) / w.chunk);
    const span = Math.ceil(STREAM.keep / w.chunk);
    for (let j = cj - span; j <= cj + span; j++) {
      for (let i = ci - span; i <= ci + span; i++) {
        if (i < 0 || j < 0 || i >= w.n || j >= w.n) continue;
        const cx = w.west + (i + 0.5) * w.chunk, cz = w.north + (j + 0.5) * w.chunk;
        const d = Math.hypot(cx - px, cz - pz) - w.chunk * 0.71;
        if (d > STREAM.keep) continue;
        out.push({ i, j, d, lod: d < STREAM.full ? 'full' : 'mid' });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  update(px, pz) {
    const want = this.want(px, pz);
    const keep = new Set(want.map((w) => w.i + ',' + w.j));
    for (const [id, rec] of this.live) {
      if (!keep.has(id)) this.drop(id, rec);
    }
    let built = 0;
    for (const w of want) {
      const id = w.i + ',' + w.j;
      const rec = this.live.get(id);
      if (rec && rec.lod === w.lod) continue;
      if (this.pending.has(id)) {
        if (built < STREAM.perFrame) {
          if (rec) this.drop(id, rec);
          this.build(w.i, w.j, w.lod, this.pending.get(id));
          built++;
        }
        continue;
      }
      if (rec) {                                   // present, wrong LOD: rebuild
        if (built < STREAM.perFrame && rec.raw) {
          this.drop(id, rec, true);
          this.build(w.i, w.j, w.lod, rec.raw);
          built++;
        }
        continue;
      }
      if (!this.fetching.has(id) && this.fetching.size < STREAM.fetchAhead) this.fetch(w.i, w.j);
    }
  }

  async fetch(i, j) {
    const id = i + ',' + j;
    this.fetching.add(id);
    try {
      const r = await fetch(`${this.base}c${i}_${j}.bin`);
      if (!r.ok) throw new Error(r.status);
      this.pending.set(id, parseChunk(await r.arrayBuffer()));
    } catch (e) {
      // A chunk that is not there is a hole in the city, not a reason to stop.
      // It is remembered as empty so it is never asked for again on every frame.
      this.pending.set(id, { terr: null, bldg: [], road: [], area: [],
                             prop: null, shop: [], sign: [] });
      if (window.__crash) window.__crash('chunk ' + id + ': ' + e.message);
    } finally {
      this.fetching.delete(id);
    }
  }

  build(i, j, lod, raw) {
    const id = i + ',' + j;
    const w = this.m.world;
    // Filtered ONCE, here, and the same filtered chunk goes to the renderer and
    // to the collider below. Two filters is two chances to disagree.
    const c = this.ov ? this.ov.filter(raw, w.west + i * w.chunk, w.north + j * w.chunk, w.chunk)
                      : raw;
    const g = new THREE.Group();
    g.position.set(w.west + i * w.chunk, 0, w.north + j * w.chunk);
    const meshes = [];
    // Returns the mesh, because the props one is handed to hero.js to write
    // into. Everything else ignores it.
    const add = (data, mat) => {
      if (!data.tris) return null;
      const mesh = new THREE.Mesh(geom(data), mat);
      mesh.frustumCulled = true;
      g.add(mesh); meshes.push(mesh);
      this.tris += data.tris;
      return mesh;
    };
    if (c.terr) add(buildTerrain(c.terr, w.chunk), this.opaque);
    add(buildAreas(c.area, this.names.area, false), this.opaque);
    add(buildRoads(c.road, this.names.road, lod), this.opaque);
    add(buildBuildings(c.bldg, this.names.building, lod), this.opaque);
    // WITH RANGES: the triangle span each prop owns, so hero.js can swap one
    // of them for a better model without rebuilding the chunk. Costs one
    // Int32Array of 2n and nothing at all if nothing ever asks.
    let propGeo = null, ranges = null;
    if (lod === 'full' || lod === 'mid') {
      const d = buildProps(c.prop, this.names.prop, lod, true);
      const m = add(d, this.opaque);
      if (m) { propGeo = m.geometry; ranges = d.ranges; }
    }
    if (c.shop && c.shop.length) add(buildShops(c.shop, this.names.shop), this.opaque);
    if (c.sign && c.sign.length) add(buildStreetSigns(c.sign), this.opaque);
    add(buildAreas(c.area, this.names.area, true), this.water);
    this.root.add(g);
    this.live.set(id, { id, group: g, lod, meshes, raw, shops: c.shop, sign: c.sign,
                        props: c.prop, propGeo, ranges,
                        ox: g.position.x, oz: g.position.z });
    this.ground.addChunk(i, j, c, this.names);
    this.pending.delete(id);
  }

  drop(id, rec, keepRaw) {
    // Anything holding a range into this chunk's buffers -- hero.js -- needs
    // to know they are gone rather than discovering it by writing into them.
    rec.dead = true;
    this.root.remove(rec.group);
    for (const m of rec.meshes) { m.geometry.dispose(); this.tris -= m.geometry.attributes.position.count / 3; }
    this.live.delete(id);
    const [i, j] = id.split(',').map(Number);
    this.ground.removeChunk(i, j);
    if (keepRaw) this.pending.set(id, rec.raw);
  }

  stats() {
    return { live: this.live.size, fetching: this.fetching.size, tris: Math.round(this.tris) };
  }

  /** Loaded chunks, for anything that needs to walk what is currently in the world. */
  loaded() { return this.live.values(); }
}
