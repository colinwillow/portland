"""Local ENU projection: WGS84 lon/lat <-> game metres.

HANDEDNESS, stated once and never guessed again:

    +X is EAST        +Y is UP        +Z is SOUTH        north is -Z

That is the right-handed basis three.js uses with Y up (east x up = south), so
a camera at +Z looking at the origin is looking NORTH, which is the shot this
game opens on. A compass BEARING (0 = north, 90 = east) becomes a heading
vector (sin b, -cos b) in (x, z), and the model's yaw about +Y is -b, because a
positive yaw about +Y in a right-handed frame turns east toward north, which is
anticlockwise on a compass. `tools/test_geo.py` pins all four cardinals; do
not re-derive this by intuition, it comes out backwards half the time.

The scale factors are evaluated ONCE at the anchor latitude and written into
the manifest, so the runtime converts with the same two numbers rather than its
own copy of a formula. Over a 6 km city the constant-scale error is under 20 cm
-- far below anything the player can see, and worth it to keep one source of
truth.
"""
import math

def metres_per_degree(lat_deg):
    """Metres per degree of latitude and of longitude at this latitude (WGS84)."""
    p = math.radians(lat_deg)
    mlat = 111132.92 - 559.82*math.cos(2*p) + 1.175*math.cos(4*p) - 0.0023*math.cos(6*p)
    mlon = 111412.84*math.cos(p) - 93.5*math.cos(3*p) + 0.118*math.cos(5*p)
    return mlat, mlon

class Anchor:
    """Origin of the game's metre grid."""
    def __init__(self, lat, lon):
        self.lat, self.lon = lat, lon
        self.mlat, self.mlon = metres_per_degree(lat)
    def xz(self, lon, lat):
        return (lon - self.lon) * self.mlon, -(lat - self.lat) * self.mlat
    def lonlat(self, x, z):
        return self.lon + x / self.mlon, self.lat - z / self.mlat
    def to_json(self):
        return {"lat": self.lat, "lon": self.lon,
                "metresPerDegLat": self.mlat, "metresPerDegLon": self.mlon}

def bearing_to_yaw(bearing_deg):
    """Compass bearing -> rotation about +Y, radians."""
    return -math.radians(bearing_deg)

def heading_vec(bearing_deg):
    b = math.radians(bearing_deg)
    return math.sin(b), -math.cos(b)
