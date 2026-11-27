"""Genera el mundo por teselas de 1 km: public/world/tiles/<tx>_<tz>.{glb,json,jpg}, manifest.json y dem.json.

Entradas (tools/data/): osm_t/ (fetch_osm_tiles.py), dem.json (fetch_dem.py), catastro_ciudad.json (fetch_catastro.py),
ortho_t/ (fetch_ortho_tiles.py). Coordenadas locales en metros: x = este, y = arriba, z = sur; origen = Explanada.

Uso:  python tools/build_tiles.py            # todas las teselas
      python tools/build_tiles.py 0,-1 -1,-1 # solo esas
"""
import time
import base64, hashlib, json, math, os, shutil, sys
from collections import Counter
from multiprocessing import Pool

import numpy as np, trimesh, shapely
from shapely import STRtree, make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_config import *          # LAT0, LNG0, KLAT, KLNG, TILE, X0.., tiles(), tile_box(), ortho_px()
from world_lib import *
from world_decks import build_decks, _Mesh
from world_boats import place_boats, boats_mesh
from world_signs import place_signs, signs_mesh             # hexrgb, tri_mesh, box_at, dome_at, tower_at, fountain_at, write_glb, join_parts ...

D = "tools/data/"
OUT = "public/world/tiles"
BAY, FLOOR = 3.2, 3.1
CELL = 10                       # = paso de la malla de relieve (make_dem_fine.py)

ROAD_W = {"motorway": 12, "trunk": 11, "primary": 10, "secondary": 8.5, "tertiary": 7.5, "residential": 6.2,
          "unclassified": 6.2, "living_street": 5.2, "service": 4.2, "primary_link": 6, "secondary_link": 5.5, "tertiary_link": 5}
WALK_W = {"footway": 2.4, "pedestrian": 6.0, "path": 2.0, "cycleway": 2.5, "steps": 2.0, "track": 3.0}
WALL_COLS = [0xf1e9d6, 0xe8d9b8, 0xf6efe0, 0xe3c9a0, 0xf4e4c1, 0xdcb89a, 0xefd7c4, 0xfaf6ec, 0xe9c58a, 0xd9a78a, 0xf0e2a8, 0xc9d3d6]
ROOF_COLS = [0xa85a3c, 0x9c5238, 0x8a8d90, 0xb4684a, 0x7d7f82]
OLD_COLS = [0xf1e9d6, 0xe8d9b8, 0xf6efe0, 0xe3c9a0, 0xf4e4c1, 0xdcb89a, 0xefd7c4, 0xe9c58a, 0xd9a78a, 0xf0e2a8]
MID_COLS = [0xece8dc, 0xe3ded0, 0xd9d3c3, 0xf3efe6, 0xdcd6c6, 0xe8dfc9]
NEW_COLS = [0xf4f4f2, 0xe6e8ea, 0xd7dbdd, 0xefe9de, 0xc9cfd2, 0xf8f6f0]
SC_COLS = [0xfaf8f2, 0xfaf8f2, 0xf3efe4, 0xf7efd9, 0xdbe8f2, 0xf2dcc6, 0xfaf8f2, 0xe9d2a4]

PLAZA = (82.0, -195.0)                    # Plaza del Ayuntamiento
SANTA_CRUZ = (-110.0, -470.0, 135.0)      # barrio de Santa Cruz (cx, cz, radio)
LM_AYTO, LM_CONCA, LM_SMARIA, LM_MERCAT, LM_AUDIT, LM_SOL = 265207919, 83998999, 22560738, 21410214, 515871894, 53271502
LM_COL = {LM_AYTO: 0xe3b48f, LM_CONCA: 0xe6dcc3, LM_SMARIA: 0xe0b685, LM_MERCAT: 0xf1dea0, LM_AUDIT: 0xf4f1ea,
          22561001: 0xe0b685, 156992115: 0xe7b8a8, 33197578: 0xf2ecde, 22588102: 0xf3f3f1}
FOUNTAINS = [  # (x, z, radio, escala, estrella, id colisión)
    (-757.0, -312.0, 9.0, 1.6, True, -3),     # Luceros (Plaça dels Estels)
    (-260.0, -21.0, 3.2, 0.9, False, -4),     # Fuente de la Aguadora
]
LM_STATION = 20987191                      # Alacant Terminal (estación de tren)
LM_CHURCH = {22736202: 0xe6d9b8, 80695443: 0xe8dcc0, 33198270: 0xe9dcc0, 23904415: 0xe6dcc3, 86300369: 0xfaf8f2, 74336063: 0xe9dcc0}
LM_COL[LM_STATION] = 0xe9d6a8
LM_COL.update(LM_CHURCH)
LM_COL[138298706] = 0xf4f4f2                # ADDA, Auditori de la Diputació
CASTLE_GUESS = (300.0, -600.0)            # cumbre del Benacantil

# ---------- estado global por proceso ----------
G = {}
_osm_cache = {}


def P(pt):
    return ((pt["lon"] - LNG0) * KLNG, -(pt["lat"] - LAT0) * KLAT)


def osm(tx, tz, kind):
    k = (tx, tz, kind)
    if k not in _osm_cache:
        if len(_osm_cache) > 10: _osm_cache.clear()
        f = f"{D}osm_t/{tx}_{tz}_{kind}.json"
        _osm_cache[k] = json.load(open(f)) if os.path.exists(f) else []
    return _osm_cache[k]


def gather(tx, tz, kind):
    """Elementos de la tesela y sus 8 vecinas, sin duplicados (los elementos largos aparecen en varias)."""
    out, seen = [], set()
    for dz in (-1, 0, 1):
        for dx in (-1, 0, 1):
            a, b = tx + dx, tz + dz
            if a not in TX_RANGE or b not in TZ_RANGE: continue
            for e in osm(a, b, kind):
                key = (e.get("type"), e.get("id"))
                if key in seen: continue
                seen.add(key); out.append(e)
    return out


def ways(els):
    return [e for e in els if e.get("type") == "way" and len(e.get("geometry", [])) >= 2]


def polys_of(g):
    return [g] if isinstance(g, Polygon) else [x for x in getattr(g, "geoms", []) if isinstance(x, Polygon)]


# ---------- relieve ----------
def load_dem():
    """Relieve fino de 10 m con calzadas aplanadas (tools/make_dem_fine.py)."""
    z = np.load(D + "dem_fine.npz")
    G["DX0"], G["DZ0"], G["DST"] = int(z["x0"]), int(z["z0"]), int(z["step"])
    H = z["H"].astype(float)
    G["DXS"] = [G["DX0"] + i * G["DST"] for i in range(H.shape[1])]; G["DZS"] = [G["DZ0"] + j * G["DST"] for j in range(H.shape[0])]
    G["HG"] = H


def _cr(t, p0, p1, p2, p3):
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def hf(x, z):
    """Altura del relieve: Catmull-Rom bicúbico sobre la malla de 10 m (C1: sin quiebros de pendiente en la malla). Igual que heightAt() de geo.ts."""
    HG = G["HG"]; ny, nx = HG.shape
    x = np.asarray(x, dtype=float); z = np.asarray(z, dtype=float)
    gx = np.clip((x - G["DX0"]) / G["DST"], 0, nx - 1.001); gz = np.clip((z - G["DZ0"]) / G["DST"], 0, ny - 1.001)
    ix = gx.astype(int); iz = gz.astype(int); fx = gx - ix; fz = gz - iz
    rows = []
    for dz in (-1, 0, 1, 2):
        jz = np.clip(iz + dz, 0, ny - 1)
        rows.append(_cr(fx, *[HG[jz, np.clip(ix + dx, 0, nx - 1)] for dx in (-1, 0, 1, 2)]))
    return _cr(fz, *rows)


def lerp_col(c0, c1, t):
    t = np.clip(t, 0, 1)[:, None]
    return np.array(c0)[None, :] * (1 - t) + np.array(c1)[None, :] * t


def drape(geom, off, color, terrain_tint=False, uvfn=None):
    """Recorta en celdas del DEM (alineadas con las teselas) y levanta cada vértice al terreno: sin grietas."""
    if geom is None or geom.is_empty: return None
    polys = polys_of(geom)
    if not polys: return None
    tree = STRtree(polys)
    bx0, bz0, bx1, bz1 = geom.bounds
    V, F, C, U = [], [], [], []; nv = 0
    for gx in range(int(math.floor(bx0 / CELL)) * CELL, int(math.ceil(bx1 / CELL)) * CELL, CELL):
        for gz in range(int(math.floor(bz0 / CELL)) * CELL, int(math.ceil(bz1 / CELL)) * CELL, CELL):
            cell = box(gx, gz, gx + CELL, gz + CELL)
            for i in tree.query(cell):
                piece = polys[i].intersection(cell)
                for q in polys_of(piece):
                    if q.is_empty or q.area < 0.05: continue
                    try: v, f = trimesh.creation.triangulate_polygon(q, engine="earcut")
                    except Exception: continue
                    y = hf(v[:, 0], v[:, 1]) + off
                    V.append(np.column_stack([v[:, 0], y, v[:, 1]])); F.append(f[:, ::-1] + nv); nv += len(v)
                    if terrain_tint:
                        col = lerp_col(color, hexrgb(0x8f7f5c), (y - 6) / 70.0)
                        C.append(np.column_stack([col, np.full(len(v), 255)]))
                    else:
                        C.append(np.tile(color, (len(v), 1)))
                    if uvfn is not None: U.append(uvfn(v[:, 0], v[:, 1]))
    if not V: return None
    return np.vstack(V), np.vstack(F), np.vstack(C).astype(np.uint8), (np.vstack(U) if U else None)


# ---------- Catastro ----------
def load_catastro():
    G["CAT_POLYS"], G["CAT_META"], G["CAT_B"], G["CAT_TREE"] = [], [], {}, None
    f = D + "catastro_ciudad.json"
    if not os.path.exists(f): return
    cat = json.load(open(f)); G["CAT_B"] = cat["buildings"]
    for p in cat["parts"]:
        for rings in p["polys"]:
            try: g = Polygon(rings[0], rings[1:]).buffer(0)
            except Exception: continue
            if not g.is_empty and g.area > 0.5: G["CAT_POLYS"].append(g); G["CAT_META"].append((p["floors"], p["ref"]))
    G["CAT_TREE"] = STRtree(G["CAT_POLYS"])


def cat_pieces(poly):
    """Trocea la huella OSM en volúmenes con las plantas del Catastro. [(poly, plantas|None, año|None, uso|None)]"""
    none = [(poly, None, None, None)]
    tree = G["CAT_TREE"]
    if tree is None: return none
    polys, meta, CB = G["CAT_POLYS"], G["CAT_META"], G["CAT_B"]
    groups = {}; covered = 0.0; yrs = Counter(); uses = Counter()
    for i in tree.query(poly):
        fl = meta[i][0]
        if not fl: continue
        inter = poly.intersection(polys[i]); ar = inter.area
        if ar < 1.0: continue
        groups.setdefault(fl, []).append(inter); covered += ar
        bi = CB.get(meta[i][1])
        if bi:
            if bi["year"]: yrs[bi["year"]] += ar
            if bi["use"]: uses[bi["use"]] += ar
    if not groups or covered < 0.45 * poly.area: return none
    fl_area = {f: unary_union(g).area for f, g in groups.items()}
    dom = max(fl_area, key=fl_area.get)
    year = yrs.most_common(1)[0][0] if yrs else None; use = uses.most_common(1)[0][0] if uses else None
    sig = [f for f, a in fl_area.items() if a >= 15 and a >= 0.10 * poly.area]
    if len(sig) <= 1 or max(sig) - min(sig) < 2: return [(poly, dom, year, use)]
    pieces = []; used = Polygon()
    for fl in sorted(sig, reverse=True):
        g = unary_union(groups[fl]).buffer(0.4).intersection(poly).difference(used).buffer(0)
        for sub in polys_of(g):
            if sub.area >= 8: pieces.append((sub.simplify(0.2), fl, year, use))
        used = unary_union([used, g])
    for sub in polys_of(poly.difference(used).buffer(0)):
        if sub.area >= 8: pieces.append((sub.simplify(0.2), dom, year, use))
    return pieces or [(poly, dom, year, use)]


def style_for(levels, seed):
    if levels >= 8: return 3
    if levels <= 3: return 2 if seed % 3 else 0
    return 0 if seed % 5 else 1


def style_by_cat(fl, year, use):
    if use and not use.startswith("1_"): return 1
    if not year: return None
    if year < 1940: return 0 if fl >= 4 else 2
    if year < 1985: return 3 if fl >= 5 else 0
    return 1


# ---------- mar (global) ----------
def build_sea():
    ws = {}
    for (tx, tz) in tiles():
        for e in osm(tx, tz, "nat"):
            if e.get("type") == "way" and e.get("tags", {}).get("natural") == "coastline" and len(e.get("geometry", [])) >= 2:
                ws[e["id"]] = e
    key = lambda pt: (round(pt["lat"], 7), round(pt["lon"], 7))
    lst = list(ws.values())
    closed = [e for e in lst if key(e["geometry"][0]) == key(e["geometry"][-1]) and len(e["geometry"]) > 3]
    opened = [e for e in lst if e not in closed]
    by_start = {key(e["geometry"][0]): e for e in opened}
    ends = {key(e["geometry"][-1]) for e in opened}
    chains, used = [], set()
    for e in opened:
        if key(e["geometry"][0]) in ends: continue
        pts, cur = [], e
        while cur and cur["id"] not in used:
            used.add(cur["id"]); pts += [P(p) for p in cur["geometry"]]
            cur = by_start.get(key(cur["geometry"][-1]))
        if len(pts) > 2: chains.append(pts)

    def right(a, b, d=8000):
        dx, dz = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dz) or 1
        return (-dz / l * d, dx / l * d)

    def make(flip):
        sea = Polygon()
        for c in chains:
            s = -1 if flip else 1
            r0 = right(c[0], c[1]); r1 = right(c[-2], c[-1])
            poly = Polygon(c + [(c[-1][0] + s * r1[0], c[-1][1] + s * r1[1]), (c[0][0] + s * r0[0], c[0][1] + s * r0[1])]).buffer(0)
            sea = unary_union([sea, poly])
        return sea
    sea = make(False)
    if not sea.contains(Point(1500, 500)): sea = make(True)      # la tierra debe quedar a la izquierda: comprueba con un punto de mar conocido
    from shapely.geometry import LinearRing
    for e in closed:                                              # islas (tierra dentro) y lagos
        pts = [P(p) for p in e["geometry"]]
        rg = Polygon(pts).buffer(0)
        if not LinearRing(pts).is_ccw: sea = sea.difference(rg)   # en x-este/z-sur el sentido se invierte: horario = isla
        else: sea = unary_union([sea, rg])
    return sea.intersection(box(X0 - 300, Z0 - 300, X1 + 300, Z1 + 300))



NON_PALM = ("ficus", "ulmus", "platanus", "pinus", "grevillea", "jacaranda", "olea", "citrus", "cupressus", "tipuana", "quercus", "morus", "celtis", "melia", "brachychiton", "washingtonia_x")


def furniture_positions(x, z, is_signal, road_lines, roads):
    """En OSM los semáforos y algunas farolas están sobre la calzada (a veces entre dos carriles o en un cruce):
    se llevan a la acera caminando en perpendicular a la vía hasta salir del asfalto. Semáforo: uno a cada lado; farola: el lado más cercano.
    Devuelve [(x, z, yaw)]; yaw alinea el eje z local con la vía."""
    best = None
    for r in road_lines:
        pts = r["p"]
        for i in range(len(pts) - 1):
            ax, az = pts[i]; bx, bz = pts[i + 1]; dx, dz = bx - ax, bz - az; l2 = dx * dx + dz * dz
            if l2 < 0.01: continue
            t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / l2)); px, pz = ax + t * dx, az + t * dz; d = math.hypot(x - px, z - pz)
            if d < 22 and (best is None or d < best[0]): best = (d, px, pz, dx / math.sqrt(l2), dz / math.sqrt(l2), r["w"])
    if best is None: return [(x, z, 0.0)]
    d, px, pz, fx, fz, w = best
    yaw = math.atan2(fx, fz)
    if roads is None or roads.is_empty or not roads.contains(Point(x, z)): return [(x, z, yaw)]
    nx, nz = -fz, fx
    outs = []
    for sd in (1, -1):
        t = 0.25; found = False
        while t < 40:
            if not roads.contains(Point(x + nx * sd * t, z + nz * sd * t)): found = True; break
            t += 0.5
        if not found: continue
        for ext in (0.9, 1.3, 1.8, 2.5, 3.5):        # primer punto de acera libre: en un cruce el primero puede caer en la calle transversal
            qx, qz = x + nx * sd * (t + ext), z + nz * sd * (t + ext)
            if not roads.contains(Point(qx, qz)): outs.append((t, qx, qz)); break
    if not outs: return []                            # sin sitio en la acera: se descarta antes que dejarlo en el carril
    outs.sort()
    if not is_signal: outs = outs[:1]
    return [(a_, b_, yaw) for (_, a_, b_) in outs]


def tree_kind(tags, x, z):
    """1 = palmera, 0 = árbol de hoja ancha. En Alicante la mayoría son palmeras (Phoenix, Washingtonia)."""
    sp = (tags.get("species", "") + tags.get("genus", "") + tags.get("species:en", "")).lower()
    if tags.get("leaf_type") == "palm_leaved" or "phoenix" in sp or "washingtonia" in sp or "palm" in sp or "chamaerops" in sp: return 1
    if any(n in sp for n in NON_PALM): return 0
    h = int(hashlib.md5(f"{round(x)}_{round(z)}".encode()).hexdigest()[:4], 16) % 100
    return 1 if h < 62 else 0


def street_trees(road_lines, walk_t, existing, bshapes, bidx, x0, z0, x1, z1):
    """Arbolado de calle cada ~15 m a ambos lados de las vías principales, solo sobre acera y lejos de edificios."""
    out = []; taken = [(a, b) for a, b, _ in existing]
    shapely.prepare(walk_t)
    cell = {}
    for a, b in taken: cell.setdefault((int(a // 8), int(b // 8)), []).append((a, b))
    def free(x, z):
        for i in range(int(x // 8) - 1, int(x // 8) + 2):
            for j in range(int(z // 8) - 1, int(z // 8) + 2):
                for a, b in cell.get((i, j), []):
                    if (a - x) ** 2 + (b - z) ** 2 < 49: return False
        return True
    for r in road_lines:
        if r["k"] not in ("primary", "secondary", "tertiary", "residential"): continue
        pts = r["p"]; side_off = r["w"] / 2 + 0.95
        dist = 0.0; nxt = 6.0; side = 1
        for i in range(len(pts) - 1):
            ax, az = pts[i]; bx, bz = pts[i + 1]; L = math.hypot(bx - ax, bz - az)
            if L < 0.01: continue
            fx, fz = (bx - ax) / L, (bz - az) / L
            while nxt <= dist + L:
                t = nxt - dist; cx, cz = ax + fx * t, az + fz * t
                for sd in (1, -1):
                    px, pz = cx + (-fz) * side_off * sd, cz + fx * side_off * sd
                    if not (x0 <= px < x1 and z0 <= pz < z1): continue
                    if r["k"] == "residential" and (int(abs(cx * 7 + cz * 13)) % 3): continue
                    if not free(px, pz): continue
                    pt = Point(px, pz)
                    if not walk_t.contains(pt): continue
                    if any(bshapes[k].distance(pt) < 2.2 for k in bidx.query(pt.buffer(2.2))): continue
                    out.append([round(px, 2), round(pz, 2), tree_kind({}, px, pz)]); cell.setdefault((int(px // 8), int(pz // 8)), []).append((px, pz))
                nxt += 15.0 + (int(abs(cx)) % 5)
            dist += L
    return out


def explanada_palms(mosaic_geoms, x0, z0, x1, z1, total=365):
    """La Explanada de España tiene 365 palmeras (una por día del año) en filas a ambos lados del paseo, junto al mosaico.
    Se reparten a lo largo de los dos bordes largos del paseo, a 2 m hacia dentro. Devuelve [[x, z, 1]] de las que caen en la tesela."""
    if not mosaic_geoms: return [], []
    big = max(polys_of(unary_union(mosaic_geoms)), key=lambda g: g.area)
    rect = big.minimum_rotated_rectangle
    rc = list(rect.exterior.coords)[:4]
    e1 = (rc[1][0] - rc[0][0], rc[1][1] - rc[0][1]); e2 = (rc[2][0] - rc[1][0], rc[2][1] - rc[1][1])
    ax = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2
    Lx = math.hypot(*ax); ux, uz = ax[0] / Lx, ax[1] / Lx
    c = rect.centroid
    inner = big.buffer(-2.0)
    if inner.is_empty: return [], []
    ring = max(polys_of(inner), key=lambda g: g.area).exterior
    ring2 = max(polys_of(big.buffer(-4.2)), key=lambda g: g.area).exterior if not big.buffer(-4.2).is_empty else None
    side = max(Lx - 10.0, 10.0)                                    # sin las cabeceras del paseo
    step = 2.0 * side / total
    out = []; d = 0.0
    while d < ring.length:
        p = ring.interpolate(d); d += step
        if abs((p.x - c.x) * ux + (p.y - c.y) * uz) > Lx / 2 - 5.0: continue
        if x0 <= p.x < x1 and z0 <= p.y < z1: out.append([round(p.x, 2), round(p.y, 2), 1])
    lamps_out = []                                                  # farolas de globo entre las palmeras, cada ~14 m a cada lado
    if ring2 is not None:
        d = 7.0
        while d < ring2.length:
            p = ring2.interpolate(d); d += 14.0
            if abs((p.x - c.x) * ux + (p.y - c.y) * uz) > Lx / 2 - 8.0: continue
            if x0 <= p.x < x1 and z0 <= p.y < z1: lamps_out.append([round(p.x, 2), round(p.y, 2), 0, round(math.atan2(ux, uz), 3)])
    return out, lamps_out


LM_PIRAMIDE = 266286896      # Edificio La Pirámide (Av. de Dénia): torre escalonada en forma de pirámide
PARK_DEFAULT = ("tertiary", "residential", "unclassified", "living_street")
PARK_YES = {"parallel", "diagonal", "perpendicular", "lane", "street_side", "marked", "on_street", "yes", "half_on_kerb", "on_kerb", "painted_area_only"}
PARK_NO = {"no", "separate", "no_parking", "no_stopping", "no_standing", "loading", "disabled", "none"}


def _num(v):
    try: return float(str(v).split()[0])
    except Exception: return None


def park_policy(t, k):
    """Aparcamiento permitido a cada lado de la vía según OSM: {'r': True|False|None, 'l': ..., 'd': por defecto}.
    True/False = lo dice una etiqueta (parking:lane:*, parking:*, parking:condition:*); None = sin dato -> decide 'd'.
    Sin etiquetas solo se aparca en calles residenciales/terciarias de 1-2 carriles, sin carril bus ni velocidad >= 50."""
    out = {}
    for side, ks in (("r", ("right", "both")), ("l", ("left", "both"))):
        val = None
        for sd in ks:
            for key in (f"parking:lane:{sd}", f"parking:{sd}", f"parking:condition:{sd}", f"parking:condition:{sd}:default"):
                v = t.get(key)
                if not v: continue
                if v in PARK_NO or v.startswith("no_"): val = False
                elif v in PARK_YES or v in ("free", "disc", "ticket", "customers", "residents"): val = True if val is not False else val
            if val is not None: break
        out[side] = val
    ln = _num(t.get("lanes")); ms = _num(t.get("maxspeed"))
    ok = k in PARK_DEFAULT and (ln is None or ln <= 2) and (ms is None or ms < 50) and not any(t.get(x) for x in ("psv", "bus", "busway", "lanes:bus", "bus_bay"))
    out["d"] = ok
    return out




def parked_cars(road_lines, roads_t, bshapes, bidx, x0, z0, x1, z1):
    """Coches aparcados en línea junto al bordillo (derecha del sentido de la vía; ambos lados en calles anchas).
    Solo sobre calzada, fuera de cruces (9 m de los extremos) y sin tocar edificios. Devuelve ([[x, z, yaw, color, tipo]], [obstáculos])."""
    out, obst = [], []
    shapely.prepare(roads_t)
    cell = {}
    def free(x, z):
        for i in range(int(x // 6) - 1, int(x // 6) + 2):
            for j in range(int(z // 6) - 1, int(z // 6) + 2):
                for a, b in cell.get((i, j), []):
                    if (a - x) ** 2 + (b - z) ** 2 < 9.0: return False
        return True
    for r in road_lines:
        if r["w"] < 6.0: continue
        pol = r.get("pk") or {"r": None, "l": None, "d": False}
        pts = r["p"]; w = r["w"]
        L = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
        if L < 26: continue
        rnd = np.random.RandomState(int(r["id"]) % 2147483647)
        for sd in (1, -1):
            v = pol["r" if sd == 1 else "l"]
            if v is False: continue
            if v is None and not (pol["d"] and (sd == 1 or w >= 8)): continue
            s_ = 9.5 + rnd.rand() * 3; acc = 0.0; i = 0
            while s_ < L - 9.5 and i < len(pts) - 1:
                ax, az = pts[i]; bx, bz = pts[i + 1]; sl = math.hypot(bx - ax, bz - az)
                if sl < 0.01: i += 1; continue
                if s_ > acc + sl: acc += sl; i += 1; continue
                t = (s_ - acc) / sl; fx, fz = (bx - ax) / sl, (bz - az) / sl
                step = 5.7 + rnd.rand() * 2.4
                if rnd.rand() < 0.6:
                    off = (w / 2 - 0.95) * sd
                    cx, cz = ax + (bx - ax) * t + (-fz) * off + rnd.uniform(-0.12, 0.12), az + (bz - az) * t + fx * off
                    kind = 0 if rnd.rand() < 0.78 else (1 if rnd.rand() < 0.5 else 2)
                    hl = 2.1 * (1.18 if kind == 1 else 0.92 if kind == 2 else 1.0)
                    if x0 <= cx < x1 and z0 <= cz < z1 and free(cx, cz):
                        ok = roads_t.contains(Point(cx, cz)) and roads_t.contains(Point(cx + fx * hl, cz + fz * hl)) and roads_t.contains(Point(cx - fx * hl, cz - fz * hl))
                        if ok:
                            rect = Polygon([(cx + fx * hl - fz * 0.95, cz + fz * hl + fx * 0.95), (cx + fx * hl + fz * 0.95, cz + fz * hl - fx * 0.95),
                                            (cx - fx * hl + fz * 0.95, cz - fz * hl - fx * 0.95), (cx - fx * hl - fz * 0.95, cz - fz * hl + fx * 0.95)])
                            if not any(bshapes[k].intersects(rect) for k in bidx.query(rect)):
                                yaw = math.atan2(fx * sd, fz * sd)        # mira en el sentido de circulación de su lado
                                out.append([round(cx, 2), round(cz, 2), round(yaw, 3), int(rnd.randint(0, 12)), kind])
                                cell.setdefault((int(cx // 6), int(cz // 6)), []).append((cx, cz))
                                obst.append({"id": 0, "h": 1.5, "p": [[round(a_, 2), round(b_, 2)] for a_, b_ in list(rect.exterior.coords)]})
                s_ += step
    return out, obst


def street_lamps(road_lines, walk_t, trees, bshapes, bidx, existing, x0, z0, x1, z1):
    """Farolas de calle (OSM casi no las tiene mapeadas): cada ~30 m sobre la acera, alternando lados en calles estrechas y a ambos lados en las anchas.
    Lejos de fachadas, árboles y otras farolas. Devuelve [[x, z, 0, yaw]]."""
    out = []
    taken = [(a, b) for a, b, *_ in existing] + [(a, b) for a, b, _ in trees]
    cell = {}
    for a, b in taken: cell.setdefault((int(a // 10), int(b // 10)), []).append((a, b))
    def free(x, z, d2):
        for i in range(int(x // 10) - 1, int(x // 10) + 2):
            for j in range(int(z // 10) - 1, int(z // 10) + 2):
                for a, b in cell.get((i, j), []):
                    if (a - x) ** 2 + (b - z) ** 2 < d2: return False
        return True
    for r in road_lines:
        if r["k"] not in ("primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "trunk"): continue
        pts = r["p"]; side_off = r["w"] / 2 + 0.7
        both = r["w"] >= 9
        dist = 0.0; nxt = 8.0 + (int(abs(pts[0][0] * 3 + pts[0][1])) % 9); k = 0
        for i in range(len(pts) - 1):
            ax, az = pts[i]; bx, bz = pts[i + 1]; L = math.hypot(bx - ax, bz - az)
            if L < 0.01: continue
            fx, fz = (bx - ax) / L, (bz - az) / L
            while nxt <= dist + L:
                t = nxt - dist; cx, cz = ax + fx * t, az + fz * t
                sides = (1, -1) if both else ((1,) if k % 2 == 0 else (-1,))
                for sd in sides:
                    px, pz = cx + (-fz) * side_off * sd, cz + fx * side_off * sd
                    if not (x0 <= px < x1 and z0 <= pz < z1): continue
                    if not free(px, pz, 36): continue
                    pt = Point(px, pz)
                    if not walk_t.contains(pt): continue
                    if any(bshapes[j].distance(pt) < 1.4 for j in bidx.query(pt.buffer(1.4))): continue
                    out.append([round(px, 2), round(pz, 2), 0, round(math.atan2(fx, fz), 3)]); cell.setdefault((int(px // 10), int(pz // 10)), []).append((px, pz))
                k += 1; nxt += 30.0
            dist += L
    return out


def road_marks(road_lines, signals, x0, z0, x1, z1, cw_out=None):
    """Líneas de carril (discontinuas), bordes continuos y pasos de cebra en los semáforos. Devuelve (V, F, C) o None."""
    V, F = [], []
    import bisect
    def off_at(r, sdist):
        o_ = r.get("o")
        if o_ is None: return 0.0
        cum = r["cum"]; j = min(max(bisect.bisect_right(cum, sdist) - 1, 0), len(cum) - 2)
        seg = (cum[j + 1] - cum[j]) or 1e-9; t_ = (sdist - cum[j]) / seg
        return o_[j] + (o_[j + 1] - o_[j]) * t_
    def quad(p0, p1, p2, p3, offs=(0.0, 0.0, 0.0, 0.0)):
        pts = [np.array([p[0], float(hf(p[0], p[1])) + 0.05 + offs[i_], p[1]]) for i_, p in enumerate((p0, p1, p2, p3))]
        n = np.cross(pts[1] - pts[0], pts[3] - pts[0])
        if n[1] < 0: pts = [pts[0], pts[3], pts[2], pts[1]]
        b = len(V) * 1; base = sum(1 for _ in V)
        for q in pts: V.append(q)
        F.extend([[base, base + 1, base + 2], [base, base + 2, base + 3]])
    def strip(ax, az, bx, bz, off, hw, o0=0.0, o1=0.0):
        L = math.hypot(bx - ax, bz - az)
        if L < 0.05: return
        fx, fz = (bx - ax) / L, (bz - az) / L; nx, nz = -fz, fx
        quad((ax + nx * (off - hw), az + nz * (off - hw)), (ax + nx * (off + hw), az + nz * (off + hw)),
             (bx + nx * (off + hw), bz + nz * (off + hw)), (bx + nx * (off - hw), bz + nz * (off - hw)), (o0, o0, o1, o1))
    for r in road_lines:
        k, w, pts = r["k"], r["w"], r["p"]
        if k not in ("primary", "secondary", "tertiary", "residential", "unclassified") or w < 5.5: continue
        total = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
        if total < 24: continue
        dist = 0.0
        for i in range(len(pts) - 1):
            ax, az = pts[i]; bx, bz = pts[i + 1]; L = math.hypot(bx - ax, bz - az)
            if L < 0.3: dist += L; continue
            fx, fz = (bx - ax) / L, (bz - az) / L
            step = 1.25; t = 0.0
            while t < L - 1e-6:
                t2 = min(L, t + step); sa, sb = dist + t, dist + t2
                mxp, mzp = ax + fx * (t + t2) / 2, az + fz * (t + t2) / 2
                if x0 <= mxp < x1 and z0 <= mzp < z1 and sa > 9 and sb < total - 9:
                    p0 = (ax + fx * t, az + fz * t); p1 = (ax + fx * t2, az + fz * t2)
                    oa, ob = off_at(r, sa), off_at(r, sb)
                    if not r["ow"] and (sa % 7.5) < 2.5: strip(p0[0], p0[1], p1[0], p1[1], 0.0, 0.07, oa, ob)          # eje discontinuo
                    if r["ow"] and r["ln"] >= 2 and (sa % 7.5) < 2.5: strip(p0[0], p0[1], p1[0], p1[1], 0.0, 0.07, oa, ob)
                    if k in ("primary", "secondary", "tertiary"):                                                # bordes continuos
                        for sd in (1, -1): strip(p0[0], p0[1], p1[0], p1[1], sd * (w / 2 - 0.35), 0.06, oa, ob)
                t = t2
            dist += L
    # pasos de cebra en semáforos
    for (sx, sz) in signals:
        if not (x0 <= sx < x1 and z0 <= sz < z1): continue
        best = None
        for r in road_lines:
            if r["k"] not in ("primary", "secondary", "tertiary", "residential"): continue
            pts = r["p"]
            for i in range(len(pts) - 1):
                ax, az = pts[i]; bx, bz = pts[i + 1]; dx, dz = bx - ax, bz - az; l2 = dx * dx + dz * dz
                if l2 < 0.01: continue
                t = max(0, min(1, ((sx - ax) * dx + (sz - az) * dz) / l2)); px, pz = ax + t * dx, az + t * dz; d = math.hypot(sx - px, sz - pz)
                if d < 14 and (best is None or d < best[0]): best = (d, px, pz, dx / math.sqrt(l2), dz / math.sqrt(l2), r["w"])
        if best is None: continue
        _, px, pz, fx, fz, w = best; nx, nz = -fz, fx
        if cw_out is not None: cw_out.append([round(px, 1), round(pz, 1), round(fx, 3), round(fz, 3), round(w, 1)])
        n = int((w - 1.0) / 0.95)
        for j in range(n):
            lat = -((n - 1) * 0.95) / 2 + j * 0.95
            cx, cz = px + nx * lat, pz + nz * lat
            quad((cx - fx * 1.6 - nx * 0.25, cz - fz * 1.6 - nz * 0.25), (cx - fx * 1.6 + nx * 0.25, cz - fz * 1.6 + nz * 0.25),
                 (cx + fx * 1.6 + nx * 0.25, cz + fz * 1.6 + nz * 0.25), (cx + fx * 1.6 - nx * 0.25, cz + fz * 1.6 - nz * 0.25))
    if not V: return None
    Va = np.array(V); C = np.tile([240, 240, 234, 255], (len(Va), 1)).astype(np.uint8)
    return Va, np.array(F), C


def curbs(walk_t, roads_t, x0, z0, x1, z1):
    """Bordillo: pared vertical en el borde de las aceras que dan a la calzada."""
    if walk_t.is_empty or roads_t.is_empty: return None
    near_road = roads_t.buffer(0.45); shapely.prepare(near_road)
    V, F = [], []
    for poly in polys_of(walk_t):
        for ring in [poly.exterior] + list(poly.interiors):
            c = list(ring.coords)
            for (ax, az), (bx, bz) in zip(c[:-1], c[1:]):
                L = math.hypot(bx - ax, bz - az)
                if L < 0.3: continue
                n = max(1, int(L / 4.0)); fx, fz = (bx - ax) / L, (bz - az) / L
                for i in range(n):
                    p0 = (ax + (bx - ax) * i / n, az + (bz - az) * i / n); p1 = (ax + (bx - ax) * (i + 1) / n, az + (bz - az) * (i + 1) / n)
                    mx, mz = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
                    if not (x0 <= mx < x1 and z0 <= mz < z1): continue
                    # normal hacia la calzada (lado donde hay asfalto)
                    nx, nz = fz, -fx
                    if not shapely.contains_xy(near_road, mx + nx * 0.5, mz + nz * 0.5):
                        nx, nz = -nx, -nz
                        if not shapely.contains_xy(near_road, mx + nx * 0.5, mz + nz * 0.5): continue
                    ys = [float(hf(p0[0], p0[1])), float(hf(p1[0], p1[1]))]
                    q = [np.array([p0[0], ys[0] + 0.03, p0[1]]), np.array([p1[0], ys[1] + 0.03, p1[1]]),
                         np.array([p1[0], ys[1] + 0.12, p1[1]]), np.array([p0[0], ys[0] + 0.12, p0[1]])]
                    nrm = np.cross(q[1] - q[0], q[3] - q[0])
                    if nrm[0] * nx + nrm[2] * nz < 0: q = [q[0], q[3], q[2], q[1]]
                    b = len(V)
                    V.extend(q); F.extend([[b, b + 1, b + 2], [b, b + 2, b + 3]])
    if not V: return None
    Va = np.array(V); C = np.tile([196, 192, 182, 255], (len(Va), 1)).astype(np.uint8)
    return Va, np.array(F), C

# ---------- construcción de una tesela ----------
def build_tile(args):
    tx, tz = args
    x0, z0, x1, z1 = tile_box(tx, tz)
    tbox = box(x0, z0, x1, z1); mbox = tbox.buffer(70)
    mx0, mz0, mx1, mz1 = mbox.bounds

    def near(pts):
        xs = [p[0] for p in pts]; zs = [p[1] for p in pts]
        return not (max(xs) < mx0 or min(xs) > mx1 or max(zs) < mz0 or min(zs) > mz1)

    # --- calzadas, aceras, plazas y mosaico ---
    hw = ways(gather(tx, tz, "highway"))
    road_geoms, walk_geoms, road_lines, plaza_geoms, mosaic_geoms = [], [], [], [], []
    deck_ways = []
    streets = []
    for e in hw:
        t = e["tags"]; k = t.get("highway"); pts = [P(p) for p in e["geometry"]]
        if not near(pts): continue
        _nm = t.get("name:es") or t.get("name")
        if _nm and t.get("area") != "yes" and (k in ROAD_W or k in WALK_W) and t.get("tunnel") != "building_passage":
            _ls = LineString(pts).simplify(1.5)
            if _ls.length >= 4: streets.append([_nm, [[round(x_, 1), round(z_, 1)] for x_, z_ in _ls.coords]])
        if t.get("area") == "yes":
            if t.get("highway") in ("pedestrian", "footway") and len(pts) >= 4 and pts[0] == pts[-1]:
                try: g = make_valid(Polygon(pts)).buffer(0)
                except Exception: continue
                (mosaic_geoms if "esplanada" in t.get("name", "").lower() else plaza_geoms).append(g)
            continue
        if t.get("tunnel") == "building_passage": continue
        if k in ("footway", "pedestrian", "path", "cycleway") and t.get("bridge") not in (None, "", "no") and t.get("area") != "yes":
            Lf = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
            if 18 <= Lf <= 200:                                   # pasarela peatonal sobre una vía: se construye como puente estrecho
                deck_ways.append({"id": e["id"], "k": "footway", "w": 3.0, "pts": pts, "kind": "bridge", "layer": 1, "ow": False, "ln": 0, "foot": True})
                continue
        br = t.get("bridge") not in (None, "", "no"); tu = t.get("tunnel") == "yes"
        if tu and k not in ROAD_W: continue
        if k in ROAD_W:
            w = float(str(t.get("width", "0")).split()[0] or 0) if str(t.get("width", "")).replace(".", "").isdigit() else 0
            if not w: w = max(ROAD_W[k], int(t["lanes"]) * 3.2 if str(t.get("lanes", "")).isdigit() else 0)
            if tu and (k in ("service", "track") or w <= 5.0 or t.get("service") in ("parking_aisle", "driveway", "parking")): continue   # rampas de garaje/parking subterráneo: no se construyen ni se conducen
            if br or tu:
                Ltot = sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
                if Ltot >= 30:
                    try: lay = int(t.get("layer", "1" if br else "-1"))
                    except Exception: lay = 1 if br else -1
                    deck_ways.append({"id": e["id"], "k": k, "w": w, "pts": pts, "kind": "bridge" if br else "tunnel", "layer": lay if br else -1,
                                      "ow": t.get("oneway") in ("yes", "1", "true", "-1"), "ln": int(t["lanes"]) if str(t.get("lanes", "")).isdigit() else 0})
                    continue
                if tu: continue
            road_geoms.append(LineString(pts).buffer(w / 2, cap_style=2, join_style=1))
            road_lines.append({"id": e["id"], "rv": t.get("oneway") == "-1", "pk": park_policy(t, k), "k": k, "w": w, "ow": t.get("oneway") in ("yes", "1", "true", "-1"), "ln": int(t["lanes"]) if str(t.get("lanes", "")).isdigit() else 0,
                               "p": [[round(x, 2), round(z, 2)] for x, z in pts]})
        elif k in WALK_W:
            walk_geoms.append(LineString(pts).buffer(WALK_W[k] / 2, cap_style=2, join_style=1))
    roads = unary_union(road_geoms) if road_geoms else Polygon()
    # edificios pegados a la calzada: el ancho de OSM es una estimación y a veces el asfalto llega a la fachada (calle sin acera);
    # se estrecha la calzada para dejar 1,6 m de acera entre el asfalto y el edificio
    bl = []
    for e_ in ways(gather(tx, tz, "building")):
        try:
            if len(e_["geometry"]) < 4: continue
            g_ = Polygon([P(p_) for p_ in e_["geometry"]])
            if g_.is_valid and g_.area > 6: bl.append(g_)
        except Exception: pass
    bld_u = unary_union(bl) if bl else Polygon()
    if not roads.is_empty and not bld_u.is_empty:
        roads = roads.difference(bld_u.buffer(1.6))
    walk = unary_union(walk_geoms).difference(roads) if walk_geoms else Polygon()
    sidew = unary_union([g.buffer(1.8) for g in road_geoms]).difference(roads) if road_geoms else Polygon()
    if not bld_u.is_empty:
        sidew = sidew.difference(bld_u)
    mosaic = unary_union(mosaic_geoms).buffer(25).buffer(-25).difference(roads) if mosaic_geoms else Polygon()   # cierra el hueco del edificio quitado
    walk = unary_union([walk, sidew] + plaza_geoms).difference(mosaic)
    dk = build_decks(deck_ways, hf, (x0, z0, x1, z1), roads)
    hole_eff = dk["hole"]
    if dk["hole"] is not None:
        # las calles que cruzan la trinchera se mantienen a nivel del suelo como paso superior (con su cara inferior);
        # el resto de la trinchera se abre
        _surf = unary_union([g_ for g_ in (roads, walk) if not g_.is_empty]) if (not roads.is_empty or not walk.is_empty) else Polygon()
        cross = _surf.intersection(dk["hole"]) if not _surf.is_empty else Polygon()
        if not cross.is_empty:
            hole_eff = dk["hole"].difference(cross.buffer(0.15))
            under = []
            for sub in polys_of(cross):
                if sub.area < 3: continue
                ys = hf([c_[0] for c_ in sub.exterior.coords], [c_[1] for c_ in sub.exterior.coords])
                m_ = tri_mesh(sub.buffer(0.1), float(np.mean(ys)) - 0.75, hexrgb(0x7a776f))
                if m_ is not None:
                    Vm = np.asarray(m_.vertices); Fm = np.asarray(m_.faces)[:, ::-1]       # cara inferior
                    under.append((Vm, Fm, np.tile([122, 119, 111, 255], (len(Vm), 1)).astype(np.uint8)))
            if under:
                sv, sf, sc_ = join_parts(under)
                old_ = dk["parts"]["Struct"]
                if old_ is None: dk["parts"]["Struct"] = (sv, sf, sc_.astype(np.uint8))
                else: dk["parts"]["Struct"] = (np.vstack([old_[0], sv]), np.vstack([old_[1], sf + len(old_[0])]), np.vstack([old_[2], sc_.astype(np.uint8)]))
        roads = roads.difference(hole_eff); walk = walk.difference(hole_eff); mosaic = mosaic.difference(hole_eff)

    # --- mar, muelles, parques ---
    sea = G["SEA"].intersection(tbox)
    nat = ways(gather(tx, tz, "nat"))
    pier_geoms, park_geoms, pier_lines = [], [], []
    for e in nat:
        t = e.get("tags", {}); pts = [P(p) for p in e["geometry"]]
        if not near(pts): continue
        try:
            if t.get("man_made") in ("pier", "breakwater"):
                pier_geoms.append(Polygon(pts).buffer(0) if pts[0] == pts[-1] and len(pts) > 3 else LineString(pts).buffer(3.5, cap_style=2))
                if not (pts[0] == pts[-1] and len(pts) > 3): pier_lines.append(LineString(pts))
            elif (t.get("leisure") in ("park", "garden") or t.get("landuse") == "grass") and len(pts) >= 4 and pts[0] == pts[-1]:
                park_geoms.append(make_valid(Polygon(pts)).buffer(0))
        except Exception:
            pass
    piers = unary_union(pier_geoms) if pier_geoms else Polygon()
    sea_free = sea.difference(piers.buffer(0.2)) if not sea.is_empty else sea
    boats = []
    if pier_lines and not sea.is_empty:
        try:
            water_b = G["SEA"].intersection(tbox.buffer(45)).difference(piers.buffer(0.3))
            boats = place_boats(pier_lines, water_b, (x0, z0, x1, z1), (-700, 50, 500, 700))
        except Exception as ex_:
            print("barcos:", tx, tz, ex_, flush=True)
    parks = unary_union(park_geoms).difference(roads).difference(sea_free) if park_geoms else Polygon()
    land = tbox.difference(G["SEA"]); land = unary_union([land, piers.intersection(tbox)])
    if hole_eff is not None: land = land.difference(hole_eff); parks = parks.difference(hole_eff)
    roads_t = roads.intersection(tbox).difference(sea_free)
    walk_t = walk.intersection(tbox).difference(sea_free)
    mosaic_t = mosaic.intersection(tbox).difference(sea_free)
    parks_t = parks.intersection(tbox)

    # --- árboles y farolas ---
    trees, lamps, signals = [], [], []
    parked, park_obst = [], []
    shapely.prepare(roads)
    roads_pad = roads.buffer(0.7); shapely.prepare(roads_pad)     # los nodos de cruce caen justo en el borde de las vías: se ensancha para detectarlos
    for e in gather(tx, tz, "nodes"):
        if e.get("type") != "node": continue
        x, z = P(e)
        if not (x0 <= x < x1 and z0 <= z < z1): continue
        t = e.get("tags", {})
        if t.get("natural") == "tree":
            trees.append([round(x, 2), round(z, 2), tree_kind(t, x, z)])
        else:
            is_sig = t.get("highway") == "traffic_signals"
            for (fx_, fz_, yaw_) in furniture_positions(x, z, is_sig, road_lines, roads_pad):
                lamps.append([round(fx_, 2), round(fz_, 2), 1 if is_sig else 0, round(yaw_, 3)])
            if is_sig: signals.append((x, z))

    # --- detalles de fachada: escaparates, toldos y balcones en las fachadas que dan a la calle ---
    det = _Mesh(); roads_near = roads.buffer(14); shapely.prepare(roads_near)
    AWN = [0xc0392b, 0x2e6f95, 0xe0a526, 0x3b7d4f, 0xefe9d8, 0x8e3b46, 0xd9772b]
    FRAME = [0x3a3a3e, 0x5b4a3a, 0x2a3b4a, 0x6b6b6f]

    def facade_details(ring, ccw, levels, seed):
        nb_ = 0
        for ri in range(len(ring) - 1):
            (xa, za), (xb, zb) = ring[ri], ring[ri + 1]
            dx, dz = xb - xa, zb - za; L = math.hypot(dx, dz)
            if L < 5.0: continue
            tx_, tz_ = dx / L, dz / L
            nx_, nz_ = (tz_, -tx_) if ccw else (-tz_, tx_)
            mx, mz = (xa + xb) / 2, (za + zb) / 2
            if not roads_near.contains(Point(mx + nx_ * 1.5, mz + nz_ * 1.5)): continue
            hsh = (seed * 2654435761 + ri * 40503) & 0xFFFFFFFF
            y0 = float(hf(mx, mz)); ang = -math.atan2(tz_, tx_); want = (nx_, 0.0, nz_)
            if L >= 6.0 and levels >= 2 and (hsh % 100) < 50:
                a0 = 0.9; a1 = L - 0.9; o = 0.07
                def pt(t, y, d): return (xa + tx_ * t + nx_ * d, y, za + tz_ * t + nz_ * d)
                det.quad([pt(a0, y0 + 0.25, o), pt(a1, y0 + 0.25, o), pt(a1, y0 + 2.7, o), pt(a0, y0 + 2.7, o)], want, [38, 52, 62, 255])
                fc = hexrgb(FRAME[(hsh >> 8) % len(FRAME)])
                det.quad([pt(a0, y0 + 2.7, o), pt(a1, y0 + 2.7, o), pt(a1, y0 + 3.05, o), pt(a0, y0 + 3.05, o)], want, fc)
                det.quad([pt(a0 - 0.15, y0 + 0.0, o), pt(a0, y0 + 0.0, o), pt(a0, y0 + 3.05, o), pt(a0 - 0.15, y0 + 3.05, o)], want, fc)
                det.quad([pt(a1, y0 + 0.0, o), pt(a1 + 0.15, y0 + 0.0, o), pt(a1 + 0.15, y0 + 3.05, o), pt(a1, y0 + 3.05, o)], want, fc)
                if (hsh >> 12) % 100 < 55:
                    ac = hexrgb(AWN[(hsh >> 16) % len(AWN)]); dp = 1.25
                    det.quad([pt(a0, y0 + 3.15, o), pt(a1, y0 + 3.15, o), pt(a1, y0 + 2.75, dp), pt(a0, y0 + 2.75, dp)], (nx_, 0.6, nz_), ac)
                    det.quad([pt(a0, y0 + 2.75, dp), pt(a1, y0 + 2.75, dp), pt(a1, y0 + 2.5, dp), pt(a0, y0 + 2.5, dp)], want, ac)
            if levels >= 5 and L >= 8.0 and (hsh >> 6) % 100 < 55 and nb_ < 24:
                n = min(int(L // 7.5), 3)
                for k in range(n):
                    t = (k + 0.5) / n * L
                    if t < 1.6 or t > L - 1.6: continue
                    cx, cz = xa + tx_ * t + nx_ * 0.4, za + tz_ * t + nz_ * 0.4
                    for fl in range(1, min(int(levels) - 1, 4), 2):
                        yy = y0 + fl * FLOOR + 0.35
                        det.add_parts([box_at(cx, cz, yy, yy + 0.14, 1.9, 0.85, ang, [196, 190, 178, 255])])
                        cx2, cz2 = xa + tx_ * t + nx_ * 0.8, za + tz_ * t + nz_ * 0.8
                        det.add_parts([box_at(cx2, cz2, yy + 0.14, yy + 1.0, 1.9, 0.06, ang, [58, 60, 64, 255])])
                        nb_ += 1

    # --- edificios ---
    wv, wf, wc, wu = [], [], [], []; rv, rf, rc = [], [], []
    nwv = [0]; collid = []; lm_parts = []; castle_parts = []; lm_obst = []; styles = [0, 0, 0, 0]

    def emit_ring(coords, ccw_outward, st, levels_f, col, ytop, ybase=None):
        ring = list(coords); rh_ = hf([c[0] for c in ring], [c[1] for c in ring]); s_acc = 0.0
        for ri, ((xa, za), (xb, zb)) in enumerate(zip(ring[:-1], ring[1:])):
            yb1 = float(rh_[ri]) - 0.4; yb2 = float(rh_[ri + 1]) - 0.4
            if ybase is not None: yb1 = yb2 = ybase
            L = math.hypot(xb - xa, zb - za)
            if L < 0.05: continue
            u1 = s_acc / BAY + st * 1000; u2 = (s_acc + L) / BAY + st * 1000; s_acc += L
            tri = [[0, 2, 1], [0, 3, 2]] if ccw_outward else [[0, 1, 2], [0, 2, 3]]
            base = nwv[0]; nwv[0] += 4
            wv.extend([[xa, yb1, za], [xb, yb2, zb], [xb, ytop, zb], [xa, ytop, za]])
            wu.extend([[u1, (yb1 - ytop) / FLOOR + levels_f], [u2, (yb2 - ytop) / FLOOR + levels_f], [u2, levels_f], [u1, levels_f]])
            wc.extend([col] * 4)
            wf.extend([[base + i for i in f] for f in tri])


    def build_pyramid(poly0, seed):
        """Edificio La Pirámide: planta a planta, cada piso recorta su huella según un perfil triangular a lo largo del eje largo
        (cumbre a un 35 % del largo, bajada en escalones); cada escalón deja una terraza."""
        rect = poly0.minimum_rotated_rectangle; rc = list(rect.exterior.coords)[:4]
        e1 = (rc[1][0] - rc[0][0], rc[1][1] - rc[0][1]); e2 = (rc[2][0] - rc[1][0], rc[2][1] - rc[1][1])
        axv = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2
        Lx = math.hypot(*axv); ux, uz = axv[0] / Lx, axv[1] / Lx; vx, vz = -uz, ux
        ext0 = list(poly0.exterior.coords)
        us = [c[0] * ux + c[1] * uz for c in ext0]; vs = [c[0] * vx + c[1] * vz for c in ext0]
        u0, Lt = min(us), max(us) - min(us); v0, v1 = min(vs) - 5.0, max(vs) + 5.0
        FMAX, FMIN, AP = 22, 5, 0.35
        g0 = float(hf([c[0] for c in ext0], [c[1] for c in ext0]).min())
        col_ = hexrgb(0xe4d0a6); rcol_ = hexrgb(0x9a9c9e)
        st_ = style_for(16.0, seed)
        tiers = []
        for k in range(FMAX):
            t = max(0.0, (k + 1 - FMIN) / (FMAX - FMIN))
            ul, ur = AP * Lt * t, AP * Lt + (1 - AP) * Lt * (1 - t)
            strip = Polygon([(ux * (u0 + a_) + vx * b_, uz * (u0 + a_) + vz * b_) for a_, b_ in ((ul, v0), (ur, v0), (ur, v1), (ul, v1))])
            tiers.append(poly0.intersection(strip))
        for k, tk in enumerate(tiers):
            ytop = g0 + (k + 1) * FLOOR; ybase = None if k == 0 else g0 + k * FLOOR
            nxt = tiers[k + 1] if k + 1 < FMAX else Polygon()
            for pc in polys_of(tk):
                if pc.area < 4: continue
                emit_ring(list(pc.exterior.coords), pc.exterior.is_ccw, st_, (ytop - g0) / FLOOR, col_, ytop, ybase)
                for hole in pc.interiors: emit_ring(list(hole.coords), not hole.is_ccw, st_, (ytop - g0) / FLOOR, col_, ytop, ybase)
                roof_geo = pc.difference(nxt) if not nxt.is_empty else pc
                for rp in polys_of(roof_geo):
                    if rp.area < 2: continue
                    rm = tri_mesh(rp, ytop, rcol_)
                    if rm is not None:
                        base = sum(len(a_) for a_ in rv)
                        rv.append(np.asarray(rm.vertices)); rf.append(np.asarray(rm.faces) + base); rc.append(np.asarray(rm.visual.vertex_colors))
        styles[st_] += 1
        collid.append({"id": LM_PIRAMIDE, "h": round(FMAX * FLOOR, 1), "p": [[round(x, 2), round(z, 2)] for x, z in ext0]})

    for e in ways(gather(tx, tz, "building")):
        pts = [P(p) for p in e["geometry"]]
        if len(pts) < 4: continue
        cxm = sum(p[0] for p in pts) / len(pts); czm = sum(p[1] for p in pts) / len(pts)
        if not (x0 - 60 <= cxm < x1 + 60 and z0 - 60 <= czm < z1 + 60): continue
        try: poly0 = make_valid(Polygon(pts, [[P(q) for q in h] for h in e.get("holes", []) if len(h) >= 4]))
        except Exception: continue
        if isinstance(poly0, MultiPolygon): poly0 = max(poly0.geoms, key=lambda g: g.area)
        if not isinstance(poly0, Polygon) or poly0.area < 6: continue
        poly0 = poly0.buffer(0).simplify(0.15)
        if poly0.is_empty or not isinstance(poly0, Polygon): continue
        c0 = poly0.centroid
        if not (x0 <= c0.x < x1 and z0 <= c0.y < z1): continue          # cada edificio se construye en una sola tesela
        if not mosaic.is_empty and mosaic.contains(c0): continue         # no tapar el mosaico de la Explanada
        if e["id"] == LM_PIRAMIDE:
            build_pyramid(poly0, int(hashlib.md5(str(e["id"]).encode()).hexdigest()[:6], 16)); continue
        t = e["tags"]; lv = t.get("building:levels")
        if poly0.area >= 1500 and any(sp_.contains(c0) for sp_ in G.get("STADIUMS", [])): continue            # lo sustituye stadium_model()
        is_lm = e["id"] in (LM_AYTO, LM_CONCA, LM_SMARIA, LM_MERCAT, LM_AUDIT, LM_SOL) or e["id"] in LM_COL
        pieces = [(poly0, None, None, None)] if is_lm else cat_pieces(poly0)
        seed = int(hashlib.md5(str(e["id"]).encode()).hexdigest()[:6], 16)
        for pi, (poly, cfl, cyear, cuse) in enumerate(pieces):
            if not isinstance(poly, Polygon) or poly.is_empty or poly.area < 4: continue
            osm_h = None
            try: osm_h = float(str(t["height"]).replace("m", ""))
            except Exception: pass
            if osm_h is not None and (len(pieces) == 1 or cfl is None): h = osm_h; levels = h / FLOOR
            elif cfl: h = cfl * FLOOR + 1.2; levels = float(cfl)
            elif lv and lv.replace(".", "").isdigit(): h = float(lv) * FLOOR + 1.2; levels = float(lv)
            else: h = 10.5; levels = h / FLOOR
            h = max(3.0, min(h, 90.0)); levels_f = h / FLOOR
            st = style_for(levels, seed)
            col = hexrgb(WALL_COLS[seed % len(WALL_COLS)])
            if cfl and (cyear or cuse):
                sc = style_by_cat(cfl, cyear, cuse)
                if sc is not None: st = sc
                pal = OLD_COLS if (cyear or 9999) < 1940 else MID_COLS if (cyear or 9999) < 1985 else NEW_COLS
                if cuse and not cuse.startswith("1_"): pal = NEW_COLS
                col = hexrgb(pal[seed % len(pal)])
            rcol = hexrgb(ROOF_COLS[(seed >> 4) % len(ROOF_COLS)])
            _c = poly.centroid
            if e["id"] in LM_COL: col = hexrgb(LM_COL[e["id"]])
            elif math.hypot(_c.x - SANTA_CRUZ[0], _c.y - SANTA_CRUZ[1]) < SANTA_CRUZ[2]:
                col = hexrgb(SC_COLS[seed % len(SC_COLS)]); st = 2
            if e["id"] == LM_SOL: st = 1
            if e["id"] == LM_MERCAT: rcol = hexrgb(0xb7b0a0)
            styles[st] += 1
            ext = list(poly.exterior.coords)
            rh = hf([c[0] for c in ext], [c[1] for c in ext]); ytop = float(rh.max()) + h
            emit_ring(ext, poly.exterior.is_ccw, st, levels_f, col, ytop)
            if not is_lm and h >= 5.0: facade_details(ext, poly.exterior.is_ccw, levels_f, seed + pi)
            for hole in poly.interiors:
                emit_ring(list(hole.coords), not hole.is_ccw, st, levels_f, col, ytop)
            rm = tri_mesh(poly, ytop, rcol)
            if rm is not None:
                base = sum(len(a) for a in rv)
                rv.append(np.asarray(rm.vertices)); rf.append(np.asarray(rm.faces) + base); rc.append(np.asarray(rm.visual.vertex_colors))
            if (e["id"] in (LM_AYTO, LM_CONCA, LM_SMARIA, LM_MERCAT, LM_AUDIT, LM_STATION) or e["id"] in LM_CHURCH) and pi == 0:
                landmark_extras(e["id"], poly, rh, ytop, lm_parts, road_lines)
            collid.append({"id": e["id"], "h": round(h, 1), "p": [[round(x, 2), round(z, 2)] for x, z in poly.exterior.coords]})

    # --- arbolado de calle y obstáculos de árboles ---
    _pl, _lp = explanada_palms(mosaic_geoms, x0, z0, x1, z1)
    trees += _pl; lamps += _lp
    bshapes = [Polygon(b["p"]).buffer(0) for b in collid if len(b["p"]) >= 4]
    bidx = STRtree(bshapes) if bshapes else None
    if bidx is not None:
        trees += street_trees(road_lines, walk_t, trees, bshapes, bidx, x0, z0, x1, z1)
        lamps += street_lamps(road_lines, walk_t, trees, bshapes, bidx, lamps, x0, z0, x1, z1)
        parked, park_obst = parked_cars(road_lines, roads_t, bshapes, bidx, x0, z0, x1, z1)
    DRIVE_K = ("primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "trunk", "primary_link", "secondary_link", "tertiary_link")
    roads_out = [[r["id"], r["k"], (0 if not r["ow"] else 2 if r["rv"] else 1), round(r["w"], 1), [[round(x_, 1), round(z_, 1)] for x_, z_ in r["p"]]]
                 for r in road_lines if r["k"] in DRIVE_K and len(r["p"]) >= 2]
    tree_obst = [{"id": 0, "h": 4, "p": [[round(x + 0.4 * math.cos(a * math.pi / 4), 2), round(z + 0.4 * math.sin(a * math.pi / 4), 2)] for a in range(9)]} for x, z, _ in trees]

    # --- puntos de interés con modelo propio: gasolineras (marquesina, surtidores, tótem, tienda) y hospitales (cruz y helipuerto en la azotea) ---
    poi_obst = []
    BRAND_COL = {"bp": [0, 150, 60], "repsol": [255, 120, 0], "cepsa": [220, 30, 40], "moeve": [220, 30, 40], "shell": [250, 200, 0], "galp": [255, 110, 0],
                 "petroprix": [0, 90, 170], "ballenoil": [0, 110, 180], "plenoil": [240, 200, 0], "avia": [230, 20, 30], "disa": [0, 90, 160], "tamoil": [0, 70, 150],
                 "q8": [0, 70, 160], "carrefour": [20, 80, 170], "eroski": [220, 30, 40], "esclatoil": [0, 110, 180]}

    def brand_col(lm):
        t = (lm.get("brand", "") + " " + lm.get("name", "")).lower()
        for k_, v_ in BRAND_COL.items():
            if k_ in t: return v_
        return [30, 100, 170]

    def rect_obst(cx, cz, ux, uz, sx, sz, h):
        vx, vz = -uz, ux
        pts = [(cx + ux * a_ + vx * b_, cz + uz * a_ + vz * b_) for a_, b_ in ((-sx / 2, -sz / 2), (sx / 2, -sz / 2), (sx / 2, sz / 2), (-sx / 2, sz / 2), (-sx / 2, -sz / 2))]
        poi_obst.append({"id": 0, "h": h, "p": [[round(a_, 2), round(b_, 2)] for a_, b_ in pts]})

    def fuel_station(lm):
        pol = None
        if lm.get("poly") and len(lm["poly"]) >= 4:
            try: pol = Polygon(lm["poly"]).buffer(0)
            except Exception: pol = None
            if pol is not None and (pol.is_empty or not isinstance(pol, Polygon)): pol = None
        big = pol is not None and pol.area >= 120
        cx, cz = (pol.centroid.x, pol.centroid.y) if pol is not None else (lm["x"], lm["z"])
        if big:
            rc_ = list(pol.minimum_rotated_rectangle.exterior.coords)[:4]
            e1 = (rc_[1][0] - rc_[0][0], rc_[1][1] - rc_[0][1]); e2 = (rc_[2][0] - rc_[1][0], rc_[2][1] - rc_[1][1])
            axv = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2; Ls = max(math.hypot(*e1), math.hypot(*e2)); Ws = min(math.hypot(*e1), math.hypot(*e2))
            ln = math.hypot(*axv); ux, uz = axv[0] / ln, axv[1] / ln
            can_l = max(10.0, min(22.0, Ls * 0.62)); can_w = max(6.5, min(12.0, Ws * 0.55))
        else:
            bd, ux, uz = 1e9, 1.0, 0.0
            for r_ in road_lines:
                q_ = r_["p"]
                for i_ in range(len(q_) - 1):
                    ax_, az_ = q_[i_]; bx_, bz_ = q_[i_ + 1]; dx_, dz_ = bx_ - ax_, bz_ - az_; l2 = dx_ * dx_ + dz_ * dz_
                    if l2 < 0.01: continue
                    t_ = max(0.0, min(1.0, ((cx - ax_) * dx_ + (cz - az_) * dz_) / l2)); d_ = math.hypot(cx - (ax_ + t_ * dx_), cz - (az_ + t_ * dz_))
                    if d_ < bd: bd, ux, uz = d_, dx_ / math.sqrt(l2), dz_ / math.sqrt(l2)
            can_l, can_w = 14.0, 8.0
        vx, vz = -uz, ux; ang = -math.atan2(uz, ux)
        y0 = float(hf(cx, cz)); col = brand_col(lm) + [255]
        det.add_parts([box_at(cx, cz, y0 + 4.75, y0 + 5.2, can_l, can_w, ang, [238, 238, 234, 255])])           # cubierta
        det.add_parts([box_at(cx, cz, y0 + 4.45, y0 + 4.75, can_l + 0.2, can_w + 0.2, ang, col)])             # franja de color de la marca
        for a_ in (-1, 1):
            for b_ in (-1, 1):
                det.add_parts([box_at(cx + ux * a_ * (can_l / 2 - 0.8) + vx * b_ * (can_w / 2 - 0.8), cz + uz * a_ * (can_l / 2 - 0.8) + vz * b_ * (can_w / 2 - 0.8), y0, y0 + 4.5, 0.45, 0.45, ang, [205, 205, 200, 255])])
        for sd in (-1, 1):                                                                                      # dos islas con dos surtidores cada una
            ix, iz = cx + vx * sd * can_w * 0.2, cz + vz * sd * can_w * 0.2
            det.add_parts([box_at(ix, iz, y0, y0 + 0.2, can_l * 0.7, 1.2, ang, [128, 128, 132, 255])])
            rect_obst(ix, iz, ux, uz, can_l * 0.7, 1.2, 1.4)
            for k_ in (-1, 1):
                px, pz = ix + ux * k_ * can_l * 0.2, iz + uz * k_ * can_l * 0.2
                det.add_parts([box_at(px, pz, y0 + 0.2, y0 + 1.75, 0.6, 0.42, ang, col)])
                det.add_parts([box_at(px, pz, y0 + 1.2, y0 + 1.55, 0.62, 0.44, ang, [30, 34, 40, 255])])
        mx, mz = cx + ux * (can_l / 2 + 3.2) * (1 if (lm["id"] % 2) else -1), cz + uz * (can_l / 2 + 3.2) * (1 if (lm["id"] % 2) else -1)   # tótem de precios
        det.add_parts([box_at(mx, mz, y0, y0 + 7.0, 0.3, 0.3, ang, [70, 72, 78, 255])])
        det.add_parts([box_at(mx, mz, y0 + 4.6, y0 + 7.4, 0.35, 2.2, ang, col)])
        det.add_parts([box_at(mx, mz, y0 + 4.9, y0 + 5.7, 0.4, 1.9, ang, [250, 250, 246, 255])])
        if big and pol.area >= 260:                                                                             # tienda
            kx, kz = cx + vx * (can_w / 2 + 3.4), cz + vz * (can_w / 2 + 3.4)
            det.add_parts([box_at(kx, kz, y0, y0 + 3.2, 6.5, 4.0, ang, [236, 232, 222, 255])])
            det.add_parts([box_at(kx - vx * 2.02, kz - vz * 2.02, y0 + 0.4, y0 + 2.6, 5.4, 0.1, ang, [38, 52, 62, 255])])
            det.add_parts([box_at(kx, kz, y0 + 3.2, y0 + 3.5, 6.8, 4.3, ang, col)])
            rect_obst(kx, kz, ux, uz, 6.5, 4.0, 3.2)

    def hospital_roof(lm):
        pt = Point(lm["x"], lm["z"]); cand = None; area_best = 0.0
        for b_ in collid:
            if len(b_["p"]) < 4: continue
            try: bp = Polygon(b_["p"]).buffer(0)
            except Exception: continue
            if bp.is_empty or not isinstance(bp, Polygon): continue
            if (bp.contains(pt) or bp.distance(pt) < 8) and bp.area > area_best: cand, area_best = (b_, bp), bp.area
        if cand is None or area_best < 300: return
        b_, bp = cand
        ext = list(bp.exterior.coords); top = float(hf([c[0] for c in ext], [c[1] for c in ext]).max()) + b_["h"]
        rp = bp.representative_point(); rx, rz = rp.x, rp.y
        det.add_parts([box_at(rx, rz, top, top + 0.9, 0.3, 0.3, 0.0, [90, 90, 94, 255])])
        det.add_parts([box_at(rx, rz, top + 0.9, top + 7.4, 0.5, 7.0, 0.0, [250, 250, 250, 255])])               # cartel vertical con cruz
        det.add_parts([box_at(rx, rz, top + 3.0, top + 5.2, 0.6, 1.4, 0.0, [196, 26, 38, 255])])
        det.add_parts([box_at(rx, rz, top + 3.8, top + 4.4, 0.6, 4.6, 0.0, [196, 26, 38, 255])])
        if area_best >= 1200:                                                                                   # helipuerto
            hp = bp.buffer(-9)
            if not hp.is_empty and isinstance(hp, Polygon): hx, hz = hp.centroid.x, hp.centroid.y
            else: hx, hz = bp.centroid.x, bp.centroid.y
            if math.hypot(hx - rx, hz - rz) >= 10 and bp.contains(Point(hx, hz)):
                det.add_parts([box_at(hx, hz, top, top + 0.14, 13.0, 13.0, 0.0, [60, 84, 74, 255])])
                det.add_parts([box_at(hx - 2.0, hz, top + 0.14, top + 0.2, 0.8, 5.0, 0.0, [244, 244, 240, 255])])
                det.add_parts([box_at(hx + 2.0, hz, top + 0.14, top + 0.2, 0.8, 5.0, 0.0, [244, 244, 240, 255])])
                det.add_parts([box_at(hx, hz, top + 0.14, top + 0.2, 4.0, 0.8, 0.0, [244, 244, 240, 255])])

    special = []

    def emergency_vehicles(lm, kind, n):
        """Aparca n vehículos de emergencia (0 policía, 1 ambulancia, 2 bomberos) en el borde de la calzada más cercana a la entrada."""
        cands = [(lm["x"], lm["z"])] + [tuple(q_) for q_ in (lm.get("poly") or [])]
        best = None
        for (qx, qz) in cands:
            for r_ in road_lines:
                if r_["k"] not in ("primary", "secondary", "tertiary", "residential", "unclassified", "living_street") or r_["w"] < 5.5: continue
                q_ = r_["p"]
                for i_ in range(len(q_) - 1):
                    ax_, az_ = q_[i_]; bx_, bz_ = q_[i_ + 1]; dx_, dz_ = bx_ - ax_, bz_ - az_; l2 = dx_ * dx_ + dz_ * dz_
                    if l2 < 4.0: continue
                    t_ = max(0.0, min(1.0, ((qx - ax_) * dx_ + (qz - az_) * dz_) / l2)); px_, pz_ = ax_ + t_ * dx_, az_ + t_ * dz_; d_ = math.hypot(qx - px_, qz - pz_)
                    if d_ < 40 and (best is None or d_ < best[0]): best = (d_, px_, pz_, dx_ / math.sqrt(l2), dz_ / math.sqrt(l2), r_["w"])
        if best is None: return
        _, px_, pz_, fx_, fz_, w_ = best
        off = w_ / 2 - 1.0
        gap = 7.0 if kind == 2 else 5.8
        for k_ in range(n):
            cx_, cz_ = px_ + (-fz_) * off + fx_ * gap * (k_ - (n - 1) / 2), pz_ + fx_ * off + fz_ * gap * (k_ - (n - 1) / 2)
            if not (x0 <= cx_ < x1 and z0 <= cz_ < z1): continue
            if not roads.contains(Point(cx_, cz_)): continue
            special.append([round(cx_, 2), round(cz_, 2), round(math.atan2(fx_, fz_), 3), kind])
            rect_obst(cx_, cz_, fx_, fz_, 9.2 if kind == 2 else 4.6, 2.0, 2.2)

    def stadium_model(lm):
        """Estadio / plaza de toros: muro exterior, cubierta en voladizo, dos niveles de gradas con pasillo, campo (o arena) y torres de focos.
        La huella de OSM se reduce hacia el centro (escala) para colocar cada anillo; solo se emiten las aristas cuyo punto medio cae en la tesela."""
        try: pg = Polygon(lm["poly"]).buffer(0).simplify(1.5)
        except Exception: return
        if pg.is_empty or not isinstance(pg, Polygon) or pg.area < 3000: return
        ext = list(pg.exterior.coords)[:-1]
        n = len(ext)
        if n < 4: return
        cx, cz = pg.centroid.x, pg.centroid.y
        nm = lm["name"].lower()
        bull = "toros" in nm; athl = "atletismo" in nm
        H = 19.0 if bull else (23.0 if pg.area > 15000 else 13.0)
        gy = [float(hf(x_, z_)) for x_, z_ in ext]
        yb = min(gy); top = max(gy) + H
        yp = float(hf(cx, cz)) + 0.25
        CON = [186, 184, 178, 255]; CON2 = [168, 166, 160, 255]; SEAT = [[34, 76, 150, 255], [226, 226, 228, 255], [180, 40, 44, 255]]
        def ring(f): return [(cx + (x_ - cx) * f, cz + (z_ - cz) * f) for x_, z_ in ext]
        R_out, R_roof, R_t1a, R_t1b, R_t2a, R_t2b = ring(1.0), ring(0.82), ring(0.80), ring(0.70), ring(0.67), ring(0.57)
        for i in range(n):
            j = (i + 1) % n
            mx, mz = (ext[i][0] + ext[j][0]) / 2, (ext[i][1] + ext[j][1]) / 2
            if not (x0 <= mx < x1 and z0 <= mz < z1): continue
            L = math.hypot(ext[j][0] - ext[i][0], ext[j][1] - ext[i][1])
            if L < 0.5: continue
            nx, nz = (ext[j][1] - ext[i][1]) / L, -(ext[j][0] - ext[i][0]) / L
            if nx * (mx - cx) + nz * (mz - cz) < 0: nx, nz = -nx, -nz
            col = CON if i % 2 == 0 else CON2
            def P3(r, k, y): return (r[k][0], y, r[k][1])
            # muro exterior (de la cota del terreno al borde superior) con friso oscuro arriba
            det.quad([(ext[i][0], gy[i] - 0.5, ext[i][1]), (ext[j][0], gy[j] - 0.5, ext[j][1]), (ext[j][0], top - 1.4, ext[j][1]), (ext[i][0], top - 1.4, ext[i][1])], (nx, 0.0, nz), col)
            det.quad([P3(R_out, i, top - 1.4), P3(R_out, j, top - 1.4), P3(R_out, j, top), P3(R_out, i, top)], (nx, 0.0, nz), [120, 52, 40, 255] if bull else [70, 74, 82, 255])
            # cubierta: de la cornisa hacia dentro, algo más baja
            det.quad([P3(R_out, i, top), P3(R_out, j, top), P3(R_roof, j, top - 2.2), P3(R_roof, i, top - 2.2)], (-nx * 0.3, 1.0, -nz * 0.3), [214, 214, 210, 255] if not bull else [176, 84, 62, 255])
            # gradas altas, pasillo y gradas bajas (colores a franjas)
            yt1 = top - 3.0; ym = yp + (yt1 - yp) * 0.5; yw = ym - 0.2
            sc = SEAT[(i // 2) % len(SEAT)] if not bull else [206, 186, 150, 255]
            det.quad([P3(R_t1a, i, yt1), P3(R_t1a, j, yt1), P3(R_t1b, j, ym), P3(R_t1b, i, ym)], (-nx * 0.5, 0.85, -nz * 0.5), sc)
            det.quad([P3(R_t1b, i, ym), P3(R_t1b, j, ym), P3(R_t2a, j, yw), P3(R_t2a, i, yw)], (-nx * 0.2, 1.0, -nz * 0.2), [150, 150, 146, 255])
            det.quad([P3(R_t2a, i, yw), P3(R_t2a, j, yw), P3(R_t2b, j, yp + 0.5), P3(R_t2b, i, yp + 0.5)], (-nx * 0.5, 0.85, -nz * 0.5), sc)
            det.quad([P3(R_t2b, i, yp + 0.5), P3(R_t2b, j, yp + 0.5), P3(R_t2b, j, yp + 0.1), P3(R_t2b, i, yp + 0.1)], (-nx, 0.0, -nz), [60, 60, 64, 255])
        # campo (verde) o arena, con la pista de atletismo alrededor
        tb = tbox
        def fill(rg, y, colr):
            try: g = Polygon(rg).buffer(0).intersection(tb)
            except Exception: return
            for gp in polys_of(g):
                if gp.area < 2: continue
                m_ = tri_mesh(gp, y, colr)
                if m_ is not None: det.add_parts([(np.asarray(m_.vertices), np.asarray(m_.faces), np.asarray(m_.visual.vertex_colors))])
        if bull: fill(ring(0.57), yp, [214, 188, 140, 255])
        else:
            if athl or pg.area > 15000: fill(ring(0.57), yp - 0.02, [172, 70, 52, 255])
            fill(ring(0.50 if (athl or pg.area > 15000) else 0.57), yp, [64, 142, 74, 255])
        # torres de focos en las esquinas (salvo la plaza de toros)
        if not bull:
            rc_ = list(pg.minimum_rotated_rectangle.exterior.coords)[:4]
            for k_ in range(4):
                fx_, fz_ = cx + (rc_[k_][0] - cx) * 1.04, cz + (rc_[k_][1] - cz) * 1.04
                if not (x0 <= fx_ < x1 and z0 <= fz_ < z1): continue
                g0 = float(hf(fx_, fz_))
                det.add_parts([box_at(fx_, fz_, g0, top + 14, 0.9, 0.9, 0.0, [150, 150, 154, 255])])
                det.add_parts([box_at(fx_, fz_, top + 14, top + 16.5, 5.0, 1.8, 0.0, [248, 248, 236, 255])])
        c_ = pg.centroid
        if x0 <= c_.x < x1 and z0 <= c_.y < z1:
            collid.append({"id": lm["id"], "h": round(top - yb, 1), "p": [[round(x_, 2), round(z_, 2)] for x_, z_ in ext + [ext[0]]]})

    def bus_station(lm):
        """Estación de autobuses: autobuses en dársenas y marquesinas, solo donde hay suelo libre (fuera de edificios y calzada) dentro de la parcela."""
        try: pg = Polygon(lm["poly"]).buffer(0)
        except Exception: return
        if pg.is_empty or not isinstance(pg, Polygon) or pg.area < 1500: return
        rc_ = list(pg.minimum_rotated_rectangle.exterior.coords)[:4]
        e1 = (rc_[1][0] - rc_[0][0], rc_[1][1] - rc_[0][1]); e2 = (rc_[2][0] - rc_[1][0], rc_[2][1] - rc_[1][1])
        axv = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2; Lx = math.hypot(*axv); Ws = min(math.hypot(*e1), math.hypot(*e2))
        ux, uz = axv[0] / Lx, axv[1] / Lx; vx, vz = -uz, ux; ang = -math.atan2(uz, ux)
        cx, cz = pg.centroid.x, pg.centroid.y
        bsh = [Polygon(b_["p"]).buffer(0) for b_ in collid if len(b_["p"]) >= 4]
        allow = pg.buffer(2.0)
        def free(px, pz, sx, sz):
            r_ = Polygon([(px + ux * a_ + vx * b_, pz + uz * a_ + vz * b_) for a_, b_ in ((-sx / 2, -sz / 2), (sx / 2, -sz / 2), (sx / 2, sz / 2), (-sx / 2, sz / 2))])
            if not allow.contains(r_): return False
            if not roads.is_empty and roads.intersects(r_): return False
            return not any(bp.intersects(r_) for bp in bsh)
        nbus = 0
        for row in (-0.34, 0.0, 0.34):                                                       # filas de dársenas a lo ancho de la parcela
            for k_ in range(int(Lx // 13)):
                px = cx + ux * (-Lx / 2 + 7 + k_ * 13) + vx * Ws * row
                pz = cz + uz * (-Lx / 2 + 7 + k_ * 13) + vz * Ws * row
                if not (x0 <= px < x1 and z0 <= pz < z1) or nbus >= 10: continue
                if not free(px, pz, 12.6, 3.2): continue
                special.append([round(px, 2), round(pz, 2), round(math.atan2(ux, uz), 3), 3]); nbus += 1
                rect_obst(px, pz, ux, uz, 12.0, 2.6, 3.2)
                y0 = float(hf(px, pz))
                qx, qz = px + vx * 2.9, pz + vz * 2.9                                        # andén con marquesina al costado de cada autobús
                if free(qx, qz, 12.0, 2.6):
                    det.add_parts([box_at(qx, qz, y0, y0 + 0.22, 12.0, 2.6, ang, [168, 166, 160, 255])])
                    det.add_parts([box_at(qx, qz, y0 + 3.7, y0 + 4.05, 12.0, 2.8, ang, [236, 236, 232, 255])])
                    det.add_parts([box_at(qx, qz, y0 + 3.5, y0 + 3.7, 12.2, 3.0, ang, [28, 90, 168, 255])])
                    for e_ in (-1, 1): det.add_parts([box_at(qx + ux * e_ * 5.6, qz + uz * e_ * 5.6, y0, y0 + 3.6, 0.3, 0.3, ang, [200, 200, 196, 255])])

    for lm in G.get("LANDMARKS", []):
        # los estadios se reparten por teselas aristas a arista; el resto se procesan en la tesela de su centro
        try:
            if lm["cat"] == "stadium": stadium_model(lm); continue
            if lm["cat"] == "bus" and lm.get("poly"): bus_station(lm); continue
        except Exception as ex_:
            print("  aviso POI", lm["id"], ex_, flush=True)
        if not (x0 <= lm["x"] < x1 and z0 <= lm["z"] < z1): continue
        try:
            if lm["cat"] == "fuel": fuel_station(lm)
            elif lm["cat"] in ("hospital", "clinic"):
                hospital_roof(lm)
                if lm["cat"] == "hospital": emergency_vehicles(lm, 1, 2)
            elif lm["cat"] == "police": emergency_vehicles(lm, 0, 2)
            elif lm["cat"] == "fire": emergency_vehicles(lm, 2, 1)
        except Exception as ex_:
            print("  aviso POI", lm["id"], ex_, flush=True)

    # --- muros de piedra (OSM: contención, murallas, muros altos) y escaleras (highway=steps) ---
    wall_obst = []
    STONE = [178, 160, 128, 255]; STONE_TOP = [206, 192, 160, 255]; PLASTER = [222, 212, 196, 255]; TREAD = [204, 200, 190, 255]; RISER = [170, 166, 156, 255]

    def height_tag(t):
        try: return float(str(t.get("height", "")).replace("m", "").strip())
        except Exception: return None

    for e in ways(gather(tx, tz, "barrier")):
        t = e["tags"]; pts = [P(q) for q in e["geometry"]]
        if len(pts) < 2: continue
        kind = "city" if (t.get("barrier") == "city_wall" or t.get("historic")) else "retain" if t.get("barrier") == "retaining_wall" else "wall"
        htag = height_tag(t)
        th = 0.55 if kind != "wall" else 0.3
        col = PLASTER if (kind == "wall" and t.get("material") not in ("stone", "masonry") and t.get("wall") not in ("dry_stone", "stone")) else STONE
        n_ = len(pts); verts = []
        for i, (px_, pz_) in enumerate(pts):
            ax, az = pts[max(i - 1, 0)]; bx, bz = pts[min(i + 1, n_ - 1)]
            dx, dz = bx - ax, bz - az; l_ = math.hypot(dx, dz) or 1.0
            nx_, nz_ = -dz / l_, dx / l_
            yl, yr, ym = float(hf(px_ + nx_ * 1.3, pz_ + nz_ * 1.3)), float(hf(px_ - nx_ * 1.3, pz_ - nz_ * 1.3)), float(hf(px_, pz_))
            if kind == "retain":
                base = min(yl, yr, ym) - 0.3; top = max(yl, yr, ym) + 0.45
                if htag: top = max(top, base + htag)
                top = max(top, base + 1.0)
            elif kind == "city":
                base = min(yl, yr, ym) - 0.3; top = max(max(yl, yr) + 1.3, base + (htag or 4.5))
            else:
                base = ym - 0.2; top = ym + (htag or 2.2)
            verts.append((px_, pz_, nx_, nz_, base, top))
        for i in range(n_ - 1):
            (xa, za, nxa, nza, ba, ta), (xb, zb, nxb, nzb, bb, tb) = verts[i], verts[i + 1]
            mx, mz = (xa + xb) / 2, (za + zb) / 2
            if not (x0 <= mx < x1 and z0 <= mz < z1): continue
            L = math.hypot(xb - xa, zb - za)
            if L < 0.2: continue
            h = th / 2
            for sd in (1, -1):
                det.quad([(xa + nxa * h * sd, ba, za + nza * h * sd), (xb + nxb * h * sd, bb, zb + nzb * h * sd),
                          (xb + nxb * h * sd, tb, zb + nzb * h * sd), (xa + nxa * h * sd, ta, za + nza * h * sd)], (nxa * sd, 0.0, nza * sd), col)
            det.quad([(xa + nxa * h, ta, za + nza * h), (xb + nxb * h, tb, zb + nzb * h), (xb - nxb * h, tb, zb - nzb * h), (xa - nxa * h, ta, za - nza * h)], (0.0, 1.0, 0.0), STONE_TOP)
            ux, uz = (xb - xa) / L, (zb - za) / L
            wall_obst.append({"id": 0, "h": round(max(ta, tb) - min(ba, bb), 1), "p": [[round(xa + nxa * h * 1.2, 2), round(za + nza * h * 1.2, 2)], [round(xb + nxb * h * 1.2, 2), round(zb + nzb * h * 1.2, 2)],
                                                                                         [round(xb - nxb * h * 1.2, 2), round(zb - nzb * h * 1.2, 2)], [round(xa - nxa * h * 1.2, 2), round(za - nza * h * 1.2, 2)],
                                                                                         [round(xa + nxa * h * 1.2, 2), round(za + nza * h * 1.2, 2)]]})

    for e in hw:
        t = e["tags"]
        if t.get("highway") != "steps" or t.get("area") == "yes": continue
        pts = [P(q) for q in e["geometry"]]
        if len(pts) < 2: continue
        cum = [0.0]
        for i in range(1, len(pts)): cum.append(cum[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
        Ls = cum[-1]
        y_a, y_b = float(hf(*pts[0])), float(hf(*pts[-1])); dy = y_b - y_a
        if Ls < 2.0 or abs(dy) < 0.5: continue
        nst = max(3, int(round(abs(dy) / 0.17)))
        wd = height_tag({"height": t.get("width", "")}) or 2.4
        wd = max(1.2, min(wd, 6.0)) / 2

        def at(sv):
            j = 1
            while j < len(cum) - 1 and cum[j] < sv: j += 1
            sl = (cum[j] - cum[j - 1]) or 1.0; tt = max(0.0, min(1.0, (sv - cum[j - 1]) / sl))
            return (pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * tt, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * tt, (pts[j][0] - pts[j - 1][0]) / sl, (pts[j][1] - pts[j - 1][1]) / sl)

        for k in range(nst):
            xa, za, dxa, dza = at(k * Ls / nst); xb, zb, dxb, dzb = at((k + 1) * Ls / nst)
            if not (x0 <= (xa + xb) / 2 < x1 and z0 <= (za + zb) / 2 < z1): continue
            yt = y_a + dy * (k + 1) / nst; yb_ = yt - 0.75
            dl = math.hypot(xb - xa, zb - za)
            if dl < 0.05: continue
            ux, uz = (xb - xa) / dl, (zb - za) / dl; px2, pz2 = -uz * wd, ux * wd
            A1, A2, B1, B2 = (xa + px2, za + pz2), (xa - px2, za - pz2), (xb + px2, zb + pz2), (xb - px2, zb - pz2)
            det.quad([(A1[0], yt, A1[1]), (B1[0], yt, B1[1]), (B2[0], yt, B2[1]), (A2[0], yt, A2[1])], (0.0, 1.0, 0.0), TREAD)
            rx, rz = (-ux, -uz) if dy > 0 else (ux, uz)                      # contrahuella mirando a la parte baja
            ex, ez = (A1, A2) if dy > 0 else (B1, B2)
            det.quad([(ex[0], yt - 0.17, ex[1]), (ez[0], yt - 0.17, ez[1]), (ez[0], yt, ez[1]), (ex[0], yt, ex[1])], (rx, 0.0, rz), RISER)
            for sd, (s0, s1) in ((1, (A1, B1)), (-1, (A2, B2))):
                det.quad([(s0[0], yb_, s0[1]), (s1[0], yb_, s1[1]), (s1[0], yt, s1[1]), (s0[0], yt, s0[1])], (-uz * sd, 0.0, ux * sd), RISER)

    # --- fuentes con estatua ---
    stone_c = hexrgb(0xd9d3c3); water_c = hexrgb(0x4aa3d6); bronze_c = hexrgb(0x6b5a3a)
    for (fx, fz, R, sc, star, fid) in FOUNTAINS:
        if x0 <= fx < x1 and z0 <= fz < z1:
            lm_parts += fountain_at(fx, fz, float(hf(fx, fz)), R, sc, stone_c, water_c, bronze_c, star)
            lm_obst.append({"id": fid, "h": 4, "p": [[round(fx + (R + 0.2) * math.cos(a * math.pi / 8), 2), round(fz + (R + 0.2) * math.sin(a * math.pi / 8), 2)] for a in range(17)]})

    # --- castillo ---
    if x0 <= CASTLE_GUESS[0] < x1 and z0 <= CASTLE_GUESS[1] < z1:
        castle_parts, cobst = build_castle()
        lm_obst += cobst

    # --- mallas ---
    parts = []

    def add(name, geom, off, col, tint=False, uvfn=None):
        r = drape(geom, off, col, terrain_tint=tint, uvfn=uvfn)
        if r is not None: parts.append((name, r[0], r[1], r[2], r[3]))
    ground_g = land.intersection(tbox)
    if not roads_t.is_empty: ground_g = ground_g.difference(roads_t.buffer(0.02))            # el suelo no asoma por el asfalto (manchas grises)
    add("Ground", ground_g, 0.0, hexrgb(0xb7ad98), tint=True)
    add("Park", parks_t, 0.02, hexrgb(0x5f8a4a))
    add("Road", roads_t, 0.03, hexrgb(0x33363b))
    add("Sidewalk", walk_t, 0.12, hexrgb(0xd2cbb9))
    if not mosaic_t.is_empty:
        big = max(polys_of(unary_union(mosaic_geoms)), key=lambda g: g.area)
        mrr = big.minimum_rotated_rectangle; mc = list(mrr.exterior.coords)
        e1 = (mc[1][0] - mc[0][0], mc[1][1] - mc[0][1]); e2 = (mc[2][0] - mc[1][0], mc[2][1] - mc[1][1])
        ax = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2; al = math.hypot(*ax); ax = (ax[0] / al, ax[1] / al); pr = (-ax[1], ax[0])
        cx0, cz0 = mrr.centroid.x, mrr.centroid.y
        def muv(x, z):
            dx, dz = x - cx0, z - cz0
            return np.column_stack([(dx * pr[0] + dz * pr[1]) / 9.0, (dx * ax[0] + dz * ax[1]) / 9.0])   # franjas de lado a lado del paseo, como en la real
        add("Mosaic", mosaic_t, 0.05, hexrgb(0xffffff), uvfn=muv)
    for nm in ("Deck", "Struct", "Glow"):
        m_ = dk["parts"][nm]
        if m_ is not None: parts.append((nm, m_[0], m_[1], m_[2], None))
    crosswalks = []
    mk = road_marks(road_lines + dk["marks"], signals, x0, z0, x1, z1, crosswalks)
    if mk is not None: parts.append(("Marks", mk[0], mk[1], mk[2], None))
    cb = curbs(walk_t, roads_t, x0, z0, x1, z1)
    if cb is not None: parts.append(("Curb", cb[0], cb[1], cb[2], None))
    if not sea_free.is_empty:
        w = tri_mesh(sea_free, -0.45, hexrgb(0x1d6fa5))
        if w is not None: parts.append(("Water", np.asarray(w.vertices), np.asarray(w.faces), np.asarray(w.visual.vertex_colors), None))
    bm = boats_mesh(boats, -0.45) if boats else None
    if bm is not None: parts.append(("Boats", bm[0], bm[1], bm[2], None))
    nsigns = 0
    if G.get("POIS") and bl:
        sg = place_signs(G["POIS"], bl, roads_near, hf, (x0, z0, x1, z1))
        os.makedirs(OUT, exist_ok=True)
        sm = signs_mesh(sg, f"{OUT}/{tx}_{tz}_signs.jpg")
        if sm is not None:
            parts.append(("Signs", sm[0], sm[1], sm[2], sm[3])); nsigns = len(sg)
    if wv: parts.append(("Walls", np.array(wv), np.array(wf), np.array(wc), np.array(wu)))
    dm = det.out()
    if dm is not None: parts.append(("Detail", dm[0], dm[1], dm[2], None))
    if rv: parts.append(("Roofs", np.vstack(rv), np.vstack(rf), np.vstack(rc), None))
    if castle_parts:
        V, F, C = join_parts(castle_parts); parts.append(("Castle", V, F, C, None))
    if lm_parts:
        V, F, C = join_parts(lm_parts); parts.append(("Landmark", V, F, C, None))

    # --- superficie transitable (bits a 2 m) ---
    DC = 2.0; n = int(TILE / DC)
    _dp = [g_ for g_ in (roads_t, walk_t, mosaic_t, (dk["drive"].intersection(tbox) if dk["drive"] is not None else None)) if g_ is not None and not g_.is_empty]
    drive_geom = unary_union(_dp).buffer(0.5).difference(sea_free) if _dp else Polygon()
    gxs = x0 + (np.arange(n) + 0.5) * DC; gzs = z0 + (np.arange(n) + 0.5) * DC
    GX, GZ = np.meshgrid(gxs, gzs)
    if drive_geom.is_empty: okmask = np.zeros((n, n), dtype=bool)
    else:
        shapely.prepare(drive_geom)
        okmask = shapely.contains_xy(drive_geom, GX.ravel(), GZ.ravel()).reshape(n, n)
    bits = base64.b64encode(np.packbits(okmask.ravel()).tobytes()).decode()
    _wp = [g_ for g_ in (walk_t, mosaic_t) if g_ is not None and not g_.is_empty]
    walk_geom = unary_union(_wp).difference(roads_t.buffer(-0.2) if not roads_t.is_empty else Polygon()) if _wp else Polygon()
    if walk_geom.is_empty: wmask = np.zeros((n, n), dtype=bool)
    else:
        shapely.prepare(walk_geom)
        wmask = shapely.contains_xy(walk_geom, GX.ravel(), GZ.ravel()).reshape(n, n)
    wbits = base64.b64encode(np.packbits(wmask.ravel()).tobytes()).decode()

    # --- mar como obstáculo (subteselas de 150 m) ---
    sea_tiles = []
    if not sea_free.is_empty:
        T = 150
        for gx in range(x0, x1, T):
            for gz in range(z0, z1, T):
                part = sea_free.intersection(box(gx, gz, min(gx + T, x1), min(gz + T, z1)))
                for g in polys_of(part):
                    if g.area > 4: sea_tiles.append({"id": -1, "h": 0, "p": [[round(x, 2), round(z, 2)] for x, z in g.exterior.coords]})

    os.makedirs(OUT, exist_ok=True)
    name = f"{tx}_{tz}"
    has_content = bool(wv or not roads_t.is_empty or not parks_t.is_empty or not land.is_empty)
    for _try in range(8):                                    # Windows a veces rechaza la escritura un instante (antivirus / servidor de pruebas)
        try:
            write_glb(f"{OUT}/{name}.glb", parts); break
        except OSError:
            if _try == 7: raise
            time.sleep(1.5)
    json.dump({"tile": [tx, tz], "buildings": collid, "obstacles": tree_obst + sea_tiles + lm_obst + dk["obst"] + park_obst + wall_obst + poi_obst, "parked": parked, "special": special, "roads": roads_out, "cross": crosswalks, "trees": trees, "lamps": lamps, "decks": dk["decks"], "streets": streets,
               "drive": {"x0": x0, "z0": z0, "cell": DC, "nx": n, "nz": n, "bits": bits}, "walk": wbits}, open(f"{OUT}/{name}.json", "w"))
    ortho = 0
    src = f"{D}ortho_t/{name}.jpg"
    if os.path.exists(src) and not land.is_empty and (not roads_t.is_empty or wv):
        shutil.copyfile(src, f"{OUT}/{name}.jpg"); ortho = ortho_px(tx, tz)
    return {"tx": tx, "tz": tz, "glb": os.path.getsize(f"{OUT}/{name}.glb") // 1024, "buildings": len(collid), "trees": len(trees),
            "ortho": ortho, "styles": styles, "land": not land.is_empty, "signs": nsigns}


# ---------- hitos ----------
def landmark_extras(eid, poly, rh, ytop, lm_parts, road_lines):
    stone = hexrgb(LM_COL[eid]); cc = poly.centroid; ang = edge_angle_to(poly, PLAZA)
    if eid == LM_AYTO:
        for q in nearest_vertices(poly, PLAZA, 2):
            tx_, tz_ = toward_centroid(poly, q, 3.6)
            lm_parts += tower_at(tx_, tz_, float(rh.min()) - 0.5, ytop + 13.0, 6.6, ang, stone, hexrgb(0x2f6f9f), 9.0)
    elif eid == LM_CONCA:
        lm_parts.append(dome_at(cc.x, cc.y, ytop - 1.0, 11.0, 10.5, hexrgb(0x3a78b8)))
        q = nearest_vertices(poly, PLAZA, 1)[0]; tx_, tz_ = toward_centroid(poly, q, 4.5)
        lm_parts += tower_at(tx_, tz_, float(rh.min()) - 0.5, ytop + 14.0, 7.5, ang, stone, hexrgb(0xb2593a), 8.0)
    elif eid == LM_SMARIA:
        lm_parts.append(dome_at(cc.x, cc.y, ytop - 1.0, 7.5, 7.0, hexrgb(0xb2593a)))
        for q in nearest_vertices(poly, (150.0, -300.0), 2):
            tx_, tz_ = toward_centroid(poly, q, 3.8)
            lm_parts += tower_at(tx_, tz_, float(rh.min()) - 0.5, ytop + 10.0, 6.0, ang, stone, hexrgb(0xb2593a), 6.5)
    elif eid == LM_MERCAT:
        mr = poly.minimum_rotated_rectangle; mc = list(mr.exterior.coords)[:4]
        e1 = (mc[1][0] - mc[0][0], mc[1][1] - mc[0][1]); ang_m = -math.atan2(e1[1], e1[0])
        green = hexrgb(0x5f8f8a); cream = hexrgb(0xf1dea0)
        lm_parts.append(cyl_at(cc.x, cc.y, ytop - 0.5, ytop + 3.0, 7.5, hexrgb(0xe9d89a)))
        lm_parts.append(dome_at(cc.x, cc.y, ytop + 3.0, 7.5, 5.5, green))
        lm_parts.append(cyl_at(cc.x, cc.y, ytop + 8.0, ytop + 10.5, 1.0, cream, 12))
        lm_parts.append(dome_at(cc.x, cc.y, ytop + 10.5, 1.2, 1.6, green))
        for q in mc:
            tx_, tz_ = toward_centroid(poly, q, 3.5)
            lm_parts += tower_at(tx_, tz_, float(rh.min()) - 0.5, ytop + 5.0, 5.5, ang_m, cream, green, 6.0)
        best = None
        for r_ in road_lines:
            if r_["k"] not in ("primary", "secondary"): continue
            for (rx, rz) in r_["p"]:
                dd = math.hypot(rx - cc.x, rz - cc.y)
                if dd < 90 and (best is None or dd < best[0]): best = (dd, rx, rz)
        if best:
            pxy = (best[1], best[2]); be = None
            for a_, b_ in zip(mc, mc[1:] + mc[:1]):
                mid = ((a_[0] + b_[0]) / 2, (a_[1] + b_[1]) / 2); dd = math.hypot(mid[0] - pxy[0], mid[1] - pxy[1])
                if be is None or dd < be[0]: be = (dd, a_, b_, mid)
            _, a_, b_, mid = be
            dx, dz = b_[0] - a_[0], b_[1] - a_[1]; ll = math.hypot(dx, dz) or 1; dx, dz = dx / ll, dz / ll
            nx, nz = dz, -dx
            if nx * (pxy[0] - mid[0]) + nz * (pxy[1] - mid[1]) < 0: nx, nz = -nx, -nz
            angp = -math.atan2(dz, dx); gg = float(hf(mid[0], mid[1]))
            for sg in (-1, 1):
                lm_parts.append(box_at(mid[0] + dx * sg * 4.2 + nx * 0.7, mid[1] + dz * sg * 4.2 + nz * 0.7, gg - 0.3, gg + 9.5, 1.8, 2.4, angp, cream))
            lm_parts.append(box_at(mid[0] + nx * 0.7, mid[1] + nz * 0.7, gg + 9.5, gg + 12.5, 10.8, 2.4, angp, cream))
            lm_parts.append(box_at(mid[0] + nx * 0.2, mid[1] + nz * 0.2, gg - 0.3, gg + 9.5, 6.8, 0.6, angp, hexrgb(0x2b2622)))
    elif eid == LM_AUDIT:
        lm_parts.append(dome_at(cc.x, cc.y, ytop - 0.5, 7.0, 6.0, hexrgb(0xf4f1ea)))
    elif eid in LM_CHURCH or eid == LM_STATION:
        mr = poly.minimum_rotated_rectangle; mc = list(mr.exterior.coords)[:4]
        e1 = (mc[1][0] - mc[0][0], mc[1][1] - mc[0][1]); ang_m = -math.atan2(e1[1], e1[0])
        front = None                                    # arista de la huella más cercana a una calle
        for r_ in road_lines:
            if r_["k"] not in ("primary", "secondary", "tertiary", "residential", "pedestrian"): continue
            for (rx, rz) in r_["p"]:
                dd = math.hypot(rx - cc.x, rz - cc.y)
                if dd < 70 and (front is None or dd < front[0]): front = (dd, rx, rz)
        if front is not None:
            pxy = (front[1], front[2]); be = None
            for a_, b_ in zip(mc, mc[1:] + mc[:1]):
                mid = ((a_[0] + b_[0]) / 2, (a_[1] + b_[1]) / 2); dd = math.hypot(mid[0] - pxy[0], mid[1] - pxy[1])
                if be is None or dd < be[0]: be = (dd, a_, b_, mid)
            _, a_, b_, mid = be
        else:
            a_, b_ = mc[0], mc[1]; mid = ((a_[0] + b_[0]) / 2, (a_[1] + b_[1]) / 2)
        dx, dz = b_[0] - a_[0], b_[1] - a_[1]; ll = math.hypot(dx, dz) or 1; dx, dz = dx / ll, dz / ll
        nx, nz = dz, -dx
        if nx * (cc.x - mid[0]) + nz * (cc.y - mid[1]) < 0: nx, nz = -nx, -nz          # normal hacia el interior
        angp = -math.atan2(dz, dx); gg = float(hf(mid[0], mid[1])); stone = hexrgb(LM_COL[eid])
        if eid == LM_STATION:
            cream = hexrgb(0xf0e2bd); dark = hexrgb(0x2b2622)
            px_, pz_ = mid[0] + nx * 3.0, mid[1] + nz * 3.0
            lm_parts.append(box_at(px_, pz_, gg - 0.3, ytop + 7.0, 18.0, 7.0, angp, cream))          # cuerpo central avanzado
            lm_parts.append(box_at(px_ - nx * 3.6, pz_ - nz * 3.6, gg - 0.3, ytop + 7.5, 9.0, 0.7, angp, dark))   # portada oscura
            lm_parts.append(box_at(px_, pz_, ytop + 7.0, ytop + 8.4, 19.4, 8.4, angp, stone))        # cornisa
            lm_parts += tower_at(px_, pz_, ytop + 8.4, ytop + 17.5, 5.2, angp, stone, hexrgb(0xb2593a), 5.5)   # torre del reloj
            lm_parts.append(box_at(px_ - nx * 2.7, pz_ - nz * 2.7, ytop + 11.5, ytop + 14.5, 3.0, 0.3, angp, hexrgb(0xf7f4ec)))  # esfera
            for sg in (-1, 1):
                lm_parts += tower_at(mid[0] + dx * sg * 15.5 + nx * 2.5, mid[1] + dz * sg * 15.5 + nz * 2.5, gg - 0.3, ytop + 5.5, 5.0, angp, cream, hexrgb(0x8a8d90), 4.5)
        else:
            w = min(math.hypot(*e1), 30.0)
            tx_ = mid[0] + dx * (-w * 0.32) + nx * 3.2; tz_ = mid[1] + dz * (-w * 0.32) + nz * 3.2
            lm_parts += tower_at(tx_, tz_, gg - 0.5, ytop + 13.0, 5.6, angp, stone, hexrgb(0xb2593a), 7.5)
            lm_parts.append(dome_at(cc.x, cc.y, ytop - 0.5, max(3.0, min(5.5, w * 0.2)), max(2.5, min(4.5, w * 0.17)), hexrgb(0x5f8f8a) if eid != 86300369 else hexrgb(0x3a78b8)))


def build_castle():
    """Castillo de Santa Bárbara: murallas por tramos que siguen la pendiente, almenas, torres y torre del Homenaje."""
    HG, DXS, DZS = G["HG"], G["DXS"], G["DZS"]
    best = None
    for iz, zz in enumerate(DZS):
        for ix, xx in enumerate(DXS):
            if math.hypot(xx - CASTLE_GUESS[0], zz - CASTLE_GUESS[1]) <= 150 and (best is None or HG[iz, ix] > best[0]): best = (HG[iz, ix], xx, zz)
    hmax, sx0, sz0 = best
    cells = [box(xx - G["DST"] / 2, zz - G["DST"] / 2, xx + G["DST"] / 2, zz + G["DST"] / 2) for iz, zz in enumerate(DZS) for ix, xx in enumerate(DXS)
             if math.hypot(xx - sx0, zz - sz0) <= 230 and HG[iz, ix] >= hmax * 0.90]
    area = unary_union(cells).buffer(10).buffer(-10)
    if isinstance(area, MultiPolygon): area = max(area.geoms, key=lambda g: g.area)
    outer = area.simplify(4.0)
    parts, obst = [], []
    stone = hexrgb(0xcdb386); stone2 = hexrgb(0xc2a678); keepc = hexrgb(0xd9c398)
    dark = [168, 140, 100, 255]; lite = [214, 190, 146, 255]; ocre = [196, 164, 116, 255]
    ccw = outer.exterior.is_ccw
    perim = outer.exterior.length
    STEP = 3.0
    n = max(8, int(perim / STEP))
    P_ = [outer.exterior.interpolate(i * perim / n) for i in range(n)]
    gs = np.array([float(hf(p.x, p.y)) for p in P_])
    k = 4
    gsm = np.array([np.mean([gs[(i + j) % n] for j in range(-k, k + 1)]) for i in range(n)])      # cota suavizada: la coronación sigue la ladera sin escalones
    wm = _Mesh()
    for i in range(n):
        j = (i + 1) % n
        ax, az = P_[i].x, P_[i].y; bx, bz = P_[j].x, P_[j].y
        dx, dz = bx - ax, bz - az; L = math.hypot(dx, dz)
        if L < 0.2: continue
        tx_, tz_ = dx / L, dz / L
        nx_, nz_ = (tz_, -tx_) if ccw else (-tz_, tx_)          # hacia fuera
        ta, tb = gsm[i] + 7.0, gsm[j] + 7.0                      # coronación
        ya, yb = gs[i] - 3.0, gs[j] - 3.0                        # enterrado en la roca
        th = 1.1                                                 # grosor mitad
        want = (nx_, 0.0, nz_)
        def pt(x, z, y, d): return (x + nx_ * d, y, z + nz_ * d)
        mid_a = ya + (ta - ya) * 0.42; mid_b = yb + (tb - yb) * 0.42
        # cara exterior: zócalo oscuro y paño claro; la parte baja con talud
        wm.quad([pt(ax, az, ya, 1.3), pt(bx, bz, yb, 1.3), pt(bx, bz, mid_b, th), pt(ax, az, mid_a, th)], want, dark)
        wm.quad([pt(ax, az, mid_a, th), pt(bx, bz, mid_b, th), pt(bx, bz, tb, th), pt(ax, az, ta, th)], want, stone if i % 3 else lite)
        wm.quad([pt(ax, az, ya, -th), pt(bx, bz, yb, -th), pt(bx, bz, tb - 1.0, -th), pt(ax, az, ta - 1.0, -th)], (-nx_, 0.0, -nz_), stone2)
        wm.quad([pt(ax, az, ta, th), pt(bx, bz, tb, th), pt(bx, bz, tb, -th), pt(ax, az, ta, -th)], (0, 1, 0), ocre)           # adarve
        # parapeto interior y almenas
        wm.quad([pt(ax, az, ta - 1.0, -th), pt(bx, bz, tb - 1.0, -th), pt(bx, bz, tb + 0.6, -th), pt(ax, az, ta + 0.6, -th)], (-nx_, 0.0, -nz_), stone2)
        if i % 2 == 0:
            cxm, czm = (ax + bx) / 2 + nx_ * 0.75, (az + bz) / 2 + nz_ * 0.75; yy = (ta + tb) / 2
            parts.append(box_at(cxm, czm, yy, yy + 1.25, 1.3, 0.6, -math.atan2(tz_, tx_), lite))
    wv = wm.out()
    if wv is not None: parts.append(wv)
    # torres en los quiebros marcados y cada ~38 m
    since = 0.0
    for i in range(n):
        j = (i + 1) % n; h_ = (i - 1) % n
        a1 = math.atan2(P_[i].y - P_[h_].y, P_[i].x - P_[h_].x); a2 = math.atan2(P_[j].y - P_[i].y, P_[j].x - P_[i].x)
        turn = abs((a2 - a1 + math.pi) % (2 * math.pi) - math.pi)
        since += STEP
        if turn > 0.35 or since > 38:
            since = 0.0
            x, z = P_[i].x, P_[i].y; g = gs[i]; top = gsm[i] + 11.5; ang = -a2
            parts.append(box_at(x, z, g - 3.0, top, 5.8, 5.8, ang, stone2))
            parts.append(box_at(x, z, top, top + 1.2, 6.6, 6.6, ang, lite))
            for dxm, dzm in ((-2.7, -2.7), (2.7, -2.7), (2.7, 2.7), (-2.7, 2.7)):
                parts.append(box_at(x + dxm * math.cos(a2) - dzm * math.sin(a2), z + dxm * math.sin(a2) + dzm * math.cos(a2), top + 1.2, top + 2.3, 1.4, 1.4, ang, lite))
            if (i // 4) % 3 == 0: parts.append(pyramid_at(x, z, top + 1.2, 2.6, 3.2, hexrgb(0xb2593a), ang))
    rp = outer.representative_point(); hh = float(hf(rp.x, rp.y))
    parts.append(box_at(rp.x, rp.y, hh - 1.0, hh + 17.0, 11.0, 11.0, 0.3, keepc))
    parts.append(box_at(rp.x, rp.y, hh + 17.0, hh + 18.4, 12.2, 12.2, 0.3, stone))
    parts.append(box_at(rp.x, rp.y, hh + 18.4, hh + 22.0, 5.0, 5.0, 0.3, stone2))
    inner = outer.buffer(-16)
    if not inner.is_empty:
        pts_in = [(rp.x + 22, rp.y + 6), (rp.x - 24, rp.y - 8), (rp.x + 4, rp.y + 24), (rp.x - 8, rp.y - 26)]
        for qi, (qx, qz) in enumerate(pts_in):
            if not inner.contains(Point(qx, qz)): continue
            g = float(hf(qx, qz)); sz = 9 + (qi % 2) * 4
            parts.append(box_at(qx, qz, g - 1.0, g + 6.5, sz, sz * 0.7, 0.3 + qi * 0.5, stone2))
            parts.append(box_at(qx, qz, g + 6.5, g + 7.1, sz + 0.8, sz * 0.7 + 0.8, 0.3 + qi * 0.5, hexrgb(0xa85a3c)))
    obst.append({"id": -2, "h": 30, "p": [[round(x, 2), round(z, 2)] for x, z in outer.exterior.coords]})
    return parts, obst


def load_pois():
    f = D + "pois.json"
    G["POIS"] = json.load(open(f, encoding="utf-8")) if os.path.exists(f) else []
    fx = D + "pois_extra.json"                     # comercios que no están en OSM (a mano): {name, cat, lat, lng} o {x, z}
    if os.path.exists(fx):
        for q in json.load(open(fx, encoding="utf-8")):
            if "lat" in q: q["x"] = round((q["lng"] - LNG0) * KLNG, 1); q["z"] = round(-(q["lat"] - LAT0) * KLAT, 1)
            q.setdefault("sub", ""); G["POIS"].append(q)


SIGN_CAT = {"fuel": "fuel", "hospital": "hospital", "clinic": "hospital", "police": "police", "fire": "fire", "admin": "admin", "university": "edu", "bus": "transport",
            "train": "transport", "airport": "transport", "worship": "worship", "museum": "cult", "attraction": "cult", "culture": "cult", "hotel": "lodge",
            "stadium": "stadium", "mall": "market"}
LM_LABEL = {"fuel": "Gasolinera", "hospital": "Hospital", "clinic": "Clínica", "police": "Policía", "fire": "Bomberos", "admin": "Edificio público", "university": "Universidad",
            "bus": "Estación de autobuses", "worship": "Iglesia", "train": "Estación", "museum": "Museo", "attraction": "Lugar de interés", "hotel": "Hotel",
            "stadium": "Estadio", "airport": "Aeropuerto", "mall": "Centro comercial", "culture": "Cine / Teatro"}


def load_landmarks():
    """POI singulares de OSM (tools/pbf_landmarks.py): se dibujan con rótulo grande en su fachada y, gasolineras y hospitales, con modelo propio."""
    G["LANDMARKS"] = []; G["STADIUMS"] = []
    f = D + "landmarks.json"
    if not os.path.exists(f): return
    for lm in json.load(open(f, encoding="utf-8")):
        G["LANDMARKS"].append(lm)
        if lm["cat"] == "stadium" and lm.get("poly") and len(lm["poly"]) >= 4:
            try:
                sp_ = Polygon(lm["poly"]).buffer(0)
                if isinstance(sp_, Polygon) and sp_.area >= 3000: G["STADIUMS"].append(sp_)
            except Exception: pass
        q = {"x": lm["x"], "z": lm["z"], "name": lm["name"] or LM_LABEL.get(lm["cat"], ""), "cat": SIGN_CAT.get(lm["cat"], "serv"), "sub": ""}
        if lm.get("poly"):                                    # puntos del perímetro (cada ~9 m) por si el centro cae lejos de la fachada
            pl = lm["poly"]; alts = []
            for i in range(len(pl) - 1):
                (ax, az), (bx, bz) = pl[i], pl[i + 1]; n = max(1, int(math.hypot(bx - ax, bz - az) // 9))
                for k in range(n): alts.append([ax + (bx - ax) * (k + 0.5) / n, az + (bz - az) * (k + 0.5) / n])
            q["alts"] = alts[:40]
        if not q["name"]: continue
        G["POIS"].append(q)


def init():
    load_dem(); load_catastro(); load_pois(); load_landmarks(); G["SEA"] = build_sea()


def main():
    todo = tiles()
    if len(sys.argv) > 1:
        todo = [tuple(int(v) for v in a.split(",")) for a in sys.argv[1:]]
    os.makedirs(OUT, exist_ok=True)
    with Pool(processes=min(3, os.cpu_count() or 2), initializer=init) as pool:
        res = []
        for r in pool.imap_unordered(build_tile, todo):
            res.append(r); print(f"tesela {r['tx']}_{r['tz']}: glb {r['glb']} KB, edificios {r['buildings']}, árboles {r['trees']}, ortofoto {r['ortho']}px", flush=True)
    # manifiesto y relieve global
    prev = {}
    mf = "public/world/manifest.json"
    if os.path.exists(mf) and len(sys.argv) > 1:
        prev = {(t["tx"], t["tz"]): t for t in json.load(open(mf))["tiles"]}
    for r in res:
        prev[(r["tx"], r["tz"])] = {"tx": r["tx"], "tz": r["tz"], "ortho": r["ortho"], "land": r["land"], "signs": r["signs"]}
    load_dem()
    d = {"x0": G["DX0"], "z0": G["DZ0"], "step": G["DST"], "nx": len(G["DXS"]), "nz": len(G["DZS"]), "h": [round(float(v), 1) for v in G["HG"].reshape(-1)]}
    json.dump(d, open("public/world/dem.json", "w"))
    json.dump({"tile": TILE, "tx": [TX_RANGE.start, TX_RANGE.stop - 1], "tz": [TZ_RANGE.start, TZ_RANGE.stop - 1], "tiles": sorted(prev.values(), key=lambda t: (t["tz"], t["tx"]))},
              open(mf, "w"))
    print("OK", len(prev), "teselas")


if __name__ == "__main__":
    main()
