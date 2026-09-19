"""Pins the projection's DIRECTIONS, not just its magnitudes.

Every check here would pass with the map mirrored if it only asserted distance,
which is the mistake the other repos in this account keep writing down.
"""
import math, sys
from geo import Anchor, heading_vec, bearing_to_yaw, metres_per_degree

fails = []
def ok(name, cond, got=""):
    (print if cond else fails.append)(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  got {got}"))

a = Anchor(45.5231, -122.6702)   # Burnside Bridge, west end

x, z = a.xz(-122.6602, 45.5231)          # 0.01 deg EAST
ok("east is +X", x > 700 and abs(z) < 1e-6, (x, z))
x, z = a.xz(-122.6702, 45.5331)          # 0.01 deg NORTH
ok("north is -Z", z < -1000 and abs(x) < 1e-6, (x, z))
x, z = a.xz(-122.6802, 45.5131)          # west + south
ok("west is -X", x < -700, x)
ok("south is +Z", z > 1000, z)

# round trip
for lon, lat in [(-122.68, 45.51), (-122.65, 45.54), (-122.6702, 45.5231)]:
    lo, la = a.lonlat(*a.xz(lon, lat))
    ok(f"round trip {lon},{lat}", abs(lo-lon) < 1e-9 and abs(la-lat) < 1e-9, (lo, la))

for bearing, want in [(0, (0, -1)), (90, (1, 0)), (180, (0, 1)), (270, (-1, 0))]:
    hx, hz = heading_vec(bearing)
    ok(f"bearing {bearing} heads {want}", abs(hx-want[0]) < 1e-9 and abs(hz-want[1]) < 1e-9, (hx, hz))

# A yaw about +Y applied to the model's forward must reproduce the same vector.
# Model forward is -Z (north) at yaw 0, matching heading_vec(0).
#   R_y(t) = [[cos,0,sin],[0,1,0],[-sin,0,cos]];  R_y(t) . (0,0,-1) = (-sin t, 0, -cos t)
for bearing in (0, 45, 90, 180, 270):
    t = bearing_to_yaw(bearing)
    vx, vz = -math.sin(t), -math.cos(t)
    hx, hz = heading_vec(bearing)
    ok(f"yaw {bearing} matches heading", abs(vx-hx) < 1e-9 and abs(vz-hz) < 1e-9, (vx, vz, hx, hz))

mlat, mlon = metres_per_degree(45.5231)
ok("deg lat ~111.1 km", 111100 < mlat < 111200, mlat)
ok("deg lon ~78 km at 45.5N", 77800 < mlon < 78200, mlon)

print(f"\n{len(fails)} failed")
for f in fails: print(f)
sys.exit(1 if fails else 0)
