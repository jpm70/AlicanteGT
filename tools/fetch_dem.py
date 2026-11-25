"""Malla de elevaciones (EU-DEM 25 m vía opentopodata.org, sin API key) sobre el tramo piloto, en metros locales."""
import json, math, os, time, requests
LAT0, LNG0 = 38.3432, -0.4820
KLAT = 111320.0; KLNG = 111320.0 * math.cos(math.radians(LAT0))
sys_path = __import__('sys').path; sys_path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1
STEP = 25   # m
xs = list(range(X0, X1 + 1, STEP)); zs = list(range(Z0, Z1 + 1, STEP))
pts = [(x, z) for z in zs for x in xs]
out = "tools/data/dem.json"
res = {}
if os.path.exists(out): res = {tuple(map(int, k.split(","))): v for k, v in json.load(open(out))["h"].items()}
todo = [p for p in pts if p not in res]
print(len(pts), "puntos;", len(todo), "por pedir", flush=True)
for i in range(0, len(todo), 100):
    chunk = todo[i:i+100]
    loc = "|".join(f"{LAT0 - z/KLAT:.6f},{LNG0 + x/KLNG:.6f}" for x, z in chunk)
    for att in range(5):
        try:
            r = requests.get("https://api.opentopodata.org/v1/eudem25m", params={"locations": loc}, timeout=60,
                             headers={"User-Agent": "alicantegt-build/1.0"})
            r.raise_for_status(); data = r.json()["results"]; break
        except Exception as e:
            print("reintento", att, str(e)[:60], flush=True); time.sleep(3 + att * 3); data = None
    if data is None: raise SystemExit("fallo DEM")
    for (x, z), d in zip(chunk, data): res[(x, z)] = d["elevation"]
    json.dump({"x0": X0, "x1": X1, "z0": Z0, "z1": Z1, "step": STEP, "h": {f"{k[0]},{k[1]}": v for k, v in res.items()}}, open(out, "w"))
    print(i + len(chunk), "/", len(todo), flush=True); time.sleep(1.2)
print("OK")
