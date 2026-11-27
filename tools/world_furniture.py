"""Mobiliario urbano (bancos, papeleras, contenedores, marquesinas, hidrantes, aparcabicis, buzones) y terrazas de bares con mesas, sillas y sombrillas.
Todo se emite como mallas estáticas con color por vértice (se añade a «Detail» de la tesela); las terrazas devuelven además los asientos donde se
sientan peatones (src/world/pedestrians.ts). Posiciones: metros locales (x = este, z = sur)."""
import math, zlib
import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points

from world_lib import box_at, cyl_at, hexrgb

WALK_Y = 0.12                        # las aceras se dibujan 12 cm por encima del terreno


def _h(*vals):
    return zlib.crc32("|".join(str(v) for v in vals).encode("utf-8"))


class RoadIndex:
    """Calzada más cercana a un punto: distancia, dirección hacia ella y sentido de la calle."""
    def __init__(self, road_lines):
        self.lines = [LineString(r["p"]) for r in road_lines if len(r["p"]) >= 2]
        self.tree = STRtree(self.lines) if self.lines else None

    def near(self, x, z):
        if self.tree is None: return None
        p = Point(x, z)
        i = self.tree.nearest(p)
        ln = self.lines[int(i)]
        q = nearest_points(ln, p)[0]
        d = q.distance(p)
        s = ln.project(q)
        a, b = ln.interpolate(max(s - 1.0, 0)), ln.interpolate(min(s + 1.0, ln.length))
        tx, tz = b.x - a.x, b.y - a.y; tl = math.hypot(tx, tz) or 1.0
        nx, nz = (q.x - x, q.y - z); nl = math.hypot(nx, nz)
        if nl < 1e-6: nx, nz = -tz / tl, tx / tl
        else: nx, nz = nx / nl, nz / nl
        return d, nx, nz, tx / tl, tz / tl


def _rect(cx, cz, sx, sz, ang):
    """Colisionador rectangular (5 puntos) de sx × sz centrado en (cx, cz) y girado `ang` (convención de box_at: x local = (cos, -sin))."""
    c, s = math.cos(ang), math.sin(ang)
    pts = []
    for lx, lz in ((-sx / 2, -sz / 2), (sx / 2, -sz / 2), (sx / 2, sz / 2), (-sx / 2, sz / 2), (-sx / 2, -sz / 2)):
        pts.append([round(cx + lx * c + lz * s, 2), round(cz - lx * s + lz * c, 2)])
    return {"id": -7, "h": 1.5, "p": pts}


def _circle(cx, cz, r):
    return {"id": -7, "h": 1.5, "p": [[round(cx + r * math.cos(a * math.pi / 4), 2), round(cz + r * math.sin(a * math.pi / 4), 2)] for a in range(9)]}


def _ang(fx, fz):
    """Ángulo para box_at de modo que el eje x local apunte hacia (fx, fz)."""
    return -math.atan2(fz, fx)


def _rgba(h):
    return hexrgb(h)


def bench(parts, x, z, y0, fx, fz):
    """Banco mirando hacia (fx, fz)."""
    ang = _ang(fx, fz)
    wood, metal = _rgba(0x8a5a33), _rgba(0x2b2d31)
    px, pz = -fz, fx                      # eje largo del banco (perpendicular a donde mira)
    a2 = _ang(px, pz)
    parts.append(box_at(x, z, y0 + 0.42, y0 + 0.47, 1.7, 0.45, a2, wood))                                       # asiento
    parts.append(box_at(x - fx * 0.2, z - fz * 0.2, y0 + 0.62, y0 + 0.95, 1.7, 0.06, a2, wood))               # respaldo
    for s in (-0.7, 0.7):
        parts.append(box_at(x + px * s, z + pz * s, y0, y0 + 0.42, 0.07, 0.42, a2, metal))                     # patas


def waste_bin(parts, x, z, y0):
    parts.append(box_at(x, z, y0, y0 + 0.88, 0.38, 0.38, 0.0, _rgba(0x2f4a3a)))
    parts.append(box_at(x, z, y0 + 0.88, y0 + 0.94, 0.44, 0.44, 0.0, _rgba(0x20262a)))


def recycling(parts, x, z, y0, tx, tz, kind):
    """Tres contenedores seguidos (vidrio, papel, envases) o uno del tipo indicado."""
    cols = {"glass": 0x2f7d45, "paper": 0x2a5fa8, "plastic": 0xe8c200, "packaging": 0xe8c200}
    ang = _ang(tx, tz)
    sets = [cols[kind]] if kind in cols else [0x2f7d45, 0x2a5fa8, 0xe8c200]
    for i, c in enumerate(sets):
        o = (i - (len(sets) - 1) / 2) * 1.3
        cx, cz = x + tx * o, z + tz * o
        parts.append(box_at(cx, cz, y0 + 0.1, y0 + 1.35, 1.15, 1.15, ang, _rgba(c)))
        parts.append(box_at(cx, cz, y0 + 1.35, y0 + 1.45, 1.2, 1.2, ang, _rgba(0x33383c)))


def bus_stop(parts, x, z, y0, tx, tz, nx, nz, shelter):
    """Marquesina (con techo, cristales y banco) o poste con cartel azul. (nx, nz) apunta hacia la calzada."""
    blue = _rgba(0x1f4e9a)
    if not shelter:
        parts.append(box_at(x, z, y0, y0 + 2.9, 0.07, 0.07, 0.0, _rgba(0x55595e)))
        parts.append(box_at(x, z, y0 + 2.35, y0 + 2.9, 0.5, 0.05, _ang(tx, tz), blue))
        return
    cx, cz = x - nx * 0.9, z - nz * 0.9                 # el fondo mira a la fachada, el frente a la calzada
    a = _ang(tx, tz)
    parts.append(box_at(cx, cz, y0 + 2.35, y0 + 2.46, 3.2, 1.5, a, _rgba(0xcfd3d8)))                         # techo
    for s in (-1.5, 1.5):
        parts.append(box_at(cx + tx * s, cz + tz * s, y0, y0 + 2.35, 0.08, 0.08, a, _rgba(0x4c5054)))         # postes
    parts.append(box_at(cx - nx * 0.6, cz - nz * 0.6, y0 + 0.35, y0 + 2.3, 3.0, 0.04, a, _rgba(0x2a3f52)))    # cristal del fondo
    for s in (-1.5, 1.5):
        parts.append(box_at(cx + tx * s, cz + tz * s, y0 + 0.35, y0 + 2.3, 0.04, 1.2, a, _rgba(0x2a3f52)))    # cristales laterales
    parts.append(box_at(cx - nx * 0.4, cz - nz * 0.4, y0 + 0.42, y0 + 0.47, 1.9, 0.4, a, _rgba(0x6b6f75)))   # banco
    px, pz = x + tx * 2.1, z + tz * 2.1                  # poste con cartel junto a la marquesina
    parts.append(box_at(px, pz, y0, y0 + 2.9, 0.07, 0.07, 0.0, _rgba(0x55595e)))
    parts.append(box_at(px, pz, y0 + 2.35, y0 + 2.9, 0.5, 0.05, a, blue))


def hydrant(parts, x, z, y0):
    parts.append(cyl_at(x, z, y0, y0 + 0.75, 0.11, _rgba(0xc41e1e), 8))
    parts.append(cyl_at(x, z, y0 + 0.75, y0 + 0.82, 0.14, _rgba(0x8a1515), 8))


def bike_rack(parts, x, z, y0, tx, tz):
    ang = _ang(tx, tz)
    parts.append(box_at(x, z, y0 + 0.65, y0 + 0.69, 1.6, 0.05, ang, _rgba(0x6b6f75)))
    for s in (-0.7, 0, 0.7):
        parts.append(box_at(x + tx * s, z + tz * s, y0, y0 + 0.65, 0.04, 0.04, ang, _rgba(0x6b6f75)))


def postbox(parts, x, z, y0):
    parts.append(box_at(x, z, y0, y0 + 1.25, 0.5, 0.4, 0.0, _rgba(0xf2c500)))
    parts.append(box_at(x, z, y0 + 1.25, y0 + 1.33, 0.54, 0.44, 0.0, _rgba(0xc9a300)))


def water_fountain(parts, x, z, y0):
    parts.append(box_at(x, z, y0, y0 + 1.0, 0.28, 0.28, 0.0, _rgba(0x8a8f96)))
    parts.append(box_at(x, z, y0 + 1.0, y0 + 1.06, 0.4, 0.4, 0.0, _rgba(0x6b6f75)))


def furniture_parts(items, road_lines, roads_poly, walk_poly, hf, tile):
    """Mobiliario de la tesela: devuelve (mallas, colisionadores)."""
    x0, z0, x1, z1 = tile
    parts, obst = [], []
    ri = RoadIndex(road_lines)
    for it in items:
        x, z, k = it["x"], it["z"], it["k"]
        if not (x0 <= x < x1 and z0 <= z < z1) or k == "terrace": continue
        p = Point(x, z)
        if roads_poly is not None and not roads_poly.is_empty and roads_poly.contains(p) and k != "bus_stop": continue
        near = ri.near(x, z)
        if near is None: continue
        d, nx, nz, tx, tz = near
        y0 = float(hf(x, z)) + WALK_Y
        if k == "bench":
            bench(parts, x, z, y0, nx, nz); obst.append(_rect(x, z, 1.7, 0.6, _ang(-nz, nx)))
        elif k == "bin":
            waste_bin(parts, x, z, y0); obst.append(_circle(x, z, 0.3))
        elif k == "recycling":
            recycling(parts, x, z, y0, tx, tz, it.get("rec", "")); obst.append(_rect(x, z, 1.3 * (1 if it.get("rec") else 3), 1.3, _ang(tx, tz)))
        elif k == "bus_stop":
            if d > 20: continue
            on_road = roads_poly is not None and not roads_poly.is_empty and roads_poly.contains(p)
            if on_road:                                           # el nodo cae sobre el asfalto: se retrasa hasta la acera
                x, z = x - nx * (d + 1.8) if d < 3 else x - nx * 1.8, z - nz * (d + 1.8) if d < 3 else z - nz * 1.8
                if roads_poly.contains(Point(x, z)): continue
                y0 = float(hf(x, z)) + WALK_Y
            bus_stop(parts, x, z, y0, tx, tz, nx, nz, bool(it.get("shelter") or it.get("bench") or _h("bs", round(it["x"]), round(it["z"])) % 100 < 35))
            obst.append(_rect(x - nx * 0.9, z - nz * 0.9, 3.2, 1.5, _ang(tx, tz)) if (it.get("shelter") or it.get("bench")) else _circle(x, z, 0.2))
        elif k == "hydrant":
            hydrant(parts, x, z, y0); obst.append(_circle(x, z, 0.2))
        elif k == "bike":
            bike_rack(parts, x, z, y0, tx, tz); obst.append(_rect(x, z, 1.6, 0.4, _ang(tx, tz)))
        elif k == "postbox":
            postbox(parts, x, z, y0); obst.append(_circle(x, z, 0.3))
        elif k == "water":
            water_fountain(parts, x, z, y0); obst.append(_circle(x, z, 0.25))
    return parts, obst


# ---------------------------------------------------------------- terrazas
UMB = [0xefe6d0, 0xb8322f, 0x2f6b4a, 0x2d4f8c, 0xe0a526, 0xefe6d0]
CHAIR = [0x6b4a2f, 0x2b2d31, 0xd9d4c8, 0x7a5a3a]
TERRACE_SUBS = {"bar", "cafe", "restaurant", "pub", "fast_food", "ice_cream"}


def _facade(poly, x, z):
    """Punto de la fachada más cercano a (x, z), tangente y normal hacia fuera. None si el tramo es muy corto."""
    ring = list(poly.exterior.coords)
    best = None
    for a, b in zip(ring[:-1], ring[1:]):
        dx, dz = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dz)
        if L < 3.0: continue
        tx, tz = dx / L, dz / L
        t = max(0.0, min(L, (x - a[0]) * tx + (z - a[1]) * tz))
        fx, fz = a[0] + tx * t, a[1] + tz * t
        d = math.hypot(x - fx, z - fz)
        if best is None or d < best[0]: best = (d, fx, fz, tx, tz, t, L)
    if best is None: return None
    d, fx, fz, tx, tz, t, L = best
    nx, nz = -tz, tx
    if poly.contains(Point(fx + nx * 0.5, fz + nz * 0.5)): nx, nz = -nx, -nz
    return fx, fz, tx, tz, nx, nz, t, L


def terrace_parts(pois, items, bshapes, bidx, walk_poly, roads_poly, hf, tile):
    """Terrazas de los bares/cafés/restaurantes (y los puntos outdoor_seating de OSM) que tienen acera delante.
    Devuelve (mallas, asientos [[x, z, yaw]...]) con los asientos ocupados por peatones sentados."""
    x0, z0, x1, z1 = tile
    parts, seats, placed = [], [], []
    cands = []
    for p in pois:
        if p.get("cat") == "food" and p.get("sub") in TERRACE_SUBS and x0 <= p["x"] < x1 and z0 <= p["z"] < z1 and _h("terr", p["name"], round(p["x"])) % 100 < 34:
            cands.append((p["x"], p["z"], _h("t", p["name"], round(p["z"]))))
    for it in items:
        if it["k"] == "terrace" and x0 <= it["x"] < x1 and z0 <= it["z"] < z1:
            cands.append((it["x"], it["z"], _h("o", round(it["x"]), round(it["z"]))))
    if not cands or walk_poly is None or walk_poly.is_empty: return parts, seats
    for (x, z, h) in cands:
        pt = Point(x, z)
        idxs = bidx.query(pt.buffer(8.0))
        if len(idxs) == 0: continue
        poly = min((bshapes[int(i)] for i in idxs), key=lambda g: g.distance(pt))
        if poly.geom_type != "Polygon": continue
        fc = _facade(poly, x, z)
        if fc is None: continue
        fx, fz, tx, tz, nx, nz, t, L = fc
        n_tab = 1 + h % 3
        spacing = 2.4
        ok_tabs = []
        for i in range(n_tab):
            o = (i - (n_tab - 1) / 2) * spacing
            tt = t + o
            if tt < 0.8 or tt > L - 0.8: continue
            cx, cz = fx + tx * o + nx * 1.9, fz + tz * o + nz * 1.9
            c = Point(cx, cz)
            if not (walk_poly.contains(c) and walk_poly.contains(Point(cx + nx * 0.9, cz + nz * 0.9)) and walk_poly.contains(Point(cx - nx * 0.9, cz - nz * 0.9))): continue
            if roads_poly is not None and not roads_poly.is_empty and roads_poly.distance(c) < 1.2: continue
            if any(math.hypot(cx - px, cz - pz) < 2.2 for px, pz in placed): continue
            ok_tabs.append((cx, cz))
        for ti, (cx, cz) in enumerate(ok_tabs):
            placed.append((cx, cz))
            y0 = float(hf(cx, cz)) + WALK_Y
            hh = _h("tab", round(cx), round(cz))
            ang = _ang(tx, tz)
            parts.append(box_at(cx, cz, y0 + 0.72, y0 + 0.76, 0.8, 0.8, ang, _rgba(0xd8d2c4 if hh % 2 else 0x2b2d31)))       # tablero
            parts.append(box_at(cx, cz, y0, y0 + 0.72, 0.07, 0.07, ang, _rgba(0x4a4d52)))                                        # pie
            parts.append(box_at(cx, cz, y0, y0 + 0.04, 0.42, 0.42, ang, _rgba(0x4a4d52)))
            ccol = CHAIR[hh % len(CHAIR)]
            for side in (1, -1):                                                                                                  # dos sillas enfrentadas (una de espaldas a la fachada)
                sx, sz = cx + nx * 0.78 * side, cz + nz * 0.78 * side
                fxd, fzd = -nx * side, -nz * side                                                                                 # mira a la mesa
                ca = _ang(fxd, fzd)
                parts.append(box_at(sx, sz, y0 + 0.43, y0 + 0.47, 0.44, 0.44, ca, _rgba(ccol)))
                parts.append(box_at(sx - fxd * 0.21, sz - fzd * 0.21, y0 + 0.47, y0 + 0.92, 0.04, 0.44, ca, _rgba(ccol)))
                parts.append(box_at(sx, sz, y0, y0 + 0.43, 0.05, 0.05, ca, _rgba(0x2b2d31)))
                if _h("sit", round(sx * 10), round(sz * 10)) % 100 < 55:
                    seats.append([round(sx, 2), round(sz, 2), round(math.atan2(fxd, fzd), 3)])
            if hh % 100 < 55:                                                                                                     # sombrilla
                uc = UMB[(hh >> 8) % len(UMB)]
                parts.append(box_at(cx, cz, y0, y0 + 2.3, 0.05, 0.05, 0.0, _rgba(0x8a8f96)))
                parts.append(box_at(cx, cz, y0 + 2.22, y0 + 2.3, 2.5, 2.5, ang, _rgba(uc)))
                parts.append(box_at(cx, cz, y0 + 2.3, y0 + 2.42, 1.2, 1.2, ang, _rgba(uc)))
    return parts, seats
