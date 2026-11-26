"""Edificios que en OSM son multipolígonos (relación con building=*): la extracción por vías (pbf_to_tiles.py) los pierde.
Los añade a tools/data/osm_t/<tx>_<tz>_building.json como vías con `holes` (patios interiores). Idempotente.
Uso: python tools/pbf_building_relations.py"""
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


def ring(r): return [{"lat": n.lat, "lon": n.lon} for n in r]


found = {}
fp = osmium.FileProcessor(PBF).with_locations().with_areas(osmium.filter.KeyFilter("building"))
for o in fp:
    if not o.is_area() or o.from_way(): continue
    tags = {t.k: t.v for t in o.tags}
    if "building" not in tags or tags["building"] == "no": continue
    try:
        k = 0
        for outer in o.outer_rings():
            g = ring(outer)
            if len(g) < 4: continue
            holes = [ring(i) for i in o.inner_rings(outer) if len(i) >= 4]
            s = min(p["lat"] for p in g); n_ = max(p["lat"] for p in g); w = min(p["lon"] for p in g); e = max(p["lon"] for p in g)
            if n_ < BOX[0] or s > BOX[2] or e < BOX[1] or w > BOX[3]: continue
            el = {"type": "way", "id": 9_000_000_000 + o.orig_id() * 10 + k, "tags": tags, "geometry": g}
            if holes: el["holes"] = holes
            k += 1
            for t, (ts, tw, tn, te) in TB.items():
                if not (n_ < ts or s > tn or e < tw or w > te): found.setdefault(t, []).append(el)
    except Exception as ex:
        print("rel", o.orig_id(), ex)
tot = 0
for t in tiles():
    f = f"{OUT}/{t[0]}_{t[1]}_building.json"
    cur = json.load(open(f)) if os.path.exists(f) else []
    cur = [e for e in cur if e.get("id", 0) < 9_000_000_000]          # idempotente
    new = found.get(t, [])
    tot += len(new)
    json.dump(cur + new, open(f, "w"))
print("OK", tot, "volúmenes de relaciones añadidos")
