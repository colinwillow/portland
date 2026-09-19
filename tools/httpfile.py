import io, os, urllib.request, ssl, threading
CA = "/root/.ccr/ca-bundle.crt"
_ctx = ssl.create_default_context(cafile=CA)
_opener = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=_ctx),
    urllib.request.ProxyHandler({'https': os.environ.get('HTTPS_PROXY','')}),
)
STATS = {"bytes":0, "reqs":0}

def get(url, start=None, end=None, retries=4):
    req = urllib.request.Request(url)
    if start is not None:
        req.add_header("Range", f"bytes={start}-{'' if end is None else end}")
    last=None
    for i in range(retries):
        try:
            with _opener.open(req, timeout=120) as r:
                b = r.read()
                STATS["bytes"] += len(b); STATS["reqs"] += 1
                return b
        except Exception as e:
            last=e
            import time; time.sleep(1.5*(i+1))
    raise last

def size(url):
    req = urllib.request.Request(url, method="HEAD")
    with _opener.open(req, timeout=60) as r:
        return int(r.headers["Content-Length"])

class HttpFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, with a small block cache."""
    def __init__(self, url, length=None, block=1<<20):
        self.url = url
        self.length = length if length is not None else size(url)
        self.pos = 0
        self.block = block
        self.cache = {}
        self.lock = threading.Lock()
    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        if whence == 0: self.pos = off
        elif whence == 1: self.pos += off
        else: self.pos = self.length + off
        return self.pos
    def _block(self, i):
        b = self.cache.get(i)
        if b is None:
            s = i*self.block
            e = min(s+self.block, self.length)-1
            b = get(self.url, s, e)
            if len(self.cache) > 512: self.cache.clear()
            self.cache[i] = b
        return b
    def read(self, n=-1):
        if n is None or n < 0: n = self.length - self.pos
        n = max(0, min(n, self.length - self.pos))
        if n == 0: return b""
        out = bytearray()
        p = self.pos
        # Big reads go straight out as one request rather than through the cache.
        if n > 4*self.block:
            out = get(self.url, p, p+n-1)
            self.pos = p+n
            return out
        while len(out) < n:
            i = p // self.block
            off = p - i*self.block
            b = self._block(i)
            take = min(n-len(out), len(b)-off)
            out += b[off:off+take]
            p += take
        self.pos = p
        return bytes(out)
    def readinto(self, bb):
        d = self.read(len(bb))
        bb[:len(d)] = d
        return len(d)

# ---------------------------------------------------------------------------
# Why this file exists at all: every geo host worth having (Overpass, Geofabrik,
# the vector-tile CDNs) is behind a key, a rate limit or an egress policy, while
# the two that carry what this game needs are plain S3 buckets served over HTTP
# range requests. Parquet and PNG tiles both read happily that way, so a 540 MB
# Overture file costs ~58 MB to mine for one city instead of a full download.
