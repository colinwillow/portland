# Portland

A walkable, procedurally built Portland — twin-stick, mobile-first, no build
step. Open it on a phone:

### **[colinwillow.github.io/portland](https://colinwillow.github.io/portland/)**

Left thumb walks, right thumb orbits the camera. WASD and the arrow keys work
on a laptop, and that is all they are for.

---

## What is actually here

Five kilometres square, centred on the west end of the Burnside Bridge, built
from open data and nothing else:

| | |
|---|---|
| **17,045 buildings** | real footprints, real heights, 351 named |
| **23,826 road segments** | including 9,265 pavements generated where OSM maps none |
| **423 bridge segments** | deck heights *solved*, not draped — you walk over the Willamette and swim under it |
| **115,672 props** | trees, lamps, signals, benches, hydrants, 72,872 parked cars |
| **4,548 businesses** | real names, on the wall that actually faces the street |
| **3,864 street blades** | "SW HAWTHORNE BLVD", at 1,932 junctions |
| **46 people, 30 cars, 7 boats** | plus a helicopter and an airliner on approach to PDX |
| **6.05 MB** | the whole city, streamed a 500 m chunk at a time |

Terrain is USGS 3DEP; buildings, roads and places are OpenStreetMap through
Overture. Nothing is hand-placed.

## It is a scaffold, not the final art

Every street, kerb, roofline, bridge deck and hillside is in the right place at
the right height — which is the expensive part, and the part nobody wants to
author. The point is to pick **one** thing, build it properly by hand, and drop
it in with the city already standing around it:

```json
"overrides": {
  "Burnside Bridge": { "model": "models/burnside.glb", "keep": ["road"] }
}
```

`data/landmarks.json` already carries a clear box for all 73 named bridges and
351 named buildings, so an override is a model path and a name. It can carry a
second, heavier model that swaps in when you walk up to it.

## Running it

```sh
python3 -m http.server 8123      # index.html opens and runs; that is the app
npm test                         # 63 checks against the real baked city
node tools/shot.mjs --at 45.5231,-122.6745 --walk 2,1.57   # look at it headlessly
```

Re-baking the city needs Python (pyarrow, shapely, numpy, mapbox_earcut) and
about a minute:

```sh
npm run fetch    # ~21 MB of Overture GeoParquet, cached
npm run bake     # -> data/
```

`tools/README.md` is the pipeline, the sources, and every landmine that cost a
build. `CLAUDE.md` is how the runtime works and what not to break.

## Attribution

© OpenStreetMap contributors, © Overture Maps Foundation, USGS 3DEP.
Buildings and roads ODbL; terrain public domain.
