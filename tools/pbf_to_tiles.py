"""Extracto OSM de la Comunidad Valenciana (Geofabrik, ODbL) -> tools/data/osm_t/<tx>_<tz>_<tipo>.json
Mismo formato que Overpass `out body geom`, para que build_tiles.py no distinga la fuente.
Uso: curl -L -o tools/data/geofabrik/valencia.osm.pbf https://download.geofabrik.de/europe/spain/valencia-latest.osm.pbf
     python tools/pbf_to_tiles.py"""
import json, os, sys, collections
import osmium
sys.path.insert(0, os.path.dirname(__file__))
from world_config import tiles, tile_bbox_ll, to_ll, X0, X1, Z0, Z1

PBF = "tools/data/geofabrik/valencia.osm.pbf"
OUT = "tools/data/osm_t"
os.makedirs(OUT, exist_ok=True)

# caja total (grados) con margen
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)
M = 0.003
BOX = (lat_s - M, lng_w - M, lat_n + M, lng_e + M)
TB = {t: tile_bbox_ll(*t) for t in tiles()}          # (sur, oeste, norte, este)

def tiles_hit(s, w, n, e):
    return [t for t, (ts, tw, tn, te) in TB.items() if not (n < ts or s > tn or e < tw or w > te)]

NAT_KEYS = (("natural", {"coastline", "water", "beach"}), ("leisure", {"park", "garden", "marina"}),
            ("man_made", {"pier", "breakwater"}), ("landuse", {"grass"}))

def kind_of_way(tags):
    if "highway" in tags: return "highway"
    if "building" in tags: return "building"
    for k, vals in NAT_KEYS:
        if tags.get(k) in vals: return "nat"
    return None

out = collections.defaultdict(list)
nw = nn = 0
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("highway", "building", "natural", "leisure", "man_made", "landuse"))
for o in fp:
    if o.is_node():
        tags = {t.k: t.v for t in o.tags}
        if tags.get("natural") == "tree" or tags.get("highway") in ("street_lamp", "traffic_signals"):
            la, lo = o.location.lat, o.location.lon
            if BOX[0] <= la <= BOX[2] and BOX[1] <= lo <= BOX[3]:
                for t in tiles_hit(la, lo, la, lo): out[(t, "nodes")].append({"type": "node", "id": o.id, "lat": la, "lon": lo, "tags": tags})
                nn += 1
    elif o.is_way():
        tags = {t.k: t.v for t in o.tags}
        kind = kind_of_way(tags)
        if not kind: continue
        try: geom = [{"lat": n.lat, "lon": n.lon} for n in o.nodes]
        except Exception: continue
        if len(geom) < 2: continue
        s = min(p["lat"] for p in geom); n_ = max(p["lat"] for p in geom); w = min(p["lon"] for p in geom); e = max(p["lon"] for p in geom)
        if n_ < BOX[0] or s > BOX[2] or e < BOX[1] or w > BOX[3]: continue
        el = {"type": "way", "id": o.id, "tags": tags, "geometry": geom}
        for t in tiles_hit(s, w, n_, e): out[(t, kind)].append(el)
        nw += 1
        if nw % 20000 == 0: print("ways", nw, flush=True)
print("ways", nw, "nodos", nn, flush=True)
for (t, kind) in [(t, k) for t in tiles() for k in ("highway", "building", "nat", "nodes")]:
    json.dump(out.get((t, kind), []), open(f"{OUT}/{t[0]}_{t[1]}_{kind}.json", "w"))
print("OK", flush=True)
