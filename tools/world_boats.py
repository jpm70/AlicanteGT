"""Barcos del puerto deportivo: yates a motor, veleros y algún superyate, amarrados perpendiculares a los pantalanes.
Cada barco es un casco loft (popa -> proa) con cubierta, cabina con banda de cristal y, según el tipo, flybridge o mástil con botavara."""
import math
import numpy as np
from shapely.geometry import LineString, Polygon, Point
from shapely import affinity
import shapely

from world_lib import hexrgb
from world_decks import _Mesh

HULLS = [0xf6f6f2, 0xf6f6f2, 0xf6f6f2, 0xe9eef2, 0x1d2f4d, 0x23324a, 0xf2e8d0, 0x2d3b34, 0xb8c2c9]
STRIPE = [0x1d3f7a, 0xb0282e, 0x1d2f4d, 0x2e2e32, 0x1f6b5a]
ANTIFOUL = [110, 42, 42, 255]
DECK = [196, 170, 128, 255]
WHITE = [244, 244, 240, 255]
GLASS = [34, 46, 58, 255]
GREY = [150, 154, 160, 255]


def _rgba(h):
    c = hexrgb(h)
    return [int(c[0]), int(c[1]), int(c[2]), 255]


def _tri(mesh, a, b, c, col, center):
    """Triángulo orientado hacia fuera respecto de `center`."""
    a = np.asarray(a, float); b = np.asarray(b, float); c = np.asarray(c, float)
    n = np.cross(b - a, c - a)
    if np.linalg.norm(n) < 1e-9: return
    if np.dot(n, (a + b + c) / 3 - center) < 0: b, c = c, b
    k = len(mesh.V); mesh.V.extend([a, b, c]); mesh.C.extend([col] * 3); mesh.F.append([k, k + 1, k + 2])


def _quad(mesh, a, b, c, d, col, center):
    _tri(mesh, a, b, c, col, center); _tri(mesh, a, c, d, col, center)


def _box(mesh, x0, x1, y0, y1, hw, col, glass=False):
    c = np.array([(x0 + x1) / 2, (y0 + y1) / 2, 0.0])
    P = lambda x, y, z: (x, y, z)
    for (a, b, cc, d) in (((x0, y0, -hw), (x1, y0, -hw), (x1, y1, -hw), (x0, y1, -hw)), ((x0, y0, hw), (x1, y0, hw), (x1, y1, hw), (x0, y1, hw)),
                           ((x0, y1, -hw), (x1, y1, -hw), (x1, y1, hw), (x0, y1, hw)), ((x0, y0, -hw), (x0, y1, -hw), (x0, y1, hw), (x0, y0, hw)),
                           ((x1, y0, -hw), (x1, y1, -hw), (x1, y1, hw), (x1, y0, hw))):
        _quad(mesh, a, b, cc, d, col, c)


def make_boat(L, kind, seed):
    """Malla en coordenadas del barco: x = proa (+), y = arriba (0 = flotación), z = estribor. Devuelve _Mesh."""
    rnd = np.random.RandomState(seed)
    m = _Mesh()
    Wd = L * (0.27 if kind == "sail" else 0.31)
    hull = _rgba(0x1b6a66) if kind == "display" else _rgba(HULLS[rnd.randint(len(HULLS))])
    T = [0.0, 0.14, 0.38, 0.6, 0.78, 0.92, 1.0]
    F_ = [0.80, 0.94, 1.0, 0.96, 0.72, 0.36, 0.0]
    s = L / 12.0
    hd = 0.85 * min(max(s, 0.6), 1.9)
    st = []
    for t, f in zip(T, F_):
        x = (t - 0.5) * L; w = Wd / 2 * f; h = hd * (1.0 + 0.55 * t * t)
        st.append((x, w, h, -0.5 * hd * (1.0 - 0.5 * t)))
    cen = np.array([0.0, hd * 0.3, 0.0])
    for i in range(len(st) - 1):
        (xa, wa, ha, da), (xb, wb, hb, db) = st[i], st[i + 1]
        for sd in (-1, 1):                         # costados
            _quad(m, (xa, ha, sd * wa), (xb, hb, sd * wb), (xb, db, sd * wb * 0.55), (xa, da, sd * wa * 0.55), hull, cen)
        _quad(m, (xa, da, -wa * 0.55), (xb, db, -wb * 0.55), (xb, db, wb * 0.55), (xa, da, wa * 0.55), ANTIFOUL, cen)        # fondo
        _quad(m, (xa, ha, -wa), (xb, hb, -wb), (xb, hb, wb), (xa, ha, wa), DECK, cen)                                       # cubierta
    x0, w0, h0, d0 = st[0]
    _quad(m, (x0, h0, -w0), (x0, h0, w0), (x0, d0, w0 * 0.55), (x0, d0, -w0 * 0.55), hull, cen)                              # espejo de popa
    if rnd.rand() < 0.7:                                                                                                       # franja del casco
        sc = _rgba(STRIPE[rnd.randint(len(STRIPE))])
        for i in range(len(st) - 1):
            (xa, wa, ha, da), (xb, wb, hb, db) = st[i], st[i + 1]
            for sd in (-1, 1):
                _quad(m, (xa, ha - 0.1, sd * (wa + 0.01)), (xb, hb - 0.1, sd * (wb + 0.01)), (xb, hb - 0.28, sd * (wb + 0.01)), (xa, ha - 0.28, sd * (wa + 0.01)), sc, cen)
    deck_y = hd * 1.18
    if kind == "display":                                   # velero de regatas en exposición: sin mástil, con bañera, escotillas y botavara
        for sd in (-1, 1):                                 # gráfica clara a babor y estribor (parches blancos sobre el casco)
            for (ta, tb) in ((0.18, 0.34), (0.48, 0.56), (0.66, 0.84)):
                for i in range(len(st) - 1):
                    (xa, wa, ha, da), (xb, wb, hb, db) = st[i], st[i + 1]
                    if tb <= (xa / L + 0.5) or ta >= (xb / L + 0.5): continue
                    _quad(m, (xa, ha - 0.35, sd * (wa + 0.012)), (xb, hb - 0.35, sd * (wb + 0.012)), (xb, hb - 0.75, sd * (wb + 0.012)), (xa, ha - 0.75, sd * (wa + 0.012)), WHITE, cen)
        _box(m, -0.40 * L, -0.20 * L, deck_y, deck_y + 0.18, Wd * 0.26, GREY)                                             # bañera
        _box(m, -0.12 * L, 0.02 * L, deck_y, deck_y + 0.45 * s, Wd * 0.22, WHITE)                                          # escotilla principal
        _box(m, 0.08 * L, 0.2 * L, deck_y, deck_y + 0.22 * s, Wd * 0.18, GREY)
        _box(m, 0.02 * L - 0.1, 0.02 * L + 0.1, deck_y, deck_y + 0.5, 0.1, GREY)
        _box(m, -0.30 * L, 0.04 * L, deck_y + 0.5, deck_y + 0.62, 0.06, GREY)                                              # botavara
        return m
    if kind == "sail":
        cl = L * 0.34
        _box(m, -0.15 * L, -0.15 * L + cl, deck_y, deck_y + 0.55 * s, Wd * 0.26, WHITE)
        mast_x = 0.05 * L; mh = 0.95 * L
        _box(m, mast_x - 0.07, mast_x + 0.07, deck_y, deck_y + mh, 0.07, GREY)
        _box(m, mast_x - 0.9 * L * 0.35, mast_x - 0.03, deck_y + 1.1 * s, deck_y + 1.1 * s + 0.12, 0.06, GREY)               # botavara
        if rnd.rand() < 0.6:                                                                                                   # vela enrollada
            _box(m, mast_x - 0.9 * L * 0.35, mast_x - 0.07, deck_y + 1.1 * s + 0.12, deck_y + 1.1 * s + 0.36, 0.13, WHITE)
    else:
        cabin_h = 1.25 * s
        c0, c1 = -0.28 * L, 0.2 * L
        _box(m, c0, c1, deck_y, deck_y + cabin_h, Wd * 0.3, WHITE)
        _box(m, c0 - 0.02, c1 + 0.02, deck_y + cabin_h * 0.35, deck_y + cabin_h * 0.8, Wd * 0.3 + 0.02, GLASS)
        _box(m, c0 + 0.1, c1 - 0.1, deck_y + cabin_h, deck_y + cabin_h + 0.12, Wd * 0.32, WHITE)
        if kind == "super" or L > 15:
            f0, f1 = c0 + 0.12 * L, c1 - 0.12 * L
            _box(m, f0, f1, deck_y + cabin_h + 0.12, deck_y + cabin_h + 0.12 + cabin_h * 0.85, Wd * 0.22, WHITE)
            _box(m, f0 - 0.02, f1 + 0.02, deck_y + cabin_h + 0.12 + cabin_h * 0.25, deck_y + cabin_h + 0.12 + cabin_h * 0.7, Wd * 0.22 + 0.02, GLASS)
            top = deck_y + cabin_h * 1.97
        else:
            top = deck_y + cabin_h + 0.12
        _box(m, (c0 + c1) / 2 - 0.05, (c0 + c1) / 2 + 0.05, top, top + 1.6 * s, 0.05, GREY)                                       # mástil de radar
        _box(m, (c0 + c1) / 2 - 0.2, (c0 + c1) / 2 + 0.2, top + 1.0 * s, top + 1.0 * s + 0.1, 0.35, GREY)
    return m


def place_boats(piers_lines, water, tile, port_box, seed0=17, placed=None):
    """Atraca barcos a ambos lados de cada pantalán de `piers_lines` (LineString en m locales) dentro de `water` (polígono de agua libre).
    Devuelve lista de (cx, cz, yaw, L, kind, seed) cuyo centro cae en `tile` (x0, z0, x1, z1)."""
    out = []
    if placed is None: placed = []
    shapely.prepare(water)
    px0, pz0, px1, pz1 = port_box
    for li, ln in enumerate(sorted(piers_lines, key=lambda l: (round(l.coords[0][0], 1), round(l.coords[0][1], 1)))):
        mx, mz = ln.interpolate(0.5, normalized=True).x, ln.interpolate(0.5, normalized=True).y
        if not (px0 <= mx <= px1 and pz0 <= mz <= pz1) or ln.length < 25: continue
        rnd = np.random.RandomState(int(abs(mx) * 7 + abs(mz) * 13) % 100000 + seed0)
        for side in (1, -1):
            s = 4.0 + rnd.rand() * 2
            while s < ln.length - 4.0:
                p = ln.interpolate(s); q = ln.interpolate(min(s + 1.0, ln.length)); r = ln.interpolate(max(s - 1.0, 0))
                tx, tz = q.x - r.x, q.y - r.y; tl = math.hypot(tx, tz) or 1.0; tx, tz = tx / tl, tz / tl
                nx, nz = -tz * side, tx * side
                kr = rnd.rand()
                kind = "sail" if kr < 0.38 else "super" if kr > 0.93 else "motor"
                L = (rnd.uniform(8.5, 15.5) if kind == "sail" else rnd.uniform(26, 38) if kind == "super" else rnd.uniform(8, 21))
                Wd = L * (0.27 if kind == "sail" else 0.31)
                off = 3.5 + 0.4 + L / 2
                cx, cz = p.x + nx * off, p.y + nz * off
                rect = Polygon([(-L / 2, -Wd / 2 - 0.5), (L / 2, -Wd / 2 - 0.5), (L / 2, Wd / 2 + 0.5), (-L / 2, Wd / 2 + 0.5)])
                yaw = math.atan2(nz, nx)                       # proa hacia fuera del pantalán
                rect = affinity.translate(affinity.rotate(rect, yaw, origin=(0, 0), use_radians=True), cx, cz)
                ok = water.contains(rect) and not any(rect.intersects(o) for o in placed)
                if ok:
                    placed.append(rect)
                    if tile[0] <= cx < tile[2] and tile[1] <= cz < tile[3]:
                        out.append((cx, cz, yaw, L, kind, int(abs(cx) * 31 + abs(cz) * 17) % 100000))
                    s += Wd + 1.1 + rnd.rand() * 0.6
                else:
                    s += 2.0
    return out


def place_quay_boats(sea, water, piers_lines, tile, port_box, placed, seed0=91):
    """Barcos amarrados de popa al muelle (primera línea del puerto): recorre la orilla del mar dentro del puerto deportivo
    (a menos de 150 m de algún pantalán) y coloca un barco cada pocos metros, perpendicular a la orilla y sin pisar a otros.
    Determinista por orilla (misma colocación en todas las teselas). Devuelve lista como `place_boats`."""
    from shapely.geometry import box
    from shapely.ops import unary_union
    out = []
    px0, pz0, px1, pz1 = port_box
    lines = [l for l in piers_lines if px0 - 120 <= l.centroid.x <= px1 + 120 and pz0 - 120 <= l.centroid.y <= pz1 + 120]
    if not lines or sea is None or sea.is_empty: return out
    near = unary_union([l.buffer(150) for l in lines]); shapely.prepare(near)
    shapely.prepare(water)
    loc = sea.intersection(box(px0 - 60, pz0 - 60, px1 + 60, pz1 + 60))
    polys = list(loc.geoms) if hasattr(loc, "geoms") else [loc]
    rings = []
    for pg in polys:
        if getattr(pg, "geom_type", "") != "Polygon": continue
        rings.append(LineString(pg.exterior.coords))
        rings.extend(LineString(r.coords) for r in pg.interiors)
    rings.sort(key=lambda r: (round(r.coords[0][0], 1), round(r.coords[0][1], 1), round(r.length)))
    for ring in rings:
        if ring.length < 20: continue
        rnd = np.random.RandomState(int(abs(ring.coords[0][0]) * 7 + abs(ring.coords[0][1]) * 13) % 100000 + seed0)
        s = 2.0
        while s < ring.length - 2.0:
            p = ring.interpolate(s)
            if not (px0 <= p.x <= px1 and pz0 <= p.y <= pz1) or not near.contains(p):
                s += 3.0; continue
            q = ring.interpolate(min(s + 1.5, ring.length)); r = ring.interpolate(max(s - 1.5, 0))
            tx, tz = q.x - r.x, q.y - r.y; tl = math.hypot(tx, tz) or 1.0; tx, tz = tx / tl, tz / tl
            nx, nz = -tz, tx
            if not water.contains(Point(p.x + nx * 3.0, p.y + nz * 3.0)):
                nx, nz = -nx, -nz
                if not water.contains(Point(p.x + nx * 3.0, p.y + nz * 3.0)):
                    s += 3.0; continue
            kr = rnd.rand()
            kind = "sail" if kr < 0.40 else "super" if kr > 0.95 else "motor"
            L = (rnd.uniform(8.5, 14.5) if kind == "sail" else rnd.uniform(26, 36) if kind == "super" else rnd.uniform(8, 19))
            Wd = L * (0.27 if kind == "sail" else 0.31)
            gap = rnd.rand()
            cx, cz = p.x + nx * (L / 2 + 0.7), p.y + nz * (L / 2 + 0.7)
            rect = Polygon([(-L / 2, -Wd / 2 - 0.4), (L / 2, -Wd / 2 - 0.4), (L / 2, Wd / 2 + 0.4), (-L / 2, Wd / 2 + 0.4)])
            yaw = math.atan2(nz, nx)                            # proa hacia fuera del muelle
            rect = affinity.translate(affinity.rotate(rect, yaw, origin=(0, 0), use_radians=True), cx, cz)
            if gap < 0.88 and water.contains(rect) and not any(rect.intersects(o) for o in placed):
                placed.append(rect)
                if tile[0] <= cx < tile[2] and tile[1] <= cz < tile[3]:
                    out.append((cx, cz, yaw, L, kind, int(abs(cx) * 31 + abs(cz) * 17) % 100000))
                s += Wd + 1.0 + rnd.rand() * 0.8
            else:
                s += 2.5
    return out


ORANGE = [232, 99, 26, 255]
STEEL = [78, 82, 88, 255]


def display_sailboat(cx, cz, y0, yaw, L=20.4, seed=5):
    """Velero de regatas en exposición, a 3,8 m del suelo sobre soportes de acero, con su quilla (naranja) y timón a la vista.
    Devuelve (partes [(V, F, C)], colisionadores de los soportes). `yaw`: ángulo de la proa desde +x hacia +z."""
    m = make_boat(L, "display", seed)
    Vb = np.array(m.V); Fb = np.array(m.F); Cb = np.array(m.C, dtype=np.uint8)
    c, s_ = math.cos(yaw), math.sin(yaw)
    lift = y0 + 3.8 + 0.7                                      # el casco queda a ~3,8 m del suelo
    parts = [(np.column_stack([Vb[:, 0] * c - Vb[:, 2] * s_ + cx, Vb[:, 1] + lift, Vb[:, 0] * s_ + Vb[:, 2] * c + cz]), Fb, Cb)]

    def box(lx, lz, ya, yb, sx, sz, col):
        """Caja en coordenadas del barco (x proa, z estribor), girada con el barco."""
        x, z = lx * c - lz * s_ + cx, lx * s_ + lz * c + cz
        ang = -yaw
        import trimesh
        b = trimesh.creation.box(extents=[sx, yb - ya, sz])
        b.apply_transform(trimesh.transformations.rotation_matrix(ang, [0, 1, 0]))
        b.apply_translation([x, (ya + yb) / 2, z])
        V = np.asarray(b.vertices)
        parts.append((V, np.asarray(b.faces), np.tile(col, (len(V), 1)).astype(np.uint8)))
        return x, z

    keel_x = 0.04 * L
    box(keel_x, 0.0, lift - 0.6 - 3.0, lift - 0.45, 1.6, 0.14, ORANGE)                       # aleta de quilla
    box(keel_x, 0.0, lift - 0.6 - 3.5, lift - 0.6 - 3.0, 2.6, 0.5, ORANGE)                    # bulbo
    box(-0.47 * L, 0.0, lift - 0.5 - 1.4, lift - 0.2, 0.5, 0.1, ORANGE)                       # timón
    obst = []
    for lx in (-0.30 * L, 0.0, 0.30 * L):                                                        # tres cunas: dos pies y una viga con refuerzo
        for lz in (-1.5, 1.5):
            x, z = box(lx, lz, y0, lift - 0.45, 0.3, 0.3, STEEL)
            obst.append({"id": -8, "h": 4, "p": [[round(x + 0.5 * math.cos(a * math.pi / 4), 2), round(z + 0.5 * math.sin(a * math.pi / 4), 2)] for a in range(9)]})
        box(lx, 0.0, lift - 0.75, lift - 0.45, 0.4, 3.4, STEEL)
    return parts, obst


def boats_mesh(boats, water_y, hf=None):
    """Une todos los barcos en un solo (V, F, C)."""
    V, F, C = [], [], []
    base = 0
    for (cx, cz, yaw, L, kind, seed) in boats:
        m = make_boat(L, kind, seed)
        if not m.V: continue
        Vb = np.array(m.V); Fb = np.array(m.F); Cb = np.array(m.C, dtype=np.uint8)
        # x local = proa: yaw medido desde +x hacia +z
        c, s_ = math.cos(yaw), math.sin(yaw)
        x = Vb[:, 0] * c - Vb[:, 2] * s_ ; z = Vb[:, 0] * s_ + Vb[:, 2] * c
        P = np.column_stack([x + cx, Vb[:, 1] + water_y, z + cz])
        V.append(P); F.append(Fb + base); C.append(Cb); base += len(P)
    if not V: return None
    return np.vstack(V), np.vstack(F), np.vstack(C)
