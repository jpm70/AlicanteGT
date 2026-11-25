"""OSM -> public/world/alicante.glb  (+ colliders.json)

Coordenadas locales en metros: x = este, y = arriba, z = sur (convenio Three.js, -z = norte).

Origen = Explanada. Capas del GLB: Ground, Road, Sidewalk, Buildings."""

import json, math, os, hashlib

import numpy as np, trimesh

from shapely.geometry import Polygon, LineString, MultiPolygon, Point, box

from shapely.ops import unary_union

from shapely import make_valid


LAT0, LNG0 = 38.3432, -0.4820

KLAT = 111320.0; KLNG = 111320.0 * math.cos(math.radians(LAT0))

def P(pt): return ((pt["lon"] - LNG0) * KLNG, -(pt["lat"] - LAT0) * KLAT)   # (x, z)

D = "tools/data/"

def load(n):
    f = D + f"osm_{n}.json"
    return json.load(open(f)) if os.path.exists(f) else []


ROAD_W = {"motorway":12,"trunk":11,"primary":10,"secondary":8.5,"tertiary":7.5,"residential":6.2,
          "unclassified":6.2,"living_street":5.2,"service":4.2,"primary_link":6,"secondary_link":5.5,"tertiary_link":5}

WALK_W = {"footway":2.4,"pedestrian":6.0,"path":2.0,"cycleway":2.5,"steps":2.0,"track":3.0}


def hexrgb(h): return [(h>>16)&255,(h>>8)&255,h&255,255]

def tri_mesh(geom, y, color):
    meshes = []
    polys = [geom] if isinstance(geom, Polygon) else [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    for p in polys:
        if p.is_empty or p.area < 0.5: continue
        try:
            v, f = trimesh.creation.triangulate_polygon(p, engine="earcut")
        except Exception: continue
        m = trimesh.Trimesh(np.column_stack([v[:,0], np.full(len(v), y), v[:,1]]), f[:, ::-1], process=False)
        m.visual.vertex_colors = np.tile(color, (len(v),1)); meshes.append(m)
    return trimesh.util.concatenate(meshes) if meshes else None


# ---- relieve (EU-DEM 25 m, tools/fetch_dem.py)
_d = json.load(open(D + "dem.json"))
DX0, DZ0, DST = _d["x0"], _d["z0"], _d["step"]
DXS = list(range(_d["x0"], _d["x1"] + 1, DST)); DZS = list(range(_d["z0"], _d["z1"] + 1, DST))
HG = np.array([[(_d["h"].get(f"{x},{z}") or 0.0) for x in DXS] for z in DZS], dtype=float)
HG = np.maximum(HG, 0.0)
def _smooth(a):
    b = np.pad(a, 1, mode="edge"); return sum(b[i:i+a.shape[0], j:j+a.shape[1]] for i in range(3) for j in range(3)) / 9.0
HG = _smooth(HG)
def hf(x, z):
    x = np.asarray(x, dtype=float); z = np.asarray(z, dtype=float)
    gx = np.clip((x - DX0) / DST, 0, len(DXS) - 1.001); gz = np.clip((z - DZ0) / DST, 0, len(DZS) - 1.001)
    ix = gx.astype(int); iz = gz.astype(int); fx = gx - ix; fz = gz - iz
    return (HG[iz, ix]*(1-fx)*(1-fz) + HG[iz, ix+1]*fx*(1-fz) + HG[iz+1, ix]*(1-fx)*fz + HG[iz+1, ix+1]*fx*fz)

def lerp_col(c0, c1, t):
    t = np.clip(t, 0, 1)[:, None]; return (np.array(c0)[None, :] * (1 - t) + np.array(c1)[None, :] * t)

CELL = 25
def drape(geom, off, color, terrain_tint=False, uvfn=None):
    """Recorta la geometría en celdas del DEM y levanta cada vértice a la altura del terreno (sin grietas)."""
    from shapely import STRtree
    if geom is None or geom.is_empty: return None
    polys = [geom] if isinstance(geom, Polygon) else [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    if not polys: return None
    tree = STRtree(polys)
    bx0, bz0, bx1, bz1 = geom.bounds
    V, F, C, U = [], [], [], []
    for gx in range(int(math.floor(bx0 / CELL)) * CELL, int(math.ceil(bx1 / CELL)) * CELL, CELL):
        for gz in range(int(math.floor(bz0 / CELL)) * CELL, int(math.ceil(bz1 / CELL)) * CELL, CELL):
            cell = box(gx, gz, gx + CELL, gz + CELL)
            for i in tree.query(cell):
                piece = polys[i].intersection(cell)
                for q in ([piece] if isinstance(piece, Polygon) else [g for g in getattr(piece, "geoms", []) if isinstance(g, Polygon)]):
                    if q.is_empty or q.area < 0.05: continue
                    try: v, f = trimesh.creation.triangulate_polygon(q, engine="earcut")
                    except Exception: continue
                    y = hf(v[:, 0], v[:, 1]) + off
                    base = sum(len(a) for a in V)
                    V.append(np.column_stack([v[:, 0], y, v[:, 1]])); F.append(f[:, ::-1] + base)
                    if terrain_tint:
                        col = lerp_col(color, hexrgb(0x8f7f5c), (y - 6) / 70.0)
                        C.append(np.column_stack([col, np.full(len(v), 255)]))
                    else:
                        C.append(np.tile(color, (len(v), 1)))
                    if uvfn is not None: U.append(uvfn(v[:, 0], v[:, 1]))
    if not V: return None
    return np.vstack(V), np.vstack(F), np.vstack(C).astype(np.uint8), (np.vstack(U) if U else None)

def ways(els): return [e for e in els if e.get("type")=="way" and len(e.get("geometry",[]))>=2]


# ---- calzadas y aceras/peatonal

hw = ways(load("highway"))

road_geoms, walk_geoms, road_lines = [], [], []

for e in hw:
    t = e["tags"]; k = t.get("highway"); pts = [P(p) for p in e["geometry"]]
    if t.get("area")=="yes" or t.get("tunnel") in ("yes","building_passage"): continue
    if k in ROAD_W:
        w = float(str(t.get("width","0")).split()[0] or 0) if str(t.get("width","")).replace(".","").isdigit() else 0
        if not w: w = max(ROAD_W[k], int(t["lanes"])*3.2 if str(t.get("lanes","")).isdigit() else 0)
        road_geoms.append(LineString(pts).buffer(w/2, cap_style=2, join_style=1)); road_lines.append({"k":k,"w":w,"p":[[round(x,2),round(z,2)] for x,z in pts]})
    elif k in WALK_W:
        walk_geoms.append(LineString(pts).buffer(WALK_W[k]/2, cap_style=2, join_style=1))

plaza_geoms, mosaic_geoms = [], []
for e in hw:
    t = e["tags"]; pts = [P(p) for p in e["geometry"]]
    if t.get("area") == "yes" and t.get("highway") in ("pedestrian", "footway") and len(pts) >= 4 and pts[0] == pts[-1]:
        try: g = make_valid(Polygon(pts)).buffer(0)
        except Exception: continue
        (mosaic_geoms if "esplanada" in (t.get("name","")).lower() else plaza_geoms).append(g)
roads = unary_union(road_geoms) if road_geoms else Polygon()

walk = unary_union(walk_geoms).difference(roads) if walk_geoms else Polygon()

# acera a ambos lados de calzadas urbanas (1.8 m)

sidew = unary_union([g.buffer(1.8) for g in road_geoms]).difference(roads) if road_geoms else Polygon()

mosaic = unary_union(mosaic_geoms).difference(roads) if mosaic_geoms else Polygon()
walk = unary_union([walk, sidew] + plaza_geoms).difference(mosaic)



# ---- hitos: primitivas y tabla por id de OSM
def _vc(V, col):
    return np.tile(col, (len(V), 1))

def box_at(cx, cz, ybase, ytop, sx, sz, ang, col):
    b = trimesh.creation.box(extents=[sx, ytop - ybase, sz])
    R = trimesh.transformations.rotation_matrix(ang, [0, 1, 0]); b.apply_transform(R)
    b.apply_translation([cx, (ybase + ytop) / 2, cz])
    V = np.asarray(b.vertices); return V, np.asarray(b.faces), _vc(V, col)

def dome_at(cx, cz, y, r, hr, col):
    m = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    keep = m.vertices[m.faces].mean(axis=1)[:, 1] > -0.05          # solo la mitad superior (cúpula)
    F = m.faces[keep]; used = np.unique(F); remap = -np.ones(len(m.vertices), dtype=int); remap[used] = np.arange(len(used))
    V = np.asarray(m.vertices)[used] * np.array([r, hr, r]) + np.array([cx, y, cz])
    return V, remap[F], _vc(V, col)

def pyramid_at(cx, cz, y, half, h, col, ang=0.0):
    m = trimesh.creation.cone(radius=half * 1.4142, height=h, sections=4)
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    m.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 4 + ang, [0, 1, 0]))
    m.apply_translation([cx, y, cz])
    V = np.asarray(m.vertices); return V, np.asarray(m.faces), _vc(V, col)

def tower_at(cx, cz, ybase, ytop, size, ang, wallc, capc, caph):
    return [box_at(cx, cz, ybase, ytop, size, size, ang, wallc),
            box_at(cx, cz, ytop, ytop + 0.9, size + 1.0, size + 1.0, ang, wallc),
            pyramid_at(cx, cz, ytop + 0.9, (size + 0.6) / 2, caph, capc, ang)]

def nearest_vertices(poly, pt, k=2):
    pts = list(poly.exterior.coords)[:-1]
    pts.sort(key=lambda q: math.hypot(q[0] - pt[0], q[1] - pt[1])); return pts[:k]

def toward_centroid(poly, q, d):
    c = poly.centroid; vx, vz = c.x - q[0], c.y - q[1]; l = math.hypot(vx, vz) or 1
    return q[0] + vx / l * d, q[1] + vz / l * d

def edge_angle_to(poly, pt):
    pts = list(poly.exterior.coords); best = None
    for a, b in zip(pts[:-1], pts[1:]):
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2; d = math.hypot(mx - pt[0], mz - pt[1])
        if best is None or d < best[0]: best = (d, -math.atan2(b[1] - a[1], b[0] - a[0]))
    return best[1]

PLAZA = (82.0, -195.0)            # Plaza del Ayuntamiento
SANTA_CRUZ = (-110.0, -470.0, 135.0)   # barrio de Santa Cruz (cx, cz, radio)
LM_AYTO, LM_CONCA, LM_SMARIA, LM_MERCAT, LM_AUDIT, LM_SOL = 265207919, 83998999, 22560738, 21410214, 515871894, 53271502
LM_COL = {LM_AYTO: 0xe3b48f, LM_CONCA: 0xe6dcc3, LM_SMARIA: 0xe0b685, LM_MERCAT: 0xf1dea0, LM_AUDIT: 0xf4f1ea,
          22561001: 0xe0b685, 156992115: 0xe7b8a8, 33197578: 0xf2ecde, 22588102: 0xf3f3f1}
SC_COLS = [0xfaf8f2, 0xfaf8f2, 0xf3efe4, 0xf7efd9, 0xdbe8f2, 0xf2dcc6, 0xfaf8f2, 0xe9d2a4]
lm_parts = []

# ---- edificios: muros con UV de fachada (u = tramos de 3,2 m + 1000*estilo, v = plantas de 3,1 m) y tejados aparte

BAY, FLOOR = 3.2, 3.1

collid = []

WALL_COLS = [0xf1e9d6,0xe8d9b8,0xf6efe0,0xe3c9a0,0xf4e4c1,0xdcb89a,0xefd7c4,0xfaf6ec,0xe9c58a,0xd9a78a,0xf0e2a8,0xc9d3d6]

ROOF_COLS = [0xa85a3c,0x9c5238,0x8a8d90,0xb4684a,0x7d7f82]

wv, wf, wc, wu = [], [], [], []   # muros

rv, rf, rc = [], [], []           # tejados

nwv = 0

def style_for(levels, seed):
    if levels >= 8: return 3
    if levels <= 3: return 2 if seed % 3 else 0
    return 0 if seed % 5 else 1

styles_count = [0,0,0,0]

# ---- Catastro INSPIRE (tools/fetch_catastro.py): plantas por volumen, año y uso
from collections import Counter
from shapely import STRtree as _STRtree
CAT_PATH = D + "catastro_piloto.json"
CAT_POLYS, CAT_META, CAT_B, CAT_TREE = [], [], {}, None
if os.path.exists(CAT_PATH):
    _cat = json.load(open(CAT_PATH)); CAT_B = _cat["buildings"]
    for _p in _cat["parts"]:
        for _rings in _p["polys"]:
            try: _g = Polygon(_rings[0], _rings[1:]).buffer(0)
            except Exception: continue
            if not _g.is_empty and _g.area > 0.5: CAT_POLYS.append(_g); CAT_META.append((_p["floors"], _p["ref"]))
    CAT_TREE = _STRtree(CAT_POLYS)
    print("catastro: partes", len(CAT_POLYS), "edificios", len(CAT_B))

def _polys_of(g):
    return [g] if isinstance(g, Polygon) else [x for x in getattr(g, "geoms", []) if isinstance(x, Polygon)]

def cat_pieces(poly):
    """Trocea la huella OSM en volúmenes con las plantas del Catastro. [(poly, plantas|None, año|None, uso|None)]"""
    none = [(poly, None, None, None)]
    if CAT_TREE is None: return none
    groups = {}; covered = 0.0; yrs = Counter(); uses = Counter()
    for i in CAT_TREE.query(poly):
        fl = CAT_META[i][0]
        if not fl: continue
        inter = poly.intersection(CAT_POLYS[i]); ar = inter.area
        if ar < 1.0: continue
        groups.setdefault(fl, []).append(inter); covered += ar
        bi = CAT_B.get(CAT_META[i][1])
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
        for sub in _polys_of(g):
            if sub.area >= 8: pieces.append((sub.simplify(0.2), fl, year, use))
        used = unary_union([used, g])
    for sub in _polys_of(poly.difference(used).buffer(0)):
        if sub.area >= 8: pieces.append((sub.simplify(0.2), dom, year, use))
    return pieces or [(poly, dom, year, use)]

OLD_COLS = [0xf1e9d6,0xe8d9b8,0xf6efe0,0xe3c9a0,0xf4e4c1,0xdcb89a,0xefd7c4,0xe9c58a,0xd9a78a,0xf0e2a8]
MID_COLS = [0xece8dc,0xe3ded0,0xd9d3c3,0xf3efe6,0xdcd6c6,0xe8dfc9]
NEW_COLS = [0xf4f4f2,0xe6e8ea,0xd7dbdd,0xefe9de,0xc9cfd2,0xf8f6f0]

def style_by_cat(fl, year, use):
    if use and not use.startswith("1_"): return 1
    if not year: return None
    if year < 1940: return 0 if fl >= 4 else 2
    if year < 1985: return 3 if fl >= 5 else 0
    return 1

def emit_ring(coords, ccw_outward, h_top_fn, st, levels_f, col, ytop):
    """Muros verticales sobre el terreno para un anillo; devuelve nada (acumula en wv/wf/wc/wu)."""
    global nwv
    ring = list(coords); rh_ = hf([c[0] for c in ring], [c[1] for c in ring]); s_acc = 0.0
    for ri, ((x1, z1), (x2, z2)) in enumerate(zip(ring[:-1], ring[1:])):
        yb1 = float(rh_[ri]) - 0.4; yb2 = float(rh_[ri + 1]) - 0.4
        L = math.hypot(x2 - x1, z2 - z1)
        if L < 0.05: continue
        u1 = s_acc / BAY + st * 1000; u2 = (s_acc + L) / BAY + st * 1000; s_acc += L
        tri = [[0, 2, 1], [0, 3, 2]] if ccw_outward else [[0, 1, 2], [0, 2, 3]]
        base = nwv; nwv += 4
        wv.extend([[x1, yb1, z1], [x2, yb2, z2], [x2, ytop, z2], [x1, ytop, z1]])
        wu.extend([[u1, (yb1 - ytop) / FLOOR + levels_f], [u2, (yb2 - ytop) / FLOOR + levels_f], [u2, levels_f], [u1, levels_f]])
        wc.extend([col] * 4)
        wf.extend([[base + i for i in f] for f in tri])

for e in ways(load("building")):
    pts = [P(p) for p in e["geometry"]]
    if len(pts) < 4: continue
    try: poly0 = make_valid(Polygon(pts))
    except Exception: continue
    if isinstance(poly0, MultiPolygon): poly0 = max(poly0.geoms, key=lambda g: g.area)
    if not isinstance(poly0, Polygon) or poly0.area < 6: continue
    poly0 = poly0.buffer(0).simplify(0.15)
    if poly0.is_empty or not isinstance(poly0, Polygon): continue
    if not mosaic.is_empty and mosaic.contains(poly0.centroid): continue   # no tapar el mosaico de la Explanada
    t = e["tags"]; lv = t.get("building:levels")
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
        styles_count[st] += 1
        rcol = hexrgb(ROOF_COLS[(seed >> 4) % len(ROOF_COLS)])
        _c = poly.centroid
        if e["id"] in LM_COL: col = hexrgb(LM_COL[e["id"]])
        elif math.hypot(_c.x - SANTA_CRUZ[0], _c.y - SANTA_CRUZ[1]) < SANTA_CRUZ[2]:
            col = hexrgb(SC_COLS[seed % len(SC_COLS)]); st = 2
        if e["id"] == LM_SOL: st = 1

        ext = list(poly.exterior.coords)
        rh = hf([c[0] for c in ext], [c[1] for c in ext]); ytop = float(rh.max()) + h
        emit_ring(ext, poly.exterior.is_ccw, None, st, levels_f, col, ytop)
        for hole in poly.interiors:     # patios: muros hacia el interior del hueco
            emit_ring(list(hole.coords), not hole.is_ccw, None, st, levels_f, col, ytop)
        rm = tri_mesh(poly, ytop, rcol)
        if rm is not None:
            base = sum(len(x) for x in rv)
            rv.append(np.asarray(rm.vertices)); rf.append(np.asarray(rm.faces) + base); rc.append(np.asarray(rm.visual.vertex_colors))
        if e["id"] in (LM_AYTO, LM_CONCA, LM_SMARIA, LM_MERCAT, LM_AUDIT) and pi == 0:
            stone = hexrgb(LM_COL[e["id"]]); cc = poly.centroid; ang = edge_angle_to(poly, PLAZA)
            if e["id"] == LM_AYTO:
                for q in nearest_vertices(poly, PLAZA, 2):
                    tx, tz = toward_centroid(poly, q, 3.6)
                    lm_parts += tower_at(tx, tz, float(rh.min()) - 0.5, ytop + 13.0, 6.6, ang, stone, hexrgb(0x2f6f9f), 9.0)
            elif e["id"] == LM_CONCA:
                lm_parts.append(dome_at(cc.x, cc.y, ytop - 1.0, 11.0, 10.5, hexrgb(0x3a78b8)))
                q = nearest_vertices(poly, PLAZA, 1)[0]; tx, tz = toward_centroid(poly, q, 4.5)
                lm_parts += tower_at(tx, tz, float(rh.min()) - 0.5, ytop + 14.0, 7.5, ang, stone, hexrgb(0xb2593a), 8.0)
            elif e["id"] == LM_SMARIA:
                lm_parts.append(dome_at(cc.x, cc.y, ytop - 1.0, 7.5, 7.0, hexrgb(0xb2593a)))
                for q in nearest_vertices(poly, (150.0, -300.0), 2):
                    tx, tz = toward_centroid(poly, q, 3.8)
                    lm_parts += tower_at(tx, tz, float(rh.min()) - 0.5, ytop + 10.0, 6.0, ang, stone, hexrgb(0xb2593a), 6.5)
            elif e["id"] == LM_MERCAT:
                lm_parts.append(dome_at(cc.x, cc.y, ytop - 0.5, 9.0, 5.5, hexrgb(0x7e9a8e)))
            elif e["id"] == LM_AUDIT:
                lm_parts.append(dome_at(cc.x, cc.y, ytop - 0.5, 7.0, 6.0, hexrgb(0xf4f1ea)))
        collid.append({"id": e["id"], "h": round(h, 1), "p": [[round(x, 2), round(z, 2)] for x, z in poly.exterior.coords]})

print("estilos de fachada", styles_count)


# ---- costa -> mar (OSM: tierra a la izquierda, mar a la derecha del sentido de la línea)

def chain_coast():
    ws = [e for e in load("coast") if e.get("tags",{}).get("natural")=="coastline" and len(e.get("geometry",[]))>=2]
    key = lambda pt: (round(pt["lat"],7), round(pt["lon"],7))
    by_start = {key(e["geometry"][0]): e for e in ws}
    ends = {key(e["geometry"][-1]) for e in ws}
    start = [e for e in ws if key(e["geometry"][0]) not in ends]
    if not start: return []
    pts, cur, seen = [], start[0], set()
    while cur and cur["id"] not in seen:
        seen.add(cur["id"]); pts += [P(p) for p in cur["geometry"]]
        cur = by_start.get(key(cur["geometry"][-1]))
    return pts

coast = chain_coast()

sea = Polygon()

if len(coast) > 2:
    def right(a, b, d=4000):
        dx, dz = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dz) or 1
        # sentido x este, z sur: "derecha" del trayecto = (-dz, dx)·(-1)... se comprueba abajo
        return (-dz/l*d, dx/l*d)
    r0 = right(coast[0], coast[1]); r1 = right(coast[-2], coast[-1])
    cand = Polygon(coast + [(coast[-1][0]+r1[0], coast[-1][1]+r1[1]), (coast[0][0]+r0[0], coast[0][1]+r0[1])])
    # el mar debe contener un punto claramente al SE de la Explanada (playa/puerto lado mar)
    probe = Polygon(cand).buffer(0)
    if not probe.contains(__import__("shapely.geometry",fromlist=["Point"]).Point(-300, 300)):
        r0 = (-r0[0], -r0[1]); r1 = (-r1[0], -r1[1])
        probe = Polygon(coast + [(coast[-1][0]+r1[0], coast[-1][1]+r1[1]), (coast[0][0]+r0[0], coast[0][1]+r0[1])]).buffer(0)
    sea = probe

EXT = box(-1700, -1100, 900, 900)

sea = sea.intersection(EXT) if not sea.is_empty else sea


# muelles/espigones: tierra firme sobre el mar

pier_geoms = []

for e in ways(load("pier")):
    pts = [P(p) for p in e["geometry"]]
    try: pier_geoms.append(Polygon(pts).buffer(0) if pts[0]==pts[-1] and len(pts)>3 else LineString(pts).buffer(3.5, cap_style=2))
    except Exception: pass

piers = unary_union(pier_geoms) if pier_geoms else Polygon()

sea_free = sea.difference(piers.buffer(0.2)) if not sea.is_empty else sea


# parques / jardines

park_geoms = []

for e in ways(load("parks")):
    pts = [P(p) for p in e["geometry"]]
    if len(pts) >= 4 and pts[0] == pts[-1]:
        try: park_geoms.append(make_valid(Polygon(pts)).buffer(0))
        except Exception: pass

parks = unary_union(park_geoms).difference(roads).difference(sea_free) if park_geoms else Polygon()


# árboles (OSM) -> colliders.json; palmeras si lo indica el etiquetado

trees = []

for e in load("trees"):
    if e.get("type") != "node": continue
    t = e.get("tags", {}); x, z = P(e)
    sp = (t.get("species","") + t.get("genus","") + t.get("species:en","")).lower()
    palm = t.get("leaf_type") == "palm_leaved" or "phoenix" in sp or "washingtonia" in sp or "palm" in sp
    trees.append([round(x,2), round(z,2), 1 if palm else 0])

tree_obst = []

for x, z, _ in trees:
    tree_obst.append({"id":0,"h":4,"p":[[round(x+0.4*math.cos(a*math.pi/4),2), round(z+0.4*math.sin(a*math.pi/4),2)] for a in range(9)]})


lamps = []

for e in load("lamps"):
    if e.get("type") == "node":
        x, z = P(e); lamps.append([round(x,2), round(z,2), 1 if e.get("tags",{}).get("highway")=="traffic_signals" else 0])


# ---- suelo

land = EXT.difference(sea) if not sea.is_empty else EXT

land = unary_union([land, piers.intersection(EXT)])


# ---- superficie transitable (calzada + aceras + plazas + Explanada), rasterizada a 2 m y empaquetada en bits
import base64, shapely
drive_geom = unary_union([roads, walk, mosaic]).difference(sea_free).buffer(0.5)
DC = 2.0
dx0, dz0, dx1, dz1 = -1700, -1100, 900, 900
dnx, dnz = int((dx1 - dx0) / DC), int((dz1 - dz0) / DC)
gxs = dx0 + (np.arange(dnx) + 0.5) * DC; gzs = dz0 + (np.arange(dnz) + 0.5) * DC
GX, GZ = np.meshgrid(gxs, gzs)
shapely.prepare(drive_geom)
okmask = shapely.contains_xy(drive_geom, GX.ravel(), GZ.ravel()).reshape(dnz, dnx)
drive_b64 = base64.b64encode(np.packbits(okmask.ravel()).tobytes()).decode()
print("transitable %.1f%% del area, bits KB %d" % (100 * okmask.mean(), len(drive_b64) // 1024))

parts = []   # (nombre, V, F, C, UV|None)
def add(name, geom, off, col, tint=False, uvfn=None):
    r = drape(geom, off, col, terrain_tint=tint, uvfn=uvfn)
    if r is not None: parts.append((name, r[0], r[1], r[2], r[3]))
add("Ground", land, 0.0, hexrgb(0xb7ad98), tint=True)
add("Park", parks, 0.02, hexrgb(0x5f8a4a))
add("Road", roads.difference(sea_free), 0.03, hexrgb(0x3a3d42))
add("Sidewalk", walk.difference(sea_free), 0.06, hexrgb(0xc9c0ab))
# Explanada: mosaico ondulado; UV alineada al eje largo del paseo
if not mosaic.is_empty:
    mrr = mosaic.minimum_rotated_rectangle; mc = list(mrr.exterior.coords)
    e1 = (mc[1][0]-mc[0][0], mc[1][1]-mc[0][1]); e2 = (mc[2][0]-mc[1][0], mc[2][1]-mc[1][1])
    ax = e1 if math.hypot(*e1) >= math.hypot(*e2) else e2; al = math.hypot(*ax); ax = (ax[0]/al, ax[1]/al); pr = (-ax[1], ax[0])
    cx0, cz0 = mrr.centroid.x, mrr.centroid.y
    def muv(x, z):
        dx, dz = x - cx0, z - cz0
        return np.column_stack([(dx*ax[0] + dz*ax[1]) / 9.0, (dx*pr[0] + dz*pr[1]) / 9.0])
    add("Mosaic", mosaic.difference(sea_free), 0.07, hexrgb(0xffffff), uvfn=muv)
add("Water", sea_free if not sea_free.is_empty else Polygon(), 0.0, hexrgb(0x1d6fa5)) if False else None
_w = tri_mesh(sea_free if not sea_free.is_empty else Polygon(), -0.45, hexrgb(0x1d6fa5))
if _w is not None: parts.append(("Water", np.asarray(_w.vertices), np.asarray(_w.faces), np.asarray(_w.visual.vertex_colors), None))

# ---- Castillo de Santa Bárbara (Benacantil): murallas sobre la cota alta del DEM, torres y torre del Homenaje
def box_at(cx, cz, ybase, ytop, sx, sz, ang, col):
    b = trimesh.creation.box(extents=[sx, ytop - ybase, sz])
    R = trimesh.transformations.rotation_matrix(ang, [0, 1, 0]); b.apply_transform(R)
    b.apply_translation([cx, (ybase + ytop) / 2, cz])
    return np.asarray(b.vertices), np.asarray(b.faces), np.tile(col, (len(b.vertices), 1))

castle_parts = []   # (V, F, C)
castle_obst = []
try:
    iz0, ix0 = np.unravel_index(HG.argmax(), HG.shape)
    sx0, sz0 = DXS[ix0], DZS[iz0]; hmax = HG[iz0, ix0]
    cells = []
    for iz, zz in enumerate(DZS):
        for ix, xx in enumerate(DXS):
            if math.hypot(xx - sx0, zz - sz0) <= 230 and HG[iz, ix] >= hmax * 0.90:
                cells.append(box(xx - 12.5, zz - 12.5, xx + 12.5, zz + 12.5))
    area = unary_union(cells).buffer(10).buffer(-10)
    if isinstance(area, MultiPolygon): area = max(area.geoms, key=lambda g: g.area)
    outer = area.simplify(4.0)
    if outer.area < 2500:
        from shapely import affinity
        outer = affinity.rotate(affinity.scale(Point(sx0, sz0).buffer(1), 70, 32), 20)
    ring = list(outer.exterior.coords)
    rh_c = hf([c[0] for c in ring], [c[1] for c in ring])
    ybase = float(rh_c.min()) - 3.0; ytop_w = float(rh_c.max()) + 7.0
    stone = hexrgb(0xcdb386); stone2 = hexrgb(0xc2a678); keepc = hexrgb(0xd9c398)
    perim = outer.exterior.length
    segs = max(1, int(perim / 4.0))
    for i in range(segs):
        pa = outer.exterior.interpolate(i * perim / segs); pb = outer.exterior.interpolate((i + 1) * perim / segs)
        ha, hb = float(hf(pa.x, pa.y)), float(hf(pb.x, pb.y)); hm = (ha + hb) / 2
        L = math.hypot(pb.x - pa.x, pb.y - pa.y)
        if L < 0.2: continue
        ang = -math.atan2(pb.y - pa.y, pb.x - pa.x)
        castle_parts.append(box_at((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, min(ha, hb) - 2.5, hm + 6.0, L + 0.25, 2.2, ang, stone))
        for k in (0.25, 0.75):   # almenas
            castle_parts.append(box_at(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k, hm + 6.0, hm + 7.2, 1.4, 2.3, ang, stone))
    # torres cuadradas cada ~45 m, a la altura local del terreno
    last = None
    for (x, z) in ring[:-1]:
        if last is None or math.hypot(x - last[0], z - last[1]) > 45:
            g = float(hf(x, z))
            castle_parts.append(box_at(x, z, g - 2.5, g + 11.0, 6.0, 6.0, 0.4, stone2))
            castle_parts.append(box_at(x, z, g + 11.0, g + 12.3, 6.6, 6.6, 0.4, stone))
            last = (x, z)
    # torre del Homenaje
    rp = outer.representative_point()
    hh = float(hf(rp.x, rp.y))
    castle_parts.append(box_at(rp.x, rp.y, hh - 1.0, hh + 17.0, 11.0, 11.0, 0.3, keepc))
    castle_parts.append(box_at(rp.x, rp.y, hh + 17.0, hh + 18.4, 12.2, 12.2, 0.3, stone))
    castle_parts.append(box_at(rp.x, rp.y, hh + 18.4, hh + 22.0, 5.0, 5.0, 0.3, stone2))
    castle_obst.append({"id": -2, "h": 30, "p": [[round(x, 2), round(z, 2)] for x, z in outer.exterior.coords]})
    print("castillo: cumbre", int(sx0), int(sz0), "cota", int(hmax), "perimetro", int(perim), "m2", int(outer.area), "piezas", len(castle_parts))
except Exception as ex:
    print("castillo omitido:", repr(ex))

parts.append(("Walls", np.array(wv), np.array(wf), np.array(wc), np.array(wu)))

parts.append(("Roofs", np.vstack(rv), np.vstack(rf), np.vstack(rc), None))
castle_parts_all = castle_parts
lm_all = lm_parts
if False: pass
if castle_parts:
    _o = 0; _V, _F, _C = [], [], []
    for cv_, cf_, cc_ in castle_parts:
        _V.append(cv_); _F.append(cf_ + _o); _C.append(np.column_stack([cc_[:, :3], np.full(len(cc_), 255)])); _o += len(cv_)
    parts.append(("Castle", np.vstack(_V), np.vstack(_F), np.vstack(_C), None))
if lm_all:
    _o = 0; _V, _F, _C = [], [], []
    for cv_, cf_, cc_ in lm_all:
        _V.append(cv_); _F.append(cf_ + _o); _C.append(np.column_stack([cc_[:, :3], np.full(len(cc_), 255)])); _o += len(cv_)
    parts.append(("Landmark", np.vstack(_V), np.vstack(_F), np.vstack(_C), None))


def write_glb(path, parts):
    from pygltflib import GLTF2, Scene, Node, Mesh, Primitive, Buffer, BufferView, Accessor, Asset, FLOAT, UNSIGNED_INT, UNSIGNED_BYTE, Attributes, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER
    g = GLTF2(asset=Asset(version="2.0", generator="alicantegt"), scenes=[Scene(nodes=[])], scene=0)
    blob = bytearray()
    def push(arr, target, ctype, typ, normalized=False, minmax=False):
        nonlocal blob
        while len(blob) % 4: blob += bytes(1)
        data = arr.tobytes(); bv = BufferView(buffer=0, byteOffset=len(blob), byteLength=len(data), target=target)
        g.bufferViews.append(bv); blob += data
        acc = Accessor(bufferView=len(g.bufferViews)-1, componentType=ctype, count=int(arr.shape[0]), type=typ, normalized=normalized or None)
        if minmax: acc.min = arr.min(axis=0).astype(float).tolist(); acc.max = arr.max(axis=0).astype(float).tolist()
        g.accessors.append(acc); return len(g.accessors)-1
    for name, V, F, C, UV in parts:
        V = np.ascontiguousarray(V, dtype=np.float32); F = np.ascontiguousarray(F, dtype=np.uint32).reshape(-1)
        C = np.ascontiguousarray(C[:, :4], dtype=np.uint8)
        attrs = {"POSITION": push(V, ARRAY_BUFFER, FLOAT, "VEC3", minmax=True), "COLOR_0": push(C, ARRAY_BUFFER, UNSIGNED_BYTE, "VEC4", normalized=True)}
        if UV is not None: attrs["TEXCOORD_0"] = push(np.ascontiguousarray(UV, dtype=np.float32), ARRAY_BUFFER, FLOAT, "VEC2")
        idx = push(F.reshape(-1,1), ELEMENT_ARRAY_BUFFER, UNSIGNED_INT, "SCALAR")
        g.meshes.append(Mesh(name=name, primitives=[Primitive(attributes=Attributes(**attrs), indices=idx)]))
        g.nodes.append(Node(name=name, mesh=len(g.meshes)-1)); g.scenes[0].nodes.append(len(g.nodes)-1)
    g.buffers = [Buffer(byteLength=len(blob))]; g.set_binary_blob(bytes(blob)); g.save_binary(path)


os.makedirs("public/world", exist_ok=True)

write_glb("public/world/alicante.glb", parts)

sea_tiles = []

if not sea_free.is_empty:
    T = 150
    for gx in range(-1700, 900, T):
        for gz in range(-1100, 900, T):
            part = sea_free.intersection(box(gx, gz, gx+T, gz+T))
            for g in ([part] if isinstance(part, Polygon) else list(getattr(part, "geoms", []))):
                if isinstance(g, Polygon) and g.area > 4:
                    sea_tiles.append({"id":-1,"h":0,"p":[[round(x,2),round(z,2)] for x,z in g.exterior.coords]})

json.dump({"origin":{"lat":LAT0,"lng":LNG0},"buildings":collid,"obstacles":tree_obst+sea_tiles+castle_obst,
           "roads":road_lines,"trees":trees,"lamps":lamps,
           "drive":{"x0":dx0,"z0":dz0,"cell":DC,"nx":dnx,"nz":dnz,"bits":drive_b64},
           "dem":{"x0":DX0,"z0":DZ0,"step":DST,"nx":len(DXS),"nz":len(DZS),"h":[round(float(v),1) for v in HG.reshape(-1)]}}, open("public/world/colliders.json","w"))

print("mar m2", int(sea_free.area), "tiles", len(sea_tiles), "arboles", len(trees), "parques m2", int(parks.area), "farolas", len(lamps), "|", "edificios", len(collid), "calles", len(road_lines), "glb KB", os.path.getsize("public/world/alicante.glb")//1024)

