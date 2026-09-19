"""Draw the BAKED city from above. The cheapest possible 'look at it'.

Reading the chunk files rather than the source tables is deliberate: this
picture is wrong if the writer is wrong, if the reader is wrong, or if the
winding is inside out, and one glance tells all three apart from the correct
answer -- which no amount of reading the code does.
"""
import json, os, sys, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw
import readchunk

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
M = json.load(open(os.path.join(OUT, "manifest.json")))
Wm, Em = M["world"]["west"], M["world"]["east"]
Nm, Sm = M["world"]["north"], M["world"]["south"]
CH, NC = M["world"]["chunk"], M["world"]["n"]
PX = int(sys.argv[1]) if len(sys.argv) > 1 else 1400
SC = PX / (Em - Wm)
def T(x, z): return ((x - Wm) * SC, (z - Nm) * SC)

AREA_COL = {"water":(60,105,150),"river":(52,96,142),"pond":(70,115,160),
  "park":(120,155,95),"grass":(139,171,110),"forest":(88,128,84),"scrub":(140,155,110),
  "garden":(136,168,108),"pitch":(120,160,110),"playground":(178,152,120),
  "sand":(214,198,160),"plaza":(196,188,174),"parking":(178,175,170),
  "school":(196,185,170),"religious":(190,182,172),"cemetery":(150,168,140),
  "brownfield":(168,158,140),"construction":(190,178,152),
  "residential_lu":(214,206,194),"retail_lu":(214,200,190),"commercial_lu":(210,200,196),
  "industrial_lu":(198,192,190),"wetland":(130,150,130),"railway":(180,172,168),
  "track":(180,170,160)}
ROAD_COL = {"motorway":(120,110,105),"trunk":(125,115,110),"primary":(130,120,112),
  "secondary":(138,128,120),"tertiary":(146,136,128),"residential":(156,148,140),
  "sidewalk":(190,185,178),"footway":(185,180,172),"crosswalk":(220,218,210),
  "steps":(200,170,160),"rail":(110,100,100)}
ac, rc, bc = M["classes"]["area"], M["classes"]["road"], M["classes"]["building"]

img = Image.new("RGB", (PX, PX), (226, 221, 210))
d = ImageDraw.Draw(img, "RGBA")
nb = nr = na = npr = 0
for j in range(NC):
    for i in range(NC):
        p = os.path.join(OUT, f"c{i}_{j}.bin")
        if not os.path.exists(p): continue
        c = readchunk.read(p)
        ox, oz = Wm + i*CH, Nm + j*CH
        for a in c.get("area", []):
            col = AREA_COL.get(ac[a["cls"]], (200,200,200))
            v = a["verts"]
            for k in range(0, len(a["idx"]), 3):
                t = [v[a["idx"][k+q]] for q in range(3)]
                d.polygon([T(ox+q[0], oz+q[1]) for q in t], fill=col)
            na += 1
        for r in c.get("road", []):
            nm = rc[r["cls"]]
            col = ROAD_COL.get(nm, (168,160,152))
            w = max(1.0, r["w"] * SC)
            pts = [T(ox+x, oz+z) for x, z, y in r["pts"]]
            if r["flags"] & 1: col = (200, 140, 110)
            d.line(pts, fill=col, width=int(round(w)), joint="curve")
            nr += 1
        for b in c.get("bldg", []):
            h = b["top"] - b["base"]
            g = max(0, min(255, int(235 - min(h, 80) * 1.9)))
            col = (g, int(g*0.95), int(g*0.9))
            if b["flags"] & 1: col = (196, 120, 96)
            d.polygon([T(ox+x, oz+z) for x, z in b["ring"]], fill=col, outline=(90,85,80))
            nb += 1
        for pr in c.get("prop", []):
            npr += 1
            if pr["kind"] in (0, 1):
                x, y = T(ox+pr["x"], oz+pr["z"])
                d.ellipse([x-1.6, y-1.6, x+1.6, y+1.6], fill=(70,110,60))
img.save(sys.argv[2] if len(sys.argv) > 2 else "/tmp/pdx.png")
print(f"{nb} buildings, {nr} roads, {na} area records, {npr} props -> {sys.argv[2] if len(sys.argv)>2 else '/tmp/pdx.png'}")
