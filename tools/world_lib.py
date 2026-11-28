"""Primitivas geométricas y escritura de GLB compartidas por build_tiles.py (extraído de build_world.py)."""
import math
import numpy as np, trimesh
from shapely.geometry import Polygon


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


def cyl_at(cx, cz, ybase, ytop, r, col, sections=28):
    m = trimesh.creation.cylinder(radius=r, height=ytop - ybase, sections=sections)
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    m.apply_translation([cx, (ybase + ytop) / 2, cz])
    V = np.asarray(m.vertices); return V, np.asarray(m.faces), _vc(V, col)

def statue_at(cx, cz, y, sc, col, star=True):
    """Figura estilizada: falda cónica, torso, cabeza, brazos en alto y estrella."""
    parts = []
    cone = trimesh.creation.cone(radius=0.75 * sc, height=2.3 * sc, sections=16)
    cone.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0])); cone.apply_translation([cx, y, cz])
    V = np.asarray(cone.vertices); parts.append((V, np.asarray(cone.faces), _vc(V, col)))
    parts.append(cyl_at(cx, cz, y + 2.1 * sc, y + 3.1 * sc, 0.34 * sc, col, 12))
    parts.append(dome_at(cx, cz, y + 3.05 * sc, 0.3 * sc, 0.34 * sc, col))
    for sgn in (-1, 1):   # brazos en alto
        b = trimesh.creation.box(extents=[0.18 * sc, 1.2 * sc, 0.18 * sc])
        b.apply_transform(trimesh.transformations.rotation_matrix(sgn * 0.45, [0, 0, 1]))
        b.apply_translation([cx + sgn * 0.62 * sc, y + 3.55 * sc, cz])
        V = np.asarray(b.vertices); parts.append((V, np.asarray(b.faces), _vc(V, col)))
    if star:
        st = trimesh.creation.icosphere(subdivisions=1, radius=0.38 * sc)
        st.apply_translation([cx, y + 4.55 * sc, cz])
        V = np.asarray(st.vertices); parts.append((V, np.asarray(st.faces), _vc(V, hexrgb(0xf0d27a))))
        for ang in (0, math.pi / 2):
            r_ = trimesh.creation.box(extents=[1.5 * sc, 0.12 * sc, 0.12 * sc])
            r_.apply_transform(trimesh.transformations.rotation_matrix(ang + math.pi / 4, [0, 0, 1]))
            r_.apply_translation([cx, y + 4.55 * sc, cz])
            V = np.asarray(r_.vertices); parts.append((V, np.asarray(r_.faces), _vc(V, hexrgb(0xf0d27a))))
    return parts

def fountain_at(cx, cz, g, R, sc, stone, water, bronze, star=True):
    parts = []
    parts.append(cyl_at(cx, cz, g - 0.5, g + 0.95, R, stone, 40))               # borde del estanque
    parts.append(cyl_at(cx, cz, g + 0.5, g + 0.82, R - 0.8, water, 40))         # agua
    parts.append(cyl_at(cx, cz, g + 0.5, g + 1.3, R * 0.34, stone, 28))         # taza central
    parts.append(cyl_at(cx, cz, g + 0.5, g + 2.4 * sc, 0.55 * sc, stone, 16))   # pedestal
    parts.append(cyl_at(cx, cz, g + 2.4 * sc, g + 2.9 * sc, 0.95 * sc, stone, 16))
    parts += statue_at(cx, cz, g + 2.9 * sc, sc, bronze, star)
    return parts


def horse_at(hx, hz, y, yaw, sc, body, dark):
    """Caballo encabritado con volúmenes inclinados (marco local: +x adelante, +y arriba, +z lateral): grupa, cuello arqueado, cabeza, crin, orejas, cola,
    patas traseras apoyadas y delanteras en alto con casco doblado."""
    parts = []
    def seg(c, ext, rz, col):                         # c = centro local, ext = (largo x, alto y, ancho z), rz = giro sobre z (rad)
        b = trimesh.creation.box(extents=list(ext))
        b.apply_transform(trimesh.transformations.rotation_matrix(rz, [0, 0, 1])); b.apply_translation(c)
        b.apply_scale(sc); b.apply_transform(trimesh.transformations.rotation_matrix(yaw, [0, 1, 0])); b.apply_translation([hx, y, hz])
        V = np.asarray(b.vertices); parts.append((V, np.asarray(b.faces), _vc(V, col)))
    seg((-0.15, 1.75, 0), (2.0, 0.95, 0.85), 0.5, body)                 # tronco inclinado (cabeza arriba)
    seg((0.55, 1.45, 0), (0.9, 0.9, 0.8), 0.5, body)                    # pecho
    seg((0.95, 2.55, 0), (0.55, 1.35, 0.5), -0.55, body)                # cuello arqueado
    seg((0.72, 2.7, 0), (0.16, 1.35, 0.3), -0.55, dark)                 # crin
    seg((1.55, 3.2, 0), (0.95, 0.36, 0.36), -0.9, body)                 # cabeza (hocico hacia delante y abajo)
    for zz in (-0.12, 0.12): seg((1.2, 3.55, zz), (0.1, 0.3, 0.1), -0.2, dark)   # orejas
    seg((-1.35, 1.35, 0), (0.17, 1.3, 0.22), 0.55, dark)                # cola
    for zz in (-0.28, 0.28):
        seg((-0.75, 0.62, zz), (0.28, 1.25, 0.26), 0.12, body)          # patas traseras
        seg((-0.78, 0.07, zz), (0.4, 0.14, 0.3), 0, dark)               # cascos
    for zz in (-0.28, 0.28):
        seg((1.1, 1.95, zz), (0.26, 0.95, 0.24), -1.0, body)            # brazo delantero levantado
        seg((1.62, 1.72, zz), (0.22, 0.8, 0.22), 0.5, body)             # caña doblada
        seg((1.72, 1.32, zz), (0.3, 0.14, 0.26), 0.3, dark)             # casco
    return parts


def luceros_at(cx, cz, g, R):
    """Fuente de la Plaza de los Luceros (Daniel Bañuls, 1930s): pila circular de arenisca con borde festoneado, cuerpo central escalonado,
    cuatro grupos de caballos y una torre estrecha y escalonada con figura en relieve y remate en punta (referencia: fotos aportadas por el usuario)."""
    sand = hexrgb(0xd2b78c); dark = hexrgb(0xb89a6c); light = hexrgb(0xe3d2b0); water = hexrgb(0x4aa3d6); foam = hexrgb(0xdff1fa)
    P = []
    P.append(cyl_at(cx, cz, g - 0.5, g + 0.6, R, sand, 48))                                   # muro de la pila
    P.append(cyl_at(cx, cz, g + 0.4, g + 0.82, R - 0.9, water, 48))                             # agua
    for k in range(40):                                                                         # borde festoneado: media esfera por «gallón»
        a = k * 2 * math.pi / 40
        P.append(dome_at(cx + math.cos(a) * (R - 0.35), cz + math.sin(a) * (R - 0.35), g + 0.55, 0.62, 0.5, dark))
    P.append(cyl_at(cx, cz, g + 0.4, g + 1.7, R * 0.64, dark, 36))                             # base circular escalonada
    P.append(cyl_at(cx, cz, g + 1.7, g + 2.3, R * 0.56, sand, 36))
    for k in range(8):                                                                          # chorros: surtidores bajos alrededor
        a = k * math.pi / 4 + math.pi / 8
        P.append(cyl_at(cx + math.cos(a) * (R * 0.72), cz + math.sin(a) * (R * 0.72), g + 0.9, g + 2.0, 0.09, foam, 6))
    for k in range(4):                                                                          # grupos de caballos en las diagonales
        a = math.pi / 4 + k * math.pi / 2; ca, sa = math.cos(a), math.sin(a)
        hx_, hz_ = cx + ca * R * 0.46, cz + sa * R * 0.46                                      # peana
        ang = -(a + math.pi / 2)                                                                # el caballo mira en sentido tangente
        tx, tz = -sa, ca
        P.append(box_at(hx_ + tx * 0.3, hz_ + tz * 0.3, g + 2.3, g + 3.0, 4.0, 1.7, ang, dark))
        P += horse_at(hx_, hz_, g + 3.0, ang, 1.05, sand, dark)
    def pinnacle(px, pz, y0, h, w):                                                             # pináculo: fuste cuadrado, cornisilla y aguja corta con bola
        P.append(box_at(px, pz, y0, y0 + h, w, w, 0, sand))
        P.append(box_at(px, pz, y0 + h, y0 + h + 0.12, w * 1.5, w * 1.5, 0, light))
        P.append(pyramid_at(px, pz, y0 + h + 0.12, w * 0.7, h * 0.9, dark))
    P.append(box_at(cx, cz, g + 2.3, g + 4.4, 3.9, 3.9, 0, dark))                               # zócalo de la torre
    for sx in (-1, 1):
        for sz in (-1, 1):
            pinnacle(cx + sx * 1.55, cz + sz * 1.55, g + 4.4, 1.0, 0.42)                         # pináculos sobre el zócalo
    P.append(box_at(cx, cz, g + 4.4, g + 8.6, 2.5, 2.5, 0, sand))                               # primer cuerpo
    P.append(box_at(cx, cz, g + 8.6, g + 9.0, 3.0, 3.0, 0, light))                              # primera cornisa
    for sx in (-1, 1):
        for sz in (-1, 1):
            pinnacle(cx + sx * 1.25, cz + sz * 1.25, g + 9.0, 1.3, 0.38)                         # pináculos de la primera cornisa
    P.append(box_at(cx, cz, g + 9.0, g + 16.6, 1.65, 1.65, 0, sand))                            # fuste esbelto
    for ang in (0, math.pi / 2):                                                                # figura en relieve en las cuatro caras
        P.append(box_at(cx, cz, g + 10.3, g + 14.2, 0.6, 1.8, ang, light))
        P.append(box_at(cx, cz, g + 14.2, g + 14.9, 0.46, 1.82, ang, dark))                     # dosel sobre la figura
        P.append(box_at(cx, cz, g + 9.6, g + 10.3, 0.4, 1.72, ang, dark))                       # peana de la figura
    P.append(box_at(cx, cz, g + 16.6, g + 17.1, 2.2, 2.2, 0, light))                            # cornisa superior
    for sx in (-1, 1):
        for sz in (-1, 1):
            pinnacle(cx + sx * 0.9, cz + sz * 0.9, g + 17.1, 0.9, 0.3)                           # pináculos de la cornisa superior
    P.append(box_at(cx, cz, g + 17.1, g + 19.6, 1.15, 1.15, 0, sand))                           # linterna
    P.append(box_at(cx, cz, g + 19.6, g + 19.9, 1.5, 1.5, 0, light))
    P.append(pyramid_at(cx, cz, g + 19.9, 0.62, 5.0, dark))                                     # aguja
    P.append(dome_at(cx, cz, g + 24.8, 0.26, 0.26, hexrgb(0xe9d9a8)))                           # remate
    return P


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


def join_parts(lst):
    """[(V, F, C)] -> (V, F, C RGBA) concatenados."""
    o = 0; V, F, C = [], [], []
    for v, f, c in lst:
        V.append(v); F.append(f + o); C.append(np.column_stack([c[:, :3], np.full(len(c), 255)])); o += len(v)
    return np.vstack(V), np.vstack(F), np.vstack(C)
