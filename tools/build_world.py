"""OSM -> public/world/alicante.glb  (+ colliders.json)
Coordenadas locales en metros: x = este, y = arriba, z = sur (convenio Three.js, -z = norte).
Origen = Explanada. Capas del GLB: Ground, Road, Sidewalk, Buildings."""
import json, math, os, hashlib
import numpy as np, trimesh
from shapely.geometry import Polygon, LineString, MultiPolygon, box
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
roads = unary_union(road_geoms) if road_geoms else Polygon()
walk = unary_union(walk_geoms).difference(roads) if walk_geoms else Polygon()
# acera a ambos lados de calzadas urbanas (1.8 m)
sidew = unary_union([g.buffer(1.8) for g in road_geoms]).difference(roads) if road_geoms else Polygon()
walk = unary_union([walk, sidew])

# ---- edificios
bl, collid = [], []
rng_cols = [0xe9e2d0,0xdcd0b8,0xefe6cf,0xd9c7a3,0xf2ede0,0xcdb89a,0xe6d5b5,0xf5f1e6,0xd8b98f]
bmeshes = []
for e in ways(load("building")):
    pts = [P(p) for p in e["geometry"]]
    if len(pts) < 4: continue
    try: poly = make_valid(Polygon(pts))
    except Exception: continue
    if isinstance(poly, MultiPolygon): poly = max(poly.geoms, key=lambda g: g.area)
    if not isinstance(poly, Polygon) or poly.area < 6: continue
    poly = poly.buffer(0).simplify(0.15)
    if poly.is_empty or not isinstance(poly, Polygon): continue
    t = e["tags"]
    try: h = float(str(t["height"]).replace("m","")) 
    except Exception:
        lv = t.get("building:levels"); h = (float(lv)*3.1 + 1.2) if lv and lv.replace(".","").isdigit() else 10.5
    h = max(3.0, min(h, 90.0))
    seed = int(hashlib.md5(str(e["id"]).encode()).hexdigest()[:6], 16)
    col = hexrgb(rng_cols[seed % len(rng_cols)])
    try: m = trimesh.creation.extrude_polygon(poly, h, engine="earcut")
    except Exception: continue
    v = m.vertices.copy()   # extrude_polygon: (x, y_plano, z_alto)
    nv = np.column_stack([v[:,0], v[:,2], v[:,1]])
    f = m.faces[:, ::-1]
    mm = trimesh.Trimesh(nv, f, process=False); mm.visual.vertex_colors = np.tile(col, (len(nv),1))
    bmeshes.append(mm)
    collid.append({"id":e["id"],"h":round(h,1),"p":[[round(x,2),round(z,2)] for x,z in poly.exterior.coords]})
buildings = trimesh.util.concatenate(bmeshes)

# ---- suelo
ext = box(-1700, -1100, 900, 900)
scene = trimesh.Scene()
g = tri_mesh(ext, 0.0, hexrgb(0xb7ad98)); scene.add_geometry(g, node_name="Ground", geom_name="Ground")
r = tri_mesh(roads, 0.03, hexrgb(0x3a3d42)); scene.add_geometry(r, node_name="Road", geom_name="Road")
s = tri_mesh(walk, 0.06, hexrgb(0xc9c0ab)); scene.add_geometry(s, node_name="Sidewalk", geom_name="Sidewalk")
scene.add_geometry(buildings, node_name="Buildings", geom_name="Buildings")
os.makedirs("public/world", exist_ok=True)
scene.export("public/world/alicante.glb")
json.dump({"origin":{"lat":LAT0,"lng":LNG0},"buildings":collid,"roads":road_lines,
           "roadPolys":[[round(x,2) for x in c] for c in []]}, open("public/world/colliders.json","w"))
print("edificios", len(collid), "calles", len(road_lines), "glb KB", os.path.getsize("public/world/alicante.glb")//1024)
