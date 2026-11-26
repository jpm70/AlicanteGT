"""Muros de OSM (barrier=retaining_wall / city_wall / wall alto, historic=citywalls) -> tools/data/osm_t/<tx>_<tz>_barrier.json
Mismo formato que las demás extracciones (vías con geometry + tags). Uso: python tools/pbf_barriers.py"""
import json, os, sys
import osmium
sys.path.insert(0, os.path.dirname(__file__))
from world_config import tiles, tile_bbox_ll, to_ll, X0, X1, Z0, Z1

PBF = "tools/data/geofabrik/valencia.osm.pbf"
OUT = "tools/data/osm_t"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)
M = 0.003
BOX = (lat_s - M, lng_w - M, lat_n + M, lng_e + M)
TB = {t: tile_bbox_ll(*t) for t in tiles()}


def height(t):
    try: return float(str(t.get("height", "")).replace("m", "").strip())
    except Exception: return None


def keep(t):
    b = t.get("barrier")
    if b in ("retaining_wall", "city_wall"): return True
    if t.get("historic") in ("citywalls", "city_walls", "castle_wall"): return True
    if b == "wall":
        h = height(t)
        return (h is not None and h >= 1.5) or t.get("wall") in ("dry_stone", "stone") or t.get("material") in ("stone", "masonry")
    return False


found = {}
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("barrier", "historic"))
for o in fp:
    if not o.is_way(): continue
    t = {x.k: x.v for x in o.tags}
    if not keep(t): continue
    try: g = [{"lat": n.lat, "lon": n.lon} for n in o.nodes]
    except Exception: continue
    if len(g) < 2: continue
    s = min(p["lat"] for p in g); n_ = max(p["lat"] for p in g); w = min(p["lon"] for p in g); e = max(p["lon"] for p in g)
    if n_ < BOX[0] or s > BOX[2] or e < BOX[1] or w > BOX[3]: continue
    el = {"type": "way", "id": o.id, "tags": {k: t[k] for k in ("barrier", "historic", "height", "material", "wall", "name") if k in t}, "geometry": g}
    for tl, (ts, tw, tn, te) in TB.items():
        if not (n_ < ts or s > tn or e < tw or w > te): found.setdefault(tl, []).append(el)
tot = 0
for tl in tiles():
    json.dump(found.get(tl, []), open(f"{OUT}/{tl[0]}_{tl[1]}_barrier.json", "w"))
    tot += len(found.get(tl, []))
print("OK", tot, "muros (con repeticiones entre teselas)")
