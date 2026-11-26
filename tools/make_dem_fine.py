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


def cr(t, p0, p1, p2, p3):
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def sample(x, z):
    """Catmull-Rom bicúbico del DEM grueso en (x, z) (arrays)."""
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
    h = sample(px, pz)
    k = 5   # suavizado a lo largo del eje (±20 m)
    if n > 2:
        hp = np.pad(h, k, mode="edge"); ker = np.ones(2 * k + 1) / (2 * k + 1)
        h = np.convolve(hp, ker, mode="valid")
    hw = w / 2 + 3.0                                   # calzada + acera
    for off_x in range(-2, 3):
        for off_z in range(-2, 3):
            ix = np.round((px - X0) / F).astype(int) + off_x; iz = np.round((pz - Z0) / F).astype(int) + off_z
            ok = (ix >= 0) & (ix < nx_) & (iz >= 0) & (iz < nz_)
            ix, iz, hh, qx, qz = ix[ok], iz[ok], h[ok], px[ok], pz[ok]
            dist = np.hypot(X0 + ix * F - qx, Z0 + iz * F - qz)
            wt = np.clip(1.0 - (dist - hw) / 9.0, 0.0, 1.0); wt = wt * wt * (3 - 2 * wt)
            m = wt > 0
            np.add.at(S, (iz[m], ix[m]), wt[m] * hh[m]); np.add.at(Wsum, (iz[m], ix[m]), wt[m]); np.maximum.at(Wmax, (iz[m], ix[m]), wt[m])
tgt = np.where(Wsum > 0, S / np.maximum(Wsum, 1e-9), base)
out = base * (1 - Wmax) + tgt * Wmax
print("nodos aplanados:", int((Wmax > 0.5).sum()), "de", out.size, "; cambio máx", float(np.abs(out - base).max()), "m", flush=True)
np.savez_compressed(D + "dem_fine.npz", x0=X0, z0=Z0, step=F, H=out.astype(np.float32))
print("OK")
