"""Túneles y puentes (OSM bridge=*, tunnel=yes) para build_tiles.py.

- Puente: la vía sube con rampas de 50 m hasta 5,4 m por capa, con tablero, pretiles, fachada y pilares.
- Túnel: la vía baja un 10 %% hasta 6,6 m; mientras la profundidad es menor de 5,6 m es una trinchera abierta con muros
  (se abre un hueco en el suelo) y a partir de ahí va cubierta, con techo, muros y luces.
Cada vía se construye en la tesela donde cae su punto medio; el hueco y la máscara transitable se calculan en todas las que toca.
"""
import math
import numpy as np
from shapely.geometry import LineString, Polygon, Point
from shapely.ops import unary_union

from world_lib import box_at, hexrgb

ASPH = [51, 54, 59, 255]
CONC = [186, 182, 171, 255]
CONC_D = [122, 119, 112, 255]
CEIL = [92, 94, 100, 255]
GLOW = [255, 244, 205, 255]
OPEN_LIMIT = 5.6        # profundidad a partir de la cual el túnel va cubierto (m)
MAX_DEPTH = 6.6
SLOPE = 0.10


def _smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def offset_fn(kind, layer, total):
    if kind == "bridge":
        H = min(5.4 * max(layer, 1), 11.0); R = 50.0
        if total < 2 * R: H *= total / (2 * R)
        return lambda s: H * _smooth(min(s, total - s) / R)
    return lambda s: -min(SLOPE * min(s, total - s), MAX_DEPTH)


def resample(pts, step=3.0):
    cum = [0.0]
    for i in range(len(pts) - 1):
        cum.append(cum[-1] + math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]))
    total = cum[-1]
    if total < 1e-6: return [], 0.0
    n = max(2, int(round(total / step)) + 1)
    out = []; j = 0
    for k in range(n):
        s = total * k / (n - 1)
        while j < len(cum) - 2 and cum[j + 1] < s: j += 1
        seg = cum[j + 1] - cum[j] or 1e-9
        t = (s - cum[j]) / seg
        out.append((pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t, s))
    return out, total


class _Mesh:
    def __init__(self):
        self.V, self.F, self.C = [], [], []

    def quad(self, p, want, col):
        a = [np.asarray(q, dtype=float) for q in p]
        n = np.cross(a[1] - a[0], a[3] - a[0])
        if np.dot(n, want) < 0: a = [a[0], a[3], a[2], a[1]]
        b = len(self.V)
        self.V.extend(a); self.C.extend([col] * 4)
        self.F.extend([[b, b + 1, b + 2], [b, b + 2, b + 3]])

    def add_parts(self, parts):
        for V, F, C in parts:
            b = len(self.V)
            self.V.extend(list(V)); self.C.extend([list(c) for c in C]); self.F.extend((np.asarray(F) + b).tolist())

    def out(self):
        if not self.V: return None
        return np.array(self.V), np.array(self.F), np.array(self.C, dtype=np.uint8)


def build_decks(deck_ways, hf, tile, roads_ground):
    """deck_ways: [{id,k,w,pts,kind,layer,ow,ln}] (todas las que tocan la tesela y sus vecinas).
    Devuelve dict(parts, hole, drive, decks, obst, marks) con la geometría de las vías propias de la tesela."""
    x0, z0, x1, z1 = tile
    deck = _Mesh(); struct = _Mesh(); glow = _Mesh()
    holes, drive_polys, decks_json, obst, marks = [], [], [], [], []
    for w_ in deck_ways:
        w = w_["w"]; S, total = resample(w_["pts"], 3.0)
        if len(S) < 2: continue
        off = offset_fn(w_["kind"], w_["layer"], total)
        o = [off(s) for (_, _, s) in S]
        drive_polys.append(LineString(w_["pts"]).buffer(w / 2 + 0.2, cap_style=2, join_style=1))
        # tangentes y normales
        T = []
        for i in range(len(S)):
            a = S[max(i - 1, 0)]; b = S[min(i + 1, len(S) - 1)]
            dx, dz = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dz) or 1.0
            T.append((dx / l, dz / l))
        g = [float(hf(x, z)) for (x, z, _) in S]
        # huecos de las trincheras abiertas (se calculan siempre: el suelo de las teselas vecinas también se recorta)
        if w_["kind"] == "tunnel":
            for i in range(len(S) - 1):
                d0, d1 = -o[i], -o[i + 1]
                if min(d0, d1) > 0.25 and max(d0, d1) < OPEN_LIMIT + 0.01:
                    hw_ = w / 2 + 0.25
                    pts4 = []
                    for k in (i, i + 1):
                        nx, nz = -T[k][1], T[k][0]
                        pts4.append((S[k][0] - nx * hw_, S[k][1] - nz * hw_))
                    for k in (i + 1, i):
                        nx, nz = -T[k][1], T[k][0]
                        pts4.append((S[k][0] + nx * hw_, S[k][1] + nz * hw_))
                    try: holes.append(Polygon(pts4).buffer(0))
                    except Exception: pass
        # marcas viales (de todas: build_tiles filtra por tesela)
        cum = [s for (_, _, s) in S]
        marks.append({"k": w_["k"], "w": w, "ow": w_["ow"], "ln": w_["ln"], "p": [[x, z] for (x, z, _) in S], "cum": cum, "o": o})
        # propiedad: tesela donde cae el punto medio
        mid = S[len(S) // 2]
        if not (x0 <= mid[0] < x1 and z0 <= mid[1] < z1): continue
        decks_json.append({"w": round(w, 1), "p": [[round(x, 1), round(z, 1), round(oo, 2)] for (x, z, _), oo in zip(S, o)]})
        # ---- mallas ----
        for i in range(len(S) - 1):
            e = []
            for k in (i, i + 1):
                nx, nz = -T[k][1], T[k][0]; y = g[k] + o[k]
                e.append(((S[k][0] - nx * w / 2, S[k][1] - nz * w / 2), (S[k][0] + nx * w / 2, S[k][1] + nz * w / 2), y, (nx, nz), g[k]))
            (L0, R0, y0, n0, g0), (L1, R1, y1, n1, g1) = e
            up = (0, 1, 0)
            deck.quad([(L0[0], y0 + 0.04, L0[1]), (R0[0], y0 + 0.04, R0[1]), (R1[0], y1 + 0.04, R1[1]), (L1[0], y1 + 0.04, L1[1])], up, ASPH)
            nxm, nzm = n0
            if w_["kind"] == "bridge":
                # fachada exterior, subtablero y pretiles
                for (A0, A1, sgn) in ((L0, L1, -1), (R0, R1, 1)):
                    want = (sgn * nxm, 0, sgn * nzm)
                    struct.quad([(A0[0], y0 - 0.9, A0[1]), (A1[0], y1 - 0.9, A1[1]), (A1[0], y1 + 0.04, A1[1]), (A0[0], y0 + 0.04, A0[1])], want, CONC)
                    ix0 = (A0[0] - sgn * nxm * 0.15, A0[1] - sgn * nzm * 0.15); ix1 = (A1[0] - sgn * n1[0] * 0.15, A1[1] - sgn * n1[1] * 0.15)
                    ox0 = (A0[0] + sgn * nxm * 0.05, A0[1] + sgn * nzm * 0.05); ox1 = (A1[0] + sgn * n1[0] * 0.05, A1[1] + sgn * n1[1] * 0.05)
                    struct.quad([(ix0[0], y0 + 0.04, ix0[1]), (ix1[0], y1 + 0.04, ix1[1]), (ix1[0], y1 + 0.95, ix1[1]), (ix0[0], y0 + 0.95, ix0[1])], (-want[0], 0, -want[2]), CONC)
                    struct.quad([(ox0[0], y0 + 0.04, ox0[1]), (ox1[0], y1 + 0.04, ox1[1]), (ox1[0], y1 + 0.95, ox1[1]), (ox0[0], y0 + 0.95, ox0[1])], want, CONC_D)
                    struct.quad([(ix0[0], y0 + 0.95, ix0[1]), (ox0[0], y0 + 0.95, ox0[1]), (ox1[0], y1 + 0.95, ox1[1]), (ix1[0], y1 + 0.95, ix1[1])], up, CONC)
                struct.quad([(L0[0], y0 - 0.9, L0[1]), (R0[0], y0 - 0.9, R0[1]), (R1[0], y1 - 0.9, R1[1]), (L1[0], y1 - 0.9, L1[1])], (0, -1, 0), CONC_D)
            else:
                d0, d1 = -o[i], -o[i + 1]
                covered = min(d0, d1) >= OPEN_LIMIT
                for (A0, A1, sgn) in ((L0, L1, 1), (R0, R1, -1)):          # muros orientados hacia la calzada
                    want = (sgn * nxm, 0, sgn * nzm)
                    if covered:
                        yc0, yc1 = g0 - 0.45, g1 - 0.45
                        struct.quad([(A0[0], y0 + 0.04, A0[1]), (A1[0], y1 + 0.04, A1[1]), (A1[0], yc1, A1[1]), (A0[0], yc0, A0[1])], want, CONC_D)
                    else:
                        struct.quad([(A0[0], y0 + 0.04, A0[1]), (A1[0], y1 + 0.04, A1[1]), (A1[0], g1, A1[1]), (A0[0], g0, A0[1])], want, CONC)
                if covered:
                    yc0, yc1 = g0 - 0.45, g1 - 0.45
                    struct.quad([(L0[0], yc0, L0[1]), (R0[0], yc0, R0[1]), (R1[0], yc1, R1[1]), (L1[0], yc1, L1[1])], (0, -1, 0), CEIL)
                    if i % 4 == 0:   # luminarias
                        cx0, cz0 = (L0[0] + R0[0]) / 2, (L0[1] + R0[1]) / 2; cx1, cz1 = (L1[0] + R1[0]) / 2, (L1[1] + R1[1]) / 2
                        hw2 = 0.9
                        glow.quad([(cx0 - n0[0] * hw2, yc0 - 0.03, cz0 - n0[1] * hw2), (cx0 + n0[0] * hw2, yc0 - 0.03, cz0 + n0[1] * hw2),
                                   (cx0 + n0[0] * hw2 + (cx1 - cx0) * 0.35, yc0 - 0.03, cz0 + n0[1] * hw2 + (cz1 - cz0) * 0.35),
                                   (cx0 - n0[0] * hw2 + (cx1 - cx0) * 0.35, yc0 - 0.03, cz0 - n0[1] * hw2 + (cz1 - cz0) * 0.35)], (0, -1, 0), GLOW)
        # pilares del puente (solo si debajo no hay calzada)
        if w_["kind"] == "bridge":
            nxt = 14.0
            for (x, z, s), oo, gg, t in zip(S, o, g, T):
                if s < nxt: continue
                nxt = s + 16.0
                if oo < 2.2: continue
                if roads_ground is not None and roads_ground.contains(Point(x, z)): continue
                ang = -math.atan2(t[1], t[0])
                struct.add_parts([box_at(x, z, gg - 0.3, gg + oo - 0.9, 1.7, 1.5, ang, CONC)])
                obst.append({"id": -5, "h": 6, "p": [[round(x + 0.95 * math.cos(a * math.pi / 4), 2), round(z + 0.95 * math.sin(a * math.pi / 4), 2)] for a in range(9)]})
    hole = unary_union(holes) if holes else None
    drive = unary_union(drive_polys) if drive_polys else None
    return {"parts": {"Deck": deck.out(), "Struct": struct.out(), "Glow": glow.out()}, "hole": hole, "drive": drive,
            "decks": decks_json, "obst": obst, "marks": marks}
