import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ATMOSPHERE_SPECS } from '../game/constants';
import type { AtmosphereMode, CameraPreset, CarPaintPreset, CarState } from '../types/game';
import { createSportsCar, type SportsCarRig } from '../scene/createSportsCar';
import { CollisionWorld, type BuildingCollider, type DriveMask } from './collision';
import { heightAt, setDem, TILE, toLocal, type DemData } from './geo';
import { createFacadeAtlas, createMosaicTexture, FACADE_STYLES } from './facades';

const DEG = Math.PI / 180;
/** Las luces de constants.ts están pensadas para el coche solo; en un mundo claro saturan. */
const LK = 0.5;
const damp = (a: number, b: number, l: number, dt: number) => a + (b - a) * (1 - Math.exp(-l * dt));

const SKY: Record<AtmosphereMode, { sky: number; fog: number; fogFar: number }> = {
  sunset: { sky: 0xf4b183, fog: 0xe9b79a, fogFar: 520 },
  night: { sky: 0x070b18, fog: 0x0b1226, fogFar: 380 },
  day: { sky: 0x8ec9f0, fog: 0xcfe6f5, fogFar: 700 },
};

const CAM: Record<CameraPreset, { dist: number; height: number; look: number; fov: number }> = {
  chase: { dist: 7.2, height: 2.7, look: 7, fov: 62 },
  driver: { dist: -0.15, height: 1.12, look: 30, fov: 74 },
  aerial: { dist: 46, height: 38, look: 8, fov: 55 },
};

interface TileInfo { tx: number; tz: number; ortho: number; land: boolean }
interface Manifest { tile: number; tx: [number, number]; tz: [number, number]; tiles: TileInfo[] }
interface LoadedTile { key: string; group: THREE.Group; textures: THREE.Texture[]; materials: THREE.Material[] }

/** Escena Three.js propia: mundo por teselas .glb de Alicante + coche + cámara + colisiones. Sin MapLibre. */
export class WorldScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 2500);
  readonly rig: SportsCarRig;
  collision: CollisionWorld | null = null;

  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private fog = new THREE.Fog(0xcfe6f5, 60, 700);
  private preset: CameraPreset = 'chase';
  private camBearing = 0;
  private camSnap = true;
  private base = '/';
  private manifest: Manifest | null = null;
  private infos = new Map<string, TileInfo>();
  private tiles = new Map<string, LoadedTile>();
  private loading = new Set<string>();
  private lastTileKey = '';
  private wallMat: THREE.MeshStandardMaterial | null = null;
  private mosaicMat: THREE.MeshStandardMaterial | null = null;
  private plainMats: Record<string, THREE.MeshStandardMaterial> = {};
  private dummyTex: THREE.DataTexture | null = null;
  private loader = new GLTFLoader();
  public loadedCount = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  private camGround = 0;
  private camPos = new THREE.Vector3();
  private ro: ResizeObserver;
  private mode: AtmosphereMode;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private wallUniforms = { uMask: { value: null as THREE.Texture | null }, uNight: { value: 0 } };

  constructor(
    private container: HTMLElement,
    paint: CarPaintPreset,
    mode: AtmosphereMode,
    lowPower: boolean
  ) {
    this.mode = mode;
    this.renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(lowPower ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = !lowPower;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    const spec = ATMOSPHERE_SPECS[mode];
    this.key = new THREE.DirectionalLight(spec.keyColor, spec.keyIntensity * LK);
    this.key.castShadow = !lowPower;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.key.shadow.bias = -0.0004;
    this.scene.add(this.key, this.key.target);
    this.hemi = new THREE.HemisphereLight(spec.hemiSkyColor, spec.hemiGroundColor, spec.hemiIntensity * LK);
    this.rim = new THREE.DirectionalLight(spec.rimColor, spec.rimIntensity * LK);
    this.scene.add(this.hemi, this.rim);

    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pm.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envTarget.texture;
    pm.dispose();

    this.rig = createSportsCar(paint, mode);
    this.rig.root.traverse((o) => {
      o.frustumCulled = false;
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.scene.add(this.rig.root);

    this.scene.fog = this.fog;
    this.wallUniforms.uNight.value = mode === 'night' ? 1 : mode === 'sunset' ? 0.3 : 0;
    this.applySky();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  /** Carga el manifiesto y el relieve global, y deja lista la tesela donde está el coche. */
  async init(base: string, startX: number, startZ: number, onProgress?: (t: string) => void): Promise<void> {
    this.base = base;
    onProgress?.('Descargando el mapa de Alicante…');
    const [manifest, dem] = await Promise.all([
      fetch(`${base}world/manifest.json`).then((r) => r.json() as Promise<Manifest>),
      fetch(`${base}world/dem.json`).then((r) => r.json() as Promise<DemData>),
    ]);
    this.manifest = manifest;
    for (const t of manifest.tiles) this.infos.set(`${t.tx}_${t.tz}`, t);
    setDem(dem);
    this.collision = new CollisionWorld();
    this.collision.setBounds(manifest.tx[0] * TILE, manifest.tz[0] * TILE, (manifest.tx[1] + 1) * TILE, (manifest.tz[1] + 1) * TILE);
    onProgress?.('Cargando el barrio…');
    await this.ensureTile(Math.floor(startX / TILE), Math.floor(startZ / TILE));
    this.streamTiles(startX, startZ);
    onProgress?.(`Mundo listo · ${this.loadedCount} teselas`);
  }

  private async ensureTile(tx: number, tz: number): Promise<void> {
    const key = `${tx}_${tz}`;
    const info = this.infos.get(key);
    if (!info || this.tiles.has(key)) return;
    if (this.loading.has(key)) {
      while (this.loading.has(key)) await new Promise((r) => setTimeout(r, 60));
      return;
    }
    this.loading.add(key);
    try {
      const [gltf, col, ortho] = await Promise.all([
        this.loader.loadAsync(`${this.base}world/tiles/${key}.glb`),
        fetch(`${this.base}world/tiles/${key}.json`).then((r) => r.json()),
        info.ortho > 0 ? new THREE.TextureLoader().loadAsync(`${this.base}world/tiles/${key}.jpg`).catch(() => null) : Promise.resolve(null),
      ]);
      if (this.tiles.has(key)) return;
      const lt: LoadedTile = { key, group: new THREE.Group(), textures: [], materials: [] };
      let orthoTex: THREE.Texture | null = null;
      if (ortho) {
        const maxTex = this.renderer.capabilities.maxTextureSize;
        const img = ortho.image as HTMLImageElement;
        if (img.width > maxTex) {   // GPU con límite de textura bajo: se reduce al cargar
          const k = maxTex / img.width;
          const cv = document.createElement('canvas');
          cv.width = Math.floor(img.width * k);
          cv.height = Math.floor(img.height * k);
          cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
          ortho.image = cv as unknown as HTMLImageElement;
          ortho.needsUpdate = true;
        }
        ortho.colorSpace = THREE.SRGBColorSpace;
        ortho.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        ortho.wrapS = ortho.wrapT = THREE.ClampToEdgeWrapping;
        orthoTex = ortho;
        lt.textures.push(ortho);
      }
      const orthoMix: Record<string, number> = { Ground: 0.92, Road: 0.22, Sidewalk: 0.16, Park: 0.8, Water: 0.8 };
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const n = o.name;
        const ca = m.geometry.getAttribute('color');   // los colores del GLB están en sRGB; Three espera lineal en COLOR_0
        if (ca) {
          const c = new THREE.Color();
          for (let i = 0; i < ca.count; i++) {
            c.setRGB(ca.getX(i), ca.getY(i), ca.getZ(i), THREE.SRGBColorSpace);
            ca.setXYZ(i, c.r, c.g, c.b);
          }
          ca.needsUpdate = true;
        }
        m.receiveShadow = n !== 'Water';
        m.castShadow = n === 'Walls' || n === 'Roofs' || n === 'Castle' || n === 'Landmark';
        if ((orthoTex && n in orthoMix) || n === 'Road' || n === 'Sidewalk') {
          const mat = this.makeOrthoMaterial(n, orthoMix[n] ?? 0, orthoTex, info);
          lt.materials.push(mat);
          m.material = mat;
        } else if (n === 'Walls') {
          m.material = this.wallMat ??= this.makeWallMaterial();
        } else if (n === 'Mosaic') {
          m.material = this.mosaicMat ??= new THREE.MeshStandardMaterial({ map: createMosaicTexture(), roughness: 0.6, metalness: 0.05 });
        } else {
          m.material = this.plainMats[n] ??= new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            roughness: n === 'Road' ? 0.92 : n === 'Water' ? 0.12 : 0.85,
            metalness: n === 'Water' ? 0.25 : 0,
            polygonOffset: n === 'Marks',
            polygonOffsetFactor: n === 'Marks' ? -4 : 0,
            polygonOffsetUnits: n === 'Marks' ? -4 : 0,
          });
        }
      });
      lt.group.add(gltf.scene);
      this.addTrees(lt, (col.trees ?? []) as [number, number, number][]);
      this.addLamps(lt, (col.lamps ?? []) as [number, number, number, number?][]);
      this.scene.add(lt.group);
      this.tiles.set(key, lt);
      this.collision?.addTile(
        key,
        [...(col.buildings as BuildingCollider[]), ...((col.obstacles ?? []) as BuildingCollider[])],
        (col.drive ?? null) as DriveMask | null
      );
      this.loadedCount = this.tiles.size;
    } finally {
      this.loading.delete(key);
    }
  }

  private unloadTile(key: string) {
    const lt = this.tiles.get(key);
    if (!lt) return;
    this.scene.remove(lt.group);
    lt.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    lt.textures.forEach((t) => t.dispose());
    lt.materials.forEach((m) => m.dispose());
    this.collision?.removeTile(key);
    this.tiles.delete(key);
    this.loadedCount = this.tiles.size;
  }

  /** Carga las teselas alrededor del coche y descarga las lejanas. */
  private streamTiles(x: number, z: number) {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    const key = `${tx}_${tz}`;
    if (key === this.lastTileKey) return;
    this.lastTileKey = key;
    const want: [number, number][] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) want.push([tx + dx, tz + dz]);
    want.sort((a, b) => Math.hypot(a[0] - tx, a[1] - tz) - Math.hypot(b[0] - tx, b[1] - tz));
    (async () => {
      for (const [a, b] of want) {
        try { await this.ensureTile(a, b); } catch (err) { console.warn('[Alicante GT] tesela', a, b, err); }
      }
    })();
    for (const k of [...this.tiles.keys()]) {
      const [a, b] = k.split('_').map(Number);
      if (Math.abs(a - tx) > 2 || Math.abs(b - tz) > 2) this.unloadTile(k);
    }
  }

  /** Suelo/calzada/mar: color de vértice mezclado con la ortofoto del PNOA (mapeo plano en x,z). */
  private makeOrthoMaterial(name: string, mix: number, tex: THREE.Texture | null, info: TileInfo): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: name === 'Road' ? 0.95 : name === 'Water' ? 0.15 : name === 'Sidewalk' ? 0.9 : 0.88,
      metalness: name === 'Water' ? 0.2 : 0,
      polygonOffset: name === 'Road' || name === 'Sidewalk',
      polygonOffsetFactor: name === 'Road' ? -1 : name === 'Sidewalk' ? -2 : 0,
      polygonOffsetUnits: name === 'Road' ? -1 : name === 'Sidewalk' ? -2 : 0,
    });
    const kind = name === 'Road' ? 1 : name === 'Sidewalk' ? 2 : 0;
    const dummy = this.dummyTex ??= new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    dummy.needsUpdate = true;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uOrtho = { value: tex ?? dummy };
      sh.uniforms.uOB = { value: new THREE.Vector4(info.tx * TILE, info.tz * TILE, TILE, TILE) };
      sh.uniforms.uOMix = { value: tex ? mix : 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vOXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vOXZ;
          uniform sampler2D uOrtho;
          uniform vec4 uOB;
          uniform float uOMix;
          float hs(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 ouv = (vOXZ - uOB.xy) / uOB.zw;
          if (uOMix > 0.0 && ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
            vec3 oc = texture2D(uOrtho, vec2(ouv.x, 1.0 - ouv.y)).rgb;
            diffuseColor.rgb = mix(diffuseColor.rgb, oc, uOMix);
          }
          ${kind === 1 ? `float g1 = hs(floor(vOXZ * 6.0)); float g2 = hs(floor(vOXZ * 0.8));
          diffuseColor.rgb *= 0.9 + 0.13 * g1 + 0.07 * g2;` : ''}
          ${kind === 2 ? `vec2 q = vOXZ / 0.6; vec2 f = fract(q); vec2 id = floor(q);
          float joint = min(step(f.x, 0.05) + step(f.y, 0.05), 1.0);
          diffuseColor.rgb *= (0.97 + hs(id) * 0.07) * (1.0 - 0.2 * joint);` : ''}`);
    };
    return mat;
  }

  /** Material de muros: atlas de fachadas (estilo en u/1000, plantas en v) + ventanas iluminadas de noche. */
  private makeWallMaterial(): THREE.MeshStandardMaterial {
    const { map, mask } = createFacadeAtlas();
    this.wallUniforms.uMask.value = mask;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, map, roughness: 0.88, metalness: 0 });
    const u = this.wallUniforms;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMask = u.uMask;
      sh.uniforms.uNight = u.uNight;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uMask;
          uniform float uNight;
          float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <map_fragment>', `
          float stl = floor(vMapUv.x / 1000.0 + 0.0001);
          vec2 cuv = vec2(vMapUv.x - stl * 1000.0, vMapUv.y);
          float row = floor(cuv.y) < 1.0 ? 0.0 : 1.0;
          vec2 fc = fract(cuv);
          const float NS = ${FACADE_STYLES}.0;
          vec2 auv = vec2((stl + fc.x * 0.96 + 0.02) / NS, (row + fc.y * 0.96 + 0.02) * 0.5);
          vec2 gx = vec2(dFdx(cuv.x) * 0.96 / NS, dFdx(cuv.y) * 0.48);
          vec2 gy = vec2(dFdy(cuv.x) * 0.96 / NS, dFdy(cuv.y) * 0.48);
          vec4 fac = textureGrad(map, auv, gx, gy);
          float win = textureGrad(uMask, auv, gx, gy).r;
          diffuseColor *= vec4(fac.rgb, 1.0);
          float lit = step(0.55, h21(floor(cuv) + vec2(stl * 7.0, 3.0)));
          totalEmissiveRadiance += win * lit * uNight * vec3(1.0, 0.74, 0.4) * 1.4;
        `);
    };
    return mat;
  }

  /** Farolas y semáforos instanciados (los semáforos van en las aceras, orientados a lo largo de la vía). */
  private addLamps(lt: LoadedTile, lamps: [number, number, number, number?][]) {
    const poles = lamps.filter((l) => l[2] === 0);
    const sigs = lamps.filter((l) => l[2] === 1);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.6, metalness: 0.5 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffd48a, emissiveIntensity: 0.6, roughness: 0.4 });
    const red = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff2a20, emissiveIntensity: 1.4, roughness: 0.4 });
    const amb = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff9a10, emissiveIntensity: 0.25, roughness: 0.4 });
    const grn = new THREE.MeshStandardMaterial({ color: 0x35d06a, emissive: 0x1fb050, emissiveIntensity: 0.25, roughness: 0.4 });
    lt.materials.push(metal, glow, red, amb, grn);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      im.frustumCulled = false;
      lt.group.add(im);
      return im;
    };
    const pp = mk(new THREE.CylinderGeometry(0.07, 0.1, 6, 6), metal, poles.length);
    const ph = mk(new THREE.SphereGeometry(0.28, 8, 6), glow, poles.length);
    poles.forEach(([x, z], i) => {
      const y = heightAt(x, z);
      m.compose(new THREE.Vector3(x, y + 3, z), q, one); pp.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 6.1, z), q, one); ph.setMatrixAt(i, m);
    });
    // semáforo: mástil, cabezal con tres luces por las dos caras
    const sp = mk(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6), metal, sigs.length);
    const sh = mk(new THREE.BoxGeometry(0.3, 0.95, 0.26), metal, sigs.length);
    const lensGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const lr = mk(lensGeo, red, sigs.length * 2);
    const la = mk(lensGeo, amb, sigs.length * 2);
    const lg = mk(lensGeo, grn, sigs.length * 2);
    const off = new THREE.Vector3();
    sigs.forEach(([x, z, , yaw = 0], i) => {
      const y = heightAt(x, z);
      const rot = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      m.compose(new THREE.Vector3(x, y + 2.1, z), q, one); sp.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 4.3, z), rot, one); sh.setMatrixAt(i, m);
      [lr, la, lg].forEach((im, k) => {
        for (let f = 0; f < 2; f++) {
          off.set(0, 0.28 - k * 0.28, (f === 0 ? 1 : -1) * 0.14).applyQuaternion(rot);
          m.compose(new THREE.Vector3(x + off.x, y + 4.3 + off.y, z + off.z), q, one);
          im.setMatrixAt(i * 2 + f, m);
        }
      });
    });
    [pp, ph, sp, sh, lr, la, lg].forEach((im) => { im.instanceMatrix.needsUpdate = true; });
  }

  /** Árboles y palmeras instanciados (posiciones reales de OSM). */
  private addTrees(lt: LoadedTile, trees: [number, number, number][]) {
    const palms = trees.filter((t) => t[2] === 1);
    const broad = trees.filter((t) => t[2] === 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f35, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9 });
    const frondMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
    lt.materials.push(trunkMat, leafMat, frondMat);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      im.castShadow = true;
      im.frustumCulled = false;
      lt.group.add(im);
      return im;
    };
    // árboles de hoja ancha: tronco + copa
    const bt = mk(new THREE.CylinderGeometry(0.12, 0.2, 2.6, 6), trunkMat, broad.length);
    const bc = mk(new THREE.IcosahedronGeometry(1.9, 1), leafMat, broad.length);
    broad.forEach(([x, z], i) => {
      const sc = 0.8 + ((i * 37) % 10) / 25;
      m.compose(new THREE.Vector3(x, heightAt(x, z) + 1.3, z), q, new THREE.Vector3(1, 1, 1)); bt.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, heightAt(x, z) + 3.6 * sc, z), q, new THREE.Vector3(sc, sc * 0.85, sc)); bc.setMatrixAt(i, m);
    });
    // palmeras (la mayoría de los árboles de Alicante): tronco alto con anillos, bulbo y corona de 14 frondas curvas
    const pt = mk(new THREE.CylinderGeometry(0.15, 0.27, 7, 8), trunkMat, palms.length);
    const bulb = mk(new THREE.SphereGeometry(0.42, 8, 6), trunkMat, palms.length);
    const fronds: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 14; k++) {
      const g = new THREE.BoxGeometry(0.55, 0.035, 3.9, 1, 1, 6);
      g.translate(0, 0, 1.95);
      const pos = g.getAttribute('position');
      const droop = 0.05 + (k % 3) * 0.012;
      for (let i = 0; i < pos.count; i++) {   // frondas que se arquean hacia abajo
        const z = pos.getZ(i);
        pos.setY(i, pos.getY(i) + 0.55 * Math.sin(Math.min(z, 2.2) * 0.7) * 0.5 - droop * z * z);
      }
      g.rotateY((k / 14) * Math.PI * 2 + (k % 2) * 0.22);
      fronds.push(g);
    }
    const pf = mk(mergeGeometries(fronds)!, frondMat, palms.length);
    const greens = [0x4f8f3c, 0x5c9a45, 0x437a33, 0x68a04a].map((h) => new THREE.Color(h));
    palms.forEach(([x, z], i) => {
      const sc = 0.8 + ((i * 53) % 10) / 16;          // 0,8 .. 1,4 -> palmeras de 5,6 a 10 m
      const y = heightAt(x, z);
      const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 2.399) % (Math.PI * 2));
      m.compose(new THREE.Vector3(x, y + 3.5 * sc, z), q, new THREE.Vector3(sc, sc, sc)); pt.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 7.0 * sc, z), q, new THREE.Vector3(sc, sc, sc)); bulb.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 7.2 * sc, z), rot, new THREE.Vector3(sc, sc, sc)); pf.setMatrixAt(i, m);
      pf.setColorAt(i, greens[i % greens.length]);
    });
    if (pf.instanceColor) pf.instanceColor.needsUpdate = true;
    [bt, bc, pt, bulb, pf].forEach((im) => { im.instanceMatrix.needsUpdate = true; });
  }

  private applySky() {
    const s = SKY[this.mode];
    this.scene.environmentIntensity = this.mode === 'night' ? 0.1 : this.mode === 'sunset' ? 0.55 : 0.9;
    this.scene.background = new THREE.Color(s.sky);
    this.fog.color.setHex(s.fog);
    this.fog.far = s.fogFar;
    this.fog.near = s.fogFar * 0.12;
  }

  setAtmosphere(mode: AtmosphereMode) {
    this.mode = mode;
    const spec = ATMOSPHERE_SPECS[mode];
    this.key.color.setHex(spec.keyColor);
    this.key.intensity = spec.keyIntensity * LK;
    this.hemi.color.setHex(spec.hemiSkyColor);
    this.hemi.groundColor.setHex(spec.hemiGroundColor);
    this.hemi.intensity = spec.hemiIntensity * LK;
    this.rim.color.setHex(spec.rimColor);
    this.rim.intensity = spec.rimIntensity * LK;
    this.rig.setAtmosphere(mode);
    this.wallUniforms.uNight.value = mode === 'night' ? 1 : mode === 'sunset' ? 0.3 : 0;
    this.applySky();
  }

  setPaint(p: CarPaintPreset) {
    this.rig.setPaint(p);
  }

  setCameraPreset(p: CameraPreset) {
    this.preset = p;
    this.rig.setBodyVisible(p !== 'driver');
    this.camSnap = true;
  }

  snapCamera() {
    this.camSnap = true;
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Dibuja un frame: coloca el coche y la cámara según el estado. */
  render(state: CarState, dt: number) {
    const p = toLocal(state.lat, state.lng);
    if (this.manifest) this.streamTiles(p.x, p.z);
    this.rig.updateFromState(state, dt);
    const gy = heightAt(p.x, p.z);
    const hd = state.headingDeg * DEG;
    const ahead = heightAt(p.x + Math.sin(hd) * 1.9, p.z - Math.cos(hd) * 1.9);
    const behind = heightAt(p.x - Math.sin(hd) * 1.9, p.z + Math.cos(hd) * 1.9);
    const side =
      heightAt(p.x + Math.cos(hd) * 0.9, p.z + Math.sin(hd) * 0.9) -
      heightAt(p.x - Math.cos(hd) * 0.9, p.z - Math.sin(hd) * 0.9);
    this.groundPitch += (Math.atan2(ahead - behind, 3.8) - this.groundPitch) * (1 - Math.exp(-10 * dt));
    this.groundRoll += (Math.atan2(side, 1.8) - this.groundRoll) * (1 - Math.exp(-10 * dt));
    if (this.camSnap) this.camGround = gy;
    this.camGround += (gy - this.camGround) * (1 - Math.exp(-6 * dt));
    this.rig.root.rotation.order = 'YXZ';
    this.rig.root.position.set(p.x, gy + 0.05, p.z);
    this.rig.root.rotation.y = -hd - state.driftSlipRad * 0.45;
    this.rig.root.rotation.x = this.groundPitch;
    this.rig.root.rotation.z = this.groundRoll;

    const cfg = CAM[this.preset];
    const driver = this.preset === 'driver';
    const lambda = driver ? 14 : state.isDrifting ? 3 : 5.5;
    if (this.camSnap) {
      this.camBearing = state.headingDeg;
    } else {
      const diff = ((state.headingDeg - this.camBearing + 540) % 360) - 180;
      this.camBearing = (this.camBearing + diff * (1 - Math.exp(-lambda * dt)) + 360) % 360;
    }
    const b = this.camBearing * DEG;
    const fx = Math.sin(b);
    const fz = -Math.cos(b);
    const speedBack = Math.min(Math.abs(state.speedMps) / 56, 1) * (driver ? 0 : 2.2);
    const tx = p.x - fx * (cfg.dist + speedBack);
    const tz = p.z - fz * (cfg.dist + speedBack);
    const ty = cfg.height + this.camGround;
    if (this.camSnap) {
      this.camPos.set(tx, ty, tz);
      this.camSnap = false;
    } else {
      const l = driver ? 40 : 10;
      this.camPos.x = damp(this.camPos.x, tx, l, dt);
      this.camPos.y = damp(this.camPos.y, ty, l, dt);
      this.camPos.z = damp(this.camPos.z, tz, l, dt);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(p.x + fx * cfg.look, this.camGround + (driver ? 1.1 : 1.0), p.z + fz * cfg.look);
    const fov = cfg.fov + Math.min(Math.abs(state.speedMps) / 56, 1) * 8;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // sombra y luz siguen al coche
    const kp = ATMOSPHERE_SPECS[this.mode].keyPosition;
    this.key.position.set(p.x + kp[0] * 6, gy + Math.abs(kp[1]) * 6 + 40, p.z + kp[2] * 6);
    this.key.target.position.set(p.x, gy, p.z);
    this.rim.position.set(p.x + 14, 9, p.z + 16);

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.ro.disconnect();
    this.rig.dispose();
    this.envTarget?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
