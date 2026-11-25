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
