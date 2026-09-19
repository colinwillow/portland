"""Mine one city out of Overture Maps without downloading the planet.

Overture publishes GeoParquet on a public S3 bucket, ~280 GB for buildings
alone. Two facts make a city cheap to extract:

  1. Every row carries a `bbox` struct, and Parquet keeps min/max statistics
     for it PER ROW GROUP. The footer alone (about 1.4 MB) says which of a
     file's 256 row groups can possibly touch Portland.
  2. The rows are spatially sorted, so the answer is usually ONE file and a
     dozen row groups. Measured for a 16 km box over Portland: 58 MB fetched,
     19 seconds, 125,006 buildings.

The per-file bbox scan costs a minute for 512 files, so it is CACHED to disk
(`.ovindex/`). Re-baking a different corner of the same city is then instant.
"""
import json, os, re, sys, time, urllib.parse, concurrent.futures as cf
import pyarrow.parquet as pq, pyarrow.compute as pc
from httpfile import HttpFile, get, STATS

BUCKET = "https://overturemaps-us-west-2.s3.amazonaws.com"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ovindex")

def latest_release():
    s = get(f"{BUCKET}/?list-type=2&delimiter=/&prefix=release/").decode()
    rels = sorted(re.findall(r"<Prefix>release/([^/<]+)/</Prefix>", s))
    if not rels:
        raise RuntimeError("no Overture releases listed")
    return rels[-1]

def list_files(prefix):
    keys, token = [], None
    while True:
        u = f"{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefix)}&max-keys=1000"
        if token:
            u += "&continuation-token=" + urllib.parse.quote(token, safe="")
        s = get(u).decode()
        keys += [k for k in re.findall(r"<Key>(.*?)</Key>", s) if k.endswith(".parquet")]
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", s)
        if not m:
            return sorted(keys)
        token = m.group(1)

def _file_bbox(key):
    try:
        md = pq.ParquetFile(HttpFile(BUCKET + "/" + key)).metadata
        X = [1e9, -1e9]; Y = [1e9, -1e9]
        for g in range(md.num_row_groups):
            rg = md.row_group(g)
            for c in range(rg.num_columns):
                col = rg.column(c)
                if not col.statistics:
                    continue
                p = col.path_in_schema
                if p == "bbox.xmin": X[0] = min(X[0], col.statistics.min)
                elif p == "bbox.xmax": X[1] = max(X[1], col.statistics.max)
                elif p == "bbox.ymin": Y[0] = min(Y[0], col.statistics.min)
                elif p == "bbox.ymax": Y[1] = max(Y[1], col.statistics.max)
        return key, [X[0], Y[0], X[1], Y[1]]
    except Exception as e:                       # a bad file must not sink the scan
        print(f"    ! {key.split('/')[-1][:22]}: {e}", file=sys.stderr)
        return key, None

def bbox_index(release, theme, typ, workers=12):
    """{key: [W,S,E,N]} for every file of a theme/type. Cached on disk."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{release}__{theme}__{typ}.json")
    if os.path.exists(path):
        return json.load(open(path))
    prefix = f"release/{release}/theme={theme}/type={typ}/"
    keys = list_files(prefix)
    print(f"  indexing {len(keys)} files of {theme}/{typ} ...", flush=True)
    t = time.time()
    out = {}
    with cf.ThreadPoolExecutor(workers) as ex:
        for k, b in ex.map(_file_bbox, keys):
            if b: out[k] = b
    print(f"  indexed {len(out)} files in {time.time()-t:.0f}s", flush=True)
    json.dump(out, open(path, "w"))
    return out

def _overlaps(b, W, S, E, N):
    return b[0] <= E and b[2] >= W and b[1] <= N and b[3] >= S

def _row_groups(md, W, S, E, N):
    keep = []
    for g in range(md.num_row_groups):
        rg = md.row_group(g); d = {}
        for c in range(rg.num_columns):
            col = rg.column(c)
            if col.path_in_schema.startswith("bbox.") and col.statistics:
                d[col.path_in_schema] = (col.statistics.min, col.statistics.max)
        if len(d) < 4 or _overlaps([d["bbox.xmin"][0], d["bbox.ymin"][0],
                                    d["bbox.xmax"][1], d["bbox.ymax"][1]], W, S, E, N):
            keep.append(g)
    return keep

def fetch(release, theme, typ, bbox, columns, cache_dir=None):
    """Rows of theme/type whose bbox intersects `bbox` = (W,S,E,N)."""
    W, S, E, N = bbox
    tag = f"{theme}-{typ}_{W:.4f}_{S:.4f}_{E:.4f}_{N:.4f}"
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        p = os.path.join(cache_dir, tag + ".parquet")
        if os.path.exists(p):
            t = pq.read_table(p)
            print(f"  {theme}/{typ}: {t.num_rows} rows (cached)", flush=True)
            return t
    idx = bbox_index(release, theme, typ)
    hits = [k for k, b in idx.items() if _overlaps(b, W, S, E, N)]
    tables = []
    t0 = time.time(); b0 = STATS["bytes"]
    for key in hits:
        f = HttpFile(BUCKET + "/" + key, block=1 << 22)
        pf = pq.ParquetFile(f)
        gs = _row_groups(pf.metadata, W, S, E, N)
        if not gs:
            continue
        tb = pf.read_row_groups(gs, columns=columns)
        bb = tb["bbox"].combine_chunks()
        m = pc.and_(pc.and_(pc.less_equal(bb.field("xmin"), E),
                            pc.greater_equal(bb.field("xmax"), W)),
                    pc.and_(pc.less_equal(bb.field("ymin"), N),
                            pc.greater_equal(bb.field("ymax"), S)))
        tables.append(tb.filter(m))
    import pyarrow as pa
    out = pa.concat_tables(tables) if tables else None
    n = out.num_rows if out is not None else 0
    print(f"  {theme}/{typ}: {n} rows from {len(hits)} file(s), "
          f"{(STATS['bytes']-b0)/1e6:.0f} MB, {time.time()-t0:.0f}s", flush=True)
    if cache_dir and out is not None:
        pq.write_table(out, p)
    return out
