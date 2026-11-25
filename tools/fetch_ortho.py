"""Ortofoto PNOA (IGN, CC BY 4.0) del tramo piloto vía WMS, sin API key -> public/world/ortho.jpg
Región en metros locales (x -1148..900, z -900..636), 0,5 m/px = 4096 x 3072 px."""
import math, io, os, sys, time, requests
from PIL import Image
LAT0, LNG0 = 38.3432, -0.4820
KLAT = 111320.0; KLNG = 111320.0 * math.cos(math.radians(LAT0))
X0, X1, Z0, Z1 = -1148, 900, -900, 636
MPP = 0.5
NX, NY = 4, 3                              # 12 teselas de 1024 px
W = int((X1 - X0) / MPP); H = int((Z1 - Z0) / MPP)
tw, th = W // NX, H // NY
lat_n = LAT0 - Z0 / KLAT; lat_s = LAT0 - Z1 / KLAT
lng_w = LNG0 + X0 / KLNG; lng_e = LNG0 + X1 / KLNG
out = Image.new("RGB", (W, H))
URL = "https://www.ign.es/wms-inspire/pnoa-ma"
for j in range(NY):            # filas de norte a sur
    for i in range(NX):
        la1 = lat_n - (lat_n - lat_s) * j / NY; la0 = lat_n - (lat_n - lat_s) * (j + 1) / NY
        lo0 = lng_w + (lng_e - lng_w) * i / NX; lo1 = lng_w + (lng_e - lng_w) * (i + 1) / NX
        bb = f"{la0:.7f},{lo0:.7f},{la1:.7f},{lo1:.7f}"
        img = None
        for size in (tw, 1280, 900, 640, tw, 1280, 900):     # el WMS falla de forma caprichosa según el tamaño pedido
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
