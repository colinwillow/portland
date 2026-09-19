"""Ground height for the city, from AWS's public terrain tiles.

`elevation-tiles-prod` serves Terrarium PNGs: height in metres is
`R*256 + G + B/256 - 32768`, which is a 1/256 m quantisation -- far finer than
anything a walking camera resolves. Over the United States the underlying data
is USGS 3DEP at roughly 10 m, so Portland's West Hills and the Willamette's cut
banks are real terrain and not a smooth dome.

Zoom 15 at latitude 45.5 is about 3.3 m per pixel, which is the right grain: a
kerb is not in here (the road surfaces handle that) but a 40 m bluff is.
"""
import io, math, concurrent.futures as cf
import numpy as np
from PIL import Image
from httpfile import get

BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"

def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1/math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y

def _tile(args):
    z, x, y = args
    try:
        im = Image.open(io.BytesIO(get(f"{BASE}/{z}/{x}/{y}.png"))).convert("RGB")
        a = np.asarray(im, dtype=np.float32)
        return (x, y), a[:, :, 0]*256.0 + a[:, :, 1] + a[:, :, 2]/256.0 - 32768.0
    except Exception:
        return (x, y), None

class Heightfield:
    """Elevation in metres, sampled in tile-pixel space, bilinear."""
    def __init__(self, bbox, z=15, workers=12):
        W, S, E, N = bbox
        x0, y0 = lonlat_to_tile(W, N, z)      # north-west
        x1, y1 = lonlat_to_tile(E, S, z)      # south-east
        self.z = z
        self.tx0, self.ty0 = int(math.floor(x0)), int(math.floor(y0))
        tx1, ty1 = int(math.floor(x1)), int(math.floor(y1))
        nx, ny = tx1 - self.tx0 + 1, ty1 - self.ty0 + 1
        self.grid = np.zeros((ny*256, nx*256), dtype=np.float32)
        jobs = [(z, self.tx0+i, self.ty0+j) for j in range(ny) for i in range(nx)]
        missing = 0
        with cf.ThreadPoolExecutor(workers) as ex:
            for (x, y), a in ex.map(_tile, jobs):
                if a is None:
                    missing += 1; continue
                j, i = y - self.ty0, x - self.tx0
                self.grid[j*256:(j+1)*256, i*256:(i+1)*256] = a
        self.nx, self.ny = nx, ny
        print(f"  terrain: {nx}x{ny} tiles at z{z} "
              f"({self.grid.shape[1]}x{self.grid.shape[0]} px, {missing} missing), "
              f"{self.grid.min():.0f}..{self.grid.max():.0f} m", flush=True)

    def px(self, lon, lat):
        x, y = lonlat_to_tile(lon, lat, self.z)
        return (x - self.tx0) * 256.0, (y - self.ty0) * 256.0

    def at(self, lon, lat):
        u, v = self.px(lon, lat)
        return self._bilinear(np.array([u]), np.array([v]))[0]

    def at_many(self, lons, lats):
        n = 2 ** self.z
        lons = np.asarray(lons, dtype=np.float64); lats = np.asarray(lats, dtype=np.float64)
        u = ((lons + 180.0) / 360.0 * n - self.tx0) * 256.0
        r = np.radians(lats)
        v = ((1 - np.log(np.tan(r) + 1/np.cos(r)) / np.pi) / 2 * n - self.ty0) * 256.0
        return self._bilinear(u, v)

    def _bilinear(self, u, v):
        H, W = self.grid.shape
        u = np.clip(u, 0, W - 1.001); v = np.clip(v, 0, H - 1.001)
        i0 = u.astype(np.int32); j0 = v.astype(np.int32)
        fu = (u - i0).astype(np.float32); fv = (v - j0).astype(np.float32)
        g = self.grid
        a = g[j0, i0]; b = g[j0, i0+1]; c = g[j0+1, i0]; d = g[j0+1, i0+1]
        return (a*(1-fu) + b*fu)*(1-fv) + (c*(1-fu) + d*fu)*fv
