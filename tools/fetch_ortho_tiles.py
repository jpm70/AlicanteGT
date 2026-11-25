"""Ortofoto PNOA (IGN, CC BY 4.0) por teselas de 1 km -> tools/data/ortho_t/<tx>_<tz>.jpg (WMS, sin API key).
Cerca del centro 2048 px (2x2 peticiones de 1024), fuera 1024 px. El WMS del IGN solo responde bien a ciertos tamaños."""
import io, os, sys, time
import requests
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from world_config import tiles, tile_bbox_ll, ortho_px

OUT = "tools/data/ortho_t"
os.makedirs(OUT, exist_ok=True)
URL = "https://www.ign.es/wms-inspire/pnoa-ma"

def get(bb, size):
    s, w, n, e = bb
    for sz in (size, 1280, 1024, 640, size, 1280, 1024):
        p = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS="OI.OrthoimageCoverage", STYLES="", CRS="EPSG:4326",
                 BBOX=f"{s:.7f},{w:.7f},{n:.7f},{e:.7f}", WIDTH=sz, HEIGHT=sz, FORMAT="image/jpeg")
        try:
            r = requests.get(URL, params=p, timeout=120, headers={"User-Agent": "alicantegt-build/1.0"})
        except Exception as ex:
            time.sleep(3); continue
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            im = Image.open(io.BytesIO(r.content)).convert("RGB")
            return im if sz == size else im.resize((size, size), Image.LANCZOS)
        time.sleep(2)
    raise SystemExit("fallo WMS")

for tx, tz in tiles():
    path = f"{OUT}/{tx}_{tz}.jpg"
    if os.path.exists(path): continue
    px = ortho_px(tx, tz); s, w, n, e = tile_bbox_ll(tx, tz)
    if px == 2048:
        out = Image.new("RGB", (2048, 2048))
        for j in range(2):
            for i in range(2):
                la1 = n - (n - s) * j / 2; la0 = n - (n - s) * (j + 1) / 2
                lo0 = w + (e - w) * i / 2; lo1 = w + (e - w) * (i + 1) / 2
                out.paste(get((la0, lo0, la1, lo1), 1024), (i * 1024, j * 1024))
    else:
        out = get((s, w, n, e), 1024)
    out.save(path, quality=78, optimize=True, progressive=True)
    print(f"{tx}_{tz} {px}px {os.path.getsize(path)//1024} KB", flush=True)
print("OK", flush=True)
