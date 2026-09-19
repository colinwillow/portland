# Working on Portland

A walkable Portland, built procedurally from open map data. Native ES modules,
a vendored three, **no build step** — `index.html` opens and runs, the same
shape as every other game in this account.

* **`game/`** — the runtime. Streaming chunks, a collider that knows about
  bridges, a crowd, traffic, boats, aircraft, shopfronts and street blades.
* **`data/`** — the baked city, **committed**. 100 chunk binaries, the skyline,
  the landmarks and their clear boxes. Pages serves it and there is nothing at
  deploy time that could generate it.
* **`tools/`** — the bake: Overture GeoParquet mined off S3 by range request,
  plus AWS terrain tiles. `tools/README.md` is the whole pipeline.
* **`models/`**, **`vendor/`** — Colin, and three.

## Where it is

**`https://colinwillow.github.io/portland/`** — the repo root IS the game, so
there is no subpath to remember.

It lived at `colinwillow.github.io/maps/pdx/` first, inside the map platform's
Vite project, because that is where it got written. It does not belong there:
it shares nothing with that app but a domain, it has no build step to be part
of, and a `dist/` in between is one more thing for the served copy and the
repo copy to disagree about. `colinwillow/maps` keeps the MapLibre platform and
links here.

## Anything meant for testing has to reach a phone

Pages serves `main` from `.github/workflows/pages.yml`. A change sitting on a
branch cannot be played, and a twin-stick city is only really testable with two
thumbs on glass. Branch as much as you like while working; **end on `main`**.

Before pushing:

```sh
npm test                 # 63 checks against the real baked city in data/
node tools/shot.mjs      # boots the real page in a real Chromium and looks
```

## The bar for done

It runs on a phone, in any orientation, with two thumbs. WASD and the arrow keys
exist so it is debuggable on a laptop and that is all they are for.

## What the city actually is

**A SCAFFOLD, NOT THE FINAL ART.** Every street, kerb, roofline, bridge deck and
hillside is in the right place at the right height, which is the expensive part
and the part nobody wants to author. The point is to pick ONE thing — the
Burnside Bridge — build it properly by hand, and drop it in with the rest of the
city already standing around it.

That is `data/landmarks.json`:

```json
"overrides": {
  "Burnside Bridge": { "model": "models/burnside.glb", "keep": ["road"] }
}
```

An override is two halves and both are necessary: a **model**, and a **clear
box** the generator agrees to leave alone. The bake already writes a clear box
for all 73 named bridges and 351 named buildings, so the minimum is a model path
and a name. `keep` lets a layer survive inside the box — `["road"]` for a model
that is only the superstructure and still wants a generated deck to walk on.

**The clear box filters the COLLIDER as well as the picture, from the same
filtered chunk.** Filtering only the geometry leaves an invisible building
standing inside the hand-built bridge, which is the worst kind of bug: nothing
on screen disagrees with anything and the player simply cannot walk there.

`pdx.here()` in the console prints an override entry for wherever you are
standing, and `pdx.near()` lists the nearest named landmarks. Authoring a clear
box by typing coordinates is how you get one that is nearly right, and nearly
right here is a building left inside your model.

## Handedness: derive it, never guess it

**+X is EAST. +Y is UP. +Z is SOUTH. North is −Z.** That is the right-handed
basis three.js uses with Y up (east × up = south). A compass bearing `b` becomes
the heading vector `(sin b, −cos b)` and a yaw of `−b` about +Y.

**Rings are anticlockwise SEEN FROM ABOVE**, which is a positive signed area in
(x, −z) and therefore *clockwise* in the raw (x, z) numbers. `Soup.tri` derives
every normal from the winding so there is exactly one thing to get right.

It has been got wrong three times here, and each time it LOOKED FINE:

* **The whole terrain mesh was back-facing for the first day.** Back faces are
  culled, so it was simply invisible — and the roads and land cover are drawn on
  top of it, so they carried the picture. The tell, missed at the time, was that
  changing `TERRAIN`'s colours changed nothing on screen.
* **`box()`, `cylinder()` and `blob()` were all inside out**, so every lamp post,
  tree trunk, bin and parked car in Portland was lit from within. A back-faced
  post still renders: the near side is culled and you see the far side, which
  for a thin cylinder is the same silhouette. What it costs is the lighting.
* Colin's rig faces **+Z**, not the −Z a glTF conventionally points, so he ran
  exactly backwards at every heading. `measureFacing` in `character.js` measures
  it off the TOES — a foot points forwards, which is a geometric fact about a
  body — and cross-checks against the shoulder span.

**The test that catches an inside-out mesh is the divergence theorem**: for a
closed surface with outward normals, the integral of n·x is +3V, and inside out
it is −3V. `tests/runtime.test.mjs` runs it over every prop kind. No count,
bounding box or screenshot finds this.

## Ask what a check would still pass with

A city baked MIRRORED satisfies every count, every byte length and every
bounding box you can write about it. So the checks that matter pin a DIRECTION
or a real-world fact:

* downtown is west of the river and Ladd's Addition is east of it;
* Wells Fargo Center is 167 m and is the tallest thing in the city;
* pushing "up" on the left thumb walks him AWAY FROM THE CAMERA at every
  camera bearing — not north, which is the version that works until you turn;
* a road deck over the Willamette clears the water by more than 3 m;
* stepping off a wall along its own normal lands you OUTSIDE the building.

That last one replaced a check that compared the normal with the direction to
the footprint's centroid, which is wrong on any concave plan — the inner face of
an L-shaped block correctly points back at its own centroid. 7% of downtown
failed a check that was itself the bug.

**Tilikum Crossing is not in the list of bridges with drivable decks**, and that
is the data being right: it carries light rail, buses, bikes and people and no
private cars. It failed that check first time and the check was wrong.

## Landmines in the runtime

* **Vertex colours are sRGB and three assumes they are LINEAR.** Every palette
  value in `tune.js` is a hex an eye picked. three converts `material.color` for
  you and does not convert a vertex colour, because a vertex colour is normally
  computed data already in working space. Fed sRGB bytes as linear, every
  mid-tone lands a stop and a half too light and the saturation goes with it —
  which is what "the whole city is grey" looked like, through three palette
  rewrites that could never have fixed it. `world.js` does `pow(vColor, 2.2)`
  in the vertex shader.
* **Tone mapping is `NeutralToneMapping`, not ACES.** ACES is the default reach
  and it is a FILM curve: it desaturates as it rolls off, so a hand-picked
  palette quietly stops existing. Measured on one frame, a sage ground came back
  neutral grey. `NoToneMapping` is the third option and it is worse — every lit
  pale wall clips to flat white.
* **Window bands are a shader, not geometry**, keyed on a one-byte per-vertex
  tag. As geometry a 40 m tower is twelve bands on every wall; as a fragment it
  is a `fract` of world height. It **fades out with distance**, and that is not
  a saving: a 3.3 m band under a metre of screen space aliases into moire, and
  moire on every building in a skyline is worse than no bands at all.
* **`groundAt` takes a HINT and that argument is the point.** A heightmap has
  one answer per (x, z); the Willamette bridges need two — the deck and the
  river forty feet under it. The hint is roughly where the body already is, and
  the answer is the highest surface at or a step above it.
* **Build ONE chunk per frame** (`STREAM.perFrame`). A 500 m square of Portland
  is 15–30 ms of array work; nine at once — which is what crossing a diagonal
  asks for — is a freeze. Spread, it disappears into the frame it always cost.
* **The builders are pure**: numbers in, typed arrays out, no three and no
  scene. That is the seam that lets the whole thing move into a Worker later
  without a rewrite, and it is why `tests/runtime.test.mjs` can drive them
  in node against the real baked city.
* **There is no stick watchdog and there must not be.** A pointer that is not
  moving generates no events, so "no events" and "no thumb" are the same
  observation — a test that cannot tell its two answers apart is not a test, and
  its false positive (dropping a hold someone is in the middle of) is worse than
  the bug. The four real ways a `pointerup` goes missing on a phone are all
  closed in `input.js`.
* **A phone has no console, so an exception is a blank screen.** The crash trap
  is the first thing in `<head>`, before the import map and before the module,
  registered with CAPTURE so a subresource that 404s is caught too.

## The layer that moves without you

`game/crowd.js` and `game/ambient.js`. Between them: 46 pedestrians,
30 cars, 7 boats, a helicopter and an airliner, in **two draw calls total** —
each file rebuilds everything it owns into ONE merged non-indexed geometry every
frame, which is a millisecond of array writes and no skinning, no instancing and
no second material. A city where nothing moves but you reads as a photograph you
are allowed to walk around in, and that is the whole job.

**The lines they move along are real, and that is the part that matters.**

* The crowd walks the **sidewalk / footway / path / crossing** centrelines out of
  the loaded chunks. OSM only maps separate sidewalk ways downtown, so
  `make_pavements()` in the bake generates one down both sides of every street
  in `classes.PAVED` that has not got one — 9,265 of them — and suppresses the
  run wherever a mapped pavement is already within 4 m. Without that, SE
  Hawthorne is a road with lawn either side and three people on it.
* The traffic drives the **carriageway** centrelines, the same records the road
  ribbons are drawn from, and **keeps RIGHT** of them. Getting that sign
  backwards is a head-on with every other car on the street; it is pinned in
  `tests/runtime.test.mjs`, measured along the car's own right, which is
  `(-uz, ux)` with +X east and +Z south.
* The boats follow a **centreline measured down the Willamette at bake time**
  (`river_route()`, carried in `manifest.routes.river` as `[x, z, halfWidth]`
  every 40 m). It cannot be derived in the runtime: only the chunks around the
  player are loaded, and a boat has to come from somewhere he has not walked to.
  **It is NOT "the biggest water polygon"** — the biggest one reachable from this
  bbox is the *Columbia*, four times the area and entirely north of the play
  area, and picking by area put the route off the map and the scan came back
  empty. The union is clipped to the play area first.
* The airliner is aimed at the **real airport**: PDX's lat/lon projected through
  the same anchor the city is baked against, which is 6 km north-east. Nothing
  about the airport is modelled; what it buys is a plane going *somewhere*
  rather than round a loop. It **descends** across its track, because an
  approach that holds altitude reads as a sticker pinned to the sky.
* The helicopter orbits **where the skyline says downtown is** — the far boxes
  weighted by height, computed in `world.loadFar()`. A pair of coordinates in
  `tune.js` would not survive the play area being moved or grown.

### Street name blades

`game/streets.js`. A post on a corner with a green rectangle on it saying what
the street is, at **1,932 junctions** — found, never authored, and filled from
the map data with the one thing a generator cannot invent. A grid of identical
blocks is unnavigable however well it is modelled; this is the cheapest
legibility in the city.

* **A junction is Overture's CONNECTOR, not a coinciding coordinate** — the
  bridge solver's own lesson, one system along: two streets crossing at the
  same plan position twenty feet apart are a freeway stack, not a corner you
  can stand on. One post per 32 m, so a divided street with a connector on each
  carriageway does not grow a little forest.
* **A blade's long axis is PARALLEL TO THE STREET IT NAMES.** That is how a
  street sign works and it is not arbitrary: it puts the face square to
  somebody arriving along the CROSS street, who is the only person who needs
  it. Mounted the other way it is edge-on to everybody.
* **The names are abbreviated the way a real blade is** — "Southwest Hawthorne
  Boulevard" becomes "SW HAWTHORNE BLVD". The directional prefix is the whole
  address system in Portland (SE 12th and NE 12th are two miles apart) so it is
  the one part that must never be dropped, and a test pins it.
* **They are half again life size, on purpose.** A real blade is 23 cm deep
  with 10 cm lettering, and measured at a natural walking distance that is at
  the very edge of legible — which fails the only thing this exists for.
  Accurate and useless is worse than large and readable.
* **The whole box is white and the green is a panel on it.** A green rectangle
  is a shape; a green rectangle with a white line round it is a SIGN, and that
  border does more at forty metres than the lettering does. Built the other way
  round — green box, white end caps — the caps read as pale tabs stuck on.

### One atlas for every name in the world

`SignText` in `shops.js` carries the shopfronts AND the blades, still in one
draw call, and neither producer knows the other exists: each pushes boards into
a list and the atlas decides what fits.

* **A CELL IS KEYED ON THE TEXT, NOT ON THE SIGN.** There are 405 distinct
  street names on 3,864 blades — the same one is on both corners of a junction
  and on the next block too — so a cell per board spends the whole atlas on
  four copies of one street. Keyed on the string, 28 cells were carrying 58
  boards on Burnside.
* **The INK IS MEASURED, not assumed to fill its cell.** A cell is 256×85 and a
  blade is 1.5×0.28 m; mapping the whole cell onto the whole board stretches
  every letter by the ratio between them — 1.7× wide, and wrong differently for
  every name because the font is shrunk to fit. `actualBoundingBox*` gives the
  real ink box, and `place()` fits that SHAPE centred inside whatever space the
  board offers.
* **A board gives the space available and lists its corners anticlockwise from
  the READER'S bottom left.** That rule lives in one place because the two
  producers genuinely disagree about which way that is: a shop's board runs
  along `(-fz, fx)` with its face out along `(fx, fz)`, and a blade's runs
  along `(fx, fz)` with its face out along `(-fz, fx)` — a quarter turn apart,
  so one of them lists its corners the other way round. Both directions are
  pinned by tests that were checked by reverting the fix.
* **A blade needs text on BOTH sides**, two quads sharing one cell. A
  double-sided quad shows the name in mirror image from behind, which reads as
  a rendering fault rather than as a sign.

Landmines already paid for here:

* **A shape seen from underneath needs its bottom face.** The crowd's `box()`
  skips it — right for a person standing on a pavement — and `ambient.js` has
  its own `prism()` with all six, because a plane is seen from directly below.
  Both are checked by the divergence theorem, same as the props.
* **`closed()` normalises its ring's winding rather than trusting it**, because
  a hull wound inside out still renders and what it costs is only the lighting,
  which reads as "a bit dark" and nothing on screen disagrees with anything.
* **A box car has exactly one asymmetry and it is the headlamps.** They went on
  the boot first time — local **−Z is the nose**, so a point `d` forward is at
  `dz = −d`, and the obvious sign is the wrong one. A test looks for the pale
  lamp colour ahead of the red one along the direction of travel.
* **Wheels have to show under the body.** The first car put the body's underside
  at six centimetres and buried them, and a box flat on the road with no gap
  under it reads as a skip at every distance.
* **The rotor has to be PALE.** There is no translucency in a single opaque
  merged mesh, so the only thing left to read a blur with is VALUE against a
  pale sky — a dark grey rotor on a dark body is one black blob. Measured on a
  shot at 180 m: the blades were there and invisible.
* **A river is five kilometres long and he is standing on one bridge.** Boats
  seeded once and left there means an empty river wherever he happens to be, so
  one too far to see gives its seat back and is re-seated in view — never
  closer than 260 m, because a barge fading up two hundred metres away is worse
  than an empty river.
* **`S` is the world's SOUTH edge.** Shadowing it with a chunk's shop list
  inside `write_all` wrote a list of cafes into `manifest.world.south`, which
  made the map overlay's player dot NaN and said nothing. A one-letter name in a
  long function is how a constant gets quietly replaced.
* **`Overrides.filter` has to carry EVERY layer through, not just the ones with
  a loop.** `shop` was missing from the object it builds, so a chunk that
  merely TOUCHED a clear box lost every shopfront in it — five hundred metres
  of signage gone because a bridge two streets away has an override.

## LOD, and why `THREE.LOD` is used for exactly one thing

There are three kinds of detail switch here and they need three different
mechanisms, because they are switching three different things.

**1. Chunks** (`STREAM.full` / `STREAM.mid`). A whole 500 m square is built at
one of two levels and rebuilt when it crosses the boundary. Coarse, already
there, and it is what stops the far half of the city costing anything.

**2. Props** (`game/hero.js`, `HERO`). The nearest ~44 trees, lamps, benches
and parked cars are swapped for a better version of themselves — a car gets
round tyres, a glasshouse, mirrors and lights; a tree gets a tapering trunk,
boughs and three overlapping crowns.

**`THREE.LOD` cannot do this and it is not close.** That class switches between
children of one Object3D by distance, and there is no Object3D to attach it to:
six hundred props in a chunk are ONE buffer and ONE draw call, which is the
whole reason this renderer is fast. Giving each prop its own object to hang
levels off is six hundred draw calls a chunk to improve a dozen of them.

So the swap happens INSIDE the buffer:

* `buildProps` records `ranges` — the triangle span each prop occupies.
* To take one out, every vertex in its span is written to a SINGLE POINT. Each
  of its triangles becomes zero-area, and a degenerate triangle is discarded
  before rasterisation on every GPU worth the name, so it costs the draw call
  nothing. **Collapsed to a point the prop is actually at, never the origin** —
  a degenerate triangle still counts toward a bounding sphere, and parking
  every hidden prop at (0,0,0) grows the chunk's sphere to the middle of the
  city and turns its frustum culling off in every direction at once.
* To put it back, `oneProp` rebuilds it from the chunk's own record. **Nothing
  is cached**: keeping the original vertices would be a second copy of every
  prop buffer in the city, and `oneProp` is a pure function of the record.
* **A KEY IS NOT ENOUGH — THE RECORD HAS TO BE THE SAME RECORD.** A chunk that
  crosses the LOD boundary is dropped and rebuilt with a fresh buffer, and
  `chunk:index` names the same prop in both. A set diff on the key alone
  decides nothing changed, never collapses it in the new buffer, and the car is
  then drawn twice — low inside hero, in the same place, for as long as you
  stand there. Pinned by a test.
* The budget is **triangles, not a ratio**. A plain car is 30 triangles and a
  plain tree 14, so the same absolute cost reads as 14× on one and 30× on the
  other; a test written on the ratio fails for whichever kind started cheapest.
  What is pinned is that a FULL SET fits: 44 of the heaviest kind, against a
  frame already drawing six hundred thousand. Measured on Burnside: 36 heroes,
  11k triangles, **one extra draw call**.
* Moving traffic needs none of this — `ambient.js` rebuilds it every frame
  anyway — so a car within `TRAFFIC.hero` simply gets wheels, and they TURN.
  **The spoke is the whole point there**: a tyre is rotationally symmetric, so
  a black disc spinning and a black disc standing still are the same picture,
  and the rotation only exists on screen if something on the wheel is not.
* **A tyre is not black, it is dark grey that catches light.** At 26/26/28 on a
  road at 46/46/48 the wheel was invisible and what read was the hub — one pale
  sliver poking out of nothing, which is what a car on castors looks like.
* **Every height in a hero prop is a fraction of the prop**, because the low
  versions have fixed heights and a scaled LENGTH. That is invisible under a
  dark sill and is not invisible once there are wheels: at `scale` 0.7 the body
  sat above the top of the tyre and the car came out on castors, and at 1.5 the
  wheels vanished inside it.

**3. Landmarks** (`overrides.js`). A hand-built model with a heavier version:

```json
"Wells Fargo Center": {
  "model": "models/wells-fargo.glb",
  "near":  { "model": "models/wells-fargo-hi.glb", "within": 180 }
}
```

This is the one place `THREE.LOD` would genuinely fit — a landmark IS an
Object3D — and it is still not used, for two reasons. The heavy model has to be
FETCHED, and `THREE.LOD` wants every level in hand before it can switch; a
hundred-megabyte hero building downloaded at boot for something you may never
walk past is the opposite of the point. And the swap wants hysteresis — in at
`within`, out at `within * 1.15` — or a landmark you are standing at the edge
of loads and unloads on alternate frames. Both are a dozen lines in
`Overrides.step` and neither is expressible there. **Fetched on approach, kept
once fetched**: walking away and dropping it means re-downloading every time
you cross the same street, which is exactly what you do around a landmark.

## Still to do

* **Traffic does not obey anything.** No junctions, no signals, no queueing —
  cars pass through each other and through the crowd. Shredworld's `crossGive`
  is the worked answer to that if it is ever wanted, and it is a build on its
  own.
* **No interiors, no doors.** Buildings are closed shells.
* **The hand-built landmark slot is empty.** Nothing is overridden yet; the
  machinery, the clear boxes and the tests are there waiting for the first GLB.
* **No LOD on props past `STREAM.mid`** — they are simply dropped. A billboard
  impostor for distant trees is the obvious next thing, and it is the one end
  of the range `hero.js` does not touch.
* **No hand-built landmark has been made yet**, so the `near` half of an
  override has machinery and a test and no asset to prove it on.
* **The play area is 5 km square.** `tools/city.py` moves it or grows it; the fetch
  and the bbox index are cached, so a bigger bake costs only its own row groups.
* **Colin has no idle variety, no jump animation blend-out, and no shadow.**
  There are no shadow maps at all — a projected shadow over a city this size is
  the most expensive thing that could be in here, and the vertical gradient
  baked into every wall (`WALL_AO`) is what grounds things instead.
