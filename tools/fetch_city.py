"""Pull every Overture theme this city needs, once, into tools/.cache/."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import overture as ov
from geo import Anchor
from city import CITY

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")

COLUMNS = {
  ("buildings","building"): ["id","names","height","num_floors","min_height","roof_shape",
                             "roof_color","facade_color","class","subtype","geometry","bbox"],
  # `connectors` is the REAL topology and it is why it is fetched: two decks of
  # a freeway stack cross at the same plan position and are not joined, and no
  # amount of snapping coordinates can tell that from a junction.
  ("transportation","segment"): ["id","names","class","subclass","subtype","road_surface",
                                 "road_flags","width_rules","level_rules","connectors",
                                 "geometry","bbox"],
  ("base","water"):      ["id","names","class","subtype","is_salt","geometry","bbox"],
  ("base","land_use"):   ["id","names","class","subtype","surface","geometry","bbox"],
  ("base","land"):       ["id","names","class","subtype","surface","geometry","bbox"],
  ("base","infrastructure"): ["id","names","class","subtype","height","source_tags","geometry","bbox"],
  # The businesses. This is what turns a block of boxes into a STREET: a corner
  # with Powell's on it is a different corner from an identical corner with
  # nothing on it, and the names are the part no generator can invent.
  ("places","place"): ["id","names","categories","confidence","geometry","bbox"],
}

def fetch_bbox():
    a = Anchor(*CITY["anchor"])
    p = CITY["pad"]
    w, s = a.lonlat(CITY["west"]-p, CITY["south"]+p)
    e, n = a.lonlat(CITY["east"]+p, CITY["north"]-p)
    return (w, s, e, n)

def main():
    bbox = fetch_bbox()
    print(f"bbox lon {bbox[0]:.4f}..{bbox[2]:.4f}  lat {bbox[1]:.4f}..{bbox[3]:.4f}")
    for (theme, typ), cols in COLUMNS.items():
        ov.fetch(CITY["release"], theme, typ, bbox, cols, cache_dir=CACHE)

if __name__ == "__main__":
    main()
