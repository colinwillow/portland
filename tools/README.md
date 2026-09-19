# The Portland bake

Open map data in, a walkable city out. Two commands, about three minutes, and
everything it writes lands in `data/`.

```sh
python3 -m pip install pyarrow shapely mapbox_earcut numpy Pillow
python3 tools/fetch_city.py     # ~6 MB of parquet, cached
python3 tools/bake.py           # ~50 s -> 100 chunks, 5.2 MB
python3 tools/test_geo.py       # the projection's directions
```

`fetch_city.py` is slow exactly once: it builds a bbox index over every Overture
file for each theme (about a minute for 512 building files) and caches it in
`.ovindex/`. After that a different corner of the same city is seconds.

## Where the data comes from, and why these sources

| what | source | licence |
|---|---|---|
| buildings, heights, names, roof shapes | Overture Maps `theme=buildings` | ODbL (OSM-derived) |
| roads, widths, bridges, connectors | Overture `theme=transportation` | ODbL |
| water, parks, land cover, 2,985 mapped trees | Overture `theme=base` | ODbL |
| street lamps, signals, stop signs, benches, hydrants | Overture `theme=base/infrastructure` | ODbL |
| terrain | AWS `elevation-tiles-prod` Terrarium (USGS 3DEP over the US) | public domain |

**Everything is fetched over plain HTTP RANGE REQUESTS, and that is the whole
trick.** Overture publishes GeoParquet on a public S3 bucket -- 277 GB for
buildings alone -- but every row carries a `bbox` struct and Parquet keeps
min/max statistics for it per row group. So the footer alone (1.4 MB) says which
of a file's 256 row groups can possibly touch Portland, and the rows are
spatially sorted, so the answer is usually ONE file and a dozen row groups.

Measured, for a 16 km box over Portland: **58 MB fetched, 19 seconds, 125,006
buildings.** No API key, no rate limit, no Overpass.

> Overpass, Geofabrik and every free vector-tile CDN were tried first and all of
> them are behind a key, a rate limit or an egress policy. S3 is not. If you are
> ever stuck for a geo source, look for the bucket.

## The pipeline, in order, and the order matters once

```
fetch_city.py   Overture S3  ->  tools/.cache/*.parquet
bake.py
  1  terrain    Terrarium z15 -> one city-wide grid at 10 m, water CARVED into it
  2  buildings  footprints -> rings + heights + a ridge segment, per chunk
  3  roads      centrelines -> PAVEMENTS GENERATED, resampled, draped,
                bridges SOLVED, split per chunk
  4  areas      land cover -> clipped, cut on a 25 m lattice, draped
  5  shops      places -> scored against every wall of the 4 nearest buildings
     signs      junctions of two differently NAMED streets -> a post and two
                blades, abbreviated the way a real street sign is
  6  props      real furniture + generated trees, lamps and parked cars
  7  places     named streets sampled every 70 m, for the "where am I" readout
     river      a centreline scanned down the Willamette, for the boats
  8  write      100 chunk files, far.bin, manifest.json, landmarks.json, map.png
```

**The terrain grid is built and carved BEFORE anything else reads it**, because
roads, buildings, areas and props all sit on the carved answer. It is the single
source of truth for "how high is the ground": the terrain MESH is this grid,
roads are draped on a bilinear sample of it, buildings sit on its minimum under
their footprint, and `game/ground.js` re-implements exactly the same
bilinear lookup against the same numbers. Sampling the finer source for roads
and the coarser grid for the mesh is the obvious shortcut and it puts the tarmac
a metre under the hillside.

## What it writes

```
data/
  manifest.json    anchor, world box, chunk grid, class vocabularies, attribution
                   plus `routes.river`: [x, z, halfWidth] every 40 m down the
                   Willamette, which is where the boats in ambient.js live
  c<i>_<j>.bin     100 chunks, 500 m square, mean 51 kB   (format: chunkfmt.py)
  far.bin          544 skyline boxes, 7 kB, one draw call
  landmarks.json   424 named things + a ready-made clear box per bridge
  places.json      6,549 points over 492 named streets
  map.png          the whole city drawn from the BAKED chunks
```

`map.png` is drawn by `preview.py` from the chunk binaries rather than from the
source tables, on purpose: it is wrong if the writer is wrong, if the reader is
wrong, or if the winding is inside out, and one glance tells all three apart
from the correct answer.

## Things that cost a build

* **A JUNCTION IS A CONNECTOR, NOT A COINCIDING COORDINATE.** The same lesson
  the bridge solver paid for, applied to street signs: two streets crossing at
  the same plan position twenty feet apart vertically are a freeway stack and
  not a corner anybody stands on. And ONE POST PER 32 m, because a divided
  street carries a connector on each carriageway and a slip lane adds a third
  -- keyed per connector, every boulevard junction grows a little forest.

* **`S` IS THE WORLD'S SOUTH EDGE, AND A LOOP VARIABLE TOOK IT.** `write_all`
  used `S` for a chunk's shop list, so `manifest.world.south` came out as a
  list of cafes -- the map overlay's player dot went to NaN and nothing said
  why. Caught by a test that asked whether the river route reached the south
  edge, which is the only reason anybody looked. A one-letter name in a long
  function is how a constant gets quietly replaced by something else entirely.

* **"THE BIGGEST WATER POLYGON" IS THE COLUMBIA, NOT THE WILLAMETTE.** It is
  four times the area and lies entirely NORTH of the play area, so
  `river_route()` picking by area scanned somewhere the city is not and came
  back with zero points -- a feature that silently does nothing rather than an
  error. The union is clipped to the play box first and the widest run in each
  east-west cut wins, which cannot pick a river that is not here.

* **OSM ONLY MAPS SIDEWALKS WHERE SOMEBODY BOTHERED.** Downtown and a few main
  streets have separate sidewalk ways; SE Hawthorne has none, so it baked as a
  road with lawn either side and the crowd -- which walks the pavement network
  -- had three people on it. `make_pavements()` offsets every street in
  `classes.PAVED` by `w/2 + 1.15` on both sides and suppresses the run wherever
  a mapped pavement is already within 4 m. 9,265 generated, and it is the whole
  difference between a street and a road.

* **`glob("base-land_*")` ALSO MATCHES `base-land_use_*`.** The land-use table
  got baked as land cover, 2,985 mapped street trees silently became zero, and
  nothing errored. Anchor the prefix.

* **A bridge is the one road that must not follow the ground, and solving it is
  harder than it looks.** The abutments are the connectors a bridge shares with
  a road that is on the ground; everything between is the harmonic
  (minimum-bending) surface through them. Two versions were wrong:
  * *Relaxed, not solved.* 400 Gauss-Seidel sweeps is plenty for a twelve-vertex
    span and nowhere near enough for a two-kilometre viaduct -- it needs O(n²) --
    so the middle of every long structure kept the terrain wiggles it was
    initialised with. **278 bridge segments over a 20% grade, freeway decks at
    34%**, and invisible to every check that counted or measured distances.
  * *Keyed on coincident coordinates.* Right almost everywhere and catastrophic
    at a freeway STACK, where two decks cross at the same plan position twenty
    feet apart vertically: snapped, they become one node and the solver averages
    two decks into a spike through both. **Overture ships the real connectivity
    in `connectors`** -- a shared `connector_id` is a junction and a shared
    coordinate is not.

  What is left is short ramps joining ground level to a high deck -- the Steel
  Bridge's spiral approaches, the freeway stacks -- and those really are steep.
  1.5% of drivable bridge segments are over 15%, and `tests/data.test.mjs`
  pins that ceiling so a regression cannot bring the 34% decks back quietly.

* **A DEM reports a river's surface as whatever the sensor saw**, which is noisy
  and a metre or two high. Left alone, the flat water plane pokes through it in
  patches that read as islands. The ground is CARVED to just under the water
  level inside every water polygon, which also gives the runtime a free "am I in
  the river" test.

* **A tree in the middle of West Burnside is the most obviously wrong thing this
  generator can produce, and it happens at JUNCTIONS**: the side street's own
  kerb offset puts its row of trees straight across the main road. Offsetting
  from one centreline can never see that. Every generated prop is tested against
  an index of every other road's SURFACE -- 7,899 rejected.

* **A Douglas fir on a downtown pavement** is the thing everybody who has been to
  Portland spots first. The conifer roll only happens on the residential road
  classes, and its size is capped separately: the scale range that suits a maple
  is absurd on a fir.

* **Land use is not ground cover.** `commercial`, `retail`, `residential` and
  `industrial` are administrative polygons covering a whole block, roads and
  pavements and all. They stay in the bake -- the map draws them -- and the game
  does not paint them (`HIDE_AREA` in `tune.js`). Painted, downtown is one flat
  pale plain.

* **Rings are emitted anticlockwise SEEN FROM ABOVE**, which is a positive signed
  area in (x, −z) and therefore CLOCKWISE in the raw (x, z) numbers. Get it
  backwards and every wall is lit from inside.

## Moving the city, or moving to another city

`city.py` is the whole configuration. The anchor is the west end of the Burnside
Bridge; `half` is 2500 m, so the play area is 5 km square in 100 chunks of 500 m.

Changing `anchor` and re-running both scripts bakes somewhere else. Three things
in `bake.py` are Portland-specific and would need looking at: `water_level` (the
Willamette's surface, 3 m), the spawn, and **`river_route()`'s scanline**, which
cuts east-west and takes the widest run. That is exactly right for a river
running roughly north-south through the bbox and wrong for one running the other
way -- and it says so loudly rather than quietly, because the route comes out as
a handful of disconnected rows instead of one long chain, and the count is
printed. A city with no river simply gets no boats.

The bbox index is cached per Overture release, so the second city in the same
release costs only its own row groups.

## Tools

```sh
python3 tools/preview.py 1600 /tmp/pdx.png   # draw the baked city from above
# and the browser harness, which proves the module evaluates and the winding is
# not inside out -- `--js` runs an expression against `window.pdx` before the
# shot, for the parts that are on a timer (an airliner is every half minute)
node tools/shot.mjs --at 45.5231,-122.67 --az 1.3 --settle 8 --out /tmp/a.png
node tools/shot.mjs --js "window.pdx.ambient.planeT = 0" --out /tmp/b.png
```

`shot.mjs` boots the real page in a real Chromium against a real static server,
drives it and writes a PNG. WebGL there runs on SwiftShader, so **the frame rate
it reports means nothing about a phone** -- what it proves is that the module
evaluates, the chunks parse, the geometry builds, the winding is not inside out
and the camera is pointing at the city. Every one of those is invisible to a
syntax check and every one of them is a blank screen.
