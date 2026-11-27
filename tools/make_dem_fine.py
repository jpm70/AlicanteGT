"""Relieve fino (10 m) a partir del EU-DEM de 25 m, con las calzadas aplanadas en sentido transversal.

El DEM de 25 m mezcla la ladera con la calle: una calle llana al pie del castillo salía con un peralte enorme.
1) Se interpola el DEM (suavizado 3x3) con splines Catmull-Rom a una malla de 10 m.
2) Para cada vía (no puente ni túnel) se toma la cota a lo largo del eje, suavizada, y los nodos de la malla que caen en la calzada
   (y una franja de transición de ~10 m) se llevan a esa cota: la calle queda horizontal de lado a lado y la ladera sube a su lado.
Salida: tools/data/dem_fine.npz  (x0, z0, step, H[nz, nx])."""
import json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, LAT0, LNG0, KLAT, KLNG, tiles

D = "tools/data/"
F = 10
ROAD_W = {"motorway": 12, "trunk": 11, "primary": 10, "secondary": 8.5, "tertiary": 7.5, "residential": 6.2,
          "unclassified": 6.2, "living_street": 5.2, "service": 4.2, "primary_link": 6, "secondary_link": 5.5, "tertiary_link": 5}

d = json.load(open(D + "dem.json"))
cxs = list(range(d["x0"], d["x1"] + 1, d["step"])); czs = list(range(d["z0"], d["z1"] + 1, d["step"]))
H = np.array([[(d["h"].get(f"{x},{z}") or 0.0) for x in cxs] for z in czs], dtype=float)
H = np.maximum(H, 0.0)
b = np.pad(H, 1, mode="edge")
HC = sum(b[i:i + H.shape[0], j:j + H.shape[1]] for i in range(3) for j in range(3)) / 9.0
CS = d["step"]; CX0, CZ0 = d["x0"], d["z0"]
HCg = HC
_b2 = np.pad(HC, 1, mode="edge")
HR = sum(_b2[i:i + HC.shape[0], j:j + HC.shape[1]] for i in range(3) for j in range(3)) / 9.0     # versión más suave para la cota de las calles


def cr(t, p0, p1, p2, p3):
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def sample(x, z, HC=None):
    """Catmull-Rom bicúbico del DEM grueso en (x, z) (arrays)."""
    HC = HCg if HC is None else HC
    gx = np.clip((np.asarray(x, float) - CX0) / CS, 0, HC.shape[1] - 1.001); gz = np.clip((np.asarray(z, float) - CZ0) / CS, 0, HC.shape[0] - 1.001)
    ix = gx.astype(int); iz = gz.astype(int); fx = gx - ix; fz = gz - iz
    ny, nx = HC.shape
    rows = []
    for dz in (-1, 0, 1, 2):
        jz = np.clip(iz + dz, 0, ny - 1)
        p = [HC[jz, np.clip(ix + dx, 0, nx - 1)] for dx in (-1, 0, 1, 2)]
        rows.append(cr(fx, *p))
    return np.maximum(cr(fz, *rows), 0.0)


xs = np.arange(X0, X1 + 1, F, dtype=float); zs = np.arange(Z0, Z1 + 1, F, dtype=float)
GX, GZ = np.meshgrid(xs, zs)
base = sample(GX, GZ)
print("malla", base.shape, flush=True)

# --- vías ---
ways = {}
for tx, tz in tiles():
    f = f"{D}osm_t/{tx}_{tz}_highway.json"
    if not os.path.exists(f): continue
    for e in json.load(open(f)):
        if e.get("type") != "way" or e["id"] in ways: continue
        t = e.get("tags", {})
        if t.get("highway") not in ROAD_W: continue
        if t.get("tunnel") not in (None, "no") or t.get("bridge") not in (None, "no"): continue
        if len(e.get("geometry", [])) < 2: continue
        w = float(str(t.get("width", "0")).split()[0]) if str(t.get("width", "")).replace(".", "").isdigit() else 0.0
        if not w: w = max(ROAD_W[t["highway"]], int(t["lanes"]) * 3.2 if str(t.get("lanes", "")).isdigit() else 0)
        ways[e["id"]] = (w, [((p["lon"] - LNG0) * KLNG, -(p["lat"] - LAT0) * KLAT) for p in e["geometry"]])
print(len(ways), "vías", flush=True)

S = np.zeros_like(base); Wsum = np.zeros_like(base); Wmax = np.zeros_like(base)
nx_, nz_ = base.shape[1], base.shape[0]
for wid, (w, pts) in ways.items():
    P = np.array(pts); seg = np.hypot(*np.diff(P, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)]); L = cum[-1]
    if L < 4: continue
    n = max(2, int(L / 4.0) + 1); s = np.linspace(0, L, n)
    px = np.interp(s, cum, P[:, 0]); pz = np.interp(s, cum, P[:, 1])
    h = sample(px, pz, HR)
    k = 15  # suavizado a lo largo del eje (±60 m): quita las ondas del DEM (edificios y arbolado) y deja pendientes suaves
    if n > 2:
        hp = np.pad(h, k, mode="edge"); ker = np.ones(2 * k + 1) / (2 * k + 1)
        h = np.convolve(hp, ker, mode="valid")
    hw = w / 2 + 12.0                                  # calzada + acera + una celda entera: ningún nodo que influya en la calzada queda a medias (ondulaciones)
    for off_x in range(-3, 4):
        for off_z in range(-3, 4):
            ix = np.round((px - X0) / F).astype(int) + off_x; iz = np.round((pz - Z0) / F).astype(int) + off_z
            ok = (ix >= 0) & (ix < nx_) & (iz >= 0) & (iz < nz_)
            ix, iz, hh, qx, qz = ix[ok], iz[ok], h[ok], px[ok], pz[ok]
            dist = np.hypot(X0 + ix * F - qx, Z0 + iz * F - qz)
            wt = np.clip(1.0 - (dist - hw) / 12.0, 0.0, 1.0); wt = wt * wt * (3 - 2 * wt)
            m = wt > 0
            # la cota de cada nodo la manda sobre todo SU calle: el peso cae con la distancia al eje (si no, una calle paralela a 15 m le mete su cota y la calzada ondula)
            near = wt[m] / (1.0 + (dist[m] / 3.5) ** 2)
            np.add.at(S, (iz[m], ix[m]), near * hh[m]); np.add.at(Wsum, (iz[m], ix[m]), near); np.maximum.at(Wmax, (iz[m], ix[m]), wt[m])
tgt = np.where(Wsum > 0, S / np.maximum(Wsum, 1e-9), base)
out = base * (1 - Wmax) + tgt * Wmax
# alisado final de la cota de las calzadas: promedio 3x3 solo entre nodos de calzada (peso Wmax), así las ondas de ~10-20 m que deja el muestreo se quitan
# sin mezclar la calle con el terreno de alrededor
core = (Wmax > 0.9).astype(float)
for _ in range(3):
    pad_h = np.pad(out * core, 1, mode="edge"); pad_w = np.pad(core, 1, mode="edge")
    K = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], float)
    num = sum(K[i, j] * pad_h[i:i + out.shape[0], j:j + out.shape[1]] for i in range(3) for j in range(3))
    den = sum(K[i, j] * pad_w[i:i + out.shape[0], j:j + out.shape[1]] for i in range(3) for j in range(3))
    out = np.where(core > 0, num / np.maximum(den, 1e-9), out)
# --- plazas y paseos peatonales cerrados (incluida la Explanada): llanos, sin ladera hacia el mar ---
import shapely
from shapely.geometry import Polygon
areas = []
for tx, tz in tiles():
    f = f"{D}osm_t/{tx}_{tz}_highway.json"
    if not os.path.exists(f): continue
    for e in json.load(open(f)):
        t = e.get("tags", {}); g = e.get("geometry", [])
        if e.get("type") == "way" and t.get("highway") in ("pedestrian", "footway") and len(g) >= 4 and g[0] == g[-1]:
            pts = [((q["lon"] - LNG0) * KLNG, -(q["lat"] - LAT0) * KLAT) for q in g]
            try: pg = Polygon(pts).buffer(0)
            except Exception: continue
            if pg.is_valid and pg.area >= 400: areas.append((e["id"], pg, "splanada" in t.get("name", "")))
seen = set(); nplz = 0
for pid, pg, forced in areas:
    if pid in seen: continue
    seen.add(pid)
    # la Explanada es llana y la ciudad de alrededor también: el MDE (que incluye tejados) sube hacia los edificios, así que se aplana
    # una franja ancha tierra adentro (FLAT) y solo después se enlaza (BAND)
    FLAT = 45.0 if forced else 0.0
    BAND = 40.0 if forced else 10.0
    x0, z0, x1, z1 = pg.buffer(FLAT + BAND).bounds
    i0 = max(int((x0 - X0) // F), 0); i1 = min(int((x1 - X0) // F) + 1, nx_ - 1); j0 = max(int((z0 - Z0) // F), 0); j1 = min(int((z1 - Z0) // F) + 1, nz_ - 1)
    gx, gz = np.meshgrid(X0 + np.arange(i0, i1 + 1) * F, Z0 + np.arange(j0, j1 + 1) * F)
    pts_ = shapely.points(gx.ravel(), gz.ravel())
    dist = shapely.distance(pg, pts_).reshape(gx.shape); inside = shapely.contains(pg, pts_).reshape(gx.shape)
    if inside.sum() < 4: continue
    sub = out[j0:j1 + 1, i0:i1 + 1]
    vals = sub[inside]
    # cota de la plaza: la de las calzadas que la rodean (así enlaza con ellas); si no hay, la mediana interior
    ring = (dist < 9.0) & (~inside) & (Wmax[j0:j1 + 1, i0:i1 + 1] > 0.5)
    rv = sub[ring]
    if len(rv) >= 6:
        if not forced and np.percentile(rv, 90) - np.percentile(rv, 10) > 4.0: continue          # plaza en ladera real: no se aplana
        target = float(np.median(rv))
    else:
        if not forced and np.percentile(vals, 95) - np.percentile(vals, 5) > 6.0: continue
        target = float(np.median(vals)) if not forced else float(np.percentile(vals, 20))
    wt = np.clip(1.0 - np.maximum(dist - FLAT, 0.0) / BAND, 0.0, 1.0); wt = wt * wt * (3 - 2 * wt); wt[inside] = 1.0
    if FLAT > 0: wt[(dist > 0) & (sub <= 1.2)] = 0.0                    # el mar y la orilla baja no se levantan
    out[j0:j1 + 1, i0:i1 + 1] = sub * (1 - wt) + target * wt; nplz += 1
print(nplz, "plazas aplanadas", flush=True)
print("nodos aplanados:", int((Wmax > 0.5).sum()), "de", out.size, "; cambio máx", float(np.abs(out - base).max()), "m", flush=True)
np.savez_compressed(D + "dem_fine.npz", x0=X0, z0=Z0, step=F, H=out.astype(np.float32))
print("OK")
