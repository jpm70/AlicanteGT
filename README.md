# Alicante GT — Carreras 3D en las calles reales de Alicante

Juego de conducción 3D **100 % client-side** por **Alicante** (Explanada de España, Puerto, Postiguet, Rambla, Luceros, Benalúa, Carolinas, el Castillo de Santa Bárbara y la zona del Hospital), hecho con **React**, **TypeScript**, **Tailwind CSS** y **Three.js**.

No usa mapas en línea ni API keys: el mundo es un archivo `.glb` propio generado a partir de **datos abiertos** (OpenStreetMap, EU-DEM y la ortofoto del PNOA del IGN).

---

## Qué hay en el mundo

- **Calles, aceras y plazas reales** de OpenStreetMap, con ancho según el tipo de vía y la ortofoto aérea del **PNOA** (IGN, 0,5 m/px) sobre el suelo, la calzada y el mar: se ven carriles, pasos de cebra y el puerto con sus barcos.
- **Edificios con su altura real**: plantas por volumen del **Catastro** (INSPIRE) sobre las huellas de OSM, con retranqueos, cuerpos bajos y patios interiores. El **año de construcción** y el uso eligen el estilo de fachada (ensanche, casco antiguo, bloque de los 60-70 o moderno), con planta baja distinta, balcones, persianas, toldos y **ventanas que se encienden de noche**.
- **Relieve real** (EU-DEM 25 m): la subida al Benacantil, el barrio de Santa Cruz en ladera. Coche y cámara siguen la pendiente.
- **Mar, costa, muelles, parques**, 738 árboles (62 palmeras *Phoenix canariensis*), farolas y semáforos de OSM.
- **Hitos**: Castillo de Santa Bárbara (murallas con almenas, torres y torre del Homenaje), **mosaico ondulado de la Explanada**, Ayuntamiento con torres, Concatedral de San Nicolás, Basílica de Santa María, Mercado Central (cúpula con linterna, torres de esquina y portada), Auditorio La Concha, la **fuente con estatua de la Plaza de los Luceros**, la Fuente de la Aguadora y el barrio de Santa Cruz en blanco y pastel.
- **Física y límites**: colisión con edificios, mar y troncos, y **límite de calzada** (el coche solo circula por calzada, aceras, plazas y la Explanada).

## Coche, cámaras y ambientes

- Deportivo GT procedimental en Three.js (carrocería con clearcoat, 4 ruedas, faros, luces de freno, humo al derrapar, 5 pinturas).
- 3 cámaras: **Persecución**, **Modo Conductor** (cockpit interactivo) y **Aérea**.
- 3 ambientes: **Atardecer Mediterráneo**, **Noche Neón** y **Día**.
- Motor y derrape sintetizados con Web Audio (sin archivos de audio).
- 13 puntos de salida: Explanada, Castillo, Ayuntamiento, Mercado Central, Santa Cruz, Luceros, Concatedral, Santa María, Estación Terminal, Auditorio ADDA, Puerto, Postiguet y Alfonso X (más Puerto, Postiguet y Alfonso X).

## Controles

| Acción | Teclado | Táctil |
| :--- | :--- | :--- |
| Acelerar | `W` o `↑` | Botón **Gas** |
| Frenar / marcha atrás | `S` o `↓` | Botón **Freno** |
| Girar | `A` / `D` o `←` / `→` | Botones `←` / `→` |
| Freno de mano / derrape | `Espacio` | Botón **Derrape** |
| Cambiar cámara | `C` | Botón de cámara |
| Cambiar ambiente | `1` / `2` / `3` | Selector del HUD |
| Reiniciar posición | `R` | Botón reiniciar |
| Ocultar / mostrar panel | `H` | Pestaña superior |

---

## Cómo se genera el mundo

El mundo no se descarga en tiempo de juego: se construye una vez con scripts de Python y se guarda en `public/world/`, dividido en **35 teselas de 1 km** (7 × 5, ~35 km² entre Playa de San Juan, Benalúa, Carolinas, Hospital y el Puerto). El juego carga las 9 teselas cercanas al coche y descarga las lejanas.

```bash
pip install requests numpy shapely trimesh mapbox_earcut pyproj pygltflib pillow osmium

# 1. OpenStreetMap: extracto de la Comunidad Valenciana (Geofabrik, ~140 MB) recortado por teselas
curl -L -o tools/data/geofabrik/valencia.osm.pbf https://download.geofabrik.de/europe/spain/valencia-latest.osm.pbf
python tools/pbf_to_tiles.py
python tools/fetch_dem.py            # elevaciones EU-DEM 25 m (opentopodata.org), ~50.000 puntos
python tools/fetch_catastro.py       # plantas, año y uso (Catastro INSPIRE, zip municipal de 22 MB)
python tools/fetch_ortho_tiles.py    # ortofoto PNOA (WMS del IGN) por teselas
python tools/build_tiles.py          # genera public/world/tiles/*, manifest.json y dem.json
python tools/build_tiles.py 0,-1     # (opcional) reconstruye solo una tesela
```

- Los datos descargados quedan en `tools/data/` (en `.gitignore`); `public/world/` sí está versionado (~90 MB).
- `tools/world_config.py` define el origen (Explanada), el tamaño de tesela y la región. Para otra zona, cambia ahí el rango `TX_RANGE`/`TZ_RANGE` y el origen.
- Cada tesela tiene `<tx>_<tz>.glb` (capas `Ground`, `Park`, `Road`, `Sidewalk`, `Mosaic`, `Water`, `Walls`, `Roofs`, `Castle`, `Landmark`), `<tx>_<tz>.json` (huellas de edificios, obstáculos, árboles, farolas y máscara transitable a 2 m) y `<tx>_<tz>.jpg` (ortofoto: 2048 px cerca del centro, 1024 px fuera).
- Los servidores públicos de Overpass se saturan a menudo; por eso se usa el extracto de Geofabrik. El WMS del IGN solo responde bien a algunos tamaños (640, 900, 1024, 1280 px) y el script reintenta.

## Estructura

```text
.
├── tools/                      # Generación del mundo (Python)
├── public/world/               # manifest.json, dem.json y tiles/ (glb + json + jpg)
└── src/
    ├── App.tsx                 # Bucle de juego, entrada y HUD
    ├── game/                   # Física del coche, constantes, audio, cielo
    ├── scene/
    │   ├── createSportsCar.ts  # Deportivo 3D procedimental (luces, ruedas, humo)
    │   └── carBody.ts          # Carrocería moldeada por secciones, neumáticos y llantas
    ├── world/
    │   ├── WorldScene.ts       # Escena Three.js: teselas, coche, cámara, luces, árboles
    │   ├── facades.ts          # Atlas procedimental de fachadas y mosaico de la Explanada
    │   ├── collision.ts        # Colisión con edificios/mar y límite de calzada, por teselas
    │   └── geo.ts              # lat/lng ↔ metros locales y altura del terreno
    └── components/             # HUD y cockpit
```

## Desarrollo local

Requisitos: **Bun** (el proyecto trae `bun.lock`) o Node.js >= 20.

```bash
bun install
bun run dev      # http://localhost:3000
bun run lint     # tsc --noEmit
bun run build    # producción en /dist
```

## Despliegue

SPA estática sin backend ni claves. El workflow `.github/workflows/deploy.yml` construye con Bun y publica en **GitHub Pages** bajo `/AlicanteGT/` (variable `VITE_PUBLIC_BASE_URL`). Hay que activar Pages con origen «GitHub Actions» en los ajustes del repo.

---

## Atribución y licencia

- Ortofoto © [Instituto Geográfico Nacional de España](https://www.ign.es/) · PNOA, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.es).
- Edificios (plantas, año y uso): © [Dirección General del Catastro](https://www.catastro.hacienda.gob.es/), INSPIRE, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.es).
- Datos cartográficos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), vía el extracto de [Geofabrik](https://download.geofabrik.de/).
- Relieve: EU-DEM (Copernicus) vía [OpenTopoData](https://www.opentopodata.org/).
- Código bajo licencia **MIT**: consulta [`LICENSE`](./LICENSE).
