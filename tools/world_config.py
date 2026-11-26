"""Configuración común del mundo por teselas. Coordenadas locales en metros: x = este, z = sur; origen = Explanada."""
import math

LAT0, LNG0 = 38.3432, -0.4820
KLAT = 111320.0
KLNG = 111320.0 * math.cos(math.radians(LAT0))

TILE = 1000                     # lado de cada tesela (m)
TX_RANGE = range(-3, 6)         # x: -3000 .. 6000
TZ_RANGE = range(-6, 1)         # z: -6000 .. 1000
X0, X1 = TX_RANGE.start * TILE, TX_RANGE.stop * TILE
Z0, Z1 = TZ_RANGE.start * TILE, TZ_RANGE.stop * TILE


def tiles():
    return [(tx, tz) for tz in TZ_RANGE for tx in TX_RANGE]


def tile_box(tx, tz):
    """(x0, z0, x1, z1) de la tesela en metros locales."""
    return tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE


def to_ll(x, z):
    return LAT0 - z / KLAT, LNG0 + x / KLNG


def tile_bbox_ll(tx, tz):
    """(sur, oeste, norte, este) en grados."""
    x0, z0, x1, z1 = tile_box(tx, tz)
    lat_n, lng_w = to_ll(x0, z0)
    lat_s, lng_e = to_ll(x1, z1)
    return lat_s, lng_w, lat_n, lng_e


def ortho_px(tx, tz):
    """Resolución de la ortofoto: 2048 px (0,49 m/px) cerca del centro, 1024 px (0,98 m/px) fuera."""
    cx, cz = (tx + 0.5) * TILE, (tz + 0.5) * TILE
    return 2048 if math.hypot(cx, cz) < 2300 else 1024
