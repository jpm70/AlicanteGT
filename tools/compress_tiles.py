"""Comprime con meshopt (+ cuantización) los .glb de public/world/tiles. Idempotente: salta los ya comprimidos.
Requiere bun (usa `bunx @gltf-transform/cli`). Ejecutar DESPUÉS de build_tiles.py: python tools/compress_tiles.py
El juego los descomprime en el navegador con MeshoptDecoder (src/world/WorldScene.ts)."""
import glob, json, os, shutil, struct, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

DIR = "public/world/tiles"
CLI = "@gltf-transform/cli@4.1.1"


def compressed(path):
    with open(path, "rb") as f:
        head = f.read(20)
        n = struct.unpack("<I", head[12:16])[0]
        js = json.loads(f.read(n) if False else open(path, "rb").read(20 + n)[20:20 + n])
    return "EXT_meshopt_compression" in (js.get("extensionsUsed") or [])


def work(path):
    if compressed(path): return (path, 0, 0, "ya")
    tmp = os.path.join(tempfile.gettempdir(), "gt_" + os.path.basename(path))
    a = os.path.getsize(path)
    r = subprocess.run(["bunx", CLI, "meshopt", path, tmp, "--level", "high"], capture_output=True, text=True, shell=(os.name == "nt"))
    if r.returncode != 0 or not os.path.exists(tmp): return (path, a, a, "ERROR " + (r.stderr or r.stdout)[-200:])
    b = os.path.getsize(tmp); shutil.move(tmp, path)
    return (path, a, b, "ok")


if __name__ == "__main__":
    files = sorted(g for g in glob.glob(f"{DIR}/*.glb") if os.path.getsize(g) > 0)
    ta = tb = 0
    with ThreadPoolExecutor(max_workers=3) as ex:
        for p, a, b, st in ex.map(work, files):
            ta += a; tb += b
            print(os.path.basename(p), f"{a/1e6:.1f} -> {b/1e6:.1f} MB", st, flush=True)
    print(f"TOTAL {ta/1e6:.0f} -> {tb/1e6:.0f} MB")
