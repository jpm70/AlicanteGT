# Alicante GT — Carreras 3D en las calles reales de Alicante

Juego de conducción 3D **100 % client-side** por el centro de **Alicante** (Explanada de España, Puerto, Postiguet, Rambla, Luceros y el Castillo de Santa Bárbara), hecho con **React**, **TypeScript**, **Tailwind CSS** y **Three.js**.

No usa mapas en línea ni API keys: el mundo es un archivo `.glb` propio generado a partir de **datos abiertos** (OpenStreetMap, EU-DEM y la ortofoto del PNOA del IGN).

---

## Qué hay en el mundo

- **Calles, aceras y plazas reales** de OpenStreetMap, con ancho según el tipo de vía y la ortofoto aérea del **PNOA** (IGN, 0,5 m/px) sobre el suelo, la calzada y el mar: se ven carriles, pasos de cebra y el puerto con sus barcos.
- **Edificios con su altura real**: plantas por volumen del **Catastro** (INSPIRE) sobre las huellas de OSM, con retranqueos, cuerpos bajos y patios interiores. El **año de construcción** y el uso eligen el estilo de fachada (ensanche, casco antiguo, bloque de los 60-70 o moderno), con planta baja distinta, balcones, persianas, toldos y **ventanas que se encienden de noche**.
- **Relieve real** (EU-DEM 25 m): la subida al Benacantil, el barrio de Santa Cruz en ladera. Coche y cámara siguen la pendiente.
- **Mar, costa, muelles, parques**, 738 árboles (62 palmeras *Phoenix canariensis*), farolas y semáforos de OSM.
- **Hitos**: Castillo de Santa Bárbara (murallas con almenas, torres y torre del Homenaje), **mosaico ondulado de la Explanada**, Ayuntamiento con torres, Concatedral de San Nicolás, Basílica de Santa María, Mercado Central, Auditorio La Concha y el barrio de Santa Cruz en blanco y pastel.
- **Física y límites**: colisión con edificios, mar y troncos, y **límite de calzada** (el coche solo circula por calzada, aceras, plazas y la Explanada).

## Coche, cámaras y ambientes

- Deportivo GT procedimental en Three.js (carrocería con clearcoat, 4 ruedas, faros, luces de freno, humo al derrapar, 5 pinturas).
- 3 cámaras: **Persecución**, **Modo Conductor** (cockpit interactivo) y **Aérea**.
- 3 ambientes: **Atardecer Mediterráneo**, **Noche Neón** y **Día**.
- Motor y derrape sintetizados con Web Audio (sin archivos de audio).
- 5 puntos de salida: Explanada, Castillo, Ayuntamiento, Mercado Central y Barrio de Santa Cruz (más Puerto, Postiguet y Alfonso X).

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

El mundo no se descarga en tiempo de juego: se construye una vez con tres scripts de Python y se guarda en `public/world/`.

```bash
pip install requests numpy shapely trimesh mapbox_earcut pyproj pygltflib pillow

python tools/fetch_osm.py     # OpenStreetMap (Overpass): calles, edificios, costa, parques, árboles, farolas
python tools/fetch_dem.py     # elevaciones EU-DEM 25 m (opentopodata.org)
python tools/fetch_catastro.py# plantas, año y uso (Catastro INSPIRE, zip de 22 MB del municipio 03900)
python tools/fetch_ortho.py   # ortofoto PNOA (WMS del IGN) -> public/world/ortho.jpg
python tools/build_world.py   # genera public/world/alicante.glb y colliders.json
```

- Los datos descargados quedan en `tools/data/` (en `.gitignore`); `public/world/` sí está versionado.
- `alicante.glb` contiene las capas `Ground`, `Park`, `Road`, `Sidewalk`, `Mosaic`, `Water`, `Walls`, `Roofs`, `Castle` y `Landmark`.
- `colliders.json` lleva las huellas de los volúmenes de edificio, obstáculos (árboles, mar, castillo), la máscara transitable (bits a 2 m), árboles, farolas y la malla de relieve.
- Los servidores de Overpass y del WMS del IGN fallan a ratos: los scripts guardan caché por capa y reintentan.
- Para otra zona, cambia el recuadro en `fetch_osm.py`, la región en `fetch_dem.py` / `fetch_ortho.py` y el origen en `build_world.py`.

## Estructura

```text
.
├── tools/                      # Generación del mundo (Python)
├── public/world/               # alicante.glb, colliders.json, ortho.jpg
└── src/
    ├── App.tsx                 # Bucle de juego, entrada y HUD
    ├── game/                   # Física del coche, constantes, audio, cielo
    ├── scene/createSportsCar.ts# Deportivo 3D procedimental
    ├── world/
    │   ├── WorldScene.ts       # Escena Three.js: mundo, coche, cámara, luces, árboles
    │   ├── facades.ts          # Atlas procedimental de fachadas y mosaico de la Explanada
    │   ├── collision.ts        # Colisión con edificios/mar y límite de calzada
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
- Datos cartográficos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL).
- Relieve: EU-DEM (Copernicus) vía [OpenTopoData](https://www.opentopodata.org/).
- Código bajo licencia **MIT**: consulta [`LICENSE`](./LICENSE).
