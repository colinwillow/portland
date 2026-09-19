"""What gets baked, and where it is.

The anchor is the west end of the Burnside Bridge, because the bridge is the
one piece of Portland everybody pictures and because a bridge is the feature
that forces the engine to be honest about VERTICAL: a deck you can walk over
with a river underneath is a different problem from a heightmap.

The play area is a square number of whole chunks on purpose -- a ragged edge
chunk is a chunk that is mostly empty and still costs a fetch.
"""
CITY = dict(
    name    = "Portland",
    anchor  = (45.5231, -122.6702),   # Burnside Bridge, west end
    half    = 2500,                   # metres from the anchor to each edge
    pad     = 500,                    # fetch this much beyond the play area
    chunk   = 500,                    # metres per chunk, both axes
    terrain_cell = 10,                # metres per terrain sample (3DEP's own grain)
    water_level  = 3.0,               # Willamette surface, metres above datum
    release = "2026-08-19.0",
    spawn   = (45.5231, -122.6745),   # west end of the bridge, on Naito Parkway
)
CITY["west"], CITY["east"] = -CITY["half"], CITY["half"]
CITY["north"], CITY["south"] = -CITY["half"], CITY["half"]
CITY["nchunk"] = (CITY["east"] - CITY["west"]) // CITY["chunk"]
