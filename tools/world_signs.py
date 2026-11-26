"""Carteles de comercios: rótulos con el nombre del local (OSM) pegados a la fachada, un atlas de texturas por tesela.
No se usan logotipos ni fotos (marcas registradas / derechos de imagen): cada rótulo lleva el nombre y el color de su tipo de negocio."""
import math, os
import numpy as np
from shapely import STRtree
from shapely.geometry import Point
from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H, COLS = 320, 60, 6
SIGN_W, SIGN_H = 3.8, 0.6
MAX_SIGNS = 240
COLORS = {"food": ((176, 38, 40), (255, 255, 255)), "health": ((24, 132, 82), (255, 255, 255)), "money": ((26, 66, 138), (255, 255, 255)),
          "lodge": ((106, 58, 128), (255, 255, 255)), "cult": ((148, 54, 98), (255, 255, 255)), "serv": ((78, 88, 100), (255, 255, 255)),
          "fashion": ((28, 28, 32), (232, 196, 110)), "market": ((236, 168, 36), (40, 30, 10))}
PRIORITY = {"food": 0, "market": 1, "fashion": 2, "health": 3, "money": 4, "serv": 5, "lodge": 6, "cult": 7}
_FONTS = {}


def font(size):
    if size in _FONTS: return _FONTS[size]
    f = None
    for path in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/calibrib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size); break
    _FONTS[size] = f or ImageFont.load_default()
    return _FONTS[size]


def draw_cell(im, idx, name, cat):
    col, row = idx % COLS, idx // COLS
    x0, y0 = col * CELL_W, row * CELL_H
    bg, fg = COLORS.get(cat, ((60, 60, 64), (255, 255, 255)))
    d = ImageDraw.Draw(im)
    d.rectangle([x0, y0, x0 + CELL_W - 1, y0 + CELL_H - 1], fill=bg)
    d.rectangle([x0 + 3, y0 + 3, x0 + CELL_W - 4, y0 + CELL_H - 4], outline=tuple(min(255, int(c * 1.35) + 20) for c in bg), width=2)
    txt = name.strip()
    lines = [txt]
    if len(txt) > 17 and " " in txt:                                  # dos líneas, cortando cerca de la mitad
        best = min((abs(i - len(txt) / 2), i) for i, ch in enumerate(txt) if ch == " ")[1]
        lines = [txt[:best], txt[best + 1:]]
    for size in range(34, 11, -1):
        f = font(size)
        w = max(d.textlength(l, font=f) for l in lines)
        if w <= CELL_W - 22 and size * len(lines) * 1.12 <= CELL_H - 8: break
    th = size * 1.12 * len(lines)
    ty = y0 + (CELL_H - th) / 2
    for l in lines:
        w = d.textlength(l, font=f)
        d.text((x0 + (CELL_W - w) / 2, ty), l, font=f, fill=fg)
        ty += size * 1.12


def place_signs(pois, footprints, roads_near, hf, bounds):
    """pois: dicts {x,z,name,cat}. footprints: lista de Polygon. Devuelve [(name, cat, cx, cz, nx, nz, W, y0)] sobre fachadas que dan a la calle."""
    x0, z0, x1, z1 = bounds
    cands = [p for p in pois if x0 <= p["x"] < x1 and z0 <= p["z"] < z1]
    if not cands or not footprints: return []
    cands.sort(key=lambda p: (PRIORITY.get(p["cat"], 9), p["name"]))
    tree = STRtree(footprints)
    out = []; used = []
    for p in cands:
        if len(out) >= MAX_SIGNS: break
        pt = Point(p["x"], p["z"]); best = None
        for i in tree.query(pt.buffer(14)):
            poly = footprints[i]; ring = list(poly.exterior.coords); ccw = poly.exterior.is_ccw
            for a, b in zip(ring[:-1], ring[1:]):
                dx, dz = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dz)
                if L < 3.2: continue
                tx, tz = dx / L, dz / L
                t = max(0.0, min(L, (p["x"] - a[0]) * tx + (p["z"] - a[1]) * tz))
                qx, qz = a[0] + tx * t, a[1] + tz * t
                dist = math.hypot(p["x"] - qx, p["z"] - qz)
                if best is not None and dist >= best[0]: continue
                nx, nz = (tz, -tx) if ccw else (-tz, tx)
                if not roads_near.contains(Point(qx + nx * 2.0, qz + nz * 2.0)): continue
                best = (dist, a, tx, tz, L, t, nx, nz)
        if best is None or best[0] > 12: continue
        dist, a, tx, tz, L, t, nx, nz = best
        W = min(SIGN_W, L - 0.8)
        if W < 1.6: continue
        t = max(W / 2 + 0.4, min(L - W / 2 - 0.4, t))
        cx, cz = a[0] + tx * t, a[1] + tz * t
        if any(math.hypot(cx - u[0], cz - u[1]) < 3.4 for u in used): continue
        used.append((cx, cz))
        out.append((p["name"], p["cat"], cx, cz, nx, nz, W, float(hf(cx, cz))))
    return out


def signs_mesh(signs, atlas_path):
    """Escribe el atlas y devuelve (V, F, C, UV) o None. Celda 0 = marco oscuro."""
    if not signs: return None
    n = len(signs) + 1
    rows = (n + COLS - 1) // COLS
    AW, AH = COLS * CELL_W, rows * CELL_H
    im = Image.new("RGB", (AW, AH), (22, 22, 24))
    for i, (name, cat, *_r) in enumerate(signs, start=1): draw_cell(im, i, name, cat)
    im.save(atlas_path, quality=86, optimize=True)
    V, F, UV = [], [], []

    def quad(c, y_b, y_t, w, off, cell):
        cx, cz, nx, nz = c
        rx, rz = nz, -nx                                   # derecha vista desde fuera
        P = [(cx - rx * w / 2 + nx * off, y_b, cz - rz * w / 2 + nz * off), (cx + rx * w / 2 + nx * off, y_b, cz + rz * w / 2 + nz * off),
             (cx + rx * w / 2 + nx * off, y_t, cz + rz * w / 2 + nz * off), (cx - rx * w / 2 + nx * off, y_t, cz - rz * w / 2 + nz * off)]
        col, row = cell % COLS, cell // COLS
        u0, u1 = col * CELL_W / AW, (col + 1) * CELL_W / AW
        v1, v0 = 1.0 - row * CELL_H / AH, 1.0 - (row + 1) * CELL_H / AH          # v hacia arriba (TextureLoader con flipY)
        if cell == 0:
            u0 = u1 = (CELL_W * 0.5) / AW; v0 = v1 = 1.0 - (CELL_H * 0.5) / AH
        uv = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        b = len(V); V.extend(P); UV.extend(uv)
        nrm = np.cross(np.subtract(P[1], P[0]), np.subtract(P[3], P[0]))
        if np.dot(nrm, (nx, 0, nz)) >= 0: F.extend([[b, b + 1, b + 2], [b, b + 2, b + 3]])
        else: F.extend([[b, b + 2, b + 1], [b, b + 3, b + 2]])

    for i, (name, cat, cx, cz, nx, nz, W, y0) in enumerate(signs, start=1):
        c = (cx, cz, nx, nz)
        hh = W * CELL_H / CELL_W                                 # altura según la proporción del atlas
        quad(c, y0 + 3.32, y0 + 3.48 + hh, W + 0.16, 0.10, 0)    # marco
        quad(c, y0 + 3.40, y0 + 3.40 + hh, W, 0.14, i)           # rótulo
    V = np.array(V)
    return V, np.array(F), np.full((len(V), 4), 255, dtype=np.uint8), np.array(UV)
