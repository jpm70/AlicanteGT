"""Catastro INSPIRE (Dirección General del Catastro, CC BY 4.0): plantas y año de construcción de los edificios de Alicante.

Descarga A.ES.SDGC.BU.03900.zip (22 MB, municipio 03900 Alicante) desde catastro.hacienda.gob.es, lo lee en streaming
y deja tools/data/catastro_piloto.json con solo lo que cae en el tramo piloto, en metros locales (x este, z sur):
  parts:     [{ref, floors, polys: [[exterior, hole, hole...], ...]}]    (BuildingPart: volumen con su nº de plantas)
  buildings: {ref: {use, year}}                                          (Building: uso y año)
"""
import json, math, os, sys, zipfile, requests
import xml.etree.ElementTree as ET
from pyproj import Transformer

LAT0, LNG0 = 38.3432, -0.4820
KLAT = 111320.0; KLNG = 111320.0 * math.cos(math.radians(LAT0))
X0, X1, Z0, Z1 = -750, 950, -950, 750           # región del piloto + margen (m locales)
T = Transformer.from_crs(25830, 4326, always_xy=True)
URL = "https://www.catastro.hacienda.gob.es/INSPIRE/Buildings/03/03900-ALICANTE%20ALACANT/A.ES.SDGC.BU.03900.zip"
DIR = "tools/data/catastro"
ZIP = f"{DIR}/bu03900.zip"
os.makedirs(f"{DIR}/bu", exist_ok=True)

if not os.path.exists(ZIP):
    print("descargando", URL, flush=True)
    with requests.get(URL, stream=True, timeout=120, headers={"User-Agent": "alicantegt-build/1.0"}) as r:
        r.raise_for_status()
        with open(ZIP, "wb") as f:
            for ch in r.iter_content(1 << 20): f.write(ch)
with zipfile.ZipFile(ZIP) as z:
    for n in z.namelist():
        if n.endswith((".building.gml", ".buildingpart.gml")) and not os.path.exists(f"{DIR}/bu/{n}"):
            print("extrayendo", n, flush=True); z.extract(n, f"{DIR}/bu")

def local(tag): return tag.rsplit("}", 1)[-1]

def to_local(flat):
    v = list(map(float, flat.split())); out = []
    for i in range(0, len(v) - 1, 2):
        lo, la = T.transform(v[i], v[i + 1])
        out.append([round((lo - LNG0) * KLNG, 2), round(-(la - LAT0) * KLAT, 2)])
    return out

def inside(ring):
    xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
    return not (max(xs) < X0 or min(xs) > X1 or max(zs) < Z0 or min(zs) > Z1)

def text_of(el, name):
    for e in el.iter():
        if local(e.tag) == name: return (e.text or "").strip()
    return ""

def polys_of(el):
    res = []
    for patch in el.iter():
        if local(patch.tag) != "PolygonPatch": continue
        rings = []
        for sub in patch:
            if local(sub.tag) in ("exterior", "interior"):
                for pl in sub.iter():
                    if local(pl.tag) == "posList": rings.append(to_local(pl.text))
        if rings: res.append(rings)
    return res

def stream(path, wanted):
    for _, el in ET.iterparse(path, events=("end",)):
        if local(el.tag) == wanted:
            yield el
            el.clear()

parts = []
n = 0
for el in stream(f"{DIR}/bu/A.ES.SDGC.BU.03900.buildingpart.gml", "BuildingPart"):
    n += 1
    if n % 50000 == 0: print("partes leídas", n, "guardadas", len(parts), flush=True)
    pls = polys_of(el)
    pls = [p for p in pls if inside(p[0])]
    if not pls: continue
    lid = text_of(el, "localId"); f = text_of(el, "numberOfFloorsAboveGround")
    parts.append({"ref": lid.split("_part")[0], "floors": int(f) if f.isdigit() else None, "polys": pls})
print("partes", n, "en el piloto", len(parts), flush=True)

keep = {p["ref"] for p in parts}
buildings = {}
n = 0
for el in stream(f"{DIR}/bu/A.ES.SDGC.BU.03900.building.gml", "Building"):
    n += 1
    ref = text_of(el, "localId")
    if ref not in keep: continue
    yr = ""
    for e in el.iter():
        if local(e.tag) == "beginning" and e.text: yr = e.text[:4]; break
    buildings[ref] = {"use": text_of(el, "currentUse"), "year": int(yr) if yr.isdigit() else None}
print("edificios", n, "guardados", len(buildings), flush=True)

json.dump({"parts": parts, "buildings": buildings}, open("tools/data/catastro_piloto.json", "w"))
print("OK", os.path.getsize("tools/data/catastro_piloto.json") // 1024, "KB")
