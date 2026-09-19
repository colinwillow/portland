"""The city's terrain grid: ONE source of truth for "how high is the ground".

Everything that touches the ground reads this grid and nothing reads the raw
terrain tiles: the terrain mesh IS this grid, roads are draped on a bilinear
sample of it, buildings sit on its minimum under their footprint, and the
runtime's collider re-implements exactly this bilinear lookup against the same
numbers. Sampling the finer source for roads and the coarser grid for the mesh
is the obvious shortcut and it puts the tarmac a metre under the hillside.

Water is CARVED in rather than drawn on top. A DEM reports the river's banks
honestly and its surface as whatever the sensor saw, so without carving the
Willamette sits in a shallow trough that the flat water plane pokes through in
patches. Under a water polygon the ground is pushed to just below the water
level, which also gives the runtime a free "am I in the river" test.
"""
import numpy as np

class Ground:
    def __init__(self, west, north, cell, nx, nz):
        self.west, self.north, self.cell = west, north, cell
        self.nx, self.nz = nx, nz                 # cells; samples are (nx+1, nz+1)
        self.h = np.zeros((nz + 1, nx + 1), dtype=np.float32)

    def fill_from(self, heightfield, anchor):
        """Sample the terrain tiles at every grid node."""
        gx = self.west + np.arange(self.nx + 1) * self.cell
        gz = self.north + np.arange(self.nz + 1) * self.cell
        X, Z = np.meshgrid(gx, gz)
        lon = anchor.lon + X / anchor.mlon
        lat = anchor.lat - Z / anchor.mlat
        self.h = heightfield.at_many(lon.ravel(), lat.ravel()).reshape(X.shape).astype(np.float32)

    def carve(self, mask, level):
        """Push the ground below a water surface wherever `mask` is set."""
        self.h[mask] = np.minimum(self.h[mask], level)

    def smooth(self, passes=1):
        for _ in range(passes):
            h = self.h
            k = h.copy()
            k[1:-1, 1:-1] = (h[1:-1, 1:-1]*4 + h[:-2, 1:-1] + h[2:, 1:-1]
                             + h[1:-1, :-2] + h[1:-1, 2:]) / 8.0
            self.h = k

    def at(self, x, z):
        """Bilinear height, metres. Mirrored exactly in game/ground.js."""
        u = np.clip((np.asarray(x, dtype=np.float64) - self.west) / self.cell, 0, self.nx - 1e-6)
        v = np.clip((np.asarray(z, dtype=np.float64) - self.north) / self.cell, 0, self.nz - 1e-6)
        i = u.astype(np.int32); j = v.astype(np.int32)
        fu = (u - i).astype(np.float32); fv = (v - j).astype(np.float32)
        h = self.h
        a, b = h[j, i], h[j, i + 1]
        c, d = h[j + 1, i], h[j + 1, i + 1]
        return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv

    def min_under(self, xs, zs):
        return float(np.min(self.at(np.asarray(xs), np.asarray(zs))))
