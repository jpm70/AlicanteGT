"""Comercios y locales con nombre del extracto OSM (Geofabrik, ODbL) -> tools/data/pois.json
Cada entrada: {x, z, name, cat, sub}  (metros locales; cat = grupo de color del cartel, sub = etiqueta OSM).
Uso: python tools/pbf_pois.py"""
import json, os, sys
import osmium
sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)

FOOD = {"restaurant", "cafe", "bar", "fast_food", "pub", "ice_cream", "biergarten", "bakery", "pastry", "confectionery", "butcher", "greengrocer", "seafood", "deli", "wine", "beverages", "coffee"}
HEALTH = {"pharmacy", "clinic", "doctors", "dentist", "optician", "hospital", "veterinary", "chemist"}
MONEY = {"bank", "atm", "bureau_de_change", "insurance", "estate_agent", "travel_agency"}
SERV = {"hairdresser", "beauty", "laundry", "dry_cleaning", "post_office", "copyshop", "photo", "mobile_phone", "computer", "electronics", "locksmith", "car_repair", "car_rental"}
FASHION = {"clothes", "shoes", "jewelry", "fashion", "bag", "boutique", "tailor", "fashion_accessories", "perfumery", "cosmetics"}
MARKET = {"supermarket", "convenience", "mall", "department_store", "variety_store", "kiosk", "tobacco", "newsagent", "books", "stationery", "gift", "florist", "toys", "sports", "bicycle", "furniture", "hardware", "pet", "general"}
LODGE = {"hotel", "hostel", "guest_house", "apartment", "motel"}
CULT = {"theatre", "cinema", "museum", "gallery", "arts_centre", "nightclub", "casino", "library"}


def cat_of(tags):
    for k in ("amenity", "shop", "tourism", "office", "craft"):
        v = tags.get(k)
        if not v: continue
        if v in FOOD: return "food", v
        if v in HEALTH: return "health", v
        if v in MONEY or k == "office": return "money", v
        if v in LODGE: return "lodge", v
        if v in CULT: return "cult", v
        if v in SERV: return "serv", v
        if v in FASHION: return "fashion", v
        if v in MARKET or k == "shop": return "market", v
    return None, None


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.out = []

    def add(self, lat, lon, tags):
        if not (lat_s - 0.002 <= lat <= lat_n + 0.002 and lng_w - 0.002 <= lon <= lng_e + 0.002): return
        name = tags.get("name")
        if not name or len(name) > 40: return
        cat, sub = cat_of(tags)
        if cat is None: return
        self.out.append({"x": round((lon - LNG0) * KLNG, 1), "z": round(-(lat - LAT0) * KLAT, 1), "name": name, "cat": cat, "sub": sub})

    def node(self, n):
        if "name" in n.tags: self.add(n.location.lat, n.location.lon, {t.k: t.v for t in n.tags})


h = H()
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("shop", "amenity", "tourism", "office", "craft"))
for o in fp:
    if o.is_node():
        t = {x.k: x.v for x in o.tags}
        if "name" in t: h.add(o.location.lat, o.location.lon, t)
    elif o.is_way():
        t = {x.k: x.v for x in o.tags}
        if "name" in t and "building" not in t or ("name" in t and t.get("shop")):
            try:
                pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
            except Exception:
                continue
            if pts: h.add(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), t)
seen = set(); out = []
for p in h.out:
    k = (p["x"], p["z"], p["name"])
    if k in seen: continue
    seen.add(k); out.append(p)
json.dump(out, open("tools/data/pois.json", "w", encoding="utf-8"), ensure_ascii=False)
import collections
print(len(out), "comercios", dict(collections.Counter(p["cat"] for p in out)))
