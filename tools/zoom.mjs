// Does the page actually refuse to zoom?
//
// A twin-stick game is two thumbs on glass and every browser gesture is
// something a thumb does by accident -- a double tap while jabbing at a
// control, two fingers landing at once on the sticks. Three separate
// mechanisms have to be off and only one of them is the viewport meta, so
// "did somebody remember" is not a question to answer by reading.
//
// WHAT THIS CANNOT SEE IS IOS, AND THAT MATTERS MORE THAN WHAT IT CAN.
// It runs Chromium. For four builds it reported this page as fine on the
// strength of `touch-action: manipulation`, which is the documented fix, reads
// correctly everywhere, and does NOT stop iOS Safari zooming on a double tap --
// so "ok" here and "it still zooms" on the phone were both true at once. It no
// longer accepts a CSS property as proof of anything: it sends a real touch
// stream and asks whether the page's own guard refused the second tap, which is
// this page's code and is therefore something Chromium can honestly answer.
//
// THIS FIRES THE EVENTS AND ASKS WHETHER THE DEFAULT WAS CANCELLED. Grepping
// the source for a listener proves a listener exists; it does not prove it is
// reached. Run across ten repos it found two where it was not: one guarding
// only `gesturestart` of the three, and one whose guard sat below a `three`
// load from a CDN -- so with the CDN slow or blocked, the script died before
// the listener was ever registered and the page zoomed freely. That is the
// whole argument for the guard being its own <script> in the HEAD rather than
// a few lines inside the module: a guard that installs once the game has
// loaded is absent for the whole of the loading screen, which is exactly when
// somebody starts jabbing at a page that is not responding.
//
//   node tools/zoom.mjs            # this repo
//   node tools/zoom.mjs . ../peggy # or any others alongside it
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.bin':'application/octet-stream',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml',
  '.glb':'model/gltf-binary', '.wasm':'application/wasm', '.mp3':'audio/mpeg',
  '.webmanifest':'application/manifest+json' };

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
         '--no-sandbox','--disable-dev-shm-usage'] });

let bad = 0;
for (const repo of (process.argv.slice(2).length ? process.argv.slice(2) : ['.'])) {
  const ROOT = path.resolve(repo);
  const server = http.createServer((req, res) => {
    let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // Off-host requests are aborted: what is under test is the page's own guard,
  // and a font CDN this sandbox cannot reach must not decide the result.
  await page.route('**/*', (r) => {
    const u = r.request().url();
    return u.startsWith(`http://127.0.0.1:${port}`) || u.startsWith('data:') || u.startsWith('blob:')
      ? r.continue() : r.abort();
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  const r = await page.evaluate(async () => {
    const fire = (type) => {
      // Safari's gesture events do not exist in Chromium, so they are
      // constructed directly -- the listener is registered by NAME and does not
      // care, which is the whole thing being checked.
      const e = new Event(type, { bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // A REAL DOUBLE TAP, as a touch stream. `touch-action: manipulation` was
    // what this used to accept as proof and it is not proof: it is the
    // documented answer, it reads correctly in every browser, and iOS Safari
    // zooms anyway. What has to be there is a guard that CANCELS the second
    // touchend, and that is this page's own code, so Chromium can check it.
    const tap = (x, y, el) => {
      const mk = (type, list) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        return el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
          touches: list ? [t] : [], targetTouches: list ? [t] : [], changedTouches: [t] }));
      };
      mk('touchstart', true);
      const notCancelled = mk('touchend', false);
      return !notCancelled;
    };
    const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 3) || document.body;
    tap(innerWidth / 2, innerHeight / 3, mid);            // first tap: allowed
    const second = tap(innerWidth / 2, innerHeight / 3, mid);   // second: must be refused
    await new Promise((r) => setTimeout(r, 600));
    // and two taps far apart, in quick succession, must BOTH be allowed -- a
    // guard that eats every tap is a guard that breaks the game it protects.
    tap(40, 40, document.body);
    const apart = tap(innerWidth - 40, innerHeight - 40, document.body);

    const ta = (el) => getComputedStyle(el).touchAction;
    return { gesturestart: fire('gesturestart'), gesturechange: fire('gesturechange'),
             gestureend: fire('gestureend'), dblclick: fire('dblclick'),
             doubleTapRefused: second, farTapKept: !apart,
             html: ta(document.documentElement), body: ta(document.body),
             viewport: (document.querySelector('meta[name=viewport]') || {}).content || '' };
  });
  const pinch = r.gesturestart && r.gesturechange && r.gestureend;
  // NOT `touch-action`, and that change is the whole point of this build. See
  // the comment block in index.html: every one of those was in place and the
  // phone still zoomed.
  const noDouble = r.doubleTapRefused;
  const ok = pinch && noDouble && r.farTapKept;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${repo.padEnd(11)} pinch:${pinch?'y':'N'} dbl:${r.dblclick?'y':'N'}  ` +
    `double-tap:${noDouble ? 'refused' : 'ZOOMS'}  taps-apart:${r.farTapKept ? 'kept' : 'EATEN'}  ` +
    `body.touch-action:${r.body}` +
    (errs.length ? `  pageerror: ${errs[0].slice(0, 60)}` : ''));
  await page.close(); server.close();
}
await browser.close();
console.log(bad ? `\n${bad} FAILED` : '\nall pages refuse to zoom');
process.exit(bad ? 1 : 0);
