#!/usr/bin/env python3
"""Turn Overture + 3DEP into a walkable Portland.

Run `python3 fetch_city.py` first (it caches ~6 MB of parquet); then this.
Everything it writes lands in data/ and is committed, because the
runtime is a static page with no build step and GitHub Pages has to serve it.

Read tools/README.md for the shape of the whole pipeline. The order below
matters in one place only, and it is load-bearing: the terrain grid is built
and CARVED before anything else reads it, because roads, buildings, areas and
props all sit on the carved answer.
"""
import glob, json, math, os, struct, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely.geometry import box as shbox, LineString
from shapely.ops import unary_union
import mapbox_earcut as earcut

import classes as C
from chunkfmt import ChunkWriter, dm
from city import CITY
from geo import Anchor
from ground import Ground
from terrain import Heightfield

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.abspath(os.path.join(HERE, "..", "data"))

ANCHOR = Anchor(*CITY["anchor"])
W, E = CITY["west"], CITY["east"]
N, S = CITY["north"], CITY["south"]
CH = CITY["chunk"]
NC = CITY["nchunk"]
CELL = CITY["terrain_cell"]
WATER = CITY["water_level"]


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------
def load(name):
    # The prefix must be anchored: "base-land_*" also matches "base-land_use_*",
    # which silently bakes the land-use table as land cover -- 2985 street trees
    # quietly become zero and nothing errors.
    hits = [p for p in glob.glob(os.path.join(CACHE, name + "_-*.parquet"))]
    if not hits:
        sys.exit(f"missing {name} in {CACHE} -- run fetch_city.py first")
    return pq.read_table(hits[0])


def project(geoms):
    """WKB in lon/lat -> shapely geometry in game metres. Vectorised."""
    g = shapely.from_wkb(geoms)
    return shapely.transform(g, lambda a: np.column_stack((
        (a[:, 0] - ANCHOR.lon) * ANCHOR.mlon,
        -(a[:, 1] - ANCHOR.lat) * ANCHOR.mlat)))


def chunk_of(x, z):
    i = int((x - W) // CH)
    j = int((z - N) // CH)
    return (min(max(i, 0), NC - 1), min(max(j, 0), NC - 1))


def inside(x, z, pad=0.0):
    return W - pad <= x <= E + pad and N - pad <= z <= S + pad


# --------------------------------------------------------------------------
# 1. terrain
# --------------------------------------------------------------------------
def build_ground(water_polys):
    pad = CITY["pad"]
    nx = int((E - W + 2 * pad) // CELL)
    nz = int((S - N + 2 * pad) // CELL)
    g = Ground(W - pad, N - pad, CELL, nx, nz)
    lo, la = ANCHOR.lonlat(W - pad, S + pad)
    hi_lon, hi_lat = ANCHOR.lonlat(E + pad, N - pad)
    hf = Heightfield((lo, la, hi_lon, hi_lat), z=15)
    g.fill_from(hf, ANCHOR)

    # Carve the river. A DEM's water surface is whatever the sensor saw, which
    # over a river is noisy and a metre or two high; left alone the flat water
    # plane pokes through it in patches that read as islands.
    if water_polys:
        big = unary_union([p for p in water_polys if p.area > 400])
        gx = g.west + np.arange(nx + 1) * CELL
        gz = g.north + np.arange(nz + 1) * CELL
        X, Z = np.meshgrid(gx, gz)
        pts = shapely.points(X.ravel(), Z.ravel())
        mask = shapely.contains(big, pts).reshape(X.shape)
        g.carve(mask, WATER - 1.6)
        print(f"  carved {int(mask.sum())} terrain nodes under water")
    g.smooth(1)
    return g


def river_route(water_polys):
    """A centreline down the Willamette, so boats have somewhere to be.

    NOT "the biggest polygon": the biggest water body reachable from this bbox
    is the COLUMBIA, four times the Willamette's area and entirely north of the
    play area -- picking by area put the route off the map and the whole scan
    came back empty. The union is clipped to the play area first and the widest
    run in each row wins, which cannot pick a river that is not here.

    Scanning by z and taking the widest span is right HERE and is not general:
    the Willamette runs roughly north-south through this bbox, so an east-west
    cut crosses it exactly once and the longest run of that cut IS the channel.
    A river running east-west would say so loudly -- the route would come out
    as a handful of disconnected rows instead of one long chain.

    The half width comes out of the same cut and is what keeps a boat off the
    seawall without anything being typed.
    """
    if not water_polys:
        return []
    clip = shbox(W - 200, N - 200, E + 200, S + 200)
    big = shapely.intersection(unary_union(water_polys), clip)
    if big.is_empty:
        return []
    step = 40.0
    row = []
    z = N
    while z <= S:
        cut = shapely.intersection(big, LineString([(W - 400, z), (E + 400, z)]))
        best = None
        for part in getattr(cut, "geoms", [cut]):
            if part.is_empty or part.geom_type != "LineString":
                continue
            xs = [c[0] for c in part.coords]
            w = max(xs) - min(xs)
            if best is None or w > best[1]:
                best = ((max(xs) + min(xs)) * 0.5, w)
        # A river is WIDE. Anything narrower than this is a slough, a dock or a
        # pond, and stringing those into the chain puts a tugboat in a car park.
        if best and best[1] > 60.0:
            row.append((best[0], z, best[1] * 0.5))
        z += step

    if len(row) < 6:
        return []
    # Smooth the x series: a scanline through a polygon with piers and moorings
    # in it jitters by ten metres a row, and a boat following that weaves.
    xs = np.array([r[0] for r in row])
    hw = np.array([r[2] for r in row])
    for _ in range(4):
        xs = np.convolve(np.pad(xs, 1, mode="edge"), [0.25, 0.5, 0.25], "valid")
        hw = np.convolve(np.pad(hw, 1, mode="edge"), [0.25, 0.5, 0.25], "valid")
    return [[round(float(x), 1), round(float(r[1]), 1), round(float(h), 1)]
            for x, r, h in zip(xs, row, hw)]


# --------------------------------------------------------------------------
# 2. buildings
# --------------------------------------------------------------------------
def ring_ccw_from_above(coords):
    """Emit rings anticlockwise SEEN FROM ABOVE.

    Seen from +Y the screen frame is x right, -z up, so "anticlockwise from
    above" is a positive signed area in (x, -z) -- which is CLOCKWISE in the
    raw (x, z) numbers. Getting this backwards turns every wall inside out and
    the city renders as a hole, so it is computed rather than assumed.
    """
    a = 0.0
    n = len(coords)
    for i in range(n):
        x0, z0 = coords[i]
        x1, z1 = coords[(i + 1) % n]
        a += x0 * (-z1) - x1 * (-z0)
    return coords if a > 0 else coords[::-1]


def bake_buildings(g):
    t = load("buildings-building")
    geoms = project(t["geometry"].to_pylist())
    heights = t["height"].to_pylist()
    floors = t["num_floors"].to_pylist()
    minh = t["min_height"].to_pylist()
    cls = t["class"].to_pylist()
    sub = t["subtype"].to_pylist()
    roofsh = t["roof_shape"].to_pylist()
    names = t["names"].to_pylist()

    out = defaultdict(list)
    far = []
    landmarks = []
    dropped = 0

    for k, geom in enumerate(geoms):
        if geom is None or geom.is_empty:
            continue
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        for poly in polys:
            if poly.area < 9.0:
                dropped += 1
                continue
            cx, cz = poly.centroid.x, poly.centroid.y
            if not inside(cx, cz):
                continue
            # Simplify hard: a 40-vertex ML footprint and its 8-vertex
            # simplification are the same building at any distance a player is
            # ever at, and the difference is most of the file size.
            s = poly.simplify(0.45, preserve_topology=True)
            if s.is_empty or s.geom_type != "Polygon":
                s = poly
            ring = list(s.exterior.coords)[:-1]
            if len(ring) < 3:
                continue
            if len(ring) > 64:
                ring = list(s.simplify(1.2).exterior.coords)[:-1]
                if len(ring) < 3 or len(ring) > 250:
                    ring = list(s.minimum_rotated_rectangle.exterior.coords)[:-1]
            ring = ring_ccw_from_above(ring)

            h = heights[k]
            ci = C.building_class(cls[k], sub[k], h)
            cname = C.BUILDING[ci]
            if not h:
                h = (floors[k] * 3.3 + 0.9) if floors[k] else C.FALLBACK_H[cname]
            h = max(2.2, min(h, 260.0))

            xs = [p[0] for p in ring]
            zs = [p[1] for p in ring]
            base = g.min_under(xs, zs) + (minh[k] or 0.0)
            top = base + h

            # Roof. A pitched roof is one ridge segment: the runtime lofts every
            # eaves edge to its nearest point on that segment, so a ridge that
            # has collapsed to a point is a pyramid and a ridge that spans the
            # footprint is a gable, with no second code path.
            shape = (roofsh[k] or "").lower()
            pitched = shape in ("gabled", "hipped", "pyramidal", "half_hipped",
                                "gambrel", "round", "skillion", "mansard")
            if not shape:
                pitched = cname in C.PITCHED and h < 22.0
            if shape in ("flat", "dome"):
                pitched = False
            ridge, roof_h = (0, 0, 0, 0), 0.0
            if pitched:
                ridge, roof_h = ridge_for(s, shape)

            tri = earcut.triangulate_float32(
                np.array([[x, -z] for x, z in ring], dtype=np.float32),
                np.array([len(ring)], dtype=np.uint32))
            if len(tri) != (len(ring) - 2) * 3:
                continue                     # degenerate ring; earcut bailed

            nm = (names[k] or {}).get("primary") if names[k] else None
            is_landmark = bool(nm) and (h >= 24 or s.area >= 2200)
            i, j = chunk_of(cx, cz)
            ox, oz = W + i * CH, N + j * CH
            out[(i, j)].append(dict(
                ring=[(x - ox, z - oz) for x, z in ring], tri=tri,
                cls=ci, roof=1 if pitched else 0, flags=1 if is_landmark else 0,
                base=base, top=top, roof_h=roof_h,
                ridge=(ridge[0] - ox, ridge[1] - oz, ridge[2] - ox, ridge[3] - oz)))

            if h >= 16.0:
                b = s.bounds
                far.append((cx, cz, base, top + roof_h, (b[2]-b[0])/2, (b[3]-b[1])/2, ci))
            if is_landmark:
                lon, lat = ANCHOR.lonlat(cx, cz)
                landmarks.append(dict(id=f"b{len(landmarks)}", kind="building", name=nm,
                                      x=round(cx, 1), z=round(cz, 1),
                                      y=round(base, 1), height=round(h, 1),
                                      lon=round(lon, 6), lat=round(lat, 6),
                                      chunk=[i, j]))
    n = sum(len(v) for v in out.values())
    print(f"  buildings: {n} in {len(out)} chunks ({dropped} under 9 m2 dropped), "
          f"{len(far)} in the skyline, {len(landmarks)} named landmarks")
    return out, far, landmarks


def ridge_for(poly, shape):
    """Ridge segment and rise, from the footprint's own oriented box."""
    r = poly.minimum_rotated_rectangle
    c = list(r.exterior.coords)[:-1]
    if len(c) < 4:
        p = poly.centroid
        return (p.x, p.y, p.x, p.y), 2.4
    e = [(math.dist(c[i], c[(i + 1) % 4]), i) for i in range(4)]
    e.sort()
    short_len, si = e[0]
    long_len, li = e[-1]
    # Midpoints of the two SHORT sides span the long axis: that is the ridge.
    a = mid(c[si], c[(si + 1) % 4])
    b = mid(c[(si + 2) % 4], c[(si + 3) % 4])
    rise = min(max(short_len * 0.30, 1.6), 5.5)
    if shape == "pyramidal" or long_len < short_len * 1.35:
        p = poly.centroid
        return (p.x, p.y, p.x, p.y), rise
    if shape in ("hipped", "half_hipped", "mansard", "round"):
        t = min(0.45, (short_len * 0.5) / max(long_len, 1e-3))
        a2 = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        b2 = (b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t)
        return (a2[0], a2[1], b2[0], b2[1]), rise
    return (a[0], a[1], b[0], b[1]), rise       # gabled: ridge spans the roof


def mid(p, q):
    return ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)


# --------------------------------------------------------------------------
# 3. roads, and the one thing a heightmap cannot do
# --------------------------------------------------------------------------
def resample(pts, step=9.0):
    """Insert points so no segment is longer than `step`.

    A road is draped on the terrain grid one vertex at a time, so a 120 m
    straight with two vertices cuts straight through a hill. This is the whole
    fix and it costs a few bytes.
    """
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b)
        n = int(d // step)
        for i in range(1, n + 1):
            f = i * step / d
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
        out.append(b)
    ded = [out[0]]
    for p in out[1:]:
        if math.dist(p, ded[-1]) > 0.05:
            ded.append(p)
    return ded


def road_flags(rf):
    s = set()
    for e in (rf or []):
        for v in (e.get("values") or []):
            s.add(v)
    return s


def road_width(wr, cname):
    for e in (wr or []):
        v = e.get("value")
        if v:
            return float(v)
    return C.ROAD_WIDTH.get(cname, 6.0)


def road_class(cls, subclass):
    if subclass in ("sidewalk", "crosswalk", "parking_aisle", "driveway", "alley",
                    "cycle_crossing"):
        return "cycleway" if subclass == "cycle_crossing" else subclass
    c = cls or "unknown"
    return c if c in C.RI else "unknown"


def solve_bridge_decks(segs, g):
    """Heights for every bridge vertex: fixed at the abutments, SOLVED between.

    A bridge is the one road that must NOT follow the ground, and the ground
    under it is a river. The abutments are the connectors a bridge shares with a
    road that is ON the ground, so those take the terrain height and everything
    between them is the harmonic (minimum-bending) surface through them. On a
    simple span that is a level deck; on a ramp it is a straight grade; on an
    interchange it is the smoothest set of grades meeting every abutment. One
    rule, no per-bridge data.

    TWO THINGS HERE WERE WRONG IN TURN, and both were invisible to every check
    that measured a length rather than a SLOPE.

    1. IT IS SOLVED, NOT RELAXED. The first version ran four hundred
       Gauss-Seidel sweeps, which is plenty for a twelve-vertex span and nowhere
       near enough for a two-kilometre viaduct -- Gauss-Seidel on a chain of n
       needs O(n^2) sweeps, so the middle of every long structure kept the
       TERRAIN WIGGLES it was initialised with. Measured: 278 bridge segments
       over 20%, freeway decks at 34%.

    2. THE TOPOLOGY IS OVERTURE'S CONNECTORS, NOT COINCIDING COORDINATES. The
       second version keyed the graph on snapped (x, z), which is right almost
       everywhere and catastrophically wrong at the one place bridges get
       interesting: a freeway STACK, where two decks cross at the same plan
       position twenty feet apart vertically. Snapped, they become ONE node and
       the solver averages two decks into a spike through both. Overture ships
       the real connectivity; a shared `connector_id` is a junction and a shared
       coordinate is not.
    """
    bridges = [s for s in segs if s["bridge"]]
    if not bridges:
        return {}, (lambda si, k: None)

    # Which connectors does a road ON THE GROUND use? Those are the abutments.
    ground_conn = set()
    for s in segs:
        if s["bridge"]:
            continue
        for c in (s["conn"] or []):
            ground_conn.add(c["connector_id"])

    # node id: a shared connector where there is one, otherwise the vertex itself
    nid = {}
    for si, s in enumerate(bridges):
        L = _arc(s["pts"])
        total = L[-1] or 1.0
        for c in (s["conn"] or []):
            t = c.get("at")
            if t is None:
                continue
            k = int(np.argmin(np.abs(np.asarray(L) - t * total)))
            nid[(si, k)] = ("c", c["connector_id"])
        for k in range(len(s["pts"])):
            nid.setdefault((si, k), ("v", si, k))

    nbr = defaultdict(dict)
    pos = {}
    for si, s in enumerate(bridges):
        pts = s["pts"]
        for k in range(len(pts)):
            pos.setdefault(nid[(si, k)], pts[k])
        for k in range(len(pts) - 1):
            a, b = nid[(si, k)], nid[(si, k + 1)]
            if a == b:
                continue
            w = 1.0 / max(0.5, math.dist(pts[k], pts[k + 1]))
            nbr[a][b] = max(nbr[a].get(b, 0.0), w)
            nbr[b][a] = max(nbr[b].get(a, 0.0), w)

    terr = {k: float(g.at(np.array([p[0]]), np.array([p[1]]))[0]) for k, p in pos.items()}

    seen, comps = set(), []
    for k in nbr:
        if k in seen:
            continue
        stack, comp = [k], []
        seen.add(k)
        while stack:
            c = stack.pop()
            comp.append(c)
            for m in nbr[c]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        comps.append(comp)

    h = {}
    for comp in comps:
        anchors = {k for k in comp
                   if (k[0] == "c" and k[1] in ground_conn) or len(nbr[k]) <= 1}
        if not anchors:
            # A closed loop of bridge has no abutment. Pin its lowest vertex so
            # the system has a solution at all.
            anchors = {min(comp, key=lambda k: terr[k])}
        fixed = {k: terr[k] for k in anchors}
        sol = fixed
        for _ in range(3):
            sol = _harmonic(comp, nbr, fixed)
            lift = {k: f for k, f in
                    ((k, max(terr[k] + 0.25,
                             (WATER + 3.5) if terr[k] < WATER + 0.2 else -1e9)) for k in comp)
                    if k not in fixed and sol[k] < f - 1e-6}
            if not lift:
                break
            fixed.update(lift)
        for k in comp:
            h[k] = max(sol[k], terr[k] + 0.2)

    def lookup(si, k):
        return h.get(nid.get((si, k)))
    return h, lookup


def _arc(pts):
    L, d = [0.0], 0.0
    for a, b in zip(pts, pts[1:]):
        d += math.dist(a, b)
        L.append(d)
    return L


def _harmonic(comp, nbr, fixed):
    """Minimum-bending heights over a graph with some nodes held."""
    free = [k for k in comp if k not in fixed]
    if not free:
        return dict(fixed)
    idx = {k: i for i, k in enumerate(free)}
    n = len(free)
    A = np.zeros((n, n), dtype=np.float64)
    b = np.zeros(n, dtype=np.float64)
    for k in free:
        i = idx[k]
        for m, w in nbr[k].items():
            A[i, i] += w
            if m in idx:
                A[i, idx[m]] -= w
            else:
                b[i] += w * fixed[m]
    try:
        x = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        x = np.linalg.lstsq(A, b, rcond=None)[0]
    out = dict(fixed)
    for k in free:
        out[k] = float(x[idx[k]])
    return out


def bridge_landmarks(segs):
    """Name the bridges, and give each one a box.

    This is what makes the city a SCAFFOLD rather than a demo. The point of a
    procedural Portland is that you can pick one thing -- the Burnside Bridge --
    build it properly by hand, and drop it in; and for that you need the thing
    to have a NAME, a POSITION and a REGION that the generator agrees to leave
    alone. The region comes free: it is the bounding box of the connected run of
    bridge segments that share a name, padded a little.
    """
    runs = defaultdict(list)
    for s in segs:
        if not s["bridge"] or not s.get("name"):
            continue
        runs[s["name"]].append(s)
    out = []
    for name, group in runs.items():
        xs = [p[0] for s in group for p in s["pts3"]]
        zs = [p[1] for s in group for p in s["pts3"]]
        ys = [p[2] for s in group for p in s["pts3"]]
        if not xs or not inside(sum(xs)/len(xs), sum(zs)/len(zs), 200):
            continue
        if max(xs) - min(xs) < 30 and max(zs) - min(zs) < 30:
            continue                     # a culvert, not a bridge
        cx, cz = (min(xs)+max(xs))/2, (min(zs)+max(zs))/2
        lon, lat = ANCHOR.lonlat(cx, cz)
        out.append(dict(id="br%d" % len(out), kind="bridge", name=name,
                        x=round(cx, 1), z=round(cz, 1), y=round(sum(ys)/len(ys), 1),
                        height=round(max(ys)-min(ys), 1),
                        lon=round(lon, 6), lat=round(lat, 6),
                        clear=dict(x0=round(min(xs)-12, 1), z0=round(min(zs)-12, 1),
                                   x1=round(max(xs)+12, 1), z1=round(max(zs)+12, 1),
                                   y0=round(min(ys)-14, 1), y1=round(max(ys)+40, 1))))
    out.sort(key=lambda d: -((d["clear"]["x1"]-d["clear"]["x0"]) *
                             (d["clear"]["z1"]-d["clear"]["z0"])))
    print(f"  bridges named: {len(out)} -- " + ", ".join(d["name"] for d in out[:8]))
    return out


def make_pavements(segs):
    """A pavement down both sides of every street that has not got one.

    OSM maps separate sidewalk ways where somebody has bothered -- downtown and
    a few main streets -- and nowhere else, which is most of the city. Without
    these, SE Hawthorne is a road with LAWN either side of it and nobody on
    foot, because the crowd walks the pavement network and there is none.

    Generated ones are suppressed where a real one already runs, so the two
    never sit a metre apart as a double kerb. They carry the `sidewalk` class,
    so they are drawn, walked on and collided with by exactly the same code as
    the mapped ones -- there is no second kind of pavement.
    """
    mapped = Hash2D(6.0)
    for s in segs:
        if s["cls"] in ("sidewalk", "footway", "pedestrian"):
            for p in s["pts"]:
                mapped.add(p[0], p[1])
    out = []
    kept = 0
    for s in segs:
        if s["cls"] not in C.PAVED or s["bridge"]:
            continue
        half = s["w"] * 0.5 + 1.15
        for side in (-1, 1):
            line = []
            for k, p in enumerate(s["pts"]):
                a = s["pts"][max(0, k - 1)]
                b = s["pts"][min(len(s["pts"]) - 1, k + 1)]
                dx, dz = b[0] - a[0], b[1] - a[1]
                L = math.hypot(dx, dz)
                if L < 1e-6:
                    continue
                nx, nz = -dz / L, dx / L
                px, pz = p[0] + nx * half * side, p[1] + nz * half * side
                if mapped.near(px, pz, 4.0):
                    if len(line) >= 2:
                        out.append(dict(pts=line, cls="sidewalk", bridge=False,
                                        steps=False, w=2.1, conn=None, name=s.get("name")))
                        kept += 1
                    line = []
                    continue
                line.append((px, pz))
            if len(line) >= 2:
                out.append(dict(pts=line, cls="sidewalk", bridge=False, steps=False,
                                w=2.1, conn=None, name=s.get("name")))
                kept += 1
    print(f"  pavements: {kept} generated where none is mapped")
    return out


def bake_roads(g):
    t = load("transportation-segment")
    geoms = project(t["geometry"].to_pylist())
    cls = t["class"].to_pylist()
    sub = t["subclass"].to_pylist()
    subtype = t["subtype"].to_pylist()
    flags = t["road_flags"].to_pylist()
    widths = t["width_rules"].to_pylist()
    names = t["names"].to_pylist()
    conns = t["connectors"].to_pylist()

    segs = []
    for k, geom in enumerate(geoms):
        if geom is None or geom.is_empty or geom.geom_type != "LineString":
            continue
        pts = [(x, z) for x, z in geom.coords]
        if len(pts) < 2:
            continue
        if not any(inside(x, z, 60) for x, z in pts):
            continue
        f = road_flags(flags[k])
        if "is_tunnel" in f or "is_abandoned" in f or "is_under_construction" in f:
            continue
        cname = "rail" if subtype[k] == "rail" else road_class(cls[k], sub[k])
        pts = resample(pts, 9.0)
        br = "is_bridge" in f
        segs.append(dict(pts=pts, cls=cname, bridge=br, steps=(cname == "steps"),
                         w=road_width(widths[k], cname), conn=conns[k],
                         name=(names[k] or {}).get("primary") if names[k] else None))

    segs += make_pavements(segs)
    deck, deck_at = solve_bridge_decks(segs, g)
    nbr_count = sum(1 for s in segs if s["bridge"])
    print(f"  bridges: {nbr_count} segments, {len(deck)} deck nodes solved")

    out = defaultdict(list)
    centrelines = []                     # kept in metres for the prop generator
    bi = -1
    for s in segs:
        xs = np.array([p[0] for p in s["pts"]])
        zs = np.array([p[1] for p in s["pts"]])
        ys = g.at(xs, zs)
        if s["bridge"]:
            bi += 1
            ys = np.array([deck_at(bi, k) if deck_at(bi, k) is not None else y
                           for k, y in enumerate(ys)])
        pts3 = list(zip(xs.tolist(), zs.tolist(), ys.tolist()))
        s["pts3"] = pts3
        centrelines.append(s)
        for (i, j), piece in split_by_chunk(pts3):
            if len(piece) < 2:
                continue
            ox, oz = W + i * CH, N + j * CH
            out[(i, j)].append(dict(
                cls=C.RI[s["cls"]],
                flags=(1 if s["bridge"] else 0) | (4 if s["steps"] else 0),
                w4=max(2, min(255, int(round(s["w"] * 4)))),
                pts=[(p[0] - ox, p[1] - oz, p[2]) for p in piece]))
    n = sum(len(v) for v in out.values())
    print(f"  roads: {len(segs)} segments -> {n} chunk pieces")
    # After the drape loop, not before it: `pts3` is what carries the solved
    # deck heights and it does not exist until every segment has been walked.
    return out, centrelines, bridge_landmarks(segs)


def split_by_chunk(pts3, maxpts=250):
    """Cut a polyline where it crosses a chunk boundary.

    The crossing vertex goes into BOTH chunks, so the ribbon the runtime builds
    has no gap at the seam. Dropping it instead leaves a chunk-wide crack in
    every street, which reads as the road not loading.
    """
    runs = []
    cur, cc = [], None
    for p in pts3:
        c = chunk_of(p[0], p[1])
        if cc is None:
            cc = c
        if c != cc:
            cur.append(p)
            runs.append((cc, cur))
            cur, cc = [p], c
        else:
            cur.append(p)
        if len(cur) >= maxpts:
            runs.append((cc, cur))
            cur = [p]
    if len(cur) >= 2:
        runs.append((cc, cur))
    return runs


# --------------------------------------------------------------------------
# 4. ground cover
# --------------------------------------------------------------------------
GRID = 25.0        # metres: how finely an area polygon is cut up before draping


def triangulate(poly):
    """(verts, indices) for a shapely polygon, holes included, CCW from above."""
    rings = [list(poly.exterior.coords)[:-1]]
    for h in poly.interiors:
        rings.append(list(h.coords)[:-1])
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None
    verts, sizes = [], []
    for r in rings:
        verts += r
        sizes.append(len(r))
    flat = np.array([[x, -z] for x, z in verts], dtype=np.float32)
    idx = earcut.triangulate_float32(flat, np.cumsum(sizes, dtype=np.uint32))
    if len(idx) < 3:
        return None
    return verts, idx


def bake_areas(g, water_polys, water_cls, land_rows, use_rows):
    """Land cover, clipped to chunks and cut on a grid so it hugs the terrain.

    Cutting on a grid is the whole trick. A park is a handful of vertices, and
    a triangle spanning 200 m of a hillside is a ramp through it -- so the
    polygon is intersected with a 25 m lattice first and each piece draped on
    its own. Water is exempt: a river is flat by definition and subdividing it
    only makes triangles.
    """
    out = defaultdict(list)
    items = []
    for poly, ci in zip(water_polys, water_cls):
        items.append((poly, ci, True))
    for poly, ci in land_rows + use_rows:
        items.append((poly, ci, False))

    play = shbox(W, N, E, S)
    for poly, ci, flat in items:
        if poly is None or poly.is_empty or ci is None:
            continue
        for p in (poly.geoms if poly.geom_type == "MultiPolygon" else [poly]):
            if p.area < 60:
                continue
            p = p.intersection(play)
            if p.is_empty:
                continue
            for q in (p.geoms if p.geom_type in ("MultiPolygon", "GeometryCollection") else [p]):
                if q.geom_type != "Polygon" or q.area < 40:
                    continue
                emit_area(out, g, q, ci, flat)
    raw = sum(len(v) for v in out.values())
    out = merge_areas(out)
    n = sum(len(v) for v in out.values())
    tri = sum(len(a["idx"]) // 3 for v in out.values() for a in v)
    print(f"  areas: {raw} grid pieces merged to {n} records, {tri} triangles")
    return out


def merge_areas(out):
    """One record per class per chunk.

    The 25 m lattice that makes an area hug the terrain also shatters it into
    hundreds of scraps, and a record header per scrap costs more than the
    geometry does. They are welded back together here rather than in the
    runtime, where it would be the same loop with a worse profiler.
    """
    LIMIT = 60000                       # nv is a u16
    merged = {}
    for key, items in out.items():
        bycls = defaultdict(list)
        for it in items:
            bycls[it["cls"]].append(it)
        res = []
        for ci, group in bycls.items():
            verts, idx = [], []
            for it in group:
                if len(verts) + len(it["verts"]) > LIMIT:
                    res.append(dict(cls=ci, verts=verts, idx=idx))
                    verts, idx = [], []
                base = len(verts)
                verts += it["verts"]
                idx += [int(v) + base for v in it["idx"]]
            if verts:
                res.append(dict(cls=ci, verts=verts, idx=idx))
        merged[key] = res
    return merged


def emit_area(out, g, poly, ci, flat):
    b = poly.bounds
    cells = []
    x0 = math.floor(b[0] / GRID) * GRID
    z0 = math.floor(b[1] / GRID) * GRID
    if not flat and (b[2] - b[0] > GRID or b[3] - b[1] > GRID):
        x = x0
        while x < b[2]:
            z = z0
            while z < b[3]:
                cells.append(shbox(x, z, x + GRID, z + GRID))
                z += GRID
            x += GRID
    else:
        cells = [None]
    for cell in cells:
        q = poly if cell is None else poly.intersection(cell)
        if q.is_empty:
            continue
        for r in (q.geoms if q.geom_type in ("MultiPolygon", "GeometryCollection") else [q]):
            if r.geom_type != "Polygon" or r.area < 4:
                continue
            t = triangulate(r)
            if not t:
                continue
            verts, idx = t
            cx, cz = r.centroid.x, r.centroid.y
            i, j = chunk_of(cx, cz)
            ox, oz = W + i * CH, N + j * CH
            if flat:
                ys = [WATER] * len(verts)
            else:
                ys = (g.at(np.array([v[0] for v in verts]),
                           np.array([v[1] for v in verts])) + 0.06).tolist()
            out[(i, j)].append(dict(
                cls=ci,
                verts=[(v[0] - ox, v[1] - oz, y) for v, y in zip(verts, ys)],
                idx=idx))


# --------------------------------------------------------------------------
# 4b. businesses
# --------------------------------------------------------------------------
def bake_shops(g, places, footprints, fgeo, centrelines):
    """Put every business on the wall it actually trades from.

    A place is a POINT -- usually somewhere inside the building, sometimes in
    the middle of its block -- and a sign has to be on a WALL FACING THE STREET.

    THE NEAREST WALL IS NOT THE STREET WALL, and taking it put 14% of Portland's
    shopfronts facing into their own building or into the neighbour they share a
    party wall with. Downtown blocks are built wall to wall: step a metre out of
    the back of a building and you are inside the next one. So every edge of the
    footprint is a CANDIDATE, and the one that wins is the one whose outward
    step lands in the open AND lands near a road -- which is the definition of a
    shopfront rather than a description of one.

    TWO SIGNS ON TOP OF EACH OTHER IS WORSE THAN ONE SIGN MISSING. A twelve-
    tenant building has twelve places inside it, all wanting the same frontage,
    so the facade is claimed at `SPACING` metres and the first to ask gets it.
    Sorted by confidence, so what survives is what Overture is surest about.
    """
    SPACING = 7.0
    REACH = 45.0
    OUT = 1.6
    roads = shapely.STRtree([
        LineString([(p[0], p[1]) for p in s["pts3"]])
        for s in centrelines
        if len(s["pts3"]) > 1 and s["cls"] not in ("rail",)])
    claimed = Hash2D(8.0)
    out = defaultdict(list)
    placed = far_from_any = no_face = 0
    for cat, name, conf, x, z in places:
        pt = shapely.points(x, z)
        near = [hi for hi in footprints.query(pt.buffer(REACH))]
        if not near:
            far_from_any += 1
            continue
        near.sort(key=lambda hi: fgeo[hi].distance(pt) if fgeo[hi] is not None else 1e9)
        best = None
        for hi in near[:4]:                      # the four closest buildings
            poly = fgeo[hi]
            if poly is None or poly.is_empty:
                continue
            base = poly.distance(pt)
            if base > 30:
                break
            ring = list((poly.exterior if poly.geom_type == "Polygon" else
                         list(poly.geoms)[0].exterior).coords)[:-1]
            ring = ring_ccw_from_above(ring)
            for i in range(len(ring)):
                ax, az = ring[i]
                bx, bz = ring[(i + 1) % len(ring)]
                ex, ez = bx - ax, bz - az
                L = math.hypot(ex, ez)
                if L < 3.0:
                    continue
                t = max(0.0, min(1.0, ((x - ax) * ex + (z - az) * ez) / (L * L)))
                qx, qz = ax + ex * t, az + ez * t
                # Anticlockwise from above, the outward normal of a->b is
                # (-ez, ex) normalised -- derived once in the wall builder and
                # the same fact here.
                nx, nz = -ez / L, ex / L
                ox_, oz_ = qx + nx * OUT, qz + nz * OUT
                probe = shapely.points(ox_, oz_)
                if any(fgeo[k] is not None and fgeo[k].contains(probe)
                       for k in footprints.query(probe)):
                    continue                      # that wall is a party wall
                rd = roads.query_nearest(probe)
                droad = 1e9
                if len(rd):
                    droad = float(shapely.distance(probe, roads.geometries.take(rd[:1])[0]))
                score = math.hypot(x - qx, z - qz) * 0.6 + droad
                if best is None or score < best[0]:
                    best = (score, (qx, qz), (nx, nz), L)
        if best is None:
            no_face += 1
            continue
        _, bp, bn, blen = best
        if claimed.near(bp[0], bp[1], SPACING):
            continue
        claimed.add(bp[0], bp[1])
        if not inside(bp[0], bp[1]):
            continue
        px, pz = bp[0] + bn[0] * 0.12, bp[1] + bn[1] * 0.12
        y = float(g.at(np.array([px]), np.array([pz]))[0])
        cname = C.SHOP[cat]
        awning = cname in ("food", "cafe", "bar", "shop", "grocery", "pharmacy")
        landmark = cname == "landmark"
        i, j = chunk_of(px, pz)
        ox, oz = W + i * CH, N + j * CH
        out[(i, j)].append(dict(
            cat=cat, flags=(1 if awning else 0) | (2 if landmark else 0),
            yaw=math.atan2(bn[0], -bn[1]),           # bearing of the outward normal
            w=min(blen - 0.6, max(2.2, len(name) * 0.30 + 1.0)),
            x=px - ox, z=pz - oz, y=y,
            h=3.55 if not landmark else 4.2, name=name[:48]))
        placed += 1
    lost = len(places) - placed - far_from_any - no_face
    print(f"  shops: {placed} on street-facing walls ({far_from_any} had no building "
          f"within {REACH:.0f} m, {no_face} had no wall facing anything, "
          f"{lost} lost the frontage to a neighbour)")
    return out


# --------------------------------------------------------------------------
# 5. street furniture
# --------------------------------------------------------------------------
INFRA_PROP = {
    "street_lamp": "street_lamp", "traffic_signals": "traffic_signal",
    "stop": "stop_sign", "give_way": "stop_sign", "bench": "bench",
    "fire_hydrant": "hydrant", "waste_basket": "bin", "bollard": "bollard",
    "bus_stop": "bus_stop", "post_box": "post_box",
    "drinking_water": "drinking_fountain", "power_pole": "power_pole",
    "catenary_mast": "power_pole", "utility_pole": "power_pole",
    "artwork": "artwork", "bicycle_parking": "bike_rack",
    "picnic_table": "picnic_table", "fountain": "fountain", "flagpole": "flagpole",
}


class Hash2D:
    """Enough spatial index to answer 'is there already one of these here'."""
    def __init__(self, cell):
        self.c = cell
        self.g = defaultdict(list)
    def add(self, x, z):
        self.g[(int(x // self.c), int(z // self.c))].append((x, z))
    def near(self, x, z, r):
        cx, cz = int(x // self.c), int(z // self.c)
        rr = r * r
        n = int(r // self.c) + 1
        for i in range(cx - n, cx + n + 1):
            for j in range(cz - n, cz + n + 1):
                for px, pz in self.g.get((i, j), ()):
                    if (px - x) ** 2 + (pz - z) ** 2 < rr:
                        return True
        return False


# --------------------------------------------------------------------------
# 5b. street name blades
# --------------------------------------------------------------------------
# Streets that get a name blade at their junctions. A driveway, an alley and a
# parking aisle do not have street signs and a motorway's name belongs on a
# gantry, not on a post at a corner.
SIGN_ON = {"trunk", "primary", "secondary", "tertiary",
           "residential", "unclassified", "living_street"}

# What is actually painted on a Portland street blade. These are not
# decoration: "Southwest Hawthorne Boulevard" is 31 characters and needs a
# two-metre sign to be legible, "SW HAWTHORNE BLVD" is 17 and fits on the
# blade the real street has. The directional prefix is the whole address
# system here -- SE 12th and NE 12th are two miles apart -- so it is the one
# part that must never be dropped.
ABBR_PRE = {"northwest": "NW", "northeast": "NE", "southwest": "SW",
            "southeast": "SE", "north": "N", "south": "S",
            "east": "E", "west": "W"}
ABBR_SUF = {"street": "ST", "avenue": "AVE", "boulevard": "BLVD", "drive": "DR",
            "road": "RD", "court": "CT", "place": "PL", "lane": "LN",
            "terrace": "TER", "parkway": "PKWY", "highway": "HWY",
            "circle": "CIR", "alley": "ALY", "way": "WAY", "loop": "LOOP",
            "trail": "TRL", "square": "SQ", "bridge": "BRG"}


def abbrev(name):
    """"Southwest Hawthorne Boulevard" -> "SW HAWTHORNE BLVD"."""
    w = name.replace("#", "").split()
    if not w:
        return ""
    if w[0].lower() in ABBR_PRE:
        w[0] = ABBR_PRE[w[0].lower()]
    if len(w) > 1 and w[-1].lower() in ABBR_SUF:
        w[-1] = ABBR_SUF[w[-1].lower()]
    return " ".join(w).upper()[:22]


def bake_street_signs(g, centrelines, footprints, in_road):
    """A blade per street at every junction of two DIFFERENTLY NAMED streets.

    The junction is Overture's CONNECTOR, not a coinciding coordinate -- the
    same lesson the bridge solver paid for, one system along: two streets that
    cross at the same plan position twenty feet apart vertically are a freeway
    stack and not a corner you can stand on.

    A blade's long axis is PARALLEL TO THE STREET IT NAMES, which is how a
    street sign works and is not an arbitrary choice: it puts the blade's face
    square to somebody arriving along the CROSS street, which is the only
    person who needs to read it. Mounted the other way it is edge-on to
    everybody.
    """
    at = defaultdict(list)
    for s in centrelines:
        nm = s.get("name")
        if not nm or s["cls"] not in SIGN_ON or not s["conn"]:
            continue
        pts = s["pts3"]
        L = _arc([(p[0], p[1]) for p in pts])
        total = L[-1] or 1.0
        for c in s["conn"]:
            t = c.get("at")
            if t is None:
                continue
            k = int(np.argmin(np.abs(np.asarray(L) - t * total)))
            a, b = max(k - 1, 0), min(k + 1, len(pts) - 1)
            dx, dz = pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]
            d = math.hypot(dx, dz)
            if d < 0.3:
                continue
            at[c["connector_id"]].append(
                dict(name=nm, ux=dx / d, uz=dz / d, half=s["w"] * 0.5,
                     x=pts[k][0], z=pts[k][1], y=pts[k][2], cls=s["cls"],
                     bridge=s["bridge"]))

    # ONE POST PER CORNER, not one per connector. A divided street carries a
    # connector on each carriageway twenty metres apart, and a slip lane adds a
    # third; without this every boulevard junction grows a little forest.
    taken = Hash2D(36.0)
    out = defaultdict(list)
    made = no_room = 0
    for cid, arms in at.items():
        names = {}
        for a in arms:
            names.setdefault(a["name"], a)
        if len(names) < 2:
            continue
        p = arms[0]
        if not inside(p["x"], p["z"]) or taken.near(p["x"], p["z"], 32.0):
            continue
        # A bridge deck is not a place for a signpost: the post would stand on
        # the water forty feet under the road it names.
        if any(a["bridge"] for a in arms):
            continue
        pick = list(names.values())[:2]
        A, Bb = pick[0], pick[1]
        # Out of BOTH carriageways: along A by B's half width clears the cross
        # street, and along B by A's half width clears A's own. Portland is a
        # grid, so those two are near enough perpendicular for this to be a
        # corner. All four corners are tried and the first clear one wins.
        spot = None
        for sa in (1, -1):
            for sb in (1, -1):
                px = p["x"] + A["ux"] * (Bb["half"] + 2.3) * sa + Bb["ux"] * (A["half"] + 2.3) * sb
                pz = p["z"] + A["uz"] * (Bb["half"] + 2.3) * sa + Bb["uz"] * (A["half"] + 2.3) * sb
                if not inside(px, pz):
                    continue
                if in_road(px, pz) or in_building(footprints, px, pz):
                    continue
                spot = (px, pz)
                break
            if spot:
                break
        if spot is None:
            no_room += 1
            continue
        px, pz = spot
        taken.add(p["x"], p["z"])
        y = float(g.at(np.array([px]), np.array([pz]))[0])
        i, j = chunk_of(px, pz)
        ox, oz = W + i * CH, N + j * CH
        for b, arm in enumerate(pick):
            txt = abbrev(arm["name"])
            if not txt:
                continue
            out[(i, j)].append(dict(
                x=px - ox, z=pz - oz, y=y,
                # bearing of the street this blade names: heading (sin, -cos)
                yaw=math.atan2(arm["ux"], -arm["uz"]) % (2 * math.pi),
                blade=b, post=1 if b == 0 else 0, name=txt))
        made += 1
    n = sum(len(v) for v in out.values())
    print(f"  street signs: {made} posts, {n} blades "
          f"({len(at)} connectors, {no_room} junctions with no clear corner)")
    return out


def carriageway_index(centrelines):
    """Every drivable surface as a polygon, for rejecting props that land in it.

    A tree in the middle of West Burnside is the most obviously wrong thing this
    generator can produce, and it happens at JUNCTIONS: the side street's own
    offset puts its row of trees straight across the main road. Offsetting from
    one centreline can never see that -- the test has to be against every other
    road's surface, which is what this is.
    """
    polys = []
    for s in centrelines:
        if s["cls"] in ("footway", "sidewalk", "path", "steps", "cycleway", "crosswalk"):
            continue
        line = LineString([(p[0], p[1]) for p in s["pts3"]])
        if line.length < 0.5:
            continue
        polys.append(line.buffer(s["w"] * 0.5 + 0.55, cap_style=2, quad_segs=2))
    print(f"  carriageway: {len(polys)} surfaces indexed")
    return shapely.STRtree(polys), polys


def bake_props(g, centrelines, tree_pts, infra_rows, footprints, in_road):
    props = []
    trees = Hash2D(12.0)
    lamps = Hash2D(24.0)

    def add(kind, x, z, yaw=0.0, scale=1.0, tint=0, y=None):
        if not inside(x, z):
            return
        if y is None:
            y = float(g.at(np.array([x]), np.array([z]))[0])
        props.append((C.PI[kind], x, z, y, yaw, scale, tint))

    for x, z in tree_pts:
        if not inside(x, z):
            continue
        trees.add(x, z)
        h = hash01(x, z)
        # A mapped tree downtown is a street tree, and a 28 m Douglas fir on a
        # pavement is the thing everybody who knows the city spots first. The
        # conifer roll is rare and its SIZE is capped separately -- the scale
        # range that suits a maple is absurd on a fir.
        conif = h < 0.07
        add("tree_conifer" if conif else "tree", x, z, yaw=h * 6.283,
            scale=(0.62 + h * 0.5) if conif else (0.85 + h * 0.8),
            tint=int(h * 40) % 6)

    for kind, x, z in infra_rows:
        p = INFRA_PROP.get(kind)
        if not p:
            continue
        if p == "street_lamp":
            lamps.add(x, z)
        add(p, x, z, yaw=hash01(x, z) * 6.283)

    # Generated furniture. Portland maps maybe a tenth of its street lamps and
    # a fraction of its street trees, so a city built only from what is mapped
    # reads as abandoned. Everything generated is DETERMINISTIC on position --
    # with Math.random the same corner grows a different tree each bake and the
    # collider stops agreeing with the picture.
    grown_t = grown_l = in_road_rej = 0
    for s in centrelines:
        w = C.STREETSCAPE.get(s["cls"])
        if not w:
            continue
        half = s["w"] * 0.5
        for (x, z, y, nx, nz, dist) in walk(s["pts3"], 13.5):
            for side in (-1, 1):
                px, pz = x + nx * (half + 1.7) * side, z + nz * (half + 1.7) * side
                hv = hash01(px, pz)
                if hv > w * 0.62:
                    continue
                if trees.near(px, pz, 8.0) or in_building(footprints, px, pz):
                    continue
                if in_road(px, pz):
                    in_road_rej += 1
                    continue
                trees.add(px, pz)
                grown_t += 1
                # A DOUGLAS FIR ON A DOWNTOWN PAVEMENT IS WRONG, and it is the
                # one mistake in this generator that everybody who has been to
                # Portland spots. Firs belong to the yards and the West Hills;
                # the streets a primary or secondary road runs down are planted
                # with deciduous trees, so the conifer roll only happens on the
                # residential classes.
                conif = hv < 0.14 and s["cls"] in ("residential", "unclassified",
                                                   "living_street")
                add("tree_conifer" if conif else "tree", px, pz, yaw=hv * 6.283,
                    scale=(0.60 + hv * 0.4) if conif else (0.8 + hv * 0.7),
                    tint=int(hv * 40) % 6)
        for (x, z, y, nx, nz, dist) in walk(s["pts3"], 31.0):
            side = 1 if int(dist // 31.0) % 2 else -1
            px, pz = x + nx * (half + 0.7) * side, z + nz * (half + 0.7) * side
            if lamps.near(px, pz, 16.0) or in_building(footprints, px, pz):
                continue
            if in_road(px, pz):
                in_road_rej += 1
                continue
            lamps.add(px, pz)
            grown_l += 1
            # The arm reaches OVER the carriageway, which is -n on the side the
            # lamp stands. `box`/`cylinder` take a yaw whose local +X is
            # (cos, sin), so the arguments are (z, x) and not (x, z).
            add("street_lamp", px, pz, yaw=math.atan2(-nz * side, -nx * side))
    # PARKED CARS. Nothing else on this list does as much for a street: an empty
    # kerb reads as a film set, and a line of cars is what says people live here.
    # They are placed against the SAME carriageway index the trees are rejected
    # by, at the kerb, facing along the street -- so they can never sit in a
    # junction or across a driveway's mouth.
    cars = 0
    for s in centrelines:
        fill = C.PARKING.get(s["cls"])
        if not fill:
            continue
        half = s["w"] * 0.5
        for (x, z, y, nx, nz, dist) in walk(s["pts3"], 6.4):
            for side in (-1, 1):
                px, pz = x + nx * (half - 1.15) * side, z + nz * (half - 1.15) * side
                hv = hash01(px * 1.7, pz * 1.7)
                if hv > fill:
                    continue
                if in_building(footprints, px, pz):
                    continue
                # ALONG the street, not across it. `n` is the road's LEFT
                # normal, so the direction of travel is (nz, -nx) -- and the
                # obvious atan2(-nz, nx) parks every car broadside, which is
                # what the first build did.
                ang = math.atan2(-nx, nz)
                add("car", px, pz, yaw=ang + (math.pi if hv < fill * 0.5 else 0),
                    scale=0.92 + hv * 0.3, tint=int(hv * 977) % 12)
                cars += 1
    print(f"  props: {len(props)} total ({cars} parked cars, {len(tree_pts)} mapped trees, "
          f"{grown_t} trees grown, {grown_l} lamps added, {in_road_rej} rejected "
          f"for standing in the road)")

    out = defaultdict(list)
    for p in props:
        i, j = chunk_of(p[1], p[2])
        ox, oz = W + i * CH, N + j * CH
        out[(i, j)].append((p[0], p[1] - ox, p[2] - oz, p[3], p[4], p[5], p[6]))
    return out


def walk(pts3, step):
    """March a polyline, yielding (x, z, y, nx, nz, distance) with n the left normal."""
    d = 0.0
    nxt = step * 0.5
    for a, b in zip(pts3, pts3[1:]):
        dx, dz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dz)
        if L < 1e-6:
            continue
        ux, uz = dx / L, dz / L
        nx, nz = -uz, ux
        while nxt <= d + L:
            f = (nxt - d) / L
            yield (a[0] + dx * f, a[1] + dz * f, a[2] + (b[2] - a[2]) * f, nx, nz, nxt)
            nxt += step
        d += L


def in_building(tree, x, z):
    if tree is None:
        return False
    return len(tree.query(shapely.points(x, z), predicate="intersects")) > 0


def hash01(x, z):
    """Deterministic 0..1 from a position, so a re-bake is the same city."""
    n = math.sin(x * 12.9898 + z * 78.233) * 43758.5453
    return n - math.floor(n)


# --------------------------------------------------------------------------
# 6. writing
# --------------------------------------------------------------------------
def pack_buildings(items):
    b = bytearray()
    for it in items:
        ring = it["ring"]
        n = len(ring)
        b += struct.pack("<BBBB", n, it["cls"], it["roof"], it["flags"])
        b += struct.pack("<hhh", dm(it["base"]), dm(it["top"]), dm(it["roof_h"]))
        b += struct.pack("<hhhh", *[dm(v) for v in it["ridge"]])
        for x, z in ring:
            b += struct.pack("<hh", dm(x), dm(z))
        b += bytes(int(v) for v in it["tri"])
    return b


def pack_roads(items):
    b = bytearray()
    for it in items:
        pts = it["pts"]
        b += struct.pack("<BBBB", it["cls"], it["flags"], it["w4"], len(pts))
        for x, z, y in pts:
            b += struct.pack("<hhh", dm(x), dm(z), dm(y))
    return b


def pack_areas(items):
    b = bytearray()
    for it in items:
        v, idx = it["verts"], it["idx"]
        b += struct.pack("<BBHH", it["cls"], 0, len(v), len(idx) // 3)
        for x, z, y in v:
            b += struct.pack("<hhh", dm(x), dm(z), dm(y))
        for i in idx:
            b += struct.pack("<H", int(i))
    return b


class NameTable:
    """One string table per chunk, SHARED by the shops and the street blades.

    Two sections indexing two tables is two tables to keep in step and two
    copies of "SE HAWTHORNE BLVD" in a chunk that has it on four corners. The
    reader builds one list from NAME and both sections index into it.
    """
    def __init__(self):
        self.list, self.idx = [], {}

    def at(self, nm):
        if nm not in self.idx:
            self.idx[nm] = len(self.list)
            self.list.append(nm)
        return self.idx[nm]

    def bytes(self):
        nb = bytearray()
        for nm in self.list:
            e = nm.encode("utf-8")[:255]
            nb += struct.pack("<B", len(e)) + e
        return bytes(nb)


def pack_shops(items, names):
    b = bytearray()
    for it in items:
        b += struct.pack("<BBBB", it["cat"], it["flags"],
                         int(it["yaw"] / (2*math.pi) % 1.0 * 256) & 255,
                         max(4, min(255, int(round(it["w"] * 4)))))
        b += struct.pack("<hhhh", dm(it["x"]), dm(it["z"]), dm(it["y"]), dm(it["h"]))
        b += struct.pack("<H", names.at(it["name"]))
    return bytes(b)


def pack_signs(items, names):
    b = bytearray()
    for it in items:
        b += struct.pack("<BB", (1 if it["post"] else 0) | (it["blade"] << 1),
                         int(it["yaw"] / (2*math.pi) % 1.0 * 256) & 255)
        b += struct.pack("<hhh", dm(it["x"]), dm(it["z"]), dm(it["y"]))
        b += struct.pack("<H", names.at(it["name"]))
    return bytes(b)


def pack_props(items):
    b = bytearray()
    for kind, x, z, y, yaw, scale, tint in items:
        b += struct.pack("<BBBBhhh", kind,
                         int(yaw / (2 * math.pi) % 1.0 * 256) & 255,
                         max(0, min(255, int((scale - 0.5) / 1.5 * 255))),
                         tint & 255, dm(x), dm(z), dm(y))
    return b


def pack_terrain(g, i, j):
    n = CH // CELL
    x0 = W + i * CH
    z0 = N + j * CH
    gi = int(round((x0 - g.west) / CELL))
    gj = int(round((z0 - g.north) / CELL))
    patch = g.h[gj:gj + n + 1, gi:gi + n + 1]
    return n, struct.pack(f"<{patch.size}h", *[dm(v) for v in patch.ravel()])


def bake_places(centrelines, landmarks):
    """Points that can answer "where am I".

    A street name is the honest answer in a grid city -- "Southwest 5th Avenue"
    tells you more than the name of the building you happen to be beside. Named
    roads are sampled every `SPACING` metres, deduplicated per name so a
    sixty-segment avenue is a line of points and not sixty copies of one.
    """
    SPACING = 70.0
    out = []
    seen = defaultdict(list)
    for s in centrelines:
        nm = s.get("name")
        if not nm:
            continue
        for (x, z, y, nx, nz, d) in walk(s["pts3"], SPACING):
            if not inside(x, z):
                continue
            if any((px-x)**2 + (pz-z)**2 < SPACING*SPACING*0.42 for px, pz in seen[nm]):
                continue
            seen[nm].append((x, z))
            out.append([nm, round(x, 1), round(z, 1)])
    for L in landmarks:
        out.append([L["name"], L["x"], L["z"]])
    print(f"  places: {len(out)} points over {len(seen)} named streets "
          f"+ {len(landmarks)} landmarks")
    return out


def write_all(g, bld, roads, areas, props, shops, signs, far, landmarks, places, river):
    os.makedirs(OUT, exist_ok=True)
    for f in glob.glob(os.path.join(OUT, "*.bin")):
        os.remove(f)
    chunks = []
    total = 0
    for j in range(NC):
        for i in range(NC):
            w = ChunkWriter()
            n, terr = pack_terrain(g, i, j)
            w.add("TERR", n, terr)
            B, R, A, P = bld.get((i, j), []), roads.get((i, j), []), \
                         areas.get((i, j), []), props.get((i, j), [])
            w.add("BLDG", len(B), pack_buildings(B))
            w.add("ROAD", len(R), pack_roads(R))
            w.add("AREA", len(A), pack_areas(A))
            w.add("PROP", len(P), pack_props(P))
            # NOT `S`. That is the module-level SOUTH edge of the world, and
            # shadowing it here wrote the last chunk's shop list into
            # `manifest.world.south` -- so the map overlay's player dot came out
            # at NaN and nothing said why. A one-letter name in a long function
            # is how a constant gets quietly replaced by a list of cafes.
            SH = shops.get((i, j), [])
            SG = signs.get((i, j), [])
            nt = NameTable()
            if SH:
                w.add("SHOP", len(SH), pack_shops(SH, nt))
            if SG:
                w.add("SGNS", len(SG), pack_signs(SG, nt))
            if nt.list:
                w.add("NAME", len(nt.list), nt.bytes())
            data = w.bytes()
            name = f"c{i}_{j}.bin"
            open(os.path.join(OUT, name), "wb").write(data)
            total += len(data)
            chunks.append(dict(i=i, j=j, bytes=len(data), b=len(B), r=len(R),
                               a=len(A), p=len(P), s=len(SH), g=len(SG)))

    fb = bytearray(b"PDXF" + struct.pack("<I", len(far)))
    for cx, cz, base, top, rx, rz, ci in far:
        fb += struct.pack("<hhhhhhBB", int(cx), int(cz), int(base), int(top),
                          int(min(rx, 32000)), int(min(rz, 32000)), ci, 0)
    open(os.path.join(OUT, "far.bin"), "wb").write(bytes(fb))

    spawn_x, spawn_z = ANCHOR.xz(CITY["spawn"][1], CITY["spawn"][0])
    manifest = dict(
        version=1,
        city=CITY["name"],
        anchor=ANCHOR.to_json(),
        world=dict(west=W, east=E, north=N, south=S, chunk=CH, n=NC,
                   terrainCell=CELL, waterLevel=WATER),
        spawn=dict(x=round(spawn_x, 1), z=round(spawn_z, 1),
                   y=round(float(g.at(np.array([spawn_x]), np.array([spawn_z]))[0]), 2)),
        classes=dict(building=C.BUILDING, road=C.ROAD, area=C.AREA, prop=C.PROP,
                     shop=C.SHOP),
        roadWidth=C.ROAD_WIDTH,
        chunks=chunks,
        far=dict(count=len(far), bytes=len(fb)),
        # Where the ambient life runs. The river is measured off the water
        # polygon here rather than guessed at in the runtime, because the
        # runtime only ever has the chunks around the player loaded and a boat
        # has to be able to come from somewhere he has not walked to yet.
        routes=dict(river=river),
        source=dict(
            overture=CITY["release"],
            terrain="AWS elevation-tiles-prod (Terrarium, USGS 3DEP over the US)",
            attribution="(c) OpenStreetMap contributors, (c) Overture Maps Foundation, "
                        "USGS 3DEP. Buildings and roads ODbL; terrain public domain."),
        baked=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=1)
    json.dump(dict(landmarks=landmarks, overrides={}),
              open(os.path.join(OUT, "landmarks.json"), "w"), indent=1)
    json.dump(dict(near=places), open(os.path.join(OUT, "places.json"), "w"))
    big = max(chunks, key=lambda c: c["bytes"])
    print(f"\n  wrote {len(chunks)} chunks, {total/1e6:.2f} MB "
          f"(mean {total/len(chunks)/1024:.0f} kB, worst c{big['i']}_{big['j']} "
          f"{big['bytes']/1024:.0f} kB: {big['b']} buildings, {big['r']} roads, "
          f"{big['a']} areas, {big['p']} props)")
    print(f"  far.bin {len(fb)/1024:.0f} kB ({len(far)} skyline boxes)")


# --------------------------------------------------------------------------
def main():
    t0 = time.time()
    print("Portland bake")

    wt = load("base-water")
    wgeo = project(wt["geometry"].to_pylist())
    wcls = [C.area_class(c, s) for c, s in zip(wt["class"].to_pylist(), wt["subtype"].to_pylist())]
    wpolys = [p for p in wgeo if p is not None and p.geom_type in ("Polygon", "MultiPolygon")]

    print(" terrain")
    g = build_ground(wpolys)

    print(" buildings")
    bld, far, landmarks = bake_buildings(g)
    foot = load("buildings-building")
    fgeo = project(foot["geometry"].to_pylist())
    ftree = shapely.STRtree([p for p in fgeo if p is not None and not p.is_empty])

    print(" roads")
    roads, centrelines, bridges = bake_roads(g)

    print(" ground cover")
    lt = load("base-land")
    lgeo = project(lt["geometry"].to_pylist())
    lcls = [C.area_class(c, s) for c, s in zip(lt["class"].to_pylist(), lt["subtype"].to_pylist())]
    tree_pts = [(p.x, p.y) for p, c in zip(lgeo, lt["class"].to_pylist())
                if p is not None and p.geom_type == "Point" and c in ("tree", "tree_row")]
    land_rows = [(p, c) for p, c in zip(lgeo, lcls)
                 if p is not None and p.geom_type in ("Polygon", "MultiPolygon")]
    ut = load("base-land_use")
    ugeo = project(ut["geometry"].to_pylist())
    ucls = [C.area_class(c, s) for c, s in zip(ut["class"].to_pylist(), ut["subtype"].to_pylist())]
    use_rows = [(p, c) for p, c in zip(ugeo, ucls)
                if p is not None and p.geom_type in ("Polygon", "MultiPolygon")]
    wpair = [(p, c) for p, c in zip(wgeo, wcls)
             if p is not None and p.geom_type in ("Polygon", "MultiPolygon")]
    areas = bake_areas(g, [p for p, _ in wpair], [c for _, c in wpair], land_rows, use_rows)

    print(" businesses")
    pt = load("places-place")
    pgeo = project(pt["geometry"].to_pylist())
    pcats = pt["categories"].to_pylist()
    pnames = pt["names"].to_pylist()
    pconf = pt["confidence"].to_pylist()
    rows = []
    for geom, cat, nm, cf in zip(pgeo, pcats, pnames, pconf):
        if geom is None or geom.geom_type != "Point" or not cf or cf < 0.55:
            continue
        name = (nm or {}).get("primary")
        if not name:
            continue
        k = C.shop_class((cat or {}).get("primary"), (cat or {}).get("alternate"))
        if k is None or not inside(geom.x, geom.y, 60):
            continue
        rows.append((k, name, float(cf), geom.x, geom.y))
    rows.sort(key=lambda r: -r[2])
    shops = bake_shops(g, rows, ftree, list(fgeo), centrelines)

    # ONE carriageway index, built once and handed to both. It is a second and a
    # half of shapely and it is the same question either time -- "is this point
    # in a road" -- so two of them is two things to keep in step.
    road_tree, _ = carriageway_index(centrelines)
    in_road = lambda x, z: len(road_tree.query(shapely.points(x, z),
                                               predicate="intersects")) > 0

    print(" street signs")
    signs = bake_street_signs(g, centrelines, ftree, in_road)

    print(" street furniture")
    it = load("base-infrastructure")
    igeo = project(it["geometry"].to_pylist())
    infra = [(c, p.x, p.y) for p, c in zip(igeo, it["class"].to_pylist())
             if p is not None and p.geom_type == "Point"]
    props = bake_props(g, centrelines, tree_pts, infra, ftree, in_road)

    print(" places")
    landmarks = bridges + landmarks
    places = bake_places(centrelines, landmarks)
    river = river_route(wpolys)
    print(f"  river centreline {len(river)} points"
          + (f", {min(r[2] for r in river)*2:.0f}..{max(r[2] for r in river)*2:.0f} m wide" if river else ""))

    print(" writing")
    write_all(g, bld, roads, areas, props, shops, signs, far, landmarks, places, river)

    # The map the MAP key shows is drawn from the BAKED chunks, not from the
    # source tables: it is wrong if the writer is wrong, if the reader is wrong,
    # or if the winding is inside out, and one glance tells all three apart.
    try:
        import subprocess
        subprocess.run([sys.executable, os.path.join(HERE, "preview.py"), "1400",
                        os.path.join(OUT, "map.png")], check=True)
    except Exception as e:
        print(f"  ! map.png not drawn: {e}")
    print(f"done in {time.time()-t0:.0f}s -> {OUT}")


if __name__ == "__main__":
    main()
