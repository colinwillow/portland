// Can every verb be reached with two thumbs?
//
// That is this account's bar for done, and it is not a matter of taste: a game
// that needs a keyboard is a game that cannot be played on the phone it is
// deployed to. The jump shipped as `keys.has(' ')` and nothing else -- so on
// glass there was no jump at all, and nothing on screen said so.
//
// THIS DRIVES REAL POINTER EVENTS AT THE REAL PADS AND WATCHES THE PLAYER.
// Reading `input.js` proves a branch exists; it does not prove the gesture
// reaches it, and it certainly does not prove the gesture is told apart from
// the one it shares a pad with. Every case below is one the tap must NOT fire
// on -- a camera drag that happens to end near the middle, a long hold, a thumb
// that flicks out and back between two frames -- because each of those is a
// jump the player did not ask for while they were looking somewhere else.
//
//   node tools/thumbs.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.bin':'application/octet-stream',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.glb':'model/gltf-binary', '.wasm':'application/wasm', '.mp3':'audio/mpeg',
  '.webmanifest':'application/manifest+json' };

const ROOT = path.resolve(process.argv[2] || '.');
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
         '--no-sandbox','--disable-dev-shm-usage'] });
// Landscape, because that is how it is held.
const page = await browser.newPage({ viewport: { width: 844, height: 390 },
                                     hasTouch: true, isMobile: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
// The sticks do not exist until the card is dismissed -- `makeSticks()` is
// inside `start()`. Press the button the player presses.
await page.waitForSelector('#startB.on', { timeout: 240000 });
await page.click('#startB');
// WAIT FOR THE CONTROL TO BE THE THING UNDER THE THUMB, not merely for the
// module to exist. `#boot` is `z-index: 20` across the whole viewport until the
// city is up, so a tap sent before it lifts lands on the loading card -- and
// every NEGATIVE case in this file then passes for the wrong reason, because
// nothing at all reaches the pad. That is the shape of bug this harness exists
// to catch, and the first version of it had exactly that.
await page.waitForFunction(() => {
  if (!(window.pdx && window.pdx.player && window.pdx.player.grounded)) return false;
  const r = document.getElementById('ringR').getBoundingClientRect();
  if (r.width < 10) return false;
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!el && el.id === 'zR';
}, null, { timeout: 90000 });
await page.waitForTimeout(600);

// Where the right pad actually is, asked of the page rather than assumed: it
// floats with the viewport and a hard-coded coordinate is a test that passes by
// missing the control.
const pad = await page.evaluate(() => {
  const r = document.getElementById('ringR').getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, over: el && el.id };
});
if (pad.over !== 'zR') { console.log(`FAIL the right pad is not what a thumb hits: ${pad.over}`); process.exit(1); }

// TWO WAYS OF SENDING A GESTURE, AND BOTH ARE NEEDED.
//
// A real CDP tap goes through the browser's own input path -- hit testing,
// capture, the lot -- which is the only thing that proves the pad is actually
// what a thumb lands on. What it CANNOT do is timing: two `mouse.move` calls
// against a page running a heavy rAF loop measured 835 ms end to end, so every
// case with a deliberate travel in it came out as a long hold and read as a
// failure of the game rather than of the harness.
//
// So the discrimination cases are dispatched in-page, where the timestamps are
// under control. That path skips hit testing, which is exactly why the first
// case below is NOT dispatched that way: between them they cover both halves.
// LATCH THE JUMP IN THE PAGE, NEVER POLL FOR IT FROM HERE. Under swiftshader
// this runs at about 10 fps, so a poll every 16 ms over 12 samples is two
// frames -- and the first version missed the jump inside its own window and
// then caught it during the NEXT case, which reported the drag jumping and the
// tap not. The suite was green on four of five and every one of those was
// meaningless. A rAF loop in the page is on the same clock as the game's own
// and cannot miss a frame.
await page.evaluate(() => {
  window.__jw = { peak: 0, air: false };
  (function tick() {
    const p = window.pdx && window.pdx.player;
    if (p) { if (p.vy > window.__jw.peak) window.__jw.peak = p.vy; if (!p.grounded) window.__jw.air = true; }
    requestAnimationFrame(tick);
  })();
});

async function landed() {
  await page.waitForFunction(() => window.pdx.player.grounded, null, { timeout: 20000 });
  // DRAIN a pending tap rather than waiting for one to be consumed: if the
  // frame loop is not reading `takeTap` at all -- which is the exact bug this
  // file exists for -- waiting is an infinite wait, and a harness whose failure
  // mode is a twenty-second timeout is a harness whose report nobody reads.
  await page.evaluate(() => {
    window.pdx.sticks.R.tapped = false;
    window.pdx.player.vy = 0; window.__jw.peak = 0; window.__jw.air = false;
  });
}
async function didJump() {
  // Give it real frames, not milliseconds: the tap is read once per frame and
  // a slow renderer is still a correct one.
  for (let i = 0; i < 40; i++) {
    const j = await page.evaluate(() => window.__jw);
    if (j.peak > 1 || j.air) return true;
    await page.waitForTimeout(40);
  }
  return false;
}

async function realTap() {
  await landed();
  await page.mouse.move(pad.x, pad.y);
  await page.mouse.down();
  await page.mouse.up();
  return { name: 'a real tap, through the browser input path', jumped: await didJump(), want: true };
}

async function synth(name, moves, holdMs, want) {
  await landed();
  await page.evaluate(async ([x, y, moves, holdMs]) => {
    const z = document.getElementById('zR');
    const ev = (type, cx, cy) => z.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true,
      bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    ev('pointerdown', x, y);
    for (const [dx, dy] of moves) ev('pointermove', x + dx, y + dy);
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    const last = moves.length ? moves[moves.length - 1] : [0, 0];
    ev('pointerup', x + last[0], y + last[1]);
  }, [pad.x, pad.y, moves, holdMs]);
  return { name, jumped: await didJump(), want };
}

const results = [];
results.push(await realTap());
results.push(await synth('tap with 8 px of thumb roll', [[5, 5], [8, 3]], 0, true));
results.push(await synth('a camera DRAG ending near the middle',
  [[40, 0], [50, 10], [30, 0], [2, 1]], 0, false));
results.push(await synth('a long HOLD, no travel', [], 700, false));
// The high-water latch: a thumb can go out and come back between two frames, so
// a release that only reads where the thumb ENDED would call this a tap.
results.push(await synth('out and back inside one frame', [[52, 0], [0, 0]], 0, false));

let bad = 0;
for (const r of results) {
  const ok = r.jumped === r.want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(38)} jumped:${r.jumped ? 'yes' : 'no '}  wanted:${r.want ? 'yes' : 'no'}`);
}
if (errs.length) console.log('pageerror:', errs[0].slice(0, 120));
await browser.close(); server.close();
console.log(bad ? `\n${bad} FAILED` : '\nthe jump is reachable with a thumb, and only on purpose');
process.exit(bad ? 1 : 0);
