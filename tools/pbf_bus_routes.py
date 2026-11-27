"""Rutas de autobús urbano del extracto OSM (Geofabrik, ODbL) -> public/world/bus_routes.json
Cada ruta: {ref, name, ways: [id de vía OSM en orden...], stops: [[x, z]...]} (metros locales). Los ids de vía coinciden con los de las teselas (roads).
Uso: python tools/pbf_bus_routes.py"""
import json, os, sys
import osmium

sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
OUT = "public/world/bus_routes.json"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)


def inside(lat, lon):
    return lat_s - 0.003 <= lat <= lat_n + 0.003 and lng_w - 0.003 <= lon <= lng_e + 0.003


# pasada 1: relaciones de ruta de autobús
rels = []
for o in osmium.FileProcessor(PBF).with_filter(osmium.filter.KeyFilter("route")):
    if not o.is_relation(): continue
    t = {x.k: x.v for x in o.tags}
    if t.get("type") != "route" or t.get("route") not in ("bus", "trolleybus"): continue
    ways, stops = [], []
    for m in o.members:
        if m.type == "w" and m.role in ("", "forward", "backward"): ways.append(m.ref)
        elif m.type == "n" and m.role in ("stop", "stop_entry_only", "stop_exit_only", "platform", "platform_entry_only", "platform_exit_only"): stops.append(m.ref)
    rels.append({"ref": t.get("ref", ""), "name": t.get("name", ""), "from": t.get("from", ""), "to": t.get("to", ""), "ways": ways, "stops": stops})
print(len(rels), "relaciones de autobús")

need_w = {w for r in rels for w in r["ways"]}; need_n = {n for r in rels for n in r["stops"]}
way_first = {}                                   # id de vía -> (lat, lon) del primer nodo (para saber si cae en la zona)
node_pos = {}
fp = osmium.FileProcessor(PBF).with_locations()
for o in fp:
    if o.is_node() and o.id in need_n and o.location.valid():
        node_pos[o.id] = (o.location.lat, o.location.lon)
    elif o.is_way() and o.id in need_w:
        try:
            n0 = next(n for n in o.nodes if n.location.valid())
            way_first[o.id] = (n0.lat, n0.lon)
        except StopIteration:
            pass

routes = []
for r in rels:
    ws = [w for w in r["ways"] if w in way_first and inside(*way_first[w])]
    if len(ws) < 3: continue
    st = [[round((node_pos[n][1] - LNG0) * KLNG, 1), round(-(node_pos[n][0] - LAT0) * KLAT, 1)] for n in r["stops"] if n in node_pos and inside(*node_pos[n])]
    routes.append({"ref": r["ref"], "name": r["name"] or f'{r["from"]} → {r["to"]}', "ways": ws, "stops": st})
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"routes": routes}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(routes), "rutas;", sum(len(r["ways"]) for r in routes), "tramos;", sum(len(r["stops"]) for r in routes), "paradas;", os.path.getsize(OUT) // 1024, "KB")
print(sorted({r["ref"] for r in routes}))
