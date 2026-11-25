# Alicante GT — Carreras 3D en las calles reales de Alicante

Juego de conducción y carreras 3D **100 % client-side** ambientado en las calles reales de **Alicante, España** (Paseo Mártires de la Libertad, Explanada de España, Puerto Deportivo, Playa del Postiguet y centro urbano), construido con **React**, **TypeScript**, **Tailwind CSS**, **MapLibre GL JS** y **Three.js**.

No requiere ninguna API Key: utiliza teselas vectoriales abiertas de **OpenFreeMap / OpenStreetMap** con edificios 3D extruidos a escala real y texturas procedimentales de fachada generadas en tiempo real.

---

## Características principales

### Mapa 3D vectorial sin API Keys
- Integración de **MapLibre GL JS** sobre el estilo vectorial abierto `https://tiles.openfreemap.org/styles/liberty`.
- **Edificios 3D reales de OpenStreetMap (`fill-extrusion`)** con alturas reales (`render_height`), gradiente de sombreado vertical e iluminación direccional dinámica.
- **Fachadas arquitectónicas procedimentales en `<canvas>`**:
  - Variantes diurnas y de atardecer en piedra/estuco mediterráneo con cornisas, marcos, balcones y ventanas oscuras reflectantes.
  - Variantes nocturnas con fachadas oscuras y ventanas iluminadas aleatoriamente en tonos cálidos y azulados.
  - Variación tonal automática por altura del edificio (`step` sobre `render_height`).
- Cielo atmosférico y horizonte suave (`map.setSky`) sin cortes bruscos al inclinar la cámara.
- Asfalto oscurecido para alto contraste y limpieza de iconos/POIs comerciales manteniendo nombres de avenidas principales.

### Deportivo 3D procedimental en Three.js (`CustomLayerInterface`)
- Integrado directamente en el contexto WebGL compartido de MapLibre (`renderingMode: '3d'`, sincronizado con la matriz de proyección y con gestión segura de estado WebGL2/VAO).
- Carrocería GT aerodinámica construida con `ExtrudeGeometry` y biseles suaves, pintura metálica reflectante (`MeshPhysicalMaterial` con `clearcoat` y mapa de entorno `RoomEnvironment`), parabrisas tintado, difusor trasero, cuádruple salida de escape y alerón trasero en fibra de carbono.
- **4 ruedas independientes**: las delanteras giran visualmente al doblar y todas rotan según la velocidad real sobre el asfalto, con discos y pinzas de freno pintadas.
- **Faros delanteros** con haces volumétricos y proyección luminosa sobre el asfalto (especialmente visibles en *Noche Neón* y *Atardecer Mediterráneo*), **luces de freno traseras** que intensifican su brillo al frenar o derrapar, sombra de contacto proyectada y partículas de humo al derrapar.
- **5 acabados de pintura seleccionables**: Rojo Levante, Azul Mediterráneo, Plata Titanio, Amarillo Sol y Negro Obsidiana.

### 3 modos de cámara + Modo Conductor (Cockpit)
1. **Persecución (Tercera Persona):** `pitch: 74°`, `zoom: 19.6`, cámara trasera dinámica que rota suavemente con el coche y ajusta zoom e inclinación según la velocidad.
2. **Modo Conductor (Primera Persona / Cockpit):** `pitch: 83°`, `zoom: 21.2` (`maxPitch: 85°`), oculta la carrocería exterior manteniendo los faros activos sobre el asfalto y superpone un interior deportivo interactivo:
   - Salpicadero en cuero oscuro con pespunte y fibra de carbono + borde del capó del color elegido del coche.
   - **Volante deportivo interactivo** sincronizado a 60 fps con el ángulo de giro real de las ruedas.
   - Retrovisor superior con velocidad y rumbo, barra LED de revoluciones, reflejo sutil en el parabrisas y micro-vibración al acelerar o frenar.
3. **Vista Aérea / Drone:** `pitch: 50°`, `zoom: 18.2`.

### Ambientes de iluminación y audio procedimental
- Cambio instantáneo entre **Atardecer Mediterráneo**, **Noche Neón** y **Día**.
- **Sintetizador de motor Web Audio API** 100 % procedimental (tono V8 reactivo a RPM y chirrido de neumáticos al derrapar), sin archivos de audio externos.
- Puntos de salida rápidos en Alicante: *Paseo Mártires / Explanada*, *Puerto Deportivo*, *Playa del Postiguet* y *Av. Alfonso X El Sabio*.
- Panel inferior colapsable para disfrutar de toda la pantalla sin obstrucciones + controles táctiles en pantallas móviles.

---

## Controles

| Acción | Teclado | Táctil (Móvil) |
| :--- | :--- | :--- |
| Acelerar | `W` o `↑` | Botón **Gas** |
| Frenar / Marcha atrás | `S` o `↓` | Botón **Freno** |
| Girar izquierda / derecha | `A` / `D` o `←` / `→` | Botones `←` / `→` |
| Freno de mano / Derrape | `Espacio` | Botón **Derrape** |
| Cambiar cámara (Persecución / Conductor / Aérea) | `C` | Botón de cámara en el HUD |
| Cambiar ambiente (Atardecer / Noche Neón / Día) | `1` / `2` / `3` | Selector de ambiente en el HUD |
| Reiniciar posición | `R` | Botón reiniciar |
| Ocultar / mostrar panel inferior | `H` | Pestaña superior del panel |

---

## Stack tecnológico

- **React 19** + **TypeScript** + **Vite 8**
- **Tailwind CSS v4**
- **MapLibre GL JS** (`maplibre-gl`) + **OpenFreeMap** (`tiles.openfreemap.org`)
- **Three.js** (`three`, `RoomEnvironment`)
- **Lucide React** para iconografía funcional del HUD
- **Web Audio API** para síntesis de motor y derrape

---

## Estructura del proyecto

```text
.
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── App.tsx                             # Orquestador del mapa, bucle físico y cámara dinámica
    ├── main.tsx                            # Punto de entrada React
    ├── index.css                           # Tailwind CSS + estilos de MapLibre y tipografía
    ├── vite-env.d.ts                       # Tipos de Vite (?url para el Web Worker de MapLibre)
    ├── types/
    │   └── game.ts                         # Tipos del estado del vehículo, cámaras y telemetría
    ├── game/
    │   ├── constants.ts                    # Coordenadas de Alicante, acabados de pintura y luces
    │   ├── carPhysics.ts                   # Física arcade-sim, derrape, marchas e integración WGS84
    │   └── engineAudio.ts                  # Sintetizador procedimental de motor y derrape (Web Audio)
    ├── map/
    │   ├── facadeTextures.ts               # Generador procedimental en <canvas> de fachadas 3D
    │   └── atmosphereStyler.ts             # Estilo de calles, edificios 3D, luces y cielo por ambiente
    ├── scene/
    │   ├── createSportsCar.ts              # Geometría y materiales PBR del deportivo 3D en Three.js
    │   └── CarCustomLayer.ts               # CustomLayerInterface de MapLibre sincronizada con Three.js
    └── components/
        ├── RacingHud.tsx                   # HUD colapsable, velocímetro, selector de ambiente y cámara
        └── DriverCockpitOverlay.tsx        # Interior deportivo interactivo para el Modo Conductor
```

---

## Instalación y desarrollo local

### Requisitos previos
- **Node.js** `>= 20`
- **npm** (o `bun` / `pnpm`)

### Pasos

```bash
# 1. Clonar el repositorio
git clone https://github.com/<tu-usuario>/alicante-gt-3d.git
cd alicante-gt-3d

# 2. Instalar dependencias
npm install

# 3. Iniciar servidor de desarrollo (http://localhost:3000)
npm run dev
```

### Scripts disponibles

```bash
npm run dev       # Servidor de desarrollo Vite en el puerto 3000
npm run lint      # Comprobación de tipos TypeScript (tsc --noEmit)
npm run build     # Compilación de producción en /dist
npm run preview   # Previsualización local del build de producción
```

---

## Notas técnicas importantes

- **Worker de MapLibre en Vite 8:** Vite 8 puede romper la resolución relativa del Web Worker interno de `maplibre-gl` al pre-empaquetarlo. El proyecto resuelve esto cargando explícitamente `maplibre-gl/dist/maplibre-gl-worker.mjs?url` con `maplibregl.setWorkerUrl(...)` y añadiendo `optimizeDeps: { exclude: ['maplibre-gl'] }` en `vite.config.ts`.
- **Sincronización WebGL2 (Three.js + MapLibre):** `CarCustomLayer` configura `renderer.autoClear = false`, preserva/restaura el estado GL alrededor de `PMREMGenerator`, llama a `renderer.resetState()` antes de cada renderizado sin limpiar el buffer de MapLibre y desvincula el VAO (`gl.bindVertexArray(null)`) tras dibujar el coche.

---

## Despliegue

Al ser una SPA **100 % estática sin backend ni claves secretas**, puede desplegarse directamente en:

- **Vercel / Netlify:** Conectar el repositorio, comando de build `npm run build` y directorio de salida `dist`.
- **GitHub Pages:** Generar `dist` con `npm run build` (configurando `base: '/<nombre-del-repo>/'` en `vite.config.ts` si se sirve bajo subruta).

---

## Atribución y licencia

- Datos cartográficos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright).
- Teselas vectoriales servidas por [OpenFreeMap](https://openfreemap.org/).
- Distribuido bajo licencia **MIT** — consulta el archivo [`LICENSE`](./LICENSE).
