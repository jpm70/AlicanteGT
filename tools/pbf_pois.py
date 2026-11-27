"""Comercios y locales con nombre del extracto OSM (Geofabrik, ODbL) -> tools/data/pois.json
Cada entrada: {x, z, name, cat, sub}  (metros locales; cat = grupo de color del cartel, sub = etiqueta OSM).
Uso: python tools/pbf_pois.py"""
import json, os, sys
import osmium
sys.path.insert(0, os.path.dirname(__file__))
from world_config import X0, X1, Z0, Z1, to_ll, KLAT, KLNG, LAT0, LNG0

PBF = "tools/data/geofabrik/valencia.osm.pbf"
lat_n, lng_w = to_ll(X0, Z0); lat_s, lng_e = to_ll(X1, Z1)

FOOD = {"restaurant", "cafe", "bar", "fast_food", "pub", "ice_cream", "biergarten", "bakery", "pastry", "confectionery", "butcher", "greengrocer", "seafood", "deli", "wine", "beverages", "coffee"}
HEALTH = {"pharmacy", "clinic", "doctors", "dentist", "optician", "hospital", "veterinary", "chemist"}
MONEY = {"bank", "atm", "bureau_de_change", "insurance", "estate_agent", "travel_agency"}
SERV = {"hairdresser", "beauty", "laundry", "dry_cleaning", "post_office", "copyshop", "photo", "mobile_phone", "computer", "electronics", "locksmith", "car_repair", "car_rental"}
FASHION = {"clothes", "shoes", "jewelry", "fashion", "bag", "boutique", "tailor", "fashion_accessories", "perfumery", "cosmetics"}
MARKET = {"supermarket", "convenience", "mall", "department_store", "variety_store", "kiosk", "tobacco", "newsagent", "books", "stationery", "gift", "florist", "toys", "sports", "bicycle", "furniture", "hardware", "pet", "general"}
LODGE = {"hotel", "hostel", "guest_house", "apartment", "motel"}
EDU = {"school", "language_school", "music_school", "driving_school", "training", "college", "kindergarten", "university", "dancing_school", "prep_school", "tutoring", "educational_institution", "research_institute"}
GYM = {"fitness_centre", "sports_centre", "dance", "yoga", "swimming_pool", "pitch"}
SKIP_AMENITY = {"parking", "bench", "toilets", "bicycle_parking", "waste_basket", "shelter", "fountain", "post_box", "recycling", "parking_entrance", "parking_space", "bicycle_rental", "charging_station", "taxi", "bus_station", "drinking_water", "clock", "vending_machine", "grave_yard", "place_of_worship", "motorcycle_parking", "waste_disposal", "bbq", "telephone", "atm"}
CULT = {"theatre", "cinema", "museum", "gallery", "arts_centre", "nightclub", "casino", "library"}


# Rótulo genérico (en castellano) para locales sin nombre en OSM: el tipo de negocio, no un nombre inventado
GENERIC = {"pharmacy": "Farmacia", "bakery": "Panadería", "pastry": "Pastelería", "confectionery": "Confitería", "hairdresser": "Peluquería", "beauty": "Estética",
           "bar": "Bar", "cafe": "Cafetería", "restaurant": "Restaurante", "fast_food": "Comida rápida", "pub": "Pub", "ice_cream": "Heladería",
           "bank": "Banco", "supermarket": "Supermercado", "convenience": "Tienda", "clothes": "Moda", "shoes": "Zapatería", "butcher": "Carnicería",
           "greengrocer": "Frutería", "seafood": "Pescadería", "deli": "Charcutería", "kiosk": "Kiosco", "tobacco": "Estanco", "newsagent": "Prensa",
           "optician": "Óptica", "dentist": "Clínica dental", "doctors": "Consulta médica", "clinic": "Clínica", "veterinary": "Veterinario",
           "laundry": "Lavandería", "dry_cleaning": "Tintorería", "florist": "Floristería", "books": "Librería", "stationery": "Papelería",
           "jewelry": "Joyería", "mobile_phone": "Telefonía", "estate_agent": "Inmobiliaria", "travel_agency": "Agencia de viajes", "car_repair": "Taller",
           "hotel": "Hotel", "hostel": "Hostal", "guest_house": "Pensión", "hardware": "Ferretería", "furniture": "Muebles", "electronics": "Electrónica",
           "gift": "Regalos", "toys": "Juguetería", "bicycle": "Bicicletas", "pet": "Mascotas", "copyshop": "Copistería", "photo": "Fotografía",
           "school": "Colegio", "kindergarten": "Escuela infantil", "language_school": "Idiomas", "driving_school": "Autoescuela", "music_school": "Música",
           "fitness_centre": "Gimnasio", "sports_centre": "Centro deportivo", "nightclub": "Discoteca", "cinema": "Cine", "theatre": "Teatro",
           "library": "Biblioteca", "museum": "Museo", "gallery": "Galería de arte", "wine": "Bodega", "beverages": "Bebidas", "coffee": "Café", "variety_store": "Bazar",
           "department_store": "Grandes almacenes", "mall": "Centro comercial", "bag": "Bolsos", "tailor": "Sastrería", "perfumery": "Perfumería", "cosmetics": "Cosmética",
           "locksmith": "Cerrajería", "computer": "Informática", "post_office": "Correos", "insurance": "Seguros", "car_rental": "Alquiler de coches"}


def label_of(tags, sub):
    """Nombre del rótulo: el del local; si no tiene, la marca o el operador; si tampoco, el tipo de negocio."""
    for k in ("name", "brand", "operator"):
        v = tags.get(k)
        if v and len(v) <= 46: return v, False
    g = GENERIC.get(sub)
    return (g, True) if g else (None, False)


def cat_of(tags):
    for k in ("amenity", "shop", "tourism", "office", "craft", "leisure", "healthcare"):
        v = tags.get(k)
        if not v: continue
        if v in EDU: return "edu", v
        if k == "leisure":
            if v in GYM: return "serv", v
            continue
        if k == "healthcare": return "health", v
        if v in FOOD: return "food", v
        if v in HEALTH: return "health", v
        if v in MONEY or k == "office": return "money", v
        if v in LODGE: return "lodge", v
        if v in CULT: return "cult", v
        if v in SERV: return "serv", v
        if v in FASHION: return "fashion", v
        if v in MARKET or k == "shop": return "market", v
        if k == "amenity" and v not in SKIP_AMENITY: return "serv", v
    return None, None


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.out = []

    def add(self, lat, lon, tags):
        if not (lat_s - 0.002 <= lat <= lat_n + 0.002 and lng_w - 0.002 <= lon <= lng_e + 0.002): return
        cat, sub = cat_of(tags)
        if cat is None: return
        name, generic = label_of(tags, sub)
        if not name: return
        e = {"x": round((lon - LNG0) * KLNG, 1), "z": round(-(lat - LAT0) * KLAT, 1), "name": name, "cat": cat, "sub": sub}
        if generic: e["gen"] = 1
        self.out.append(e)

    def node(self, n):
        if "name" in n.tags: self.add(n.location.lat, n.location.lon, {t.k: t.v for t in n.tags})


h = H()
fp = osmium.FileProcessor(PBF).with_locations().with_filter(osmium.filter.KeyFilter("shop", "amenity", "tourism", "office", "craft", "leisure", "healthcare"))
for o in fp:
    if o.is_node():
        t = {x.k: x.v for x in o.tags}
        h.add(o.location.lat, o.location.lon, t)
    elif o.is_way():
        t = {x.k: x.v for x in o.tags}
        if "building" not in t or t.get("shop") or t.get("amenity"):
            try:
                pts = [(n.lat, n.lon) for n in o.nodes if n.location.valid()]
            except Exception:
                continue
            if pts: h.add(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), t)
seen = set(); out = []
for p in h.out:
    k = (p["x"], p["z"], p["name"])
    if k in seen: continue
    seen.add(k); out.append(p)
json.dump(out, open("tools/data/pois.json", "w", encoding="utf-8"), ensure_ascii=False)
import collections
print(len(out), "comercios", dict(collections.Counter(p["cat"] for p in out)))
