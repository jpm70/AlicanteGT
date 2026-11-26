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
import zlib
FONT_FILES = ["arialbd.ttf", "georgiab.ttf", "timesbd.ttf", "impact.ttf", "trebucbd.ttf", "verdanab.ttf", "segoeuib.ttf", "cambriab.ttf",
              "palab.ttf", "constanb.ttf", "tahomabd.ttf", "bahnschrift.ttf", "BOOKOSB.TTF", "comicbd.ttf"]
SERIF = {"georgiab.ttf", "timesbd.ttf", "cambriab.ttf", "palab.ttf", "constanb.ttf", "BOOKOSB.TTF"}
# paletas (fondo, texto, acento) por categoría: cada local elige una según el hash de su nombre
PAL = {
    "food": [((176, 38, 40), (255, 255, 255), (255, 214, 120)), ((52, 34, 24), (244, 214, 150), (190, 120, 50)), ((24, 94, 62), (255, 255, 255), (240, 200, 90)),
             ((245, 236, 214), (140, 30, 30), (200, 150, 60)), ((20, 20, 24), (255, 196, 40), (255, 255, 255)), ((226, 120, 30), (255, 255, 255), (60, 30, 10)),
             ((30, 58, 112), (255, 255, 255), (230, 190, 90)), ((120, 28, 52), (250, 232, 200), (230, 170, 90))],
    "market": [((236, 168, 36), (40, 30, 10), (150, 20, 20)), ((20, 110, 60), (255, 255, 255), (255, 220, 60)), ((240, 240, 236), (200, 30, 30), (30, 60, 140)),
               ((30, 74, 150), (255, 255, 255), (255, 200, 40)), ((200, 40, 40), (255, 255, 255), (255, 230, 120)), ((42, 42, 46), (255, 255, 255), (230, 80, 60))],
    "fashion": [((28, 28, 32), (232, 196, 110), (232, 196, 110)), ((244, 240, 232), (30, 30, 34), (180, 140, 60)), ((110, 30, 60), (250, 232, 214), (230, 190, 120)),
                ((20, 52, 84), (240, 240, 240), (200, 170, 100)), ((236, 206, 206), (90, 30, 40), (160, 70, 80)), ((20, 20, 20), (255, 255, 255), (255, 255, 255))],
    "health": [((24, 132, 82), (255, 255, 255), (255, 255, 255)), ((244, 248, 246), (24, 120, 76), (24, 120, 76)), ((30, 110, 150), (255, 255, 255), (170, 230, 220)),
               ((238, 244, 250), (30, 80, 140), (200, 40, 50))],
    "money": [((26, 66, 138), (255, 255, 255), (240, 200, 80)), ((200, 30, 40), (255, 255, 255), (255, 255, 255)), ((20, 20, 24), (240, 240, 240), (230, 190, 80)),
              ((0, 120, 120), (255, 255, 255), (255, 255, 255)), ((240, 240, 240), (26, 66, 138), (26, 66, 138)), ((90, 90, 96), (255, 255, 255), (255, 200, 50))],
    "serv": [((78, 88, 100), (255, 255, 255), (255, 200, 60)), ((240, 240, 236), (50, 60, 70), (230, 80, 60)), ((30, 100, 140), (255, 255, 255), (255, 255, 255)),
             ((226, 120, 30), (255, 255, 255), (40, 30, 20)), ((30, 30, 36), (120, 220, 200), (120, 220, 200)), ((140, 40, 100), (255, 255, 255), (250, 210, 230))],
    "lodge": [((106, 58, 128), (255, 255, 255), (240, 210, 140)), ((20, 40, 70), (240, 220, 160), (240, 220, 160)), ((244, 238, 226), (60, 40, 30), (170, 130, 60)),
              ((30, 80, 70), (255, 255, 255), (230, 200, 120))],
    "cult": [((148, 54, 98), (255, 255, 255), (255, 214, 140)), ((20, 20, 28), (255, 90, 90), (255, 255, 255)), ((50, 40, 90), (255, 255, 255), (250, 210, 90)), ((236, 232, 224), (40, 40, 50), (160, 50, 50))],
}
PRIORITY = {"food": 0, "market": 1, "fashion": 2, "health": 3, "money": 4, "serv": 5, "lodge": 6, "cult": 7}
_FONTS = {}


def font(size, fname="arialbd.ttf"):
    k = (size, fname)
    if k in _FONTS: return _FONTS[k]
    f = None
    for path in (f"C:/Windows/Fonts/{fname}", "C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
        if os.path.exists(path):
            f = ImageFont.truetype(path, size); break
    _FONTS[k] = f or ImageFont.load_default()
    return _FONTS[k]


def _mix(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_cell(im, idx, name, catsub):
    cat, _, sub = catsub.partition("|")
    col, row = idx % COLS, idx // COLS
    x0, y0 = col * CELL_W, row * CELL_H
    h = zlib.crc32(name.encode("utf-8"))
    pal = PAL.get(cat, PAL["serv"])
    bg, fg, ac = pal[h % len(pal)]
    style = (h >> 8) % 5
    fname = FONT_FILES[(h >> 12) % len(FONT_FILES)]
    if cat == "health" and sub == "pharmacy": fname = "arialbd.ttf"
    d = ImageDraw.Draw(im)
    x1, y1 = x0 + CELL_W - 1, y0 + CELL_H - 1
    d.rectangle([x0, y0, x1, y1], fill=bg)
    tx0, tx1 = x0 + 14, x1 - 14                       # zona de texto
    if style == 0:                                    # marco fino
        d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], outline=ac, width=2)
    elif style == 1:                                  # banda de acento abajo y arriba
        d.rectangle([x0, y1 - 8, x1, y1], fill=ac); d.rectangle([x0, y0, x1, y0 + 4], fill=ac)
    elif style == 2:                                  # caja de color a la izquierda con la inicial
        bw = CELL_H - 6
        d.rectangle([x0 + 3, y0 + 3, x0 + 3 + bw, y1 - 3], fill=ac)
        ini = name.strip()[:1].upper(); f0 = font(40, "georgiab.ttf" if h & 1 else "arialbd.ttf")
        wi = d.textlength(ini, font=f0)
        d.text((x0 + 3 + (bw - wi) / 2, y0 + 5), ini, font=f0, fill=bg)
        tx0 = x0 + bw + 14
    elif style == 3:                                  # degradado vertical suave
        for yy in range(CELL_H): d.line([x0, y0 + yy, x1, y0 + yy], fill=_mix(bg, _mix(bg, (0, 0, 0), 0.4), yy / CELL_H))
        d.line([x0 + 6, y1 - 6, x1 - 6, y1 - 6], fill=ac, width=2)
    else:                                             # franjas laterales
        d.rectangle([x0, y0, x0 + 9, y1], fill=ac); d.rectangle([x1 - 9, y0, x1, y1], fill=ac)
        tx0, tx1 = x0 + 20, x1 - 20
    if sub == "pharmacy":                              # cruz de farmacia
        cx, cy, r = x0 + 30, y0 + CELL_H // 2, 17
        cross = (30, 170, 90) if bg[1] < 200 and sum(bg) < 500 and bg != (24, 132, 82) else (24, 140, 84)
        cc = (255, 255, 255) if bg == (24, 132, 82) else cross
        d.rectangle([cx - 5, cy - r, cx + 5, cy + r], fill=cc); d.rectangle([cx - r, cy - 5, cx + r, cy + 5], fill=cc)
        tx0 = x0 + 56
    txt = name.strip()
    if h % 3 == 0 and len(txt) < 24: txt = txt.upper()
    lines = [txt]
    avail = tx1 - tx0
    if len(txt) > 15 and " " in txt:
        best = min((abs(i - len(txt) / 2), i) for i, ch in enumerate(txt) if ch == " ")[1]
        lines = [txt[:best], txt[best + 1:]]
    for size in range(38 if len(lines) == 1 else 28, 11, -1):
        f = font(size, fname)
        w = max(d.textlength(l, font=f) for l in lines)
        if w <= avail and size * len(lines) * 1.1 <= CELL_H - 12: break
    cy0 = y0 + CELL_H / 2 - (2 if style == 1 else 0)
    for i, l in enumerate(lines):
        d.text((tx0 + avail / 2, cy0 + (i - (len(lines) - 1) / 2) * size * 1.1), l, font=f, fill=fg, anchor="mm")


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
        W = min(2.6 + (zlib.crc32(p["name"].encode("utf-8")) % 13) * 0.11, L - 0.8)
        if W < 1.6: continue
        t = max(W / 2 + 0.4, min(L - W / 2 - 0.4, t))
        cx, cz = a[0] + tx * t, a[1] + tz * t
        if any(math.hypot(cx - u[0], cz - u[1]) < 3.4 for u in used): continue
        used.append((cx, cz))
        out.append((p["name"], p["cat"] + "|" + p.get("sub", ""), cx, cz, nx, nz, W, float(hf(cx, cz))))
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
