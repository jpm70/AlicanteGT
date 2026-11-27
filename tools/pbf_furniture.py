"""Mobiliario urbano y terrazas del extracto OSM (Geofabrik, ODbL) -> tools/data/furniture.json
Cada entrada: {k, x, z, ...} en metros locales. k: bench, bin, recycling, bus_stop (shelter, bench), hydrant, bike, postbox, water, terrace.
Uso: python tools/pbf_furniture.py"""
import json, os, sys, collections
import osmium

sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)
AMENITY = {"bench": "bench", "waste_basket": "bin", "recycling": "recycling", "bicycle_parking": "bike", "post_box": "postbox", "drinking_water": "water"}

out, seen = [], set()


def add(k, la, lo, **kw):
    if not (lat_s <= la <= lat_n and lng_w <= lo <= lng_e): return
    x, z = round((lo - LNG0) * KLNG, 1), round(-(la - LAT0) * KLAT, 1)
    key = (k, round(x), round(z))
    if key in seen: return
    seen.add(key)
    out.append({"k": k, "x": x, "z": z, **kw})


fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("amenity", "highway", "emergency", "outdoor_seating"))
for o in fp:
    if not (o.is_node() or o.is_way()): continue
    t = {x.k: x.v for x in o.tags}
    if o.is_node():
        la, lo = o.location.lat, o.location.lon
    else:
        try: pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
        except Exception: continue
        if not pts: continue
        la = sum(p[0] for p in pts) / len(pts); lo = sum(p[1] for p in pts) / len(pts)
    if o.is_node():
        am = t.get("amenity")
        if am in AMENITY: add(AMENITY[am], la, lo, **({"rec": t.get("recycling_type", "")} if am == "recycling" else {}))
        elif t.get("highway") == "bus_stop": add("bus_stop", la, lo, shelter=int(t.get("shelter") == "yes"), bench=int(t.get("bench") == "yes"))
        elif t.get("emergency") == "fire_hydrant": add("hydrant", la, lo)
    if t.get("outdoor_seating") == "yes": add("terrace", la, lo)

json.dump(out, open("tools/data/furniture.json", "w", encoding="utf-8"), ensure_ascii=False)
print(len(out), "elementos", dict(collections.Counter(e["k"] for e in out)))
