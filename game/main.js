// Boot, the frame, and the wiring between everything else.
//
// The boot order is load-bearing in one place: the CITY has to be on screen
// before the button lights, because dropping in to an empty grey plane and
// watching Portland pop in around you is worse than waiting two more seconds.
// Everything else -- the far skyline, the character, the map -- can arrive late
// and says so rather than holding the door.

import * as THREE from 'three';
import { makeSticks } from './input.js';
import { Ground } from './ground.js';
import { World } from './world.js';
import { Player, wrap } from './player.js';
import { Camera } from './camera.js';
import { loadColin, animate } from './character.js';
import { makeSky } from './sky.js';
import { Overrides } from './overrides.js';
import { SignText, shopBoards } from './shops.js';
import { streetBoards } from './streets.js';
import { Crowd } from './crowd.js';
import { Ambient } from './ambient.js';
import { Hero } from './hero.js';
import { CAM, MOVE, SKY, STREAM } from './tune.js';

const BUILD = 'p1';
const DATA = new URL('../data/', import.meta.url).href;
const q = (id) => document.getElementById(id);
const boot = (msg, frac) => {
  q('bootMsg').textContent = msg;
  if (frac !== undefined) q('barFill').style.width = Math.round(Math.min(1, frac) * 100) + '%';
};

// The zoom guard USED TO LIVE HERE and has moved into the head of index.html,
// beside the crash trap. A guard that only installs once this module has
// evaluated is absent for the whole of the loading screen -- and absent
// entirely if the module throws, which is exactly the moment somebody starts
// jabbing at a page that is not responding.

const renderer = new THREE.WebGLRenderer({
  canvas: q('gl'), antialias: false, powerPreference: 'high-performance' });
renderer.setClearColor(SKY.horizon);
// NEUTRAL, NOT ACES. Both keep a bright city off the clipping point, and ACES
// is the default reach -- but ACES is a FILM curve and it desaturates as it
// rolls off, which on a hand-picked palette means the palette quietly stops
// existing: measured on the same frame, a sage ground came back a neutral grey.
// Khronos's neutral curve is built to hold hue and saturation through the
// highlight roll-off, which is the whole job here. `NoToneMapping` is the third
// option and it is the wrong one: every lit pale wall clips to flat white.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = SKY.exposure;
const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
const DPR_CAP = MOBILE ? 1.6 : 2;
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(CAM.fov, 1, 0.35, 7000);
makeSky(scene);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, DPR_CAP));
  renderer.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let world, ground, player, camera, colin, sticks, manifest, places = null, ov = null;
let signs = null, crowd = null, ambient = null, hero = null;
let running = false, last = 0, fps = 0, frames = 0, fpsT = 0, hudT = 0;
let dbg = 0;

(async function init() {
  try {
    boot('reading the manifest', 0.02);
    manifest = await (await fetch(DATA + 'manifest.json')).json();
    ground = new Ground(manifest);
    let lm = { landmarks: [], overrides: {} };
    try { lm = await (await fetch(DATA + 'landmarks.json')).json(); } catch (_) {}
    ov = new Overrides(lm);
    world = new World(scene, manifest, ground, DATA, ov);
    player = new Player(manifest.spawn);
    camera = new Camera(cam);
    camera.az = 1.34;                        // opening shot looks toward downtown
    camera.lx = player.x; camera.ly = player.y + CAM.height; camera.lz = player.z;

    signs = new SignText(scene);
    crowd = new Crowd(scene, THREE);
    hero = new Hero(scene, THREE, manifest.classes.prop);

    boot('the skyline', 0.1);
    const nfar = await world.loadFar();
    // After the skyline, because the helicopter orbits where the skyline SAYS
    // downtown is -- built before it, and it would circle the world origin.
    ambient = new Ambient(scene, THREE, manifest, world);

    boot('the streets', 0.2);
    // Build the spawn's neighbourhood before anything else, synchronously
    // enough that the first frame is a city rather than a plane.
    const near = world.want(player.x, player.z).slice(0, 12);
    await Promise.all(near.map((w) => world.fetch(w.i, w.j)));
    for (const w of near) {
      const c = world.pending.get(w.i + ',' + w.j);
      if (c) world.build(w.i, w.j, w.lod, c);
      boot('the streets', 0.2 + 0.4 * (near.indexOf(w) + 1) / near.length);
    }
    player.y = ground.groundAt(player.x, player.z, player.y + 2) + 0.05;

    boot('Colin', 0.65);
    try {
      colin = await loadColin((f) => boot('Colin', 0.65 + f * 0.3));
      scene.add(colin.root);
    } catch (e) {
      // A missing character is a city you can still fly around. It is not a
      // reason for a blank screen, and the chip says so out loud.
      if (window.__crash) window.__crash('colin: ' + (e.message || e));
    }

    if (ov.list.length) {
      boot('hand-built landmarks', 0.95);
      const n = await ov.load(scene, DATA);
      console.log(`[pdx] ${n}/${ov.list.length} override models placed`);
    }

    boot('places', 0.97);
    try { places = await (await fetch(DATA + 'places.json')).json(); } catch (_) {}

    boot(`${nfar} towers · ${manifest.chunks.length} chunks`, 1);
    q('startB').className = 'on';
    q('startB').onclick = start;
    // A tap anywhere on the card starts it too: the button is where the eye
    // goes and the whole card is where a thumb goes.
    q('boot').onclick = (e) => { if (e.target.id !== 'startB') start(); };
  } catch (e) {
    boot('could not load the city');
    if (window.__crash) window.__crash('init: ' + (e.message || e));
    throw e;
  }
})();

function start() {
  if (running) return;
  running = true;
  q('boot').className = 'gone';
  setTimeout(() => { q('boot').style.display = 'none'; }, 700);
  setTimeout(() => { q('hint').style.opacity = 0; }, 6000);
  sticks = makeSticks();
  last = performance.now();
  requestAnimationFrame(frame);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  // A tab that was backgrounded hands back a dt of several seconds, which
  // teleports him through the city and out the far side of the collider.
  if (dt > 0.1) dt = 0.1;
  if (dt <= 0) return;

  let mv = sticks.move();
  const lk = sticks.look();
  // A scripted walk, for tools/shot.mjs. It drives the SAME stick the thumb
  // drives -- a harness that pokes the player's position directly is measuring
  // a game that does not exist.
  const w = window.pdx && window.pdx.__walk;
  if (w && w.t > 0) { w.t -= dt; mv = { x: w.x, y: w.y, mag: 1, run: false }; }
  camera.step(dt, player, lk, ground);
  player.step(dt, ground, mv, camera.az, sticks.jump());
  world.update(player.x, player.z);
  if (signs) signs.update(dt, player.x, player.z, world.loaded(), collectBoards);
  if (crowd) crowd.step(dt, player.x, player.z, world.loaded(), manifest.classes.road);
  if (ambient) ambient.step(dt, player.x, player.y, player.z, world.loaded(), manifest.classes.road);
  // AFTER world.update, which is what creates and drops the chunk buffers it
  // writes into -- a hero holding a range in a geometry that was disposed on
  // the same frame writes into nothing, and does it silently.
  if (hero) hero.step(dt, player.x, player.z, world.loaded());
  if (ov) ov.step(player.x, player.z, DATA);

  if (colin) {
    colin.root.position.set(player.x, player.y, player.z);
    colin.root.rotation.y = -player.facing;
    animate(colin, dt, player.speed, player.grounded, player.vy, player.yawRate);
  }

  renderer.render(scene, cam);

  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  hudT += dt;
  if (hudT > 0.25) { hudT = 0; hud(); }
}

// ONE atlas for every name in the world. Shopfronts and street blades both push
// into it, neither knows the other exists, and the whole lot is one draw call.
function collectBoards(rec, px, pz, out) {
  shopBoards(rec, px, pz, out, manifest.classes.shop);
  streetBoards(rec, px, pz, out);
}

function hud() {
  const s = world.stats();
  const info = renderer.info.render;
  q('chip').innerHTML =
    `<b>${BUILD}</b> · ${fps.toFixed(0)} fps · ${info.calls} dc · ` +
    `${(info.triangles / 1000).toFixed(0)}k tri · ${s.live} chunks` +
    (s.fetching ? ` · loading ${s.fetching}` : '') +
    (crowd && crowd.live ? ` · ${crowd.people.filter((p) => p.live).length} people` : '') +
    (ambient && ambient.live ? ` · ${ambient.cars.filter((c) => c.live).length} cars` : '') +
    (dbg ? `<br>x ${player.x.toFixed(0)} z ${player.z.toFixed(0)} y ${player.y.toFixed(1)}` +
           ` · ${ground.terrainAt(player.x, player.z).toFixed(1)}m ground` +
           (player.swimming ? ' · SWIMMING' : '') +
           (colin ? ` · rig ${colin.facing.from}` : ' · NO COLIN') : '');
  q('where').textContent = placeName();
}

function placeName() {
  if (!places) return '';
  let best = null, bd = 1e9;
  for (const p of places.near) {
    const d = (p[1] - player.x) ** 2 + (p[2] - player.z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best && bd < 160 * 160 ? best[0] : '';
}

// ---- keys ------------------------------------------------------------------
q('kLook').onclick = () => camera.toggleHigh();
q('kDbg').onclick = () => { dbg = (dbg + 1) % 2; hud(); };
q('kMap').onclick = () => openMap();

function openMap() {
  const wrap_ = q('mapWrap'), c = q('map');
  if (wrap_.classList.contains('on')) { wrap_.classList.remove('on'); q('mapHint').style.display = 'none'; return; }
  const img = new Image();
  img.onload = () => {
    const S = Math.min(innerWidth * 0.94, innerHeight * 0.8);
    c.width = c.height = Math.round(S * Math.min(2, devicePixelRatio || 1));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const w = manifest.world;
    const u = (player.x - w.west) / (w.east - w.west) * c.width;
    const v = (player.z - w.north) / (w.south - w.north) * c.height;
    g.strokeStyle = '#1b1b1b'; g.lineWidth = 3;
    g.fillStyle = '#ffb24a';
    g.beginPath(); g.arc(u, v, 9, 0, 6.283); g.fill(); g.stroke();
    // A heading needle, because a dot says where and the question is which way.
    const hx = Math.sin(player.facing), hz = -Math.cos(player.facing);
    g.beginPath(); g.moveTo(u, v); g.lineTo(u + hx * 26, v + hz * 26);
    g.lineWidth = 4; g.strokeStyle = '#ffb24a'; g.stroke();
    c.style.width = S + 'px'; c.style.height = S + 'px';
    wrap_.classList.add('on');
    q('mapHint').style.display = 'block';
  };
  img.onerror = () => { if (window.__crash) window.__crash('map.png did not load'); };
  img.src = DATA + 'map.png';
}
q('mapWrap').onclick = () => { q('mapWrap').classList.remove('on'); q('mapHint').style.display = 'none'; };

// The console handle, the same shape every other game in this account has.
window.pdx = { get player() { return player; }, get world() { return world; },
               // The pads and the character, for the console and for
               // `tools/thumbs.mjs`. `__animate` is a harness hook beside
               // `__walk`: the gait is a pure weight table and the only way to
               // ask what it is doing on a real rig is to step it yourself.
               get sticks() { return sticks; },
               get colin() { return colin; }, __animate: animate,
               get ground() { return ground; }, get camera() { return camera; },
               get ambient() { return ambient; },
               get hero() { return hero; },
               get signs() { return signs; },
               THREE, scene, renderer,
               // Teleporting has to land you OUTSIDE. Dropped straight onto a
               // coordinate you are as likely as not inside a building, and a
               // camera inside a building is a black screen that looks exactly
               // like a broken renderer.
               go(x, z) {
                 player.y = ground.terrainAt(x, z) + 1;
                 for (let i = 0; i < 12; i++) {
                   const r = ground.resolve(x, z, player.y, MOVE.radius + 0.35);
                   x = r[0]; z = r[1];
                   if (!r[2]) break;
                   player.y = ground.terrainAt(x, z) + 1;
                 }
                 player.x = x; player.z = z;
                 player.y = ground.groundAt(x, z, player.y + 2) + 0.05;
                 player.vx = player.vz = player.vy = 0;
                 camera.lx = x; camera.ly = player.y + CAM.height; camera.lz = z;
               },
               ghost(on = true, y) { player.ghost = on; if (y !== undefined) player.y = y; },
               get landmarks() { return ov.landmarks; },
               /**
                * Print an override entry for wherever you are standing.
                *
                * Authoring a clear box by typing coordinates into JSON is how you
                * get a box that is nearly right, and "nearly right" here is a
                * building left standing inside your model. Walk to the corner,
                * call this, paste.
                */
               here(r = 40) {
                 const x = Math.round(player.x), z = Math.round(player.z);
                 const y = Math.round(ground.terrainAt(x, z));
                 const a = manifest.anchor;
                 const entry = { model: 'models/your-thing.glb', x, y, z, yaw: 0, scale: 1,
                   clear: { x0: x - r, z0: z - r, x1: x + r, z1: z + r, y0: y - 10, y1: y + 80 } };
                 console.log('lat,lon  ' + (a.lat - z / a.metresPerDegLat).toFixed(6) + ',' +
                             (a.lon + x / a.metresPerDegLon).toFixed(6));
                 console.log(JSON.stringify({ [`a name for this place`]: entry }, null, 2));
                 return entry;
               },
               near(n = 6) {
                 return ov.landmarks
                   .map((L) => ({ ...L, d: Math.round(Math.hypot(L.x - player.x, L.z - player.z)) }))
                   .sort((a, b) => a.d - b.d).slice(0, n)
                   .map((L) => `${L.d} m  ${L.kind}  ${L.name}  (${L.id})`);
               },
               to(lat, lon) {
                 const a = manifest.anchor;
                 this.go((lon - a.lon) * a.metresPerDegLon, -(lat - a.lat) * a.metresPerDegLat);
               } };
