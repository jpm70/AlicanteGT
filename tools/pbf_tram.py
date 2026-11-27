"""Líneas del TRAM de Alicante del extracto OSM (Geofabrik, ODbL) -> public/world/tram.json
chains: cadenas de vía (tram y light_rail, sin cocheras ni apartaderos) unidas por sus nodos: {p: [[x, z]...], t: [1 si el tramo que empieza en ese punto va en túnel]}
stops: paradas [x, z, nombre]. Metros locales. Uso: python tools/pbf_tram.py"""
import json, os, sys
import osmium
from shapely.geometry import LineString

sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
OUT = "public/world/tram.json"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)


def inside(lat, lon):
    return lat_s - 0.002 <= lat <= lat_n + 0.002 and lng_w - 0.002 <= lon <= lng_e + 0.002


def xz(lat, lon):
    return ((lon - LNG0) * KLNG, -(lat - LAT0) * KLAT)


ways, stops = [], []
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("railway"))
for o in fp:
    t = {x.k: x.v for x in o.tags}
    if o.is_way() and t.get("railway") in ("tram", "light_rail"):
        if t.get("service") in ("yard", "siding", "spur", "crossover") or t.get("tunnel") == "building_passage": continue
        try: nd = [(n.ref, n.lat, n.lon) for n in o.nodes if n.location.valid()]
        except Exception: continue
        if len(nd) < 2 or not any(inside(la, lo) for _, la, lo in nd): continue
        tun = 1 if (t.get("tunnel") in ("yes", "culvert") or (t.get("layer", "0").lstrip("-").isdigit() and int(t.get("layer", "0")) < 0)) else 0
        ways.append({"ids": [r for r, _, _ in nd], "pts": [xz(la, lo) for _, la, lo in nd], "tun": tun})
    elif o.is_node() and (t.get("railway") in ("tram_stop", "halt") or (t.get("railway") == "station" and t.get("light_rail") == "yes") or t.get("station") == "light_rail"):
        if inside(o.location.lat, o.location.lon):
            x, z = xz(o.location.lat, o.location.lon)
            stops.append([round(x, 1), round(z, 1), t.get("name", "")])

# unir vías por sus extremos (solo nodos con exactamente dos vías: no hay cambio de agujas)
ends = {}
for i, w in enumerate(ways):
    for k in (0, -1): ends.setdefault(w["ids"][k], []).append(i)
used = [False] * len(ways)


def oriented(i, forward):
    w = ways[i]
    return (w["ids"], w["pts"], w["tun"]) if forward else (w["ids"][::-1], w["pts"][::-1], w["tun"])


chains = []
for i in range(len(ways)):
    if used[i]: continue
    used[i] = True
    ids, pts, tun = oriented(i, True)
    pts = list(pts); flags = [tun] * (len(pts) - 1)
    for direction in (1, -1):
        while True:
            end = ids[-1] if direction == 1 else ids[0]
            nxt = [j for j in ends.get(end, []) if not used[j]]
            if len(ends.get(end, [])) != 2 or len(nxt) != 1: break
            j = nxt[0]; used[j] = True
            w = ways[j]
            fwd = (w["ids"][0] == end) if direction == 1 else (w["ids"][-1] == end)
            nid, npt, nt = oriented(j, fwd if direction == 1 else not fwd)
            if direction == 1:
                ids = ids + nid[1:]; pts = pts + list(npt[1:]); flags = flags + [nt] * (len(npt) - 1)
            else:
                ids = nid[:-1] + ids; pts = list(npt[:-1]) + pts; flags = [nt] * (len(npt) - 1) + flags
    # simplifica sin perder los cambios de túnel: por tramos de igual bandera
    sp, sf = [pts[0]], []
    a = 0
    while a < len(flags):
        b = a
        while b < len(flags) and flags[b] == flags[a]: b += 1
        seg = list(LineString(pts[a:b + 1]).simplify(0.8).coords)
        sp += seg[1:]; sf += [flags[a]] * (len(seg) - 1)
        a = b
    if LineString(sp).length >= 40:
        chains.append({"p": [[round(x, 1), round(z, 1)] for x, z in sp], "t": sf})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({"chains": chains, "stops": stops}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
tot = sum(LineString(c["p"]).length for c in chains)
tun = sum(LineString(c["p"][i:i + 2]).length for c in chains for i, f in enumerate(c["t"]) if f)
print(len(chains), "cadenas;", round(tot / 1000, 1), "km (", round(tun / 1000, 1), "km en túnel );", len(stops), "paradas;", os.path.getsize(OUT) // 1024, "KB")
