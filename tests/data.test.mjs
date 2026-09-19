// The baked city, read back through the same reader the game uses.
//
// EVERY CHECK IN HERE ASKS WHAT IT WOULD STILL PASS WITH. A city baked
// MIRRORED satisfies every count, every byte length and every bounding box you
// can write about it -- so the checks that matter are the ones that pin a
// DIRECTION or a real-world fact: that downtown is west of the river, that a
// bridge deck is above the water it crosses, that a wall's normal points out of
// the building rather than into it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseChunk, parseFar } from '../game/chunk.js';

const DATA = path.resolve('data');
const M = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
const LM = JSON.parse(fs.readFileSync(path.join(DATA, 'landmarks.json'), 'utf8'));
const W = M.world;

const read = (i, j) => {
  const b = fs.readFileSync(path.join(DATA, `c${i}_${j}.bin`));
  return parseChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const chunkOf = (x, z) => [Math.floor((x - W.west) / W.chunk), Math.floor((z - W.north) / W.chunk)];
const toWorld = (lat, lon) => [(lon - M.anchor.lon) * M.anchor.metresPerDegLon,
                               -(lat - M.anchor.lat) * M.anchor.metresPerDegLat];

describe('manifest', () => {
  it('is a square grid of whole chunks', () => {
    expect(W.east - W.west).toBe(W.chunk * W.n);
    expect(W.south - W.north).toBe(W.chunk * W.n);
    expect(M.chunks.length).toBe(W.n * W.n);
  });
  it('carries the class vocabularies the runtime maps to a look', () => {
    for (const k of ['building', 'road', 'area', 'prop'])
      expect(M.classes[k].length).toBeGreaterThan(5);
  });
  it('credits its sources -- ODbL is a licence, not a courtesy', () => {
    expect(M.source.attribution).toMatch(/OpenStreetMap/);
    expect(M.source.attribution).toMatch(/Overture/);
  });
});

describe('the projection is not mirrored', () => {
  // The single most valuable check here. A mirrored city has the right number
  // of everything and the right distances between all of it.
  it('puts east at +X and north at -Z', () => {
    const [ex] = toWorld(45.5231, -122.6602);   // 0.01 deg east of the anchor
    const [, nz] = toWorld(45.5331, -122.6702); // 0.01 deg north
    expect(ex).toBeGreaterThan(700);
    expect(nz).toBeLessThan(-1000);
  });
  it('puts downtown WEST of the river and the east side EAST of it', () => {
    const wells = LM.landmarks.find((l) => l.name === 'Wells Fargo Center');
    expect(wells, 'Wells Fargo Center should be a named landmark').toBeTruthy();
    expect(wells.x).toBeLessThan(-400);          // west of the Burnside anchor
    const ladd = toWorld(45.5065, -122.6480);    // Ladd's Addition, inner SE
    expect(ladd[0]).toBeGreaterThan(1500);
    expect(ladd[1]).toBeGreaterThan(1500);
  });
  it('agrees with the landmarks it wrote', () => {
    for (const L of LM.landmarks.slice(0, 40)) {
      const [x, z] = toWorld(L.lat, L.lon);
      expect(Math.abs(x - L.x)).toBeLessThan(1.5);
      expect(Math.abs(z - L.z)).toBeLessThan(1.5);
    }
  });
});

describe('chunks', () => {
  const all = [];
  for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) all.push([i, j]);

  it('all parse, and carry terrain at the declared resolution', () => {
    for (const [i, j] of all) {
      const c = read(i, j);
      expect(c.terr, `c${i}_${j} has no terrain`).toBeTruthy();
      expect(c.terr.n).toBe(W.chunk / W.terrainCell);
      expect(c.terr.h.length).toBe(c.terr.m * c.terr.m);
    }
  });

  it('terrain is continuous ACROSS chunk seams', () => {
    // A seam is where a bake bug shows first and where a player sees it worst.
    // The east edge of one chunk and the west edge of the next are the same
    // samples and must be identical to the decimetre they were quantised at.
    for (let j = 0; j < W.n; j++) {
      for (let i = 0; i < W.n - 1; i++) {
        const a = read(i, j).terr, b = read(i + 1, j).terr;
        for (let k = 0; k < a.m; k++) {
          expect(Math.abs(a.h[k * a.m + (a.m - 1)] - b.h[k * b.m]))
            .toBeLessThan(0.11);
        }
      }
    }
  });

  it('never quantises a length past what an int16 of decimetres holds', () => {
    for (const [i, j] of all) {
      const c = read(i, j);
      for (const b of c.bldg) {
        expect(b.top).toBeGreaterThan(b.base);
        expect(b.top - b.base).toBeLessThan(300);
        expect(b.nv).toBeGreaterThanOrEqual(3);
        expect(b.tri.length).toBe((b.nv - 2) * 3);
        for (const t of b.tri) expect(t).toBeLessThan(b.nv);
      }
    }
  });

  it('has a plausible city in it', () => {
    let bldg = 0, road = 0, prop = 0;
    for (const [i, j] of all) {
      const c = read(i, j);
      bldg += c.bldg.length; road += c.road.length; prop += c.prop ? c.prop.n : 0;
    }
    expect(bldg).toBeGreaterThan(10000);
    expect(road).toBeGreaterThan(8000);
    expect(prop).toBeGreaterThan(20000);
  });
});

describe('rings wind anticlockwise SEEN FROM ABOVE', () => {
  // Get this backwards and every wall in Portland is lit from inside, which
  // renders as a city-shaped hole. It is a sign test, so no count or distance
  // check anywhere else in this file would notice.
  it('every footprint has a positive signed area in (x, -z)', () => {
    let checked = 0;
    for (let j = 0; j < W.n; j += 3) for (let i = 0; i < W.n; i += 3) {
      for (const b of read(i, j).bldg) {
        let a = 0;
        for (let k = 0; k < b.nv; k++) {
          const p = k * 2, q = ((k + 1) % b.nv) * 2;
          a += b.ring[p] * -b.ring[q + 1] - b.ring[q] * -b.ring[p + 1];
        }
        expect(a, 'a clockwise ring turns a building inside out').toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('bridges are the vertical case', () => {
  const burnside = LM.landmarks.find((l) => l.name === 'Burnside Bridge');
  it('is named, with a clear box ready for a hand-built model', () => {
    expect(burnside).toBeTruthy();
    expect(burnside.clear.x1 - burnside.clear.x0).toBeGreaterThan(100);
  });
  // Drivable bridges only. A floating walkway and a dock ramp are also tagged
  // `bridge` and they are SUPPOSED to be at water level -- the Eastbank
  // Esplanade literally floats -- so a blanket clearance rule would either fail
  // on them or have to lift them six metres into the air.
  it('carries every road deck WELL ABOVE the water it crosses', () => {
    const drive = new Set(['motorway','trunk','primary','secondary','tertiary',
                           'residential','unclassified','living_street']);
    let overWater = 0;
    for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) {
      const c = read(i, j);
      for (const r of c.road) {
        if (!(r.flags & 1) || !drive.has(M.classes.road[r.cls])) continue;
        for (let k = 0; k < r.np; k++) {
          const lx = r.pts[k*3], lz = r.pts[k*3+1];
          if (lx < 0 || lz < 0 || lx > W.chunk || lz > W.chunk) continue;
          if (terrainAt(c, lx, lz) >= W.waterLevel) continue;
          overWater++;
          expect(r.pts[k*3+2], 'a road deck in the river').toBeGreaterThan(W.waterLevel + 3);
        }
      }
    }
    expect(overWater, 'nothing crosses water at all -- wrong bake?').toBeGreaterThan(80);
  });
  // GRADE IS THE ONE PROPERTY A BRIDGE CHECK MUST MEASURE, and it is exactly
  // the one a count or a bounding box cannot see. Two builds of this solver
  // produced decks at 34% -- a grade no road on Earth has -- while every other
  // number about them was correct.
  // Measured only WHERE IT IS OVER WATER. A named bridge's clear box covers its
  // approach viaducts as well as its span, and an approach is supposed to
  // climb; including it turns "is the deck level" into "is the ramp flat",
  // which is a different and wrong question.
  it('carries the river crossings as LEVEL DECKS', () => {
    // TILIKUM CROSSING IS NOT IN THIS LIST AND THAT IS THE DATA BEING RIGHT:
    // it carries light rail, buses, bikes and people and NO private cars, so it
    // has no drivable deck to measure. It failed this check the first time and
    // the check was wrong.
    const river = ['Burnside Bridge', 'Hawthorne Bridge', 'Morrison Bridge',
                   'Broadway Bridge', 'Steel Bridge', 'Fremont Bridge',
                   'Ross Island Bridge'];
    for (const name of river) {
      const L = LM.landmarks.find((l) => l.name === name);
      if (!L) continue;
      const [ci, cj] = chunkOf(L.x, L.z);
      let worst = 0, span = 0;
      const drive = new Set(['motorway','trunk','primary','secondary','tertiary',
                             'residential','unclassified','living_street']);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= W.n || j >= W.n) continue;
        const c = read(i, j);
        for (const r of c.road) {
          // The ROAD DECK. A pedestrian ramp down to the esplanade shares the
          // bridge's box, is also tagged `bridge`, and drops five metres in two
          // -- which is short in the source data, not wrong in the solver.
          if (!(r.flags & 1) || !drive.has(M.classes.road[r.cls])) continue;
          const ox = W.west + i * W.chunk, oz = W.north + j * W.chunk;
          for (let k = 1; k < r.np; k++) {
            const lx = r.pts[k*3], lz = r.pts[k*3+1];
            if (lx < 0 || lz < 0 || lx > W.chunk || lz > W.chunk) continue;
            const x = ox + lx, z = oz + lz;
            // BOTH filters. Over water alone picks up every dock ramp and
            // esplanade within a kilometre; inside the box alone picks up the
            // approach viaducts, which are meant to climb.
            if (x < L.clear.x0 || x > L.clear.x1 || z < L.clear.z0 || z > L.clear.z1) continue;
            if (terrainAt(c, lx, lz) >= W.waterLevel) continue;
            const run = Math.hypot(lx - r.pts[(k-1)*3], lz - r.pts[(k-1)*3+1]);
            const rise = Math.abs(r.pts[k*3+2] - r.pts[(k-1)*3+2]);
            if (run > 2) { worst = Math.max(worst, rise / run); span++; }
          }
        }
      }
      expect(span, `${name} has no deck over water`).toBeGreaterThan(3);
      expect(worst, `${name} deck grade over the river`).toBeLessThan(0.10);
    }
  });

  // The residual is stated rather than hidden. What is left above 15% is short
  // ramps joining ground level to a high deck -- the Steel Bridge's spiral
  // approaches and the freeway stacks -- which really are steep. The ceiling is
  // here so a solver regression cannot quietly bring the 34% decks back.
  it('has almost no steep drivable bridge anywhere', () => {
    const drive = new Set(['motorway','trunk','primary','secondary','tertiary',
                           'residential','unclassified','service','living_street','alley']);
    let total = 0, steep = 0, worst = 0;
    for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) {
      for (const r of read(i, j).road) {
        if (!(r.flags & 1) || !drive.has(M.classes.road[r.cls])) continue;
        for (let k = 1; k < r.np; k++) {
          const run = Math.hypot(r.pts[k*3] - r.pts[(k-1)*3], r.pts[k*3+1] - r.pts[(k-1)*3+1]);
          if (run <= 1) continue;
          const gr = Math.abs(r.pts[k*3+2] - r.pts[(k-1)*3+2]) / run;
          total++; worst = Math.max(worst, gr);
          if (gr > 0.15) steep++;
        }
      }
    }
    expect(steep / total, 'share of bridge segments over a 15% grade').toBeLessThan(0.025);
    expect(worst, 'the steepest bridge segment in the city').toBeLessThan(0.60);
  });
});

function terrainAt(c, lx, lz) {
  const { m, h } = c.terr;
  const cell = W.terrainCell;
  const u = Math.max(0, Math.min(m - 1.001, lx / cell));
  const v = Math.max(0, Math.min(m - 1.001, lz / cell));
  const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
  return (h[j*m+i]*(1-fu) + h[j*m+i+1]*fu)*(1-fv) + (h[(j+1)*m+i]*(1-fu) + h[(j+1)*m+i+1]*fu)*fv;
}

describe('the skyline', () => {
  it('holds the real towers at their real heights', () => {
    const b = fs.readFileSync(path.join(DATA, 'far.bin'));
    const f = parseFar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(f.n).toBeGreaterThan(200);
    let tallest = 0;
    for (let i = 0; i < f.n; i++) tallest = Math.max(tallest, f.top[i] - f.base[i]);
    // Wells Fargo Center is 167 m and is the tallest thing in Portland.
    expect(tallest).toBeGreaterThan(150);
    expect(tallest).toBeLessThan(200);
  });
});

describe('street name blades', () => {
  // The names are the whole feature. A blade is a green rectangle either way;
  // what makes it worth having is that it says BURNSIDE when you are on
  // Burnside, so these check the STRINGS and WHERE THEY STAND.
  const all = [];
  for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) {
    const c = read(i, j);
    for (const sg of c.sign) all.push({ ...sg, c, i, j,
      wx: W.west + i * W.chunk + sg.x, wz: W.north + j * W.chunk + sg.z });
  }

  it('puts a blade at a real number of real junctions', () => {
    expect(all.length, 'no street signs anywhere in the city').toBeGreaterThan(1500);
    const names = new Set(all.map((s) => s.name));
    expect(names.size, 'distinct street names on blades').toBeGreaterThan(250);
    // Portland's grid, in its own words.
    expect(names.has('W BURNSIDE ST') || names.has('E BURNSIDE ST')).toBe(true);
  });

  it('abbreviates the way a real blade does, and keeps the quadrant', () => {
    // "SE 12TH AVE" and "NE 12TH AVE" are two miles apart: the directional
    // prefix IS the address system here, and it is the one part of the name
    // that must never be abbreviated away.
    let quadrant = 0;
    for (const s of all) {
      expect(s.name, `"${s.name}" is not upper case`).toBe(s.name.toUpperCase());
      expect(s.name.length, `"${s.name}" is too long for a blade`).toBeLessThanOrEqual(22);
      expect(s.name.length).toBeGreaterThan(1);
      if (/^(NW|NE|SW|SE|N|S|E|W) /.test(s.name)) quadrant++;
    }
    // Portland names nearly everything by quadrant; if this collapses, the
    // prefix is being eaten somewhere.
    expect(quadrant / all.length).toBeGreaterThan(0.75);
  });

  it('is a JUNCTION: two blades on one post, across each other', () => {
    const posts = new Map();
    for (const s of all) posts.set(`${s.i},${s.j},${s.x},${s.z}`,
      [...(posts.get(`${s.i},${s.j},${s.x},${s.z}`) || []), s]);
    let pairs = 0, square = 0;
    for (const [, a] of posts) {
      if (a.length !== 2) continue;
      pairs++;
      expect(a[0].name).not.toBe(a[1].name);
      // Exactly one of the two carries the post: the other is bolted to it.
      expect(a.filter((s) => s.post).length, 'a post with two posts').toBe(1);
      // A corner is two streets CROSSING. Anything within 30 degrees of
      // parallel is the same street continuing, and a blade for it on both
      // sides of the same post says nothing.
      const d = Math.abs(Math.cos(a[0].yaw - a[1].yaw));
      if (d < Math.cos(Math.PI / 3)) square++;
    }
    expect(pairs, 'no two-blade posts at all').toBeGreaterThan(1000);
    expect(square / pairs, 'blades on a post should CROSS').toBeGreaterThan(0.85);
  });

  it('stands on the pavement, not inside a building', () => {
    // A signpost through a shopfront is the same class of bug as a tree in the
    // middle of Burnside, and just as obvious once you are standing there.
    // A chunk record carries a RING and no bounding box -- `Ground` computes
    // one when it loads, and reading `b.minx` here would compare against
    // `undefined`, which is false either way and quietly tests nothing.
    let inside = 0;
    for (const s of all) {
      for (const b of s.c.bldg) {
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (let k = 0; k < b.nv; k++) {
          const x = b.ring[k*2], z = b.ring[k*2+1];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        if (s.x < x0 || s.x > x1 || s.z < z0 || s.z > z1) continue;
        if (inRing(b, s.x, s.z)) { inside++; break; }
      }
    }
    expect(inside, `${inside} of ${all.length} signposts stand inside a building`).toBe(0);
  });
});

/** Point in a building's footprint, in chunk-local metres. */
function inRing(b, x, z) {
  let hit = false;
  for (let i = 0, j = b.nv - 1; i < b.nv; j = i++) {
    const xi = b.ring[i*2], zi = b.ring[i*2+1], xj = b.ring[j*2], zj = b.ring[j*2+1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}
