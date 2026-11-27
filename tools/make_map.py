"""Datos ligeros para el minimapa: carreteras por clase, costa, parques y agua, simplificados -> public/world/map.json
Coordenadas en metros locales (x este, z sur), enteras. Ejecutar tras pbf_to_tiles.py y build_tiles.py (usa el manifiesto para las teselas de tierra).
Uso: python tools/make_map.py"""
import glob, json, os, sys
from shapely.geometry import LineString, Polygon
sys.path.insert(0, os.path.dirname(__file__))
from world_config import LNG0, LAT0, KLNG, KLAT, X0, X1, Z0, Z1

OSM = "tools/data/osm_t"
CLASSES = {"motorway": "m", "motorway_link": "m", "trunk": "m", "trunk_link": "m", "primary": "p", "primary_link": "p", "secondary": "s", "secondary_link": "s",
           "tertiary": "t", "tertiary_link": "t", "residential": "r", "unclassified": "r", "living_street": "r"}
TOL = {"m": 3.0, "p": 3.0, "s": 3.5, "t": 4.0, "r": 6.0}


def loc(g): return [((p["lon"] - LNG0) * KLNG, -(p["lat"] - LAT0) * KLAT) for p in g]


def flat(pts): return [int(round(v)) for q in pts for v in q]


roads = {k: [] for k in "mpstr"}; coast = []; parks = []; water = []
seen = set()
for f in sorted(glob.glob(f"{OSM}/*_highway.json")):
    for e in json.load(open(f)):
        if e.get("type") != "way" or e["id"] in seen: continue
        seen.add(e["id"])
        k = CLASSES.get(e["tags"].get("highway"))
        if not k or len(e.get("geometry", [])) < 2: continue
        ls = LineString(loc(e["geometry"]))
        if ls.length < (18 if k == "r" else 8): continue
        sl = ls.simplify(TOL[k])
        if sl.geom_type == "LineString": roads[k].append(flat(sl.coords))
seen = set()
for f in sorted(glob.glob(f"{OSM}/*_nat.json")):
    for e in json.load(open(f)):
        if e.get("type") != "way" or e["id"] in seen or len(e.get("geometry", [])) < 3: continue
        seen.add(e["id"]); t = e["tags"]; pts = loc(e["geometry"])
        if t.get("natural") == "coastline":
            coast.append(flat(LineString(pts).simplify(4).coords))
        elif t.get("leisure") == "park" or t.get("natural") == "beach":
            pg = Polygon(pts).buffer(0)
            if pg.area > 2500 and pg.geom_type == "Polygon": parks.append(flat(pg.simplify(6).exterior.coords))
        elif t.get("natural") == "water":
            pg = Polygon(pts).buffer(0)
            if pg.area > 800 and pg.geom_type == "Polygon": water.append(flat(pg.simplify(5).exterior.coords))
man = json.load(open("public/world/manifest.json")) if os.path.exists("public/world/manifest.json") else {"tiles": []}
land = [[t["tx"], t["tz"]] for t in man["tiles"] if t.get("land")]
out = {"b": [int(X0), int(Z0), int(X1), int(Z1)], "tile": man.get("tile", 1000), "land": land, "roads": roads, "coast": coast, "parks": parks, "water": water}
json.dump(out, open("public/world/map.json", "w"), separators=(",", ":"))
print({k: len(v) for k, v in roads.items()}, "costa", len(coast), "parques", len(parks), "agua", len(water), "KB", os.path.getsize("public/world/map.json") // 1024)
