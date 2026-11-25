"""Descarga de OSM (Overpass) para el tramo piloto de Alicante. Sin API keys.
Consultas pequeñas por categoría, con reintentos y varios espejos."""
import json, os, sys, time, requests
S, W, N, E = 38.3395, -0.4905, 38.3515, -0.4715   # Explanada · Rambla · Luceros · Postiguet
BB = f"({S},{W},{N},{E})"
MIRRORS = ["https://overpass-api.de/api/interpreter",
           "https://overpass.private.coffee/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
PARTS = {
 "highway":  f'way["highway"]{BB};',
 "building": f'way["building"]{BB};',
 "coast":    f'way["natural"~"coastline|water|beach"]{BB};',
 "parks":    f'way["leisure"~"park|garden|marina"]{BB}; way["landuse"="grass"]{BB};',
 "pier":     f'way["man_made"~"pier|breakwater"]{BB};',
 "trees":    f'node["natural"="tree"]{BB};',
 "lamps":    f'node["highway"~"street_lamp|traffic_signals"]{BB};',
}
H = {"User-Agent": "alicantegt-build/1.0", "Accept": "application/json"}
out = {}
for name, body in PARTS.items():
    q = f"[out:json][timeout:60];({body});out body geom;"
    cache = f"tools/data/osm_{name}.json"
    if os.path.exists(cache):
        out[name] = json.load(open(cache)); print(name, "(cache)", len(out[name]), flush=True); continue
    got = None
    for attempt in range(4):
        for m in MIRRORS:
            try:
                r = requests.post(m, data={"data": q}, timeout=75, headers=H)
                r.raise_for_status(); got = r.json()["elements"]; break
            except Exception as e:
                print(f"[{name}] {m.split('/')[2]} -> {type(e).__name__} {str(e)[:60]}", flush=True)
        if got is not None: break
        time.sleep(8)
    if got is None: sys.exit(f"no se pudo descargar {name}")
    json.dump(got, open(cache, "w")); out[name] = got; print(name, len(got), flush=True)
json.dump(out, open("tools/data/osm_piloto.json", "w"))
print("OK")
