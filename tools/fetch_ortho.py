"""Ortofoto PNOA (IGN, CC BY 4.0) del tramo piloto vía WMS, sin API key -> public/world/ortho.jpg
Región = la del DEM en metros locales (x -700..900, z -900..700), 0,5 m/px."""
import math, io, os, sys, time, requests
from PIL import Image
LAT0, LNG0 = 38.3432, -0.4820
KLAT = 111320.0; KLNG = 111320.0 * math.cos(math.radians(LAT0))
X0, X1, Z0, Z1 = -700, 900, -900, 700
MPP = 0.5
N = 5                                    # 5x5 teselas de 640 px (el WMS falla con otros tamaños)
W = int((X1 - X0) / MPP); H = int((Z1 - Z0) / MPP)
tw, th = W // N, H // N
lat_n = LAT0 - Z0 / KLAT; lat_s = LAT0 - Z1 / KLAT
lng_w = LNG0 + X0 / KLNG; lng_e = LNG0 + X1 / KLNG
out = Image.new("RGB", (W, H))
URL = "https://www.ign.es/wms-inspire/pnoa-ma"
for j in range(N):            # filas de norte a sur
    for i in range(N):
        la1 = lat_n - (lat_n - lat_s) * j / N; la0 = lat_n - (lat_n - lat_s) * (j + 1) / N
        lo0 = lng_w + (lng_e - lng_w) * i / N; lo1 = lng_w + (lng_e - lng_w) * (i + 1) / N
        bb = f"{la0:.7f},{lo0:.7f},{la1:.7f},{lo1:.7f}"
        img = None
        for size in (tw, 900, 1024, 1280, tw, 900, 1024):     # el WMS falla de forma caprichosa según el tamaño pedido
            p = dict(SERVICE="WMS", VERSION="1.3.0", REQUEST="GetMap", LAYERS="OI.OrthoimageCoverage", STYLES="", CRS="EPSG:4326",
                     BBOX=bb, WIDTH=size, HEIGHT=size, FORMAT="image/jpeg")
            try:
                r = requests.get(URL, params=p, timeout=120, headers={"User-Agent": "alicantegt-build/1.0"})
            except Exception as e:
                print("error", i, j, size, str(e)[:60], flush=True); time.sleep(3); continue
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                img = Image.open(io.BytesIO(r.content)).convert("RGB")
                if size != tw: img = img.resize((tw, th), Image.LANCZOS)
                break
            print("reintento", i, j, size, r.status_code, flush=True); time.sleep(2)
        if img is None: sys.exit("fallo WMS")
        out.paste(img, (i * tw, j * th)); print("tesela", i, j, flush=True)
os.makedirs("public/world", exist_ok=True)
out.save("public/world/ortho.jpg", quality=84, optimize=True)
print("OK", W, "x", H, os.path.getsize("public/world/ortho.jpg") // 1024, "KB")
