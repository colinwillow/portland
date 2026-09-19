// A follow camera with a horizontal orbit, and nothing else on the right thumb.
//
// The orbit is a RATE, not a position: deflection sets how fast the view turns.
// Reading the stick's absolute direction instead means small pushes do nothing
// and the rim snaps the whole view round at once -- Robits shipped that and
// wrote it down, twice.
//
// The boom SHORTENS against geometry rather than lifting over it. Lifting is
// the reflex fix and it turns the shot into the top-down one you were trying to
// avoid: the fix and the bug are the same mechanism. Snap in, ease out -- easing
// in is time spent inside a wall.

import { CAM, MOVE } from './tune.js';

export class Camera {
  constructor(cam) {
    this.cam = cam;
    this.az = 0;              // bearing the lens LOOKS along
    this.pitch = CAM.pitch;
    this.dist = CAM.dist;
    this.have = CAM.dist;
    this.lx = 0; this.ly = 0; this.lz = 0;
    this.high = false;
  }

  toggleHigh() { this.high = !this.high; }

  step(dt, p, look, ground) {
    const t = Math.abs(look.x) < 0.09 ? 0 : (look.x - Math.sign(look.x) * 0.09) / 0.91;
    this.az += t * CAM.orbitRate * dt;
    const wantPitch = this.high ? CAM.pitchHi : CAM.pitch;
    this.pitch += (wantPitch - this.pitch) * (1 - Math.pow(2, -dt / 0.25));

    const tx = p.x, ty = p.y + CAM.height, tz = p.z;
    const k = 1 - Math.pow(2, -dt / CAM.lookHL);
    this.lx += (tx - this.lx) * k; this.ly += (ty - this.ly) * k; this.lz += (tz - this.lz) * k;

    // WHEN THERE IS NO ROOM BEHIND HIM, THE BOOM CLIMBS. In a street canyon --
    // or against the one facade he happens to be standing at -- there can be
    // half a metre behind his head and nothing will make a shot out of that.
    // Swinging the BEARING would fight the thumb that owns it; swinging the
    // PITCH does not, and in a city the sky is the one direction that is always
    // open. Three probes, and the shallowest that has room wins.
    let pitch = this.pitch, free = 0, bx = 0, by = 0, bz = 0;
    for (const lift of CAM.lifts) {
      const p = Math.min(CAM.pitchMax, this.pitch + lift);
      const ca = Math.cos(p);
      const tx = -Math.sin(this.az) * ca, tz = Math.cos(this.az) * ca, ty = Math.sin(p);
      const f = this.probe(ground, this.lx, this.ly, this.lz, tx, ty, tz, CAM.dist);
      if (f > free) { free = f; pitch = p; bx = tx; by = ty; bz = tz; }
      if (f >= CAM.room) break;
    }
    this.shot = pitch;
    // Snap in, ease out.
    this.have = free < this.have ? free
      : this.have + (free - this.have) * (1 - Math.pow(2, -dt / 0.5));
    // CLAMPING TO A MINIMUM PUTS THE LENS INSIDE THE WALL. The probe returns
    // how much room there actually is; taking `max(minDist, that)` overrides it
    // with a number that is by definition too big, and a camera inside a
    // facade is a black screen that reads as a broken renderer. On a tight
    // pavement the shot is allowed to come right up on his shoulder instead,
    // which is ugly and is never nothing.
    const d = Math.max(CAM.hardMin, this.have);
    void 0;
    this.cam.position.set(this.lx + bx * d, this.ly + by * d, this.lz + bz * d);
    this.cam.lookAt(this.lx, this.ly, this.lz);
  }

  probe(ground, x, y, z, bx, by, bz, max) {
    // Walked, not raycast, and coarse on purpose: the city is tens of thousands
    // of boxes in a hash, so a dozen lookups beats any ray structure, and a lens
    // clipping a lamp post for an instant is not the failure a lens inside a
    // building is.
    let last = 0;
    for (let d = CAM.probe; d <= max; d += CAM.probe) {
      const px = x + bx * d, pz = z + bz * d, py = y + by * d;
      const r = ground.resolve(px, pz, py, 0.34);
      const under = ground.terrainAt(px, pz) + 0.55;
      if (r[2] || py < under) {
        // Bisect: a boom quantised to the probe step JUMPS sixty centimetres at
        // a time as the shot sways past a wall, which reads as the camera
        // popping. Four more lookups make the number continuous.
        let lo = last, hi = d;
        for (let i = 0; i < 4; i++) {
          const m = (lo + hi) * 0.5;
          const q = ground.resolve(x + bx * m, z + bz * m, y + by * m, 0.34);
          if (q[2] || (y + by * m) < ground.terrainAt(x + bx * m, z + bz * m) + 0.55) hi = m;
          else lo = m;
        }
        return lo;
      }
      last = d;
    }
    return max;
  }
}
