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
    this.yawRate = 0;        // signed, rad/s; + is a turn to his right
    this.jumps = 0;          // spent since he last touched the ground
    this.flip = -1;          // phase 0..1 through the air flip, -1 when there is none
    this.flipDur = 0.7;
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
      this.speed = 0; this.grounded = false; this.swimming = false; this.yawRate = 0;
      if (mag > 1e-4) this.facing = this.heading;
      return;
    }
    this.swimming = ground.inWater(this.x, this.z);
    const top = this.swimming ? MOVE.walk * 0.85
      : mag < 0.55 ? MOVE.walk + (MOVE.run - MOVE.walk) * (mag / 0.55)
      : move.run ? MOVE.run + (MOVE.sprint - MOVE.run) * ((mag - 0.55) / 0.45)
      : MOVE.run;
    // Which way he is already going, so the correction can be split against it.
    const sp = Math.hypot(this.vx, this.vz);
    let hx = 0, hz = 0;
    if (sp > 0.05) { hx = this.vx / sp; hz = this.vz / sp; }
    else if (mag > 1e-4) { hx = wx; hz = wz; }

    // A HARD TURN COSTS HIM SPEED, and that is what plants the feet. Every
    // other game in this account has this and Portland did not: he carried a
    // full sprint round a hairpin, and a body travelling flat out while
    // rotating has no read available to it except sliding. It is also what
    // lets the turn-in-place clip appear at all -- a reversal now drops him
    // under a walk, which is where that clip takes over. There is no brake
    // from a standstill, because `hx, hz` falls back to the thumb.
    const dot = mag > 1e-4 ? wx * hx + wz * hz : 1;     // +1 straight on, -1 a reversal
    const brake = 1 - MOVE.turnBrake * (1 - dot) * 0.5;
    // AND HE PUSHES OFF WHERE HIS FEET ARE POINTING, NOT WHERE THE THUMB IS.
    // This is Plutopia's `plant`, and its absence was the last quarter of the
    // slide: nothing stopped him accelerating flat out in a direction his body
    // was nowhere near, which is a man travelling one way and pointing another,
    // which is the definition of the thing being complained about. It is also
    // what gives the turn clip a window to exist in -- measured, the peak weight
    // on a reversal from a standstill went 0.19 (invisible) to over half.
    const face = mag > 1e-4 ? Math.cos(wrap(this.heading - this.facing)) : 1;
    const plant = MOVE.plant + (1 - MOVE.plant) * Math.max(0, face);
    const want = mag > 1e-4 ? top * Math.min(1, mag * 1.35) * brake * plant : 0;
    const tx = wx * want, tz = wz * want;
    const dx = tx - this.vx, dz = tz - this.vz;
    const along = dx * hx + dz * hz;
    const acx = dx - along * hx, acz = dz - along * hz;
    const rate = (along >= 0 ? MOVE.accel : MOVE.decel) * (this.grounded ? 1 : MOVE.airControl);
    const turn = MOVE.turnAccel * (this.grounded ? 1 : MOVE.airControl);
    this.vx += clampTo(along * hx, rate * dt) + clampTo(acx, turn * dt);
    this.vz += clampTo(along * hz, rate * dt) + clampTo(acz, turn * dt);

    // ONE IN THE AIR, AND `jumps > 0` IS THE GATE. Walking off a kerb grants
    // nothing -- the second jump exists only if he actually spent the first, so
    // stepping off a roof is a fall and not a free save. `coyote` still covers
    // the first for a tenth of a second after the ground goes.
    //
    // THE KICK IS SET, NEVER ADDED. Adding to whatever he had sends a double off
    // the top of the first into orbit and one taken late in a fall nowhere at
    // all; setting it makes the air jump the same height whenever it is spent,
    // which is what makes it a save you can rely on.
    //
    // And it is deliberately WEAKER than the first, so the first stays a
    // decision rather than half of a move you always do twice.
    if (jump && !this.swimming) {
      if (this.grounded) {
        this.vy = MOVE.jump; this.grounded = false; this.airT = 0; this.jumps = 1;
      } else if (this.jumps > 0 && this.jumps < MOVE.jumps) {
        this.vy = MOVE.jump * MOVE.second; this.jumps++;
        // AND HE GOES OVER. The clip is fitted to the air he has just bought --
        // 2v/g is the whole hang, and the flip takes `flipFill` of it -- rather
        // than played at its own length, which would finish three quarters of
        // the way up and leave him falling out of a landing pose.
        this.flip = 0;
        this.flipDur = MOVE.flipFill * 2 * (MOVE.jump * MOVE.second) / MOVE.g;
      }
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
      this.grounded = true; this.airT = 0; this.jumps = 0;
    } else if (this.y - floor < MOVE.step && this.vy <= 0.01) {
      this.y = floor;                       // step up a kerb rather than collide
      this.vy = 0; this.grounded = true; this.airT = 0; this.jumps = 0;
    } else {
      this.airT += dt;
      if (this.airT > MOVE.coyote) this.grounded = false;
    }

    // The flip runs on its own clock and the GROUND ends it: a rotation still
    // going on the frame he lands reads as a bail, and one held after landing
    // is the clip welded on, which is a bug this account has paid for twice.
    if (this.flip >= 0) {
      this.flip += dt / this.flipDur;
      if (this.flip >= 1 || this.grounded) this.flip = -1;
    }

    this.speed = Math.hypot(this.vx, this.vz);

    // HOW THE BODY COMES ROUND, AND A BARE EXPONENTIAL IS NOT IT. This was
    // three quarters of "he rotates about a point five or ten feet behind him
    // and slides round it", and the measurement says why. An exponential puts
    // most of the turn in the first two frames and then never arrives:
    //
    //   standstill, thumb swung a quarter turn   1071 deg/s on the opening frame
    //   running, thumb reversed                   592 deg/s on the opening frame
    //   and at t = 0.4 .. 0.7 s, STILL turning 118 -> 29 deg/s while the speed
    //   sits flat at 6.4 and the velocity has long since finished its turn
    //
    // That tail is the whole complaint. The velocity's turn is done, so he is
    // running in a STRAIGHT LINE while his body is visibly still rotating --
    // and a body that rotates while translating straight is, exactly, a body
    // rotating about a point off to one side of itself. There is no offset
    // anywhere in the rig (a 360 deg sweep puts the hips within 4 mm of the
    // player at every bearing); the pivot is made by the two rates disagreeing.
    //
    // So: a CEILING kills the snap, and a FLOOR is what makes it ARRIVE. The
    // ease in between is still what gives it a shape. The ceiling is the SAME
    // RATE the velocity turns at (see `MOVE.turnRate`), so the two finish
    // together and nothing is left rotating on a straight line.
    const err = wrap(this.heading - this.facing);
    let d = 0;
    if (this.speed > 0.25 || mag > 1e-4) {
      const cap = MOVE.turnRate * dt;
      const floor = MOVE.turnMin * dt;
      d = err * (1 - Math.pow(2, -dt / MOVE.faceHL));
      if (Math.abs(d) < floor) d = Math.sign(err) * floor;
      if (Math.abs(d) > cap) d = Math.sign(err) * cap;
      // Arrive rather than overshoot: the floor is what would otherwise hunt
      // back and forth across the heading for ever on a gentle curve.
      if (Math.abs(err) <= Math.abs(d)) { d = err; this.facing = this.heading; }
      else this.facing += d;
    }
    // Signed yaw rate, rad/s, for the animation. POSITIVE IS A TURN TO HIS
    // RIGHT: bearings run north -> east -> south, which is clockwise seen from
    // above, and clockwise from above while facing north is toward the east,
    // which is his right hand. Derived rather than eyeballed, and pinned by a
    // test -- this is the argument that comes out backwards half the time.
    this.yawRate = dt > 0 ? d / dt : 0;
  }
}

function clampTo(v, lim) { return v > lim ? lim : v < -lim ? -lim : v; }
function wrap(a) { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; }
export { wrap, damp };
