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
scene = trimesh.Scene()
def add(name, geom, y, col):
    m = tri_mesh(geom, y, col)
    if m is not None: scene.add_geometry(m, node_name=name, geom_name=name)
add("Ground", land, 0.0, hexrgb(0xb7ad98))
add("Park", parks, 0.02, hexrgb(0x5f8a4a))
add("Road", roads.difference(sea_free), 0.03, hexrgb(0x3a3d42))
add("Sidewalk", walk.difference(sea_free), 0.06, hexrgb(0xc9c0ab))
add("Water", sea_free if not sea_free.is_empty else Polygon(), -0.45, hexrgb(0x1d6fa5))
scene.add_geometry(buildings, node_name="Buildings", geom_name="Buildings")
os.makedirs("public/world", exist_ok=True)
scene.export("public/world/alicante.glb")
sea_tiles = []
if not sea_free.is_empty:
    T = 150
    for gx in range(-1700, 900, T):
        for gz in range(-1100, 900, T):
            part = sea_free.intersection(box(gx, gz, gx+T, gz+T))
            for g in ([part] if isinstance(part, Polygon) else list(getattr(part, "geoms", []))):
                if isinstance(g, Polygon) and g.area > 4:
                    sea_tiles.append({"id":-1,"h":0,"p":[[round(x,2),round(z,2)] for x,z in g.exterior.coords]})
json.dump({"origin":{"lat":LAT0,"lng":LNG0},"buildings":collid,"obstacles":tree_obst+sea_tiles,
           "roads":road_lines,"trees":trees,"lamps":lamps}, open("public/world/colliders.json","w"))
print("mar m2", int(sea_free.area), "tiles", len(sea_tiles), "arboles", len(trees), "parques m2", int(parks.area), "farolas", len(lamps), "|", "edificios", len(collid), "calles", len(road_lines), "glb KB", os.path.getsize("public/world/alicante.glb")//1024)
