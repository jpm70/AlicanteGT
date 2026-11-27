"""Calles y números de portal del extracto OSM (Geofabrik, ODbL) -> public/world/addresses.json
Sirve para elegir salida y meta escribiendo «calle y número» (src/game/addresses.ts).
Cada calle: {n: nombre (es), a: [alias normalizados], p: [polilíneas [[x,z]...]], h: [[número, sufijo, x, z]...]} en metros locales.
Uso: python tools/pbf_addresses.py"""
import json, math, os, re, sys, unicodedata
import osmium
from shapely.geometry import LineString

sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
OUT = "public/world/addresses.json"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)
HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "pedestrian"}

# Mismo criterio que normalizeStreet() de src/game/addresses.ts
STOP = {"calle", "carrer", "c", "avenida", "avinguda", "av", "avda", "plaza", "placa", "pl", "paseo", "passeig", "pso", "camino", "cami", "ronda", "carretera", "ctra",
        "travesia", "travessera", "rambla", "via", "de", "del", "la", "el", "los", "las", "els", "les", "l", "d", "dels", "i", "y"}


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    toks = [t for t in re.split(r"[^a-z0-9]+", s) if t and t not in STOP]
    return " ".join(toks)


def xz(lat, lon):
    return round((lon - LNG0) * KLNG, 1), round(-(lat - LAT0) * KLAT, 1)


def inside(lat, lon):
    return lat_s - 0.002 <= lat <= lat_n + 0.002 and lng_w - 0.002 <= lon <= lng_e + 0.002


streets = {}      # clave normalizada del nombre principal -> entrada
alias = {}        # alias normalizado -> clave
houses = []       # (street_str, número, sufijo, x, z)


def entry_for(names, display):
    keys = [norm(n) for n in names if n]
    keys = [k for k in keys if k]
    if not keys: return None
    main = keys[0]
    for k in keys:
        if k in alias: main = alias[k]; break
    e = streets.get(main)
    if e is None:
        e = streets[main] = {"n": display, "a": set(), "p": [], "h": []}
    for k in keys: e["a"].add(k); alias[k] = main
    return e


fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("highway", "addr:housenumber"))
for o in fp:
    t = {x.k: x.v for x in o.tags}
    if o.is_way() and t.get("highway") in HW and (t.get("name") or t.get("name:es")):
        try: pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
        except Exception: continue
        if len(pts) < 2 or not any(inside(la, lo) for la, lo in pts): continue
        disp = t.get("name:es") or t.get("name")
        e = entry_for([t.get("name:es"), t.get("name"), t.get("name:ca"), t.get("alt_name"), t.get("official_name")], disp)
        if e is None: continue
        ls = LineString([xz(la, lo) for la, lo in pts]).simplify(3.0)
        e["p"].append([[round(x, 1), round(z, 1)] for x, z in ls.coords])
    elif "addr:housenumber" in t and t.get("addr:street"):
        if o.is_node():
            la, lo = o.location.lat, o.location.lon
        elif o.is_way():
            try: pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
            except Exception: continue
            if not pts: continue
            la = sum(p[0] for p in pts) / len(pts); lo = sum(p[1] for p in pts) / len(pts)
        else:
            continue
        if not inside(la, lo): continue
        m = re.match(r"\s*(\d{1,4})\s*([A-Za-z]?)", t["addr:housenumber"])
        if not m: continue
        x, z = xz(la, lo)
        houses.append((t["addr:street"], int(m.group(1)), m.group(2).upper(), x, z))

# portales que no están en OSM (a mano): (calle, número, lat, lng)
EXTRA_HOUSES = [("Calle de los Doscientos", 8, 38.34051, -0.50106)]       # ATU Academia Técnica Universitaria
for st, num, la, lo in EXTRA_HOUSES:
    x_, z_ = xz(la, lo); houses.append((st, num, "", x_, z_))

orphans = 0
for st, num, suf, x, z in houses:
    k = norm(st)
    if not k: continue
    main = alias.get(k)
    if main is None:
        orphans += 1
        e = streets[k] = {"n": st, "a": {k}, "p": [], "h": []}; alias[k] = k; main = k
    streets[main]["h"].append([num, suf, x, z])

out = []
for k, e in streets.items():
    h = sorted({(a, b, c, d) for a, b, c, d in e["h"]})
    if not e["p"] and not h: continue
    out.append({"n": e["n"], "a": sorted(e["a"]), "p": e["p"], "h": [list(v) for v in h]})
out.sort(key=lambda e: e["n"])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"streets": out}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
nh = sum(len(e["h"]) for e in out)
print(len(out), "calles;", nh, "portales;", orphans, "portales con calle sin geometría;", os.path.getsize(OUT) // 1024, "KB")
