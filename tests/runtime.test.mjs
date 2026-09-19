// The runtime, driven headlessly against the real baked city.
//
// These are the checks that would pass on a city rendered INSIDE OUT, on a
// collider that pushes the wrong way, and on a bridge you fall through -- if
// they only counted triangles. Each one pins a direction or a consequence.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseChunk } from '../game/chunk.js';
import * as THREE from 'three';
import { buildTerrain, buildBuildings, buildRoads, buildAreas, Soup } from '../game/build.js';
import { Crowd, Pavements, figure } from '../game/crowd.js';
import { buildShops, shopBoards, SignText } from '../game/shops.js';
import { buildStreetSigns, streetBoards, bladeW, bladeY } from '../game/streets.js';
import { Ambient, car, boat, plane, heli, prism, closed } from '../game/ambient.js';
import { buildProps, oneProp } from '../game/props.js';
import { Hero } from '../game/hero.js';
import { Ground } from '../game/ground.js';
import { Overrides } from '../game/overrides.js';
import { Player } from '../game/player.js';
import { animate } from '../game/character.js';
import { MOVE, AIR, HERO, PROP as PROPS, TURN } from '../game/tune.js';

const DATA = path.resolve('data');
const M = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
const LM = JSON.parse(fs.readFileSync(path.join(DATA, 'landmarks.json'), 'utf8'));
const W = M.world;
const NAMES = M.classes;
const read = (i, j) => {
  const b = fs.readFileSync(path.join(DATA, `c${i}_${j}.bin`));
  return parseChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const chunkOf = (x, z) => [Math.floor((x - W.west) / W.chunk), Math.floor((z - W.north) / W.chunk)];

/** Point in a building's footprint, in chunk-local metres. */
function inRing(b, x, z) {
  let inside = false;
  for (let i = 0, j = b.nv - 1; i < b.nv; j = i++) {
    const xi = b.ring[i*2], zi = b.ring[i*2+1], xj = b.ring[j*2], zj = b.ring[j*2+1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

describe('geometry faces the right way', () => {
  const c = read(4, 4);

  it('terrain normals point UP, every triangle', () => {
    const g = buildTerrain(c.terr, W.chunk);
    expect(g.tris).toBeGreaterThan(1000);
    for (let t = 0; t < g.tris; t++) {
      expect(g.normal[t * 9 + 1], 'a terrain triangle wound the other way').toBeGreaterThan(0.2);
    }
  });

  it('building WALLS face out of the building, not into it', () => {
    // The whole city renders as a hole if this is backwards, and nothing about
    // the file size, the triangle count or the footprint would change.
    //
    // Tested LOCALLY -- step off the face along its own normal and you must be
    // outside the footprint. The obvious version compares the normal with the
    // direction to the CENTROID, and that is wrong on any concave plan: the
    // inner face of an L-shaped block correctly points back toward its own
    // centroid, so 7% of downtown failed a check that was itself the bug.
    let walls = 0;
    for (const b of c.bldg) {
      const g = buildBuildings([b], NAMES.building, 'full');
      for (let t = 0; t < g.tris; t++) {
        const n = [g.normal[t*9], g.normal[t*9+1], g.normal[t*9+2]];
        if (Math.abs(n[1]) > 0.25) continue;               // a roof or a parapet top
        const mx = (g.position[t*9] + g.position[t*9+3] + g.position[t*9+6]) / 3;
        const mz = (g.position[t*9+2] + g.position[t*9+5] + g.position[t*9+8]) / 3;
        expect(inRing(b, mx + n[0] * 0.35, mz + n[2] * 0.35),
               'stepping out along a wall normal lands you inside the building')
          .toBe(false);
        walls++;
      }
    }
    expect(walls).toBeGreaterThan(200);
  });

  it('flat roofs cap UPWARD', () => {
    const flat = c.bldg.filter((b) => !b.roof);
    expect(flat.length).toBeGreaterThan(0);
    for (const b of flat) {
      const g = buildBuildings([b], NAMES.building, 'mid');   // mid = no parapet
      let up = 0;
      for (let t = 0; t < g.tris; t++) if (g.normal[t*9+1] > 0.9) up++;
      expect(up, 'a flat roof with no upward face').toBeGreaterThan(0);
    }
  });

  it('road ribbons are the width the data says, measured PER SEGMENT', () => {
    // Per segment, not end to end: a curved street's start-to-end direction is
    // not the direction of anything, and measuring across it reports a 9 m
    // street as 50 m wide -- which is what the first version of this check did,
    // and it was the check that was wrong.
    for (const r of c.road.slice(0, 60)) {
      if (r.np < 2) continue;
      const g = buildRoads([r], NAMES.road, 'full');
      if (!g.tris) continue;
      for (let k = 0; k < r.np - 1; k++) {
        const ax = r.pts[k*3], az = r.pts[k*3+1];
        const dx = r.pts[(k+1)*3] - ax, dz = r.pts[(k+1)*3+1] - az;
        const L = Math.hypot(dx, dz);
        if (L < 3) continue;
        // Only where the run is STRAIGHT. A mitre legitimately widens a bend,
        // so a bend can only ever produce a soft bound; on a straight the
        // ribbon must be the declared width and the check can be tight.
        const bend = (m) => {
          if (m < 1 || m > r.np - 2) return 0;
          const ax2 = r.pts[m*3] - r.pts[(m-1)*3], az2 = r.pts[m*3+1] - r.pts[(m-1)*3+1];
          const bx2 = r.pts[(m+1)*3] - r.pts[m*3], bz2 = r.pts[(m+1)*3+1] - r.pts[m*3+1];
          const la = Math.hypot(ax2, az2) || 1, lb = Math.hypot(bx2, bz2) || 1;
          return Math.acos(Math.max(-1, Math.min(1, (ax2*bx2 + az2*bz2) / (la*lb))));
        };
        if (bend(k) > 0.25 || bend(k + 1) > 0.25) continue;
        const ux = dx / L, uz = dz / L, nx = -uz, nz = ux;
        let lo = 1e9, hi = -1e9, seen = 0;
        for (let v = 0; v < g.tris * 3; v++) {
          const px = g.position[v*3] - ax, pz = g.position[v*3+2] - az;
          const along = px * ux + pz * uz;
          if (along < L * 0.3 || along > L * 0.7) continue;   // mid-segment only
          const across = px * nx + pz * nz;
          lo = Math.min(lo, across); hi = Math.max(hi, across); seen++;
        }
        if (seen < 4) continue;
        expect(hi - lo, `${NAMES.road[r.cls]} ribbon on a straight`).toBeGreaterThan(r.w * 0.95);
        expect(hi - lo, `${NAMES.road[r.cls]} ribbon on a straight`).toBeLessThan(r.w * 1.15 + 0.3);
      }
    }
  });

  // THE DIVERGENCE THEOREM IS THE ONLY CHECK THAT CATCHES AN INSIDE-OUT PROP.
  // A back-faced lamp post still renders -- the near side is culled and you see
  // its far side, which for a thin cylinder is the same silhouette -- so what it
  // costs is the LIGHTING, and nothing about the count, the bounds or the
  // picture says so. For a closed surface with outward normals the integral of
  // n . x over the surface is +3V; inside out it is -3V. Three of the four
  // primitives in props.js shipped backwards and this is what found them.
  it('every prop kind encloses a POSITIVE volume', () => {
    const one = (kind) => buildProps(
      { n: 1, kind: new Uint8Array([kind]), yaw: new Float32Array([0.4]),
        scale: new Float32Array([1]), tint: new Uint8Array([0]),
        pos: new Float32Array([0, 0, 0]) }, NAMES.prop, 'full');
    let tested = 0;
    for (let k = 0; k < NAMES.prop.length; k++) {
      const g = one(k);
      if (!g.tris) continue;
      let v = 0;
      for (let t = 0; t < g.tris; t++) {
        const i = t * 9, P = g.position;
        v += (P[i]   * (P[i+4]*P[i+8] - P[i+5]*P[i+7])
            + P[i+1] * (P[i+5]*P[i+6] - P[i+3]*P[i+8])
            + P[i+2] * (P[i+3]*P[i+7] - P[i+4]*P[i+6])) / 6;
      }
      expect(v, `${NAMES.prop[k]} is inside out`).toBeGreaterThan(0);
      tested++;
    }
    expect(tested).toBeGreaterThan(15);
  });

  it('props stand ON the ground, never under it', () => {
    const g = buildProps(c.prop, NAMES.prop, 'full');
    expect(g.tris).toBeGreaterThan(200);
    let lowest = 1e9;
    for (let v = 0; v < g.tris * 3; v++) lowest = Math.min(lowest, g.position[v*3+1]);
    let propFloor = 1e9;
    for (let i = 0; i < c.prop.n; i++) propFloor = Math.min(propFloor, c.prop.pos[i*3+2]);
    expect(lowest).toBeGreaterThan(propFloor - 0.2);
  });

  it('water is one flat surface at the declared level', () => {
    const [ci, cj] = chunkOf(0, 200);                 // mid-river below Burnside
    const w = read(ci, cj);
    const g = buildAreas(w.area, NAMES.area, true);
    if (!g.tris) return;
    for (let v = 0; v < g.tris * 3; v++)
      expect(Math.abs(g.position[v*3+1] - W.waterLevel)).toBeLessThan(0.11);
  });
});

describe('the ground knows about bridges', () => {
  // A heightmap has ONE answer per (x, z). The Willamette bridges need two --
  // the deck and the river under it -- and that is the whole reason groundAt
  // takes a hint.
  const burnside = LM.landmarks.find((l) => l.name === 'Burnside Bridge');
  const g = new Ground(M);
  for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) g.addChunk(i, j, read(i, j), NAMES);

  it('reads the river bed under the bridge and the deck on top of it', () => {
    // Walk the span and find a point that has both.
    let found = null;
    for (let t = 0.2; t <= 0.8 && !found; t += 0.02) {
      const x = burnside.clear.x0 + (burnside.clear.x1 - burnside.clear.x0) * t;
      for (let u = 0.2; u <= 0.8; u += 0.02) {
        const z = burnside.clear.z0 + (burnside.clear.z1 - burnside.clear.z0) * u;
        const low = g.groundAt(x, z, 1.0);
        const high = g.groundAt(x, z, 14.0);
        if (g.terrainAt(x, z) < W.waterLevel && high > low + 5) { found = { x, z, low, high }; break; }
      }
    }
    expect(found, 'nowhere on the Burnside Bridge has a deck above water').toBeTruthy();
    expect(found.low).toBeLessThan(W.waterLevel + 0.5);
    expect(found.high).toBeGreaterThan(W.waterLevel + 4);
    // Standing under it, the ground is the river -- not the deck.
    expect(g.groundAt(found.x, found.z, 2.0)).toBe(found.low);
  });

  it('calls the middle of the Willamette water and the bank dry', () => {
    // The anchor is the WEST END of the Burnside Bridge, so x = 0 is the west
    // bank and not the river. Taking the middle of the bridge's own box is the
    // only way to name mid-stream without typing a coordinate.
    const mx = (burnside.clear.x0 + burnside.clear.x1) / 2;
    const mz = (burnside.clear.z0 + burnside.clear.z1) / 2;
    expect(g.inWater(mx, mz), 'mid-span is not over water').toBe(true);
    const wells = LM.landmarks.find((l) => l.name === 'Wells Fargo Center');
    expect(g.inWater(wells.x, wells.z)).toBe(false);
  });

  it('terrain agrees with the reference points it was baked from', () => {
    // Pioneer Courthouse Square sits about 50 ft up; the river is about 3 m.
    const [px] = [(-122.6790 - M.anchor.lon) * M.anchor.metresPerDegLon];
    const pz = -(45.5189 - M.anchor.lat) * M.anchor.metresPerDegLat;
    expect(g.terrainAt(px, pz)).toBeGreaterThan(8);
    expect(g.terrainAt(px, pz)).toBeLessThan(30);
  });
});

describe('the collider', () => {
  const g = new Ground(M);
  const [ci, cj] = chunkOf(-700, 450);                 // downtown blocks
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++)
    g.addChunk(ci + di, cj + dj, read(ci + di, cj + dj), NAMES);
  const c = read(ci, cj);
  const ox = W.west + ci * W.chunk, oz = W.north + cj * W.chunk;

  it('pushes a body OUT of a building, and out far enough to clear it', () => {
    const b = c.bldg.find((x) => x.nv >= 4 && x.top - x.base > 6);
    let cx = 0, cz = 0;
    for (let k = 0; k < b.nv; k++) { cx += b.ring[k*2] + ox; cz += b.ring[k*2+1] + oz; }
    cx /= b.nv; cz /= b.nv;
    const y = (b.base + b.top) / 2;
    const r = g.resolve(cx, cz, b.base + 1, MOVE.radius);
    expect(r[2], 'standing in the middle of a building is not a collision').toBe(true);
    expect(Math.hypot(r[0] - cx, r[1] - cz)).toBeGreaterThan(0.5);
    // And once pushed out, it stays out: a resolver that oscillates is worse
    // than one that does nothing.
    const again = g.resolve(r[0], r[1], b.base + 1, MOVE.radius);
    expect(Math.hypot(again[0] - r[0], again[1] - r[1])).toBeLessThan(0.05);
  });

  it('leaves a body ABOVE a building alone', () => {
    const b = c.bldg.find((x) => x.top - x.base > 6);
    const r = g.resolve(b.ring[0] + ox, b.ring[1] + oz, b.top + 20, MOVE.radius);
    expect(r[2]).toBe(false);
  });
});

describe('locomotion', () => {
  const g = new Ground(M);
  const [ci, cj] = chunkOf(M.spawn.x, M.spawn.z);
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++)
    g.addChunk(ci + di, cj + dj, read(ci + di, cj + dj), NAMES);

  const wrapA = (a) => { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; };
  const step = (p, move, camAz, n = 120, dt = 1 / 60) => {
    for (let k = 0; k < n; k++) p.step(dt, g, move, camAz, false);
  };

  it('walks AWAY from the camera when the thumb goes up', () => {
    // The check that every twin-stick in this account has got backwards at
    // least once. Camera-relative is the whole rule: "up" means away from the
    // lens, not north.
    for (const az of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const p = new Player(M.spawn);
      const x0 = p.x, z0 = p.z;
      step(p, { x: 0, y: -1, mag: 1, run: false }, az);
      const dx = p.x - x0, dz = p.z - z0;
      const fx = Math.sin(az), fz = -Math.cos(az);
      const along = dx * fx + dz * fz;
      expect(Math.hypot(dx, dz), `az ${az}: he did not move`).toBeGreaterThan(1);
      expect(along, `az ${az}: he walked toward the camera`).toBeGreaterThan(0.8 * Math.hypot(dx, dz));
    }
  });

  it('turns right when the thumb goes right', () => {
    const p = new Player(M.spawn);
    const x0 = p.x, z0 = p.z;
    step(p, { x: 1, y: 0, mag: 1, run: false }, 0);   // camera looking north
    // Camera bearing 0 looks north; its right is world +X (east).
    expect(p.x - x0).toBeGreaterThan(1);
    expect(Math.abs(p.z - z0)).toBeLessThan(Math.abs(p.x - x0));
  });

  // THE TURN. These three are the "he rotates about a point five or ten feet
  // behind him and slides round it" report, measured. There is no offset in the
  // rig -- a 360 deg sweep puts his hips within 4 mm of the player at every
  // bearing -- so the pivot is made entirely by the BODY's yaw rate and the
  // TRAVEL's turn rate disagreeing. A rigid body whose yaw changes while its
  // path stays straight has its instantaneous centre out at |v| / omega, and at
  // a full run with the body still coming round at 100 deg/s that is twelve feet.
  //
  // Ask what these would pass with: a check on "does he end up facing the thumb"
  // passes on every one of the broken versions, because an exponential does get
  // there eventually. What has to be pinned is WHEN, and at what rate.
  const turnTrial = (turn, warm = 90) => {
    const p = new Player(M.spawn);
    step(p, { x: 0, y: -1, mag: 1, run: false }, 0, warm);
    let pv = Math.atan2(p.vx, -p.vz), peak = 0, arrive = -1, slide = 0, worstFt = 0;
    for (let i = 0; i < 180; i++) {
      p.step(1 / 60, g, turn, 0, false);
      const v = Math.atan2(p.vx, -p.vz);
      const vRate = Math.abs(wrapA(v - pv)) / (1 / 60) * 57.3;
      const bRate = Math.abs(p.yawRate) * 57.3;
      pv = v;
      if (bRate > peak) peak = bRate;
      if (bRate > 30 && vRate < 15 && p.speed > 1) {
        slide++;
        const ft = p.speed / Math.abs(p.yawRate) * 3.281;
        if (ft > worstFt) worstFt = ft;
      }
      if (arrive < 0 && Math.abs(wrapA(p.heading - p.facing)) < 0.02) arrive = i / 60;
    }
    return { peak, arrive, slide, worstFt, p };
  };

  it('never spins the body faster than the feet can redirect him', () => {
    // The ceiling is not a taste number: it is `turnAccel / run`, the rate the
    // VELOCITY can be turned at a full run. Give the body the same one and the
    // two finish together by construction. Before this the opening frame of a
    // reversal put him through 562 deg/s -- one and a half turns a second.
    expect(MOVE.turnRate).toBeCloseTo(MOVE.turnAccel / MOVE.run, 1);
    for (const t of [{ x: 1, y: 0, mag: 1, run: false }, { x: 0, y: 1, mag: 1, run: false }]) {
      const { peak } = turnTrial(t);
      expect(peak, 'the body outran its own ceiling').toBeLessThan(MOVE.turnRate * 57.3 * 1.02);
    }
  });

  it('finishes the turn with the travel, not half a second after it', () => {
    // The tail is the whole complaint. An exponential never arrives, so he ran
    // in a straight line for over a second with his body still visibly rotating.
    // Measured before the floor went in: 1.35 s for a right angle, worst
    // apparent pivot 38 ft. A check on the final facing alone passes on that.
    const a = turnTrial({ x: 1, y: 0, mag: 1, run: false });
    expect(a.arrive, 'a right angle should be done inside half a second').toBeLessThan(0.5);
    expect(a.worstFt, 'still rotating on a straight line').toBeLessThan(14);
    const b = turnTrial({ x: 0, y: 1, mag: 1, run: false });
    expect(b.arrive, 'a reversal should be done inside a second').toBeLessThan(0.9);
    // And it ARRIVES: after the turn there is no residual rotation at all.
    expect(Math.abs(b.p.yawRate)).toBe(0);
  });

  it('a hard turn costs him speed, so the feet plant', () => {
    // Without this he carries a full sprint round a hairpin, which has no read
    // available to it except sliding -- and it is also what lets the
    // turn-in-place clip appear, since that only blends in below a walk.
    const p = new Player(M.spawn);
    step(p, { x: 0, y: -1, mag: 1, run: false }, 0, 90);
    const before = p.speed;
    let lo = 99;
    for (let i = 0; i < 90; i++) {
      p.step(1 / 60, g, { x: 1, y: 0, mag: 1, run: false }, 0, false);
      lo = Math.min(lo, p.speed);
    }
    expect(before).toBeGreaterThan(MOVE.run * 0.9);
    expect(lo, 'a right angle at a full run cost him nothing').toBeLessThan(MOVE.walk * 1.1);
    // and he is back up to speed once he is pointing the new way
    expect(p.speed).toBeGreaterThan(MOVE.run * 0.9);
  });

  it('POSITIVE yawRate is a turn to his RIGHT', () => {
    // Which clip plays hangs on this sign, and it is the argument that comes out
    // backwards half the time in this account. Derived: bearings run north ->
    // east -> south, which is clockwise seen from above, and clockwise from
    // above while facing north is toward the east, which is his right hand.
    // Checked here against his own right vector rather than against intuition.
    for (const [sx, name] of [[1, 'right'], [-1, 'left']]) {
      const p = new Player(M.spawn);
      const fx0 = Math.sin(p.facing), fz0 = -Math.cos(p.facing);
      const rx = -fz0, rz = fx0;                    // his right = forward x up
      step(p, { x: sx, y: 0, mag: 1, run: false }, 0, 6);
      const fx1 = Math.sin(p.facing), fz1 = -Math.cos(p.facing);
      const toward = (fx1 - fx0) * rx + (fz1 - fz0) * rz;
      expect(Math.sign(toward), `turning ${name}: his nose went the other way`).toBe(sx);
      expect(Math.sign(p.yawRate), `turning ${name}: yawRate has the wrong sign`).toBe(sx);
    }
  });

  it('jumps high enough to land on something', () => {
    // PINNED IN METRES, NEVER AS THE CONSTANT. `MOVE.jump` is a speed, and a
    // check that it equals 14.4 passes on any gravity at all -- including one
    // that makes the apex a foot. It shipped at 6.4, which is an apex of 0.88 m
    // against this `g`, and the lowest roof in 1844 buildings around the spawn
    // is 2.2 m: there was literally nothing in the city he could get onto.
    const p = new Player(M.spawn);
    step(p, { x: 0, y: 0, mag: 0, run: false }, 0, 120);
    const y0 = p.y;
    p.step(1 / 60, g, { x: 0, y: 0, mag: 0, run: false }, 0, true);
    let apex = 0, air = 0;
    for (let i = 0; i < 300; i++) {
      p.step(1 / 60, g, { x: 0, y: 0, mag: 0, run: false }, 0, false);
      apex = Math.max(apex, p.y - y0); air += 1 / 60;
      if (p.grounded && i > 3) break;
    }
    expect(apex, 'he cannot reach the lowest roof in the city').toBeGreaterThan(4.2);
    expect(apex, 'that is not a jump, that is low gravity').toBeLessThan(5.4);
    // and he comes back down: a hang past about a second and a half stops
    // reading as a jump whatever the height is.
    expect(air).toBeLessThan(1.5);
  });

  it('only jumps off the ground', () => {
    // Holding the pad down must not be a ladder. Ask what a check on the apex
    // alone would pass with: a version that jumps again every airborne frame.
    const p = new Player(M.spawn);
    step(p, { x: 0, y: 0, mag: 0, run: false }, 0, 120);
    const y0 = p.y;
    let apex = 0;
    for (let i = 0; i < 300; i++) {
      p.step(1 / 60, g, { x: 0, y: 0, mag: 0, run: false }, 0, true);   // held, every frame
      apex = Math.max(apex, p.y - y0);
    }
    expect(apex, 'a held jump climbed for ever').toBeLessThan(5.4);
  });

  it('stays on the ground it is standing on', () => {
    const p = new Player(M.spawn);
    step(p, { x: 0, y: 0, mag: 0, run: false }, 0, 240);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.y - g.groundAt(p.x, p.z, p.y + 1))).toBeLessThan(0.1);
  });

  it('cannot walk through a building', () => {
    // Aim him at the nearest tall footprint and hold the stick down for four
    // seconds. "He slowed down" is not the test; "he is not inside it" is.
    const [bi, bj] = chunkOf(M.spawn.x, M.spawn.z);
    const c = read(bi, bj);
    const ox = W.west + bi * W.chunk, oz = W.north + bj * W.chunk;
    const b = c.bldg.slice().sort((a, x) => (x.top - x.base) - (a.top - a.base))[0];
    let cx = 0, cz = 0;
    for (let k = 0; k < b.nv; k++) { cx += b.ring[k*2] + ox; cz += b.ring[k*2+1] + oz; }
    cx /= b.nv; cz /= b.nv;
    const p = new Player(M.spawn);
    const az = Math.atan2(cx - p.x, -(cz - p.z));
    step(p, { x: 0, y: -1, mag: 1, run: true }, az, 60 * 6);
    const r = g.resolve(p.x, p.z, p.y, MOVE.radius * 0.9);
    expect(r[2], 'he ended up inside a building').toBe(false);
  });
});

describe('the gait', () => {
  // `animate` is a pure weight table over a stub mixer, so it needs no GLB and
  // no GPU. What is under test is which clip is asked for and how much of it --
  // the part that decides whether he steps a turn round or slides through it.
  const rig = (names) => {
    const actions = {};
    for (const n of names) {
      let w = 0, ts = 1;
      actions[n] = { setEffectiveWeight: (v) => { w = v; }, getEffectiveWeight: () => w,
                     setEffectiveTimeScale: (v) => { ts = v; }, get ts() { return ts; } };
    }
    actions.idle.setEffectiveWeight(1);
    return { actions, mixer: { update() {} } };
  };
  const ALL = ['idle', 'walk', 'run', 'rise', 'fall', 'turnL', 'turnR'];
  const settle = (c, opts, n = 40) => {
    for (let i = 0; i < n; i++) animate(c, 1 / 60, opts.speed, true, 0, opts.yaw);
    const w = {}; let sum = 0;
    for (const k of ALL) { w[k] = c.actions[k].getEffectiveWeight(); sum += w[k]; }
    return { w, sum };
  };

  it('never lets the weights drop below one, which would bleed the T-pose in', () => {
    // A table that sums under 1 hands the remainder to the BIND POSE, and the
    // bind pose is a T-pose. It reads as a broken model rather than as a leaked
    // weight, which is why this is pinned rather than trusted.
    for (const speed of [0, 1, MOVE.walk, 3, MOVE.run, MOVE.sprint])
      for (const yaw of [0, 1, 3, 6, -6]) {
        const { sum } = settle(rig(ALL), { speed, yaw });
        expect(sum, `speed ${speed} yaw ${yaw}: weights summed to ${sum.toFixed(3)}`)
          .toBeGreaterThan(0.98);
        expect(sum).toBeLessThan(1.02);
      }
  });

  it('steps a slow turn round rather than sliding through it', () => {
    // The clip was sitting unwired in the export the whole time. Measured on the
    // real player before the speed fade was fixed, it peaked at 0.19 -- present,
    // and invisible, which is the same as absent.
    const right = settle(rig(ALL), { speed: 1.2, yaw: 5.3 });
    expect(right.w.turnR, 'turning right on the spot played no turn clip').toBeGreaterThan(0.6);
    expect(right.w.turnL).toBe(0);
    const left = settle(rig(ALL), { speed: 1.2, yaw: -5.3 });
    expect(left.w.turnL, 'turning left played the RIGHT clip or none').toBeGreaterThan(0.6);
    expect(left.w.turnR).toBe(0);
  });

  it('does not play a turn clip when there is nothing to turn', () => {
    // Ask what this check would pass with: one that only looked for the clip
    // appearing passes on a version that plays it constantly.
    expect(settle(rig(ALL), { speed: 0, yaw: 0 }).w.turnR).toBe(0);
    expect(settle(rig(ALL), { speed: MOVE.run, yaw: 0 }).w.turnR).toBe(0);
    // and not at a run either, where the gait is already doing the turning
    const fast = settle(rig(ALL), { speed: MOVE.run, yaw: 5.3 });
    expect(fast.w.turnR + fast.w.turnL, 'a turn clip laid over a sprint').toBeLessThan(0.05);
    expect(fast.w.run).toBeGreaterThan(0.9);
  });

  it('survives a rig with no turn clips at all', () => {
    // Every other character file in this account is a different export, and a
    // missing clip must degrade rather than throw or leak weight.
    const c = rig(['idle', 'walk', 'run', 'rise', 'fall']);
    let sum = 0;
    for (let i = 0; i < 40; i++) animate(c, 1 / 60, 1.2, true, 0, 5.3);
    for (const k of ['idle', 'walk', 'run']) sum += c.actions[k].getEffectiveWeight();
    expect(sum).toBeGreaterThan(0.98);
  });
});

describe('landmark overrides', () => {
  const burnside = LM.landmarks.find((l) => l.name === 'Burnside Bridge');

  it('clear a region from BOTH the picture and the collider', () => {
    // Filtering only the geometry leaves an invisible building standing inside
    // the hand-built model, which is the worst kind of bug: nothing on screen
    // disagrees with anything and the player simply cannot walk there.
    const ov = new Overrides({
      landmarks: LM.landmarks,
      overrides: { 'Burnside Bridge': { model: 'models/nothing.glb' } },
    });
    const [ci, cj] = chunkOf(burnside.x, burnside.z);
    const raw = read(ci, cj);
    const ox = W.west + ci * W.chunk, oz = W.north + cj * W.chunk;
    const cut = ov.filter(raw, ox, oz, W.chunk);
    expect(cut).not.toBe(raw);
    const before = raw.road.filter((r) => r.flags & 1).length;
    const after = cut.road.filter((r) => r.flags & 1).length;
    expect(before).toBeGreaterThan(0);
    expect(after, 'the generated bridge survived its own override').toBeLessThan(before);

    const g = new Ground(M);
    g.addChunk(ci, cj, cut, NAMES);
    // Inside the box, the only ground left is the river.
    const mx = (burnside.clear.x0 + burnside.clear.x1) / 2;
    const mz = (burnside.clear.z0 + burnside.clear.z1) / 2;
    if (g.terrainAt(mx, mz) < W.waterLevel)
      expect(g.groundAt(mx, mz, 14)).toBeLessThan(W.waterLevel + 1);
  });

  it('are a no-op on a chunk they do not touch', () => {
    const ov = new Overrides({
      landmarks: LM.landmarks,
      overrides: { 'Burnside Bridge': { model: 'models/nothing.glb' } },
    });
    const raw = read(0, 0);
    expect(ov.filter(raw, W.west, W.north, W.chunk)).toBe(raw);
  });

  it('keep a layer when asked to', () => {
    const ov = new Overrides({
      landmarks: LM.landmarks,
      overrides: { 'Burnside Bridge': { model: 'x.glb', keep: ['road'] } },
    });
    const [ci, cj] = chunkOf(burnside.x, burnside.z);
    const raw = read(ci, cj);
    const cut = ov.filter(raw, W.west + ci * W.chunk, W.north + cj * W.chunk, W.chunk);
    expect(cut.road.length).toBe(raw.road.length);
    expect(cut.bldg.length).toBeLessThanOrEqual(raw.bldg.length);
  });
});

describe('the crowd', () => {
  // A crowd that walks through walls and down the middle of Burnside is worse
  // than no crowd, so these check WHERE they are, not that they exist.
  const g = new Ground(M);
  const live = [];
  const [ci, cj] = chunkOf(M.spawn.x, M.spawn.z);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ci + di, j = cj + dj;
    const raw = read(i, j);
    g.addChunk(i, j, raw, NAMES);
    live.push({ raw, ox: W.west + i * W.chunk, oz: W.north + j * W.chunk });
  }

  it('finds a pavement network in the real city', () => {
    const p = new Pavements();
    const n = p.rebuild(live, NAMES.road);
    expect(n, 'no pavement anywhere near the spawn').toBeGreaterThan(200);
    // Every segment must be walkable-length and have a real direction.
    for (const s of p.seg) {
      expect(s.L).toBeGreaterThan(1);
      expect(Number.isFinite(s.ay) && Number.isFinite(s.by)).toBe(true);
    }
  });

  it('walks people along it, and keeps them ON it', () => {
    const crowd = new Crowd({ add() {} }, THREE);
    const moved = new Map();
    for (let k = 0; k < 400; k++) {
      crowd.step(1 / 30, M.spawn.x, M.spawn.z, live, NAMES.road);
      for (const p of crowd.people) if (p.live) {
        const was = moved.get(p);
        if (was) moved.set(p, was + Math.hypot(p.x - was.x, p.z - was.z) || was);
        else moved.set(p, { x: p.x, z: p.z, d: 0 });
      }
    }
    const walking = crowd.people.filter((p) => p.live);
    expect(walking.length, 'nobody spawned').toBeGreaterThan(8);

    const pav = crowd.pav;
    let onPath = 0;
    for (const p of walking) {
      // Nearest point on any pavement segment. Anyone further off than half a
      // pavement plus a body is not on the pavement.
      let best = 1e9;
      for (const s of pav.seg) {
        const ex = s.bx - s.ax, ez = s.bz - s.az;
        const L2 = ex * ex + ez * ez || 1;
        let t = ((p.x - s.ax) * ex + (p.z - s.az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        best = Math.min(best, Math.hypot(p.x - (s.ax + ex * t), p.z - (s.az + ez * t)));
      }
      if (best < 1.2) onPath++;
    }
    expect(onPath, `${walking.length - onPath} of ${walking.length} walked off the pavement`)
      .toBe(walking.length);
  });

  it('does not put anybody inside a building', () => {
    const crowd = new Crowd({ add() {} }, THREE);
    for (let k = 0; k < 300; k++) crowd.step(1 / 30, M.spawn.x, M.spawn.z, live, NAMES.road);
    let inside = 0;
    for (const p of crowd.people) {
      if (!p.live) continue;
      if (g.resolve(p.x, p.z, p.y + 0.9, 0.05)[2]) inside++;
    }
    // Not zero: OSM footways legitimately run through arcades and under
    // overhangs, and a building footprint is its outline at the ground. A
    // handful is the data; a quarter of the crowd would be the walker.
    expect(inside / Math.max(1, crowd.people.filter((p) => p.live).length))
      .toBeLessThan(0.15);
  });

  it('gives every walker a body that is the right way out and the right size', () => {
    const crowd = new Crowd({ add() {} }, THREE);
    for (let seed = 1; seed <= 40; seed++) {
      const p = crowd.spawn(seed, seed);
      p.live = true; p.x = 0; p.y = 0; p.z = 0; p.yaw = 0.3; p.phase = seed * 0.7;
      const s = new Soup(64);
      figure(s, p, 5);
      const gg = s.done();
      let v = 0, lo = 1e9, hi = -1e9, wlo = 1e9, whi = -1e9;
      for (let t = 0; t < gg.tris; t++) {
        const i = t * 9, P = gg.position;
        v += (P[i]   * (P[i+4]*P[i+8] - P[i+5]*P[i+7])
            + P[i+1] * (P[i+5]*P[i+6] - P[i+3]*P[i+8])
            + P[i+2] * (P[i+3]*P[i+7] - P[i+4]*P[i+6])) / 6;
        for (let k = 0; k < 9; k += 3) {
          lo = Math.min(lo, P[i+k+1]); hi = Math.max(hi, P[i+k+1]);
          wlo = Math.min(wlo, P[i+k]); whi = Math.max(whi, P[i+k]);
        }
      }
      expect(v, `walker ${seed} is inside out`).toBeGreaterThan(0);
      expect(lo, `walker ${seed} has a foot under the pavement`).toBeGreaterThan(-0.05);
      expect(hi, `walker ${seed} is ${hi.toFixed(2)} m tall`).toBeLessThan(2.4);
      expect(hi).toBeGreaterThan(1.4);
      // A person is about 0.5 m across, and an umbrella or a dog widens the
      // record rather than the body. Two metres means the proportions are gone.
      expect(whi - wlo, `walker ${seed} is ${(whi-wlo).toFixed(2)} m wide`).toBeLessThan(2.0);
    }
  });

  it('is deterministic: the same seat is the same person', () => {
    const a = new Crowd({ add() {} }, THREE);
    const b = new Crowd({ add() {} }, THREE);
    for (let i = 0; i < 12; i++) {
      const x = a.spawn(i, i + 1), y = b.spawn(i, i + 1);
      expect(x.height).toBe(y.height);
      expect(x.top).toEqual(y.top);
      expect(x.speed).toBe(y.speed);
    }
  });
});

describe('shopfronts', () => {
  it('sit on a wall, facing out of it', () => {
    // A sign whose outward normal points INTO the building is a sign on the
    // inside of the shop, and from the street it is simply not there.
    let checked = 0;
    const wrong = [];
    for (let j = 0; j < W.n; j += 2) for (let i = 0; i < W.n; i += 2) {
      const c = read(i, j);
      if (!c.shop.length) continue;
      for (const sh of c.shop) {
        const fx = Math.sin(sh.yaw), fz = -Math.cos(sh.yaw);
        // Step a metre and a half out along the facing; that must leave the
        // building, and stepping back in must enter one.
        const out = nearestBuilding(c, sh.x + fx * 1.4, sh.z + fz * 1.4);
        const inn = nearestBuilding(c, sh.x - fx * 0.9, sh.z - fz * 0.9);
        if (!inn) continue;
        checked++;
        if (out) wrong.push(sh.name);
      }
    }
    expect(checked, 'no shopfront could be tested against its wall').toBeGreaterThan(500);
    // Not zero, and stated rather than hidden: a hospital campus or a school
    // has courtyards with buildings on every side, and a chunk's footprint list
    // stops at the chunk edge, so a wall facing the next block over reads as
    // facing a building. A few per cent is the city; fourteen was taking the
    // NEAREST wall instead of the one that faces a road.
    expect(wrong.length / checked,
           `${wrong.length}/${checked} face into a building: ${wrong.slice(0, 4).join(', ')}`)
      .toBeLessThan(0.05);
  });

  it('carries real business names', () => {
    const names = new Set();
    for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++)
      for (const sh of read(i, j).shop) names.add(sh.name);
    expect(names.size).toBeGreaterThan(2000);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
  });

  it('builds geometry that faces the street', () => {
    let boards = 0;
    for (let j = 0; j < W.n && boards < 200; j += 3) for (let i = 0; i < W.n; i += 3) {
      const c = read(i, j);
      if (!c.shop.length) continue;
      const gg = buildShops(c.shop.slice(0, 20), NAMES.shop);
      expect(gg.tris).toBeGreaterThan(0);
      boards += gg.tris;
    }
    expect(boards).toBeGreaterThan(100);
  });
});

function nearestBuilding(c, x, z) {
  for (const b of c.bldg) {
    let inside = false;
    for (let i = 0, j = b.nv - 1; i < b.nv; j = i++) {
      const xi = b.ring[i*2], zi = b.ring[i*2+1], xj = b.ring[j*2], zj = b.ring[j*2+1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

describe('ambient life', () => {
  // A plane, boats and traffic are the cheapest thing in the game and the
  // easiest to get subtly wrong: a car on the wrong side of the road, a boat
  // on dry land, a hull lit from inside. None of those change a triangle
  // count, so every check here pins a POSITION or a DIRECTION.
  const live = [];
  const [ci, cj] = chunkOf(M.spawn.x, M.spawn.z);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ci + di, j = cj + dj;
    live.push({ raw: read(i, j), ox: W.west + i * W.chunk, oz: W.north + j * W.chunk });
  }
  const stubScene = { add() {} };

  it('the bake found a river, and it runs the length of the city', () => {
    const r = M.routes && M.routes.river;
    expect(r, 'no river route in the manifest -- boats have nowhere to be').toBeTruthy();
    expect(r.length).toBeGreaterThan(40);
    // NORTH TO SOUTH, which is the direction the Willamette runs here, and the
    // check that would fail if river_route() ever picked up the Columbia --
    // four times the area and entirely north of the play area. It did, once.
    expect(r[0][1]).toBeLessThan(W.north + 300);
    expect(r[r.length - 1][1]).toBeGreaterThan(W.south - 300);
    for (const p of r) {
      expect(p[0]).toBeGreaterThan(W.west);
      expect(p[0]).toBeLessThan(W.east);
      expect(p[2], 'a 60 m "river" is a slough').toBeGreaterThan(30);
    }
    // Downtown is WEST of the river and Ladd's Addition is EAST of it. The
    // route has to agree with that or it is not the Willamette.
    const mid = r[(r.length / 2) | 0];
    expect(Math.abs(mid[0]), 'the river should pass near the anchor').toBeLessThan(900);
  });

  it('boats float on the river, not on the land beside it', () => {
    const a = new Ambient(stubScene, THREE, M, { skyline: { x: 0, z: 0 } });
    expect(a.boats.length, 'no boats').toBeGreaterThan(2);
    const R = M.routes.river;
    for (let k = 0; k < 900; k++) a.step(1 / 20, M.spawn.x, 3, M.spawn.z, live, NAMES.road);
    for (const b of a.boats) {
      expect(b.y).toBeCloseTo(W.waterLevel, 3);
      // Nearest point on the centreline, which must be inside the half width
      // the bake measured for that stretch.
      let best = 1e9, hw = 0;
      for (let i = 0; i < R.length - 1; i++) {
        const ax = R[i][0], az = R[i][1], ex = R[i+1][0] - ax, ez = R[i+1][1] - az;
        const L2 = ex * ex + ez * ez || 1;
        let t = ((b.x - ax) * ex + (b.z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(b.x - (ax + ex * t), b.z - (az + ez * t));
        if (d < best) { best = d; hw = R[i][2]; }
      }
      expect(best, 'a boat left the channel').toBeLessThan(hw);
    }
  });

  it('cars drive on the RIGHT, which is the whole feature', () => {
    // Offset to the wrong side is a head-on collision with every other car on
    // the street, and it reads instantly on a phone and not at all in a count.
    const a = new Ambient(stubScene, THREE, M, { skyline: { x: 0, z: 0 } });
    for (let k = 0; k < 200; k++) a.step(1 / 20, M.spawn.x, 3, M.spawn.z, live, NAMES.road);
    const driving = a.cars.filter((c) => c.live);
    expect(driving.length, 'no traffic anywhere near the spawn').toBeGreaterThan(4);
    const segs = a.lanes.seg;
    for (const c of driving) {
      const s = segs[c.si];
      const ux = (s.bx - s.ax) / s.L * c.dir, uz = (s.bz - s.az) / s.L * c.dir;
      // Which side of the centreline he is on, measured along his own RIGHT.
      // Right of a heading (ux, uz) is (-uz, ux) with +X east and +Z south.
      let t = ((c.x - s.ax) * (s.bx - s.ax) + (c.z - s.az) * (s.bz - s.az)) / (s.L * s.L);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = c.x - (s.ax + (s.bx - s.ax) * t), dz = c.z - (s.az + (s.bz - s.az) * t);
      expect(dx * -uz + dz * ux, 'a car on the wrong side of the road')
        .toBeGreaterThan(0.2);
      // And his yaw has to agree with where he is going, or he drives sideways.
      expect(Math.sin(c.yaw) * ux + -Math.cos(c.yaw) * uz).toBeGreaterThan(0.99);
    }
  });

  it('a car points its NOSE the way it is travelling', () => {
    // A box is symmetric, so nothing about the geometry says which end is
    // front -- except the headlamps, which are the one asymmetry in it. They
    // must be forward of the tail lamps along the direction of travel.
    const s = new Soup(256);
    const c = { x: 0, y: 0, z: 0, yaw: 0.9, len: 4.3, wide: 1.8, tall: 1.44,
                big: false, col: [200, 200, 200] };
    car(s, c);
    const g = s.done();
    const fx = Math.sin(c.yaw), fz = -Math.cos(c.yaw);
    let head = -1e9, tail = 1e9;
    for (let v = 0; v < g.tris * 3; v++) {
      const i = v * 3, along = g.position[i] * fx + g.position[i+2] * fz;
      const r = g.color[i], gr = g.color[i+1], b = g.color[i+2];
      if (r > 240 && gr > 230 && b > 190) head = Math.max(head, along);   // headlamp
      if (r > 150 && r < 190 && gr < 60 && b < 60) tail = Math.min(tail, along);
    }
    expect(head, 'no headlamps on the car').toBeGreaterThan(0);
    expect(head, 'the car is driving backwards').toBeGreaterThan(tail);
  });

  it('every ambient body encloses a POSITIVE volume', () => {
    // The divergence theorem again, for the same reason it is on the props:
    // a hull wound inside out still renders, and what it costs is the
    // lighting. A boat is seen at four hundred metres and a plane from
    // directly underneath, so neither gets to skip a face either.
    const vol = (g) => {
      let v = 0;
      for (let t = 0; t < g.tris; t++) {
        const i = t * 9, P = g.position;
        v += (P[i]   * (P[i+4]*P[i+8] - P[i+5]*P[i+7])
            + P[i+1] * (P[i+5]*P[i+6] - P[i+3]*P[i+8])
            + P[i+2] * (P[i+3]*P[i+7] - P[i+4]*P[i+6])) / 6;
      }
      return v;
    };
    for (const yaw of [0, 0.7, 2.4, -1.9]) {
      let s = new Soup(64);
      prism(s, [3, 4, 5], 1, 2, 3, yaw, [120, 120, 120]);
      expect(vol(s.done()), `prism inside out at yaw ${yaw}`).toBeCloseTo(48, 3);

      // A ring listed CLOCKWISE from above must come out the same way up as
      // one listed anticlockwise -- that normalisation is the whole point of
      // `closed`, and without it half the fleet is lit from inside.
      for (const dir of [1, -1]) {
        s = new Soup(64);
        const ring = [[-1, -2], [1, -2], [1, 2], [-1, 2]];
        closed(s, (x, y, z) => [x, y, z], dir > 0 ? ring : ring.slice().reverse(),
               0, 3, [200,200,200], [150,150,150], [90,90,90]);
        expect(vol(s.done()), `closed() inside out, ring dir ${dir}`).toBeCloseTo(24, 3);
      }

      s = new Soup(256);
      plane(s, 10, 800, -30, yaw);
      expect(vol(s.done()), `the aircraft is inside out at yaw ${yaw}`).toBeGreaterThan(0);

      s = new Soup(256);
      heli(s, 10, 300, -30, yaw, 1.3);
      expect(vol(s.done()), `the helicopter is inside out at yaw ${yaw}`).toBeGreaterThan(0);
    }
  });

  it('the plane descends toward the real airport', () => {
    const a = new Ambient(stubScene, THREE, M, { skyline: { x: 0, z: 0 } });
    // PDX is north-EAST of the Burnside Bridge: +x and -z from the anchor.
    expect(a.airport.x, 'the airport is east of downtown').toBeGreaterThan(3000);
    expect(a.airport.z, 'the airport is north of downtown').toBeLessThan(-4000);

    for (let k = 0; k < 4000 && !a.plane; k++) a.step(1 / 20, 0, 3, 0, live, NAMES.road);
    expect(a.plane, 'no plane ever appeared').toBeTruthy();
    // It flies TOWARD the airport, and it comes DOWN on the way. An approach
    // that holds altitude is a plane going somewhere else, and reads as a
    // sticker pinned to the sky.
    const toward = (a.airport.x * a.plane.hx + a.airport.z * a.plane.hz) /
                   Math.hypot(a.airport.x, a.airport.z);
    expect(toward).toBeGreaterThan(0.5);
    const y0 = AIR.plane.y0, y1 = AIR.plane.y1;
    expect(y1).toBeLessThan(y0);
    expect(y1, 'an airliner at rooftop height over downtown').toBeGreaterThan(200);
  });

  it('the whole layer is ONE draw call and stays small', () => {
    const a = new Ambient(stubScene, THREE, M, { skyline: { x: 0, z: 0 } });
    for (let k = 0; k < 400; k++) a.step(1 / 20, M.spawn.x, 3, M.spawn.z, live, NAMES.road);
    expect(a.live, 'nothing drawn at all').toBeGreaterThan(50);
    // The brief was "I don't want to get super heavy". Thirty cars, five
    // boats, a plane and a helicopter live inside one geometry; if this ever
    // needs raising, the question to ask first is whether it should be a
    // second draw call instead.
    expect(a.live, 'the ambient layer has got heavy').toBeLessThan(6000);
    expect(a.mesh.geometry.attributes.position.array.length).toBeGreaterThanOrEqual(a.live * 9);
  });
});

describe('the names you can read', () => {
  // A sign says the right thing or it says it BACKWARDS, and a mirrored name
  // is worse than no name: it reads as a rendering fault rather than as a
  // street. Nothing about the triangle count, the position or the atlas
  // changes when it happens, so the check has to pin the DIRECTION the text
  // runs in -- against a normal derived from the sign's own data, never from
  // the quad, which would make it circular and always pass.
  const live = [];
  const [ci, cj] = chunkOf(M.spawn.x, M.spawn.z);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ci + di, j = cj + dj;
    live.push({ raw: read(i, j), ox: W.west + i * W.chunk, oz: W.north + j * W.chunk });
  }
  for (const rec of live) { rec.shops = rec.raw.shop; rec.sign = rec.raw.sign; }

  /** Reader's right, for somebody standing out along a board's own normal. */
  const readerRight = (ox, oz) => {
    // Viewer forward is -normal, up is +Y, and right = forward x up.
    // forward = (-ox, 0, -oz) -> right = (-oz, 0, ox) ... derived, not guessed:
    // (-ox,0,-oz) x (0,1,0) = (0*0 - (-oz)*1, (-oz)*0 - (-ox)*0, (-ox)*1 - 0) = (oz, 0, -ox)
    return [oz, -ox];
  };

  it('street blades read forwards from the side you are standing on', () => {
    // ONE SIGN AT A TIME. Matching a board back to a sign BY NAME is what the
    // first version did and it is wrong: "SW ANKENY ST" is on a dozen corners
    // and the street bends between them, so the yaw it was checked against
    // belonged to a different junction and the check came out at -0.06 -- a
    // near miss that looks exactly like a real one.
    let tested = 0;
    for (const rec of live) for (const sg of rec.sign) {
      const out = [];
      streetBoards({ sign: [sg], ox: rec.ox, oz: rec.oz },
                   rec.ox + sg.x, rec.oz + sg.z, out);
      if (!out.length) continue;
      tested++;
      const b = out[0];
      expect(b.quads.length, 'a blade needs text on BOTH sides').toBe(2);
      const fx = Math.sin(sg.yaw), fz = -Math.cos(sg.yaw);
      // Front face looks along +n, back face along -n.
      for (const [side, [A, B]] of [[1, b.quads[0]], [-1, b.quads[1]]]) {
        const [rx, rz] = readerRight(-fz * side, fx * side);
        const ax = B[0] - A[0], az = B[2] - A[2];
        expect(ax * rx + az * rz,
          `"${b.name}" is mirrored on its ${side > 0 ? 'front' : 'back'}`).toBeGreaterThan(0);
      }
    }
    expect(tested, 'no blades near the spawn').toBeGreaterThan(20);
  });

  it('shop names read forwards too, and the two boards disagree about which way that is', () => {
    // A shop board's own axis runs along `(-fz, fx)` with its face out along
    // `(fx, fz)`; a blade's runs the other way round. One of them has to list
    // its corners in the opposite order, which is exactly the kind of thing
    // that is right until somebody tidies it.
    let tested = 0;
    for (const rec of live) for (const sh of rec.shops) {
      const out = [];
      shopBoards({ shops: [sh], ox: rec.ox, oz: rec.oz },
                 rec.ox + sh.x, rec.oz + sh.z, out, NAMES.shop);
      if (!out.length) continue;
      tested++;
      const b = out[0];
      const [rx, rz] = readerRight(Math.sin(sh.yaw), -Math.cos(sh.yaw));
      const [A, B] = b.quads[0];
      expect((B[0] - A[0]) * rx + (B[2] - A[2]) * rz,
        `"${b.name}" is mirrored`).toBeGreaterThan(0);
    }
    expect(tested, 'no shopfronts near the spawn').toBeGreaterThan(20);
  });

  it('a blade is a closed box at the top of a post, with no NaN in it', () => {
    const one = { post: 1, blade: 0, yaw: 1.1, x: 0, z: 0, y: 5, name: 'SE HAWTHORNE BLVD' };
    const g = buildStreetSigns([one]);
    expect(g.tris).toBeGreaterThan(20);
    let lo = 1e9, hi = -1e9;
    for (let v = 0; v < g.tris * 3; v++) {
      expect(Number.isFinite(g.position[v*3]), 'NaN vertex').toBe(true);
      lo = Math.min(lo, g.position[v*3+1]); hi = Math.max(hi, g.position[v*3+1]);
    }
    for (let t = 0; t < g.tris; t++)
      expect(Number.isFinite(g.normal[t*9]), 'a degenerate face').toBe(true);
    // The post's foot is on the ground it was given and the blade is at the top
    // of it -- a sign floating a metre up, or buried, is the same one line.
    expect(lo).toBeCloseTo(one.y, 2);
    expect(hi).toBeGreaterThan(one.y + 2.4);
    expect(hi).toBeLessThan(one.y + 3.4);
    // A blade wide enough to hold its name, and not a hoarding.
    expect(bladeW(one.name)).toBeGreaterThan(1.2);
    expect(bladeW(one.name)).toBeLessThan(2.6);
    // The second blade hangs under the first, or they occupy the same air.
    expect(bladeY({ blade: 1 })).toBeLessThan(bladeY({ blade: 0 }) - 0.2);
  });

  it('a name that repeats costs ONE atlas cell', () => {
    // 435 street names over 2,275 junctions: the same blade is on both corners
    // and on the next block too. A cell per BOARD spends the whole atlas on
    // four copies of one street, which is what makes this the difference
    // between the blades being readable and the shops being readable.
    const st = fakeSignText();
    const boards = [
      { score: 1, name: 'SE HAWTHORNE BLVD', ink: '#fff', quads: [Q(0), Q(1)] },
      { score: 2, name: 'SE 12TH AVE', ink: '#fff', quads: [Q(2), Q(3)] },
      { score: 3, name: 'SE HAWTHORNE BLVD', ink: '#fff', quads: [Q(4), Q(5)] },
      { score: 4, name: 'SE HAWTHORNE BLVD', ink: '#fff', quads: [Q(6)] },
    ];
    st.update(99, 0, 0, [{}], (rec, px, pz, out) => out.push(...boards));
    expect(st.cells, 'four boards, three of them the same street').toBe(2);
    expect(st.quads, 'every board still gets its quads').toBe(7);
  });
});

const Q = (k) => [[k, 0, 0], [k + 1, 0, 0], [k + 1, 1, 0], [k, 1, 0]];

/** SignText against a canvas stub: node has no DOM and the logic under test
 *  is the CELL BOOKKEEPING, which never touches a pixel. */
function fakeSignText() {
  const ctx = {
    clearRect() {}, fillText() {},
    measureText: (s) => ({ width: s.length * 8, actualBoundingBoxLeft: s.length * 4,
      actualBoundingBoxRight: s.length * 4, actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2 }),
    set font(_) {}, get font() { return ''; }, set fillStyle(_) {},
    set textAlign(_) {}, set textBaseline(_) {},
  };
  globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
  return new SignText({ add() {} });
}

describe('per-prop LOD', () => {
  // The whole trick is taking ONE prop out of a merged buffer without
  // rebuilding it. If the collapse silently fails, the city looks fine and
  // every hero prop is drawn TWICE, low version inside high -- which is
  // invisible on a tree and reads as a dark slab inside a car. Nothing about
  // the draw count or the triangle count says so, because both go up either
  // way.
  const [ci, cj] = chunkOf(M.spawn.x, M.spawn.z);
  const raw = read(ci, cj);

  const rec = () => {
    const d = buildProps(raw.prop, NAMES.prop, 'full', true);
    const geo = { attributes: { position: {
      array: Float32Array.from(d.position), needsUpdate: false,
      addUpdateRange() {} } } };
    return { id: `${ci},${cj}`, lod: 'full', props: raw.prop, ranges: d.ranges,
             propGeo: geo, ox: W.west + ci * W.chunk, oz: W.north + cj * W.chunk,
             original: Float32Array.from(d.position) };
  };

  it('records a triangle span for every prop, covering the whole buffer', () => {
    const d = buildProps(raw.prop, NAMES.prop, 'full', true);
    expect(d.ranges.length).toBe(raw.prop.n * 2);
    let at = 0;
    for (let i = 0; i < raw.prop.n; i++) {
      // Contiguous and in order, or a collapse writes over its neighbour.
      expect(d.ranges[i*2], `prop ${i} span does not follow the one before`).toBe(at);
      at += d.ranges[i*2+1];
    }
    expect(at, 'the spans do not add up to the buffer').toBe(d.tris);
  });

  it('collapses a prop to nothing and puts it back exactly', () => {
    const r = rec();
    const h = new Hero({ add() {} }, THREE, NAMES.prop);
    // Pick a prop that HAS a hero version and some triangles.
    let idx = -1;
    for (let i = 0; i < raw.prop.n; i++) {
      if (HERO.on.has(NAMES.prop[raw.prop.kind[i]]) && r.ranges[i*2+1] > 4) { idx = i; break; }
    }
    expect(idx, 'no detailable prop in this chunk').toBeGreaterThanOrEqual(0);
    const w = { rec: r, i: idx, name: NAMES.prop[raw.prop.kind[idx]] };
    const at = r.ranges[idx*2] * 9, n = r.ranges[idx*2+1];

    h.collapse(w);
    const A = r.propGeo.attributes.position.array;
    for (let t = 0; t < n; t++) {
      const o = at + t * 9;
      // Every triangle zero-area: a degenerate triangle is thrown away before
      // rasterisation, which is what makes this free.
      const ux = A[o+3]-A[o], uy = A[o+4]-A[o+1], uz = A[o+5]-A[o+2];
      const vx = A[o+6]-A[o], vy = A[o+7]-A[o+1], vz = A[o+8]-A[o+2];
      const area = Math.hypot(uy*vz - uz*vy, uz*vx - ux*vz, ux*vy - uy*vx);
      expect(area, 'a collapsed triangle still has area').toBeLessThan(1e-9);
    }
    // AND NOT AT THE ORIGIN. A degenerate triangle still counts toward a
    // bounding sphere, so parking every hidden prop at (0,0,0) grows the
    // chunk's sphere to the middle of the city and turns its frustum culling
    // off in every direction at once.
    expect(Math.abs(A[at]) + Math.abs(A[at+2]),
      'collapsed to the origin').toBeGreaterThan(1);

    // Nothing outside the span moved.
    for (let k = 0; k < at; k++) expect(A[k]).toBe(r.original[k]);
    for (let k = at + n * 9; k < A.length; k++) expect(A[k]).toBe(r.original[k]);

    h.restore(w);
    for (let k = at; k < at + n * 9; k++)
      expect(A[k], `vertex ${k} came back different`).toBeCloseTo(r.original[k], 4);
  });

  it('never double-draws: a chunk rebuilt under a hero is collapsed again', () => {
    // `chunk:index` names the same prop in the old buffer and the new one, so
    // a set diff on the key alone decides nothing changed and the prop is
    // never collapsed in the fresh buffer -- drawn low AND hero, in the same
    // place, for as long as you stand there.
    const h = new Hero({ add() {} }, THREE, NAMES.prop);
    const a = rec();
    h.step(99, a.ox + a.props.pos[0], a.oz + a.props.pos[1], [a]);
    expect(h.on.size, 'nothing was picked').toBeGreaterThan(0);
    const b = rec();                                   // same chunk, new buffer
    b.id = a.id;
    a.dead = true;
    h.step(99, b.ox + b.props.pos[0], b.oz + b.props.pos[1], [b]);
    for (const [, w] of h.on) {
      expect(w.rec, 'a hero still points at the dropped buffer').toBe(b);
      const at = b.ranges[w.i*2] * 9, n = b.ranges[w.i*2+1];
      const A = b.propGeo.attributes.position.array;
      let moved = 0;
      for (let k = at; k < at + n * 9; k++) if (A[k] !== b.original[k]) moved++;
      expect(moved, `prop ${w.i} was not collapsed in the new buffer`).toBeGreaterThan(0);
    }
  });

  it('every hero prop encloses a POSITIVE volume', () => {
    // The divergence theorem again. A hero car is where the wheels are, and a
    // wheel is the first closed cylinder in this file -- inside out it still
    // renders and is simply lit from within, which on a tyre looks like a tyre.
    for (const name of HERO.on) {
      const look = PROPS[name];
      if (!look) continue;
      const s = new Soup(512);
      oneProp(s, name, look, 0, 0, 0, 1, 0.6, 2, 2);
      const g = s.done();
      expect(g.tris, `${name} has no hero version`).toBeGreaterThan(10);
      let v = 0;
      for (let t = 0; t < g.tris; t++) {
        const i = t * 9, P = g.position;
        v += (P[i]   * (P[i+4]*P[i+8] - P[i+5]*P[i+7])
            + P[i+1] * (P[i+5]*P[i+6] - P[i+3]*P[i+8])
            + P[i+2] * (P[i+3]*P[i+7] - P[i+4]*P[i+6])) / 6;
        expect(Number.isFinite(g.normal[i]), `${name} has a degenerate face`).toBe(true);
      }
      expect(v, `the hero ${name} is inside out`).toBeGreaterThan(0);
    }
  });

  it('a hero prop is heavier than the one it replaces, and a full set still fits', () => {
    let worst = 0;
    for (const name of HERO.on) {
      const look = PROPS[name];
      if (!look) continue;
      const lo = new Soup(256), hi = new Soup(512);
      oneProp(lo, name, look, 0, 0, 0, 1, 0.6, 2, 1);
      oneProp(hi, name, look, 0, 0, 0, 1, 0.6, 2, 2);
      const a = lo.done().tris, b = hi.done().tris;
      expect(b, `the hero ${name} is not actually more detailed`).toBeGreaterThan(a);
      worst = Math.max(worst, b);
    }
    // A BUDGET IN TRIANGLES, NOT A RATIO. The ratio is the wrong number to
    // pin: a plain car is thirty triangles and a plain tree fourteen, so the
    // same absolute cost reads as 14x on one and 30x on the other, and a test
    // written on it fails for the kind that started cheapest rather than for
    // the one that got expensive. What matters is that a FULL SET fits: 44 of
    // the heaviest kind is the worst this can ever cost, against a frame that
    // is already drawing six hundred thousand.
    expect(worst * HERO.count, `a full hero set is ${worst * HERO.count} triangles`)
      .toBeLessThan(26000);
  });
});
