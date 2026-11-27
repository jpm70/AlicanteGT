"""Puntos de interés singulares de OSM (gasolineras, hospitales, policía, bomberos, estaciones, estadios, museos, hoteles de 4-5 estrellas,
iglesias notables, centros comerciales, universidades...) -> tools/data/landmarks.json (con huella si es un área) y public/world/places.json (lista ligera para el juego).
Uso: python tools/pbf_landmarks.py"""
import json, math, os, sys
import osmium
sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)
KEYS = ("amenity", "railway", "tourism", "leisure", "aeroway", "shop", "building")

BRANDS = ("BP", "Repsol", "Cepsa", "Shell", "Galp", "Petroprix", "Ballenoil", "Plenoil", "Avia", "Disa", "Moeve", "Tamoil", "Q8", "Campsa", "Carrefour", "Eroski", "Esclatoil")


def cat_of(t):
    a = t.get("amenity")
    if a == "fuel": return "fuel"
    if a == "hospital": return "hospital"
    if a == "clinic" and t.get("healthcare") == "centre" and t.get("name"): return "clinic"
    if a == "police": return "police"
    if a == "fire_station": return "fire"
    if a in ("townhall", "courthouse"): return "admin"
    if a in ("university", "college") and (t.get("wikidata") or t.get("wikipedia") or t.get("operator")) and t.get("name"): return "university"
    if a == "bus_station": return "bus"
    if a == "place_of_worship" and t.get("name") and (t.get("wikidata") or t.get("wikipedia") or t.get("building") in ("cathedral", "basilica", "church")): return "worship"
    if t.get("railway") in ("station", "halt") and t.get("name"): return "train"
    if t.get("tourism") == "museum" and t.get("name"): return "museum"
    if t.get("tourism") == "attraction" and t.get("name") and (t.get("wikidata") or t.get("wikipedia")): return "attraction"
    if t.get("tourism") == "hotel" and t.get("name") and str(t.get("stars", "0"))[:1] in ("4", "5"): return "hotel"
    if t.get("leisure") == "stadium" and t.get("name"): return "stadium"
    if t.get("aeroway") in ("aerodrome", "terminal") and t.get("name"): return "airport"
    if t.get("shop") == "mall" and t.get("name"): return "mall"
    if a in ("theatre", "cinema") and t.get("name"): return "culture"
    return None


LABEL = {"fuel": "Gasolinera", "hospital": "Hospital", "clinic": "Clínica", "police": "Policía", "fire": "Bomberos", "admin": "Edificio público", "university": "Universidad",
         "bus": "Estación de autobuses", "worship": "Iglesia", "train": "Estación", "museum": "Museo", "attraction": "Lugar de interés", "hotel": "Hotel", "stadium": "Estadio",
         "airport": "Aeropuerto", "mall": "Centro comercial", "culture": "Cine / Teatro"}


def local(lat, lon): return ((lon - LNG0) * KLNG, -(lat - LAT0) * KLAT)


out = []; seen = set()
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter(*KEYS))
for o in fp:
    if not (o.is_node() or o.is_way()): continue
    t = {x.k: x.v for x in o.tags}
    k = cat_of(t)
    if not k: continue
    poly = None
    try:
        if o.is_node(): la, lo = o.location.lat, o.location.lon
        else:
            ns = [n for n in o.nodes if n.location.valid()]
            if len(ns) < 3: continue
            la = sum(n.lat for n in ns) / len(ns); lo = sum(n.lon for n in ns) / len(ns)
            poly = [[round(v, 1) for v in local(n.lat, n.lon)] for n in ns]
    except Exception:
        continue
    if not (lat_s - 0.001 < la < lat_n + 0.001 and lng_w - 0.001 < lo < lng_e + 0.001): continue
    name = t.get("name") or t.get("brand") or t.get("operator") or ""
    if k == "fuel" and not name: name = "Gasolinera"
    key = (k, round(la, 4), round(lo, 4))
    if key in seen: continue
    seen.add(key)
    x, z = local(la, lo)
    brand = t.get("brand") or t.get("operator") or name
    out.append({"id": o.id, "cat": k, "name": name[:44], "brand": brand[:30], "lat": round(la, 6), "lng": round(lo, 6), "x": round(x, 1), "z": round(z, 1), "poly": poly})
json.dump(out, open("tools/data/landmarks.json", "w", encoding="utf-8"), ensure_ascii=False)
places = [{"n": p["name"] or LABEL[p["cat"]], "c": p["cat"], "la": p["lat"], "lo": p["lng"]} for p in out]
os.makedirs("public/world", exist_ok=True)
json.dump(places, open("public/world/places.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
import collections
print(len(out), dict(collections.Counter(p["cat"] for p in out)))
