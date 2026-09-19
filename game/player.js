// Locomotion. Plutopia's model, cut to what a city needs.
//
// Three separate ideas, and skipping the third is what produces a moonwalk:
//   1. `heading` is the THUMB, taken instantly, in world space.
//   2. `facing` is the BODY, easing round to it -- fast on the spot, slow at a run.
//   3. the velocity is rebuilt with its ALONG and ACROSS parts on different
//      rates. Building speed and changing direction are different jobs, and one
//      acceleration for both is a false economy: low enough to give a wind-up
//      and he skates through every turn; high enough to turn and there is no
//      wind-up at all.
//
// The stick is CAMERA-RELATIVE, which is the one thing not to "simplify". Map it
// to compass directions and "push up" walks him north whichever way the lens is
// pointing -- sideways at best, backwards when the camera has swung behind him.

import { MOVE } from './tune.js';

const damp = (a, b, hl, dt) => b + (a - b) * Math.pow(2, -dt / hl);

export class Player {
  constructor(spawn) {
    this.x = spawn.x; this.z = spawn.z; this.y = spawn.y;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.heading = 0;             // radians, the thumb's bearing as a yaw
    this.facing = 0;              // radians, the body
    this.speed = 0;
    this.grounded = true;
    this.airT = 0;
    this.swimming = false;
    this.wantRun = true;
    // Ghost is for looking at the city, not for playing it: no gravity, no
    // collider, free vertical. Every screenshot in tools/shot.mjs is taken
    // through it, which is also why it lives here rather than in the harness --
    // a harness that drives a mode the game does not have measures nothing.
    this.ghost = false;
    this.lift = 0;
  }

  step(dt, ground, move, camAz, jump) {
    // The stick in world metres: its +Y is DOWN THE SCREEN, and "away from the
    // camera" is where the lens is looking. camAz is the bearing the camera
    // looks along, so forward is (sin, -cos) of it -- the same heading_vec the
    // baker uses, which is why they agree.
    const fx = Math.sin(camAz), fz = -Math.cos(camAz);
    const rx = -fz, rz = fx;                       // his right, = forward x up
    let wx = rx * move.x - fx * move.y;
    let wz = rz * move.x - fz * move.y;
    const mag = Math.min(1, Math.hypot(wx, wz));
    if (mag > 1e-4) { wx /= mag || 1; wz /= mag || 1; this.heading = Math.atan2(wx, -wz); }

    if (this.ghost) {
      this.x += (wx * MOVE.run * 2) * dt * mag;
      this.z += (wz * MOVE.run * 2) * dt * mag;
      this.y += this.lift * dt;
      this.vx = this.vz = this.vy = 0;
      this.speed = 0; this.grounded = false; this.swimming = false;
      if (mag > 1e-4) this.facing = this.heading;
      return;
    }
    this.swimming = ground.inWater(this.x, this.z);
    const top = this.swimming ? MOVE.walk * 0.85
      : mag < 0.55 ? MOVE.walk + (MOVE.run - MOVE.walk) * (mag / 0.55)
      : move.run ? MOVE.run + (MOVE.sprint - MOVE.run) * ((mag - 0.55) / 0.45)
      : MOVE.run;
    const want = mag > 1e-4 ? top * Math.min(1, mag * 1.35) : 0;
    const tx = wx * want, tz = wz * want;

    // Split the correction against the way he is already going.
    const sp = Math.hypot(this.vx, this.vz);
    let hx = 0, hz = 0;
    if (sp > 0.05) { hx = this.vx / sp; hz = this.vz / sp; }
    else if (mag > 1e-4) { hx = wx; hz = wz; }
    const dx = tx - this.vx, dz = tz - this.vz;
    const along = dx * hx + dz * hz;
    const acx = dx - along * hx, acz = dz - along * hz;
    const rate = (along >= 0 ? MOVE.accel : MOVE.decel) * (this.grounded ? 1 : MOVE.airControl);
    const turn = MOVE.turnAccel * (this.grounded ? 1 : MOVE.airControl);
    this.vx += clampTo(along * hx, rate * dt) + clampTo(acx, turn * dt);
    this.vz += clampTo(along * hz, rate * dt) + clampTo(acz, turn * dt);

    if (this.grounded && jump && !this.swimming) {
      this.vy = MOVE.jump; this.grounded = false; this.airT = 0;
    }
    this.vy -= MOVE.g * dt;
    if (this.swimming) this.vy = Math.max(this.vy, -1.2);

    // Move and resolve. The collider runs in sub-steps by DISTANCE, not by
    // time: at nine metres a second a long frame covers a third of a metre, and
    // a wall is a few centimetres thick in plan.
    const stepLen = Math.hypot(this.vx * dt, this.vz * dt);
    const n = Math.max(1, Math.min(6, Math.ceil(stepLen / 0.25)));
    for (let k = 0; k < n; k++) {
      let nx = this.x + this.vx * dt / n, nz = this.z + this.vz * dt / n;
      const r = ground.resolve(nx, nz, this.y, MOVE.radius);
      if (r[2]) {
        // Keep what he had ALONG the wall and lose only what went into it, so a
        // graze costs nothing and a square hit stops him. A bare scrub would
        // make the lightest brush against a shopfront a dead stop.
        const px = r[0] - nx, pz = r[1] - nz;
        const L = Math.hypot(px, pz) || 1;
        const into = this.vx * (px / L) + this.vz * (pz / L);
        if (into < 0) { this.vx -= into * (px / L); this.vz -= into * (pz / L); }
      }
      this.x = r[0]; this.z = r[1];
    }
    this.y += this.vy * dt;

    const g = ground.groundAt(this.x, this.z, this.y + MOVE.step);
    const floor = this.swimming ? Math.max(g, ground.waterLevel - 0.85) : g;
    if (this.y <= floor + 0.02) {
      this.y = floor;
      if (this.vy < 0) this.vy = 0;
      this.grounded = true; this.airT = 0;
    } else if (this.y - floor < MOVE.step && this.vy <= 0.01) {
      this.y = floor;                       // step up a kerb rather than collide
      this.vy = 0; this.grounded = true; this.airT = 0;
    } else {
      this.airT += dt;
      if (this.airT > MOVE.coyote) this.grounded = false;
    }

    this.speed = Math.hypot(this.vx, this.vz);
    const hl = MOVE.faceHL * (1 + Math.min(1, this.speed / MOVE.run) * 1.4);
    if (this.speed > 0.25 || mag > 1e-4) {
      this.facing = this.facing + wrap(this.heading - this.facing) *
        (1 - Math.pow(2, -dt / hl));
    }
  }
}

function clampTo(v, lim) { return v > lim ? lim : v < -lim ? -lim : v; }
function wrap(a) { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; }
export { wrap, damp };
