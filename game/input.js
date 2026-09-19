// Twin thumb sticks. Ported forward from the Joystick that went Robits -> Peggy
// -> Big Don -> Shredworld, cut down to the two verbs this game has: the left
// thumb walks, the right thumb looks. The flick detector, the shoot zone and the
// tap gestures are deliberately NOT here -- they exist in those games because
// something needed them, and an unused gesture is a way to fire the wrong verb.
//
// What IS kept is everything those repos paid for:
//
//  * FLOATING ORIGIN. The stick centres wherever the thumb lands inside a big
//    invisible half-screen. You never look at your thumbs on a phone.
//  * DRAWN AT REST. They sit dim at an anchor rather than appearing on touch.
//    An invisible control is indistinguishable from a broken one.
//  * A STUCK STICK IS ALWAYS A MISSING `pointerup`, and there are four ways one
//    goes missing on a phone. All four are closed below. There is deliberately
//    NO WATCHDOG: a pointer that is not moving generates no events, so "no
//    events" and "no thumb" are the same observation, and a test that cannot
//    tell its two answers apart is not a test. Its false positive -- dropping a
//    hold somebody is in the middle of -- is worse than the bug.

const DEAD = 0.055;

export class Stick {
  constructor(zone, ring, knob, anchor) {
    this.zone = zone; this.ring = ring; this.knob = knob;
    this.anchor = anchor;                 // () => [x, y] in css px
    this.id = null;
    this.x = 0; this.y = 0; this.mag = 0;
    this.radius = 58;
    this.ox = 0; this.oy = 0;
    this.park();

    zone.addEventListener('pointerdown', (e) => this.down(e), { passive: false });
    zone.addEventListener('pointermove', (e) => this.move(e), { passive: false });
    // The window hears every release, in the CAPTURE phase, which runs before
    // any target handler and cannot be stopped by one. Capture can be lost
    // without `lostpointercapture` ever reaching us, and the up then lands
    // somewhere else entirely -- this is the net under that.
    addEventListener('pointerup', (e) => this.up(e), true);
    addEventListener('pointercancel', (e) => this.up(e), true);
    // Backgrounding the app with a thumb down delivers nothing on the way out
    // and nothing on the way back. This is the one that leaves a stick parked
    // at full deflection with no finger anywhere near it.
    addEventListener('blur', () => this.release());
    addEventListener('pagehide', () => this.release());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.release(); });
  }

  park() {
    const [x, y] = this.anchor();
    this.ox = x; this.oy = y;
    this.place(x, y, x, y, false);
  }

  place(cx, cy, kx, ky, live) {
    this.ring.style.left = cx + 'px'; this.ring.style.top = cy + 'px';
    this.knob.style.left = kx + 'px'; this.knob.style.top = ky + 'px';
    this.ring.className = 'ring ' + (live ? 'live' : 'rest');
    this.knob.className = 'knob ' + (live ? 'live' : 'rest');
  }

  down(e) {
    // A stick has ONE thumb by definition; a second touch on the same pad is
    // simply not ours. Overwriting `id` here means the first finger's release
    // no longer matches and is thrown away, and the pad stays held for ever.
    if (this.id !== null) return;
    e.preventDefault();
    this.id = e.pointerId;
    this.ox = e.clientX; this.oy = e.clientY;
    this.place(this.ox, this.oy, this.ox, this.oy, true);
    // setPointerCapture THROWS if the pointer has already gone, and calling it
    // after `id` is set leaves the pad tracking an id whose up has been and
    // gone. Set it last, and survive the throw.
    try { this.zone.setPointerCapture(e.pointerId); } catch (_) {}
  }

  move(e) {
    if (e.pointerId !== this.id) return;
    e.preventDefault();
    let dx = e.clientX - this.ox, dy = e.clientY - this.oy;
    const d = Math.hypot(dx, dy);
    if (d > this.radius) { dx *= this.radius / d; dy *= this.radius / d; }
    this.x = dx / this.radius; this.y = dy / this.radius;
    const m = Math.hypot(this.x, this.y);
    this.mag = m < DEAD ? 0 : (m - DEAD) / (1 - DEAD);
    this.place(this.ox, this.oy, this.ox + dx, this.oy + dy, true);
  }

  up(e) { if (e.pointerId === this.id) this.release(); }

  release() {
    if (this.id === null) return;
    try { this.zone.releasePointerCapture(this.id); } catch (_) {}
    this.id = null;
    this.x = this.y = this.mag = 0;
    this.park();
  }
}

export function makeSticks() {
  const q = (id) => document.getElementById(id);
  const bottom = () => innerHeight - 120 - (visualViewport ? 0 : 0);
  const L = new Stick(q('zL'), q('ringL'), q('knobL'), () => [Math.min(112, innerWidth * 0.22), bottom()]);
  const R = new Stick(q('zR'), q('ringR'), q('knobR'), () => [innerWidth - Math.min(112, innerWidth * 0.22), bottom()]);
  addEventListener('resize', () => { L.park(); R.park(); });
  // Keyboard is here so this is debuggable on a laptop, and that is ALL it is
  // for. The bar for done is two thumbs on a phone.
  const keys = new Set();
  addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  return {
    L, R, keys,
    move() {
      let x = L.x, y = L.y, m = L.mag;
      if (L.id === null) {
        x = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0);
        y = (keys.has('s') ? 1 : 0) - (keys.has('w') ? 1 : 0);
        const d = Math.hypot(x, y);
        m = d > 0 ? Math.min(1, d) : 0;
        if (d > 1) { x /= d; y /= d; }
      }
      return { x, y, mag: m, run: keys.has('shift') || m > 0.86 };
    },
    look() {
      if (R.id !== null) return { x: R.x, y: R.y };
      return { x: (keys.has('arrowright') ? 1 : 0) - (keys.has('arrowleft') ? 1 : 0),
               y: (keys.has('arrowdown') ? 1 : 0) - (keys.has('arrowup') ? 1 : 0) };
    },
    jump() { return keys.has(' '); },
  };
}
