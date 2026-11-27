import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ATMOSPHERE_SPECS } from '../game/constants';
import type { AtmosphereMode, CameraPreset, CarPaintPreset, CarState } from '../types/game';
import { createSportsCar, type SportsCarRig } from '../scene/createSportsCar';
import { CollisionWorld, type BuildingCollider, type DriveMask } from './collision';
import { heightAt, setDem, TILE, toLocal, type DemData } from './geo';
import { createPalmAssets, type PalmAssets } from './palms';
import { Traffic, type ParkedRec, type RoadRec } from './traffic';
import { Pedestrians } from './pedestrians';
import { Signals } from './signals';
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

/** Realce final (en espacio de pantalla): saturación y contraste suaves y viñeta ligera. */
const GRADE = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uSat: { value: 1.08 }, uVig: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat; uniform float uVig; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      c.rgb = (c.rgb - 0.5) * 1.05 + 0.5;
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c.rgb *= 1.0 - uVig * smoothstep(0.32, 0.85, d);
      gl_FragColor = vec4(max(c.rgb, 0.0), c.a); }`,
};
/** Bloom y ambiente por atmósfera. */
const FX: Record<AtmosphereMode, { bloom: number; thr: number; ao: number; vig: number }> = {
  sunset: { bloom: 0.26, thr: 0.9, ao: 0.9, vig: 0.3 },
  night: { bloom: 0.32, thr: 0.95, ao: 0.8, vig: 0.34 },
  day: { bloom: 0.1, thr: 1.05, ao: 1.0, vig: 0.22 },
};

const CAM: Record<CameraPreset, { dist: number; height: number; look: number; fov: number }> = {
  chase: { dist: 7.2, height: 2.7, look: 7, fov: 62 },
  driver: { dist: -0.15, height: 1.12, look: 30, fov: 74 },
  aerial: { dist: 46, height: 38, look: 8, fov: 55 },
};

interface TileInfo { tx: number; tz: number; ortho: number; land: boolean; signs?: number }
interface Manifest { tile: number; tx: [number, number]; tz: [number, number]; tiles: TileInfo[] }
interface DeckSeg { tile: string; ax: number; az: number; ao: number; bx: number; bz: number; bo: number; hw: number }
interface LoadedTile { key: string; group: THREE.Group; textures: THREE.Texture[]; materials: THREE.Material[]; lamps?: Float32Array }

/** Escena Three.js propia: mundo por teselas .glb de Alicante + coche + cámara + colisiones. Sin MapLibre. */
export class WorldScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 4000);
  readonly rig: SportsCarRig;
  collision: CollisionWorld | null = null;
  readonly traffic: Traffic;
  readonly peds: Pedestrians;
  readonly signals = new Signals();

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
  private plainMats: Record<string, THREE.Material> = {};
  private dummyTex: THREE.DataTexture | null = null;
  private palmAssets: PalmAssets | null = null;
  private deckCells = new Map<string, DeckSeg[]>();
  private carY = 0;
  private sky: THREE.Mesh | null = null;
  private skyU = {
    uZenith: { value: new THREE.Color(0x3a7fd0) },
    uMid: { value: new THREE.Color(0x86bdea) },
    uHorizon: { value: new THREE.Color(0xd2e8f6) },
  };
  private clouds: { sprite: THREE.Sprite; ox: number; oz: number; alt: number; seed: number }[] = [];
  private sunSprite: THREE.Sprite | null = null;
  private skyTime = 0;
  private loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  public loadedCount = 0;
  private streets = new Map<string, [string, number[][]][]>();
  private lastStreet = '';
  private pedTest = new URLSearchParams(window.location.search).get('pedtest') === '1';
  private aerialZoom = Number(new URLSearchParams(window.location.search).get('zoom')) || 1;   // solo pruebas: ?zoom=5 aleja la cámara aérea
  private carTest = new URLSearchParams(window.location.search).get('cartest') === '1';
  private camClock = 0;
  private camRoll = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  private camGround = 0;
  private camPos = new THREE.Vector3();
  private ro: ResizeObserver;
  private mode: AtmosphereMode;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lampMats: THREE.MeshStandardMaterial[] = [];
  private poolMat: THREE.MeshBasicMaterial | null = null;
  private lampLights: THREE.PointLight[] = [];
  private pmrem: THREE.PMREMGenerator | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private gtao: GTAOPass | null = null;
  private grade: ShaderPass | null = null;
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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const fxq = new URLSearchParams(window.location.search).get('fx');
    if (fxq === '1' || (fxq !== '0' && !lowPower)) this.initComposer();

    this.rig = createSportsCar(paint, mode);
    this.rig.root.traverse((o) => {
      o.frustumCulled = false;
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.scene.add(this.rig.root);
    this.traffic = new Traffic(this.scene);
    this.traffic.setSignals(this.signals);
    this.peds = new Pedestrians(this.scene, this.traffic, (x, z) => this.collision?.sidewalk(x, z) ?? true, this.signals);
    this.traffic.setLightLevel(this.lampLevel());
    if (new URLSearchParams(window.location.search).get('traffic') === '0') { this.traffic.enabled = false; this.peds.enabled = false; }
    if (new URLSearchParams(window.location.search).get('peds') === '0') this.peds.enabled = false;
    if (new URLSearchParams(window.location.search).get('debug') === '1') (window as unknown as { __gt: WorldScene }).__gt = this;

    this.scene.fog = this.fog;
    this.buildSky();
    this.wallUniforms.uNight.value = mode === 'night' ? 1 : mode === 'sunset' ? 0.3 : 0;
    this.applySky();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  /** Cuánto lucen las farolas según la atmósfera: noche 1, atardecer 0,35, día 0. */
  private lampLevel(): number {
    return this.mode === 'night' ? 1 : this.mode === 'sunset' ? 0.35 : 0;
  }

  private getPoolMat(): THREE.MeshBasicMaterial {
    if (this.poolMat) return this.poolMat;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d')!;
    const g = c.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,200,120,0.95)'); g.addColorStop(0.35, 'rgba(255,170,90,0.45)'); g.addColorStop(1, 'rgba(255,150,70,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.poolMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 * this.lampLevel(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return this.poolMat;
  }

  /** Apaga/enciende las farolas al cambiar de atmósfera y reparte unas pocas luces reales entre las más cercanas al coche. */
  private applyLamps() {
    const lv = this.lampLevel();
    for (const m of this.lampMats) m.emissiveIntensity = 0.6 + 3.4 * lv;
    if (this.poolMat) { this.poolMat.opacity = 0.6 * lv; this.poolMat.visible = lv > 0; }
    if (lv <= 0) for (const l of this.lampLights) l.intensity = 0;
    this.traffic.setLightLevel(lv);
  }

  private updateLampLights(px: number, pz: number) {
    const lv = this.lampLevel();
    if (lv <= 0) return;
    if (!this.lampLights.length) {
      for (let i = 0; i < 6; i++) {
        const l = new THREE.PointLight(0xffc27a, 0, 26, 1.6);
        this.scene.add(l); this.lampLights.push(l);
      }
    }
    const best: { d: number; x: number; y: number; z: number }[] = [];
    for (const lt of this.tiles.values()) {
      const a = lt.lamps; if (!a) continue;
      for (let i = 0; i < a.length; i += 3) {
        const dx = a[i] - px, dz = a[i + 2] - pz, d = dx * dx + dz * dz;
        if (d > 900) continue;
        if (best.length < 6) best.push({ d, x: a[i], y: a[i + 1], z: a[i + 2] });
        else {
          let wi = 0; for (let k = 1; k < 6; k++) if (best[k].d > best[wi].d) wi = k;
          if (d < best[wi].d) best[wi] = { d, x: a[i], y: a[i + 1], z: a[i + 2] };
        }
      }
    }
    this.lampLights.forEach((l, i) => {
      const b = best[i];
      if (b) { l.position.set(b.x, b.y, b.z); l.intensity = 38 * lv; } else l.intensity = 0;
    });
  }

  /** Postproceso: oclusión ambiental (GTAO), bloom, tonemapping y realce final. fx=0 en la URL lo desactiva. */
  private initComposer() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const pr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    const gtao = new GTAOPass(this.scene, this.camera, w, h);
    gtao.updateGtaoMaterial({ radius: 1.8, distanceExponent: 1.4, thickness: 2.5, scale: 1.2, samples: 12, distanceFallOff: 1 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 12 });
    if (new URLSearchParams(window.location.search).get('ao') === '1') c.addPass(gtao);   // experimental: oclusión ambiental solo con ?ao=1
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.2, 0.55, 1.0);
    c.addPass(bloom);
    c.addPass(new OutputPass());
    const grade = new ShaderPass(GRADE);
    c.addPass(grade);
    this.composer = c; this.gtao = gtao; this.bloom = bloom; this.grade = grade;
    this.applyFx();
  }

  private applyFx() {
    const f = FX[this.mode];
    if (this.bloom) { this.bloom.strength = f.bloom; this.bloom.threshold = f.thr; }
    if (this.gtao) this.gtao.blendIntensity = f.ao;
    if (this.grade) this.grade.uniforms.uVig.value = f.vig;
  }

  /** Reflejos con el cielo real de la atmósfera actual (en vez de un estudio): cúpula con degradado, suelo y sol. */
  private rebuildEnv() {
    if (!this.pmrem) return;
    const sc = new THREE.Scene();
    const kp = ATMOSPHERE_SPECS[this.mode].keyPosition;
    const sunDir = new THREE.Vector3(kp[0], Math.abs(kp[1]) + 8, kp[2]).normalize();
    const sunI = this.mode === 'night' ? 1.2 : this.mode === 'sunset' ? 9 : 7;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(50, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { ...this.skyU, uSun: { value: sunDir }, uSunI: { value: sunI }, uGround: { value: new THREE.Color(this.mode === 'night' ? 0x05070c : 0x6b6a66) } },
        side: THREE.BackSide,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vDir; uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uSun; uniform float uSunI;
          void main(){ float y = vDir.y; float h = clamp(y, 0.0, 1.0);
            vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h)); c = mix(c, uZenith, smoothstep(0.22, 0.9, h));
            c = mix(c, uGround, smoothstep(0.0, -0.25, y));
            c += pow(max(dot(normalize(vDir), uSun), 0.0), 300.0) * uSunI + pow(max(dot(normalize(vDir), uSun), 0.0), 12.0) * uSunI * 0.04;
            gl_FragColor = vec4(c, 1.0); }`,
      })
    );
    sc.add(dome);
    const next = this.pmrem.fromScene(sc, 0.02);
    this.envTarget?.dispose();
    this.envTarget = next;
    this.scene.environment = next.texture;
    dome.geometry.dispose();
    (dome.material as THREE.Material).dispose();
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
      const [gltf, col, ortho, signTex] = await Promise.all([
        this.loader.loadAsync(`${this.base}world/tiles/${key}.glb`),
        fetch(`${this.base}world/tiles/${key}.json`).then((r) => r.json()),
        info.ortho > 0 ? new THREE.TextureLoader().loadAsync(`${this.base}world/tiles/${key}.jpg`).catch(() => null) : Promise.resolve(null),
        (info.signs ?? 0) > 0 ? new THREE.TextureLoader().loadAsync(`${this.base}world/tiles/${key}_signs.jpg`).catch(() => null) : Promise.resolve(null),
      ]);
      if (this.tiles.has(key)) return;
      const lt: LoadedTile = { key, group: new THREE.Group(), textures: [], materials: [] };
      if (signTex) {
        signTex.colorSpace = THREE.SRGBColorSpace;
        signTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        lt.textures.push(signTex);
      }
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
      const orthoMix: Record<string, number> = { Ground: 0.92, Road: 0, Sidewalk: 0, Park: 0.8, Water: 0.8 };
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
        m.castShadow = n === 'Walls' || n === 'Roofs' || n === 'Castle' || n === 'Landmark' || n === 'Struct';
        if ((orthoTex && n in orthoMix) || n === 'Road' || n === 'Sidewalk') {
          const mat = this.makeOrthoMaterial(n, orthoMix[n] ?? 0, orthoTex, info);
          lt.materials.push(mat);
          m.material = mat;
        } else if (n === 'Signs') {
          if (!signTex) { m.visible = false; return; }
          const sm = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.55, metalness: 0, emissive: new THREE.Color(0xffffff), emissiveMap: signTex, emissiveIntensity: 0.3 });
          lt.materials.push(sm);
          m.material = sm;
          m.castShadow = false;
        } else if (n === 'Walls') {
          m.material = this.wallMat ??= this.makeWallMaterial();
        } else if (n === 'Mosaic') {
          m.material = this.mosaicMat ??= new THREE.MeshStandardMaterial({ map: createMosaicTexture(), roughness: 0.6, metalness: 0.05 });
        } else {
          m.material = this.plainMats[n] ??= n === 'Glow' ? new THREE.MeshBasicMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({
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
      this.streets.set(key, (col.streets ?? []) as [string, number[][]][]);
      this.traffic.addTile(key, (col.roads ?? []) as RoadRec[], (col.parked ?? []) as ParkedRec[]);
      this.peds.addCrosswalks(key, (col.cross ?? []) as number[][]);
      this.registerDecks(key, (col.decks ?? []) as { w: number; p: [number, number, number][] }[]);
      this.collision?.addTile(
        key,
        [...(col.buildings as BuildingCollider[]), ...((col.obstacles ?? []) as BuildingCollider[])],
        (col.drive ?? null) as DriveMask | null,
        (col.walk ?? null) as string | null
      );
      this.loadedCount = this.tiles.size;
    } finally {
      this.loading.delete(key);
    }
  }

  /** Puentes y túneles: segmentos con su altura relativa al terreno, indexados en celdas de 30 m. */
  private registerDecks(key: string, decks: { w: number; p: [number, number, number][] }[]) {
    const C = 30;
    for (const d of decks) {
      if (d.w <= 5 && d.p.some((q) => q[2] < -0.5)) continue;   // rampas de garaje/parking: el coche no baja por ellas
      for (let i = 0; i < d.p.length - 1; i++) {
        const [ax, az, ao] = d.p[i], [bx, bz, bo] = d.p[i + 1];
        const seg: DeckSeg = { tile: key, ax, az, ao, bx, bz, bo, hw: d.w / 2 + 0.3 };
        const x0 = Math.floor((Math.min(ax, bx) - seg.hw) / C), x1 = Math.floor((Math.max(ax, bx) + seg.hw) / C);
        const z0 = Math.floor((Math.min(az, bz) - seg.hw) / C), z1 = Math.floor((Math.max(az, bz) + seg.hw) / C);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
          const k = `${cx},${cz}`;
          const arr = this.deckCells.get(k);
          if (arr) arr.push(seg); else this.deckCells.set(k, [seg]);
        }
      }
    }
  }

  private unregisterDecks(key: string) {
    for (const [k, arr] of this.deckCells) {
      const rest = arr.filter((sg) => sg.tile !== key);
      if (rest.length) this.deckCells.set(k, rest); else this.deckCells.delete(k);
    }
  }

  /** Altura de la superficie transitable: terreno, o el tablero de un puente / la solera de un túnel si el coche va sobre él (continuidad con `ref`). */
  private groundY(x: number, z: number, ref: number, snap = false): number {
    const base = heightAt(x, z);
    const arr = this.deckCells.get(`${Math.floor(x / 30)},${Math.floor(z / 30)}`);
    if (!arr) return base;
    let best = base, bd = Infinity;
    for (const sg of arr) {
      const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / l2));
      if (Math.hypot(x - (sg.ax + dx * t), z - (sg.az + dz * t)) > sg.hw) continue;
      const o = sg.ao + (sg.bo - sg.ao) * t;
      if (snap && o < -1.0) continue;        // al aparecer/reiniciar nunca dentro de un túnel: se queda en la calle de arriba
      const cand = base + o;
      // al teletransportar se prefiere la vía del corredor (túnel o puente); conduciendo, solo la que está a una altura alcanzable
      const dd = snap ? Math.abs(o) : Math.abs(cand - ref);
      if ((snap || dd < 1.0) && dd < bd) { best = cand; bd = dd; }
    }
    return best;
  }

  /** Nombre de la calle por la que va el coche (la más cercana a menos de 14 m; con histéresis para que no parpadee). */
  streetAt(x: number, z: number): string {
    const tx = Math.floor(x / 1000), tz = Math.floor(z / 1000);
    let best = this.lastStreet ? 18 : 14, name = '';
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = this.streets.get(`${tx + dx}_${tz + dz}`);
      if (!arr) continue;
      for (const [nm, pts] of arr) {
        const bias = nm === this.lastStreet ? 4 : 0;           // se prefiere seguir en la misma calle
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
          const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
          const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t)) - bias;
          if (d < best) { best = d; name = nm; }
        }
      }
    }
    this.lastStreet = name;
    return name;
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
    this.unregisterDecks(key);
    this.streets.delete(key);
    this.signals.unregister(key);
    this.peds.removeCrosswalks(key);
    this.traffic.removeTile(key);
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
        .replace('#include <common>', '#include <common>\nvarying vec2 vOXZ;\nvarying vec3 vWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vOXZ;
          varying vec3 vWP;
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
          ${name === 'Ground' ? `{
            vec3 gn = normalize(cross(dFdx(vWP), dFdy(vWP)));
            float steep = smoothstep(0.90, 0.66, abs(gn.y));
            float n1 = hs(floor(vOXZ * 0.9)), n2 = hs(floor(vOXZ * 0.23 + vec2(vWP.y * 0.5, 0.0)));
            float strat = hs(vec2(floor(vWP.y * 1.6), 7.0));
            vec3 rock = mix(vec3(0.60, 0.50, 0.36), vec3(0.42, 0.35, 0.27), n2 * 0.6 + strat * 0.4);
            rock *= 0.88 + 0.2 * n1;
            diffuseColor.rgb = mix(diffuseColor.rgb, rock, steep * 0.85);
          }` : ''}
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
          totalEmissiveRadiance += win * lit * uNight * vec3(1.0, 0.74, 0.4) * 0.8;
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
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    lt.materials.push(metal, glow, lensMat);
    this.lampMats.push(glow);
    glow.emissiveIntensity = 0.6 + 3.4 * this.lampLevel();
    lt.lamps = new Float32Array(poles.length * 3);
    poles.forEach(([x, z], i) => { lt.lamps![i * 3] = x; lt.lamps![i * 3 + 1] = heightAt(x, z) + 5.8; lt.lamps![i * 3 + 2] = z; });
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
    // charco de luz en el suelo bajo cada farola (aditivo; solo se nota de noche y al atardecer)
    const pool = mk(new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2), this.getPoolMat(), poles.length);
    pool.renderOrder = 5;
    poles.forEach(([x, z], i) => {
      m.compose(new THREE.Vector3(x, heightAt(x, z) + 0.09, z), q, one); pool.setMatrixAt(i, m);
    });
    pool.instanceMatrix.needsUpdate = true;
    // semáforo: mástil, cabezal con tres luces por las dos caras
    const sp = mk(new THREE.CylinderGeometry(0.07, 0.09, 4.2, 6), metal, sigs.length);
    const sh = mk(new THREE.BoxGeometry(0.3, 0.95, 0.26), metal, sigs.length);
    const lensGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const lens = mk(lensGeo, lensMat, sigs.length * 6);                     // 3 lentes x 2 caras por semáforo; el color lo pone Signals
    const off = new THREE.Vector3();
    sigs.forEach(([x, z, , yaw = 0], i) => {
      const y = heightAt(x, z);
      const rot = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      m.compose(new THREE.Vector3(x, y + 2.1, z), q, one); sp.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 4.3, z), rot, one); sh.setMatrixAt(i, m);
      for (let k = 0; k < 3; k++) for (let f = 0; f < 2; f++) {
        off.set(0, 0.28 - k * 0.28, (f === 0 ? 1 : -1) * 0.14).applyQuaternion(rot);
        m.compose(new THREE.Vector3(x + off.x, y + 4.3 + off.y, z + off.z), q, one);
        lens.setMatrixAt(i * 6 + f * 3 + k, m);
      }
    });
    [pp, ph, sp, sh, lens].forEach((im) => { im.instanceMatrix.needsUpdate = true; });
    this.signals.register(lt.key, sigs.map(([x, z, , yaw = 0]) => [x, z, yaw] as [number, number, number]));
    this.signals.attachLens(lt.key, lens);
  }

  /** Árboles y palmeras instanciados (posiciones reales de OSM + arbolado de calle). */
  private addTrees(lt: LoadedTile, trees: [number, number, number][]) {
    const palms = trees.filter((t) => t[2] === 1);
    const broad = trees.filter((t) => t[2] === 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow = false) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      im.count = n;
      im.castShadow = shadow;
      im.frustumCulled = false;
      lt.group.add(im);
      return im;
    };
    // árboles de hoja ancha: tronco + copa
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f35, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9 });
    lt.materials.push(trunkMat, leafMat);
    const bt = mk(new THREE.CylinderGeometry(0.12, 0.2, 2.6, 6), trunkMat, broad.length, true);
    const bc = mk(new THREE.IcosahedronGeometry(1.9, 1), leafMat, broad.length, true);
    broad.forEach(([x, z], i) => {
      const sc = 0.8 + ((i * 37) % 10) / 25;
      const y = heightAt(x, z);
      m.compose(new THREE.Vector3(x, y + 1.3, z), q, one); bt.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, y + 3.6 * sc, z), q, new THREE.Vector3(sc, sc * 0.85, sc)); bc.setMatrixAt(i, m);
    });
    [bt, bc].forEach((im) => { im.instanceMatrix.needsUpdate = true; });

    // palmeras: Phoenix canariensis (60 %) y Washingtonia (40 %), con altura, inclinación y color propios
    const assets = (this.palmAssets ??= createPalmAssets());
    const hash = (x: number, z: number) => { const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return v - Math.floor(v); };
    const phoenix = palms.filter((p) => hash(p[0], p[1]) < 0.6);
    const wash = palms.filter((p) => hash(p[0], p[1]) >= 0.6);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const tint = new THREE.Color();
    const planting = (
      list: [number, number, number][],
      trunkIM: THREE.InstancedMesh, crownIM: THREE.InstancedMesh, bulbIM: THREE.InstancedMesh, skirtIM: THREE.InstancedMesh | null,
      hMin: number, hMax: number, radius: number, crownScale: number
    ) => {
      list.forEach(([x, z], i) => {
        const r1 = hash(x * 1.7, z * 2.3), r2 = hash(x * 3.1, z * 0.7), r3 = hash(x * 0.9, z * 4.1);
        const H = hMin + (hMax - hMin) * r1;
        const tilt = 0.02 + r2 * 0.06, az = r3 * Math.PI * 2;
        dir.set(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
        const y = heightAt(x, z);
        const base = new THREE.Vector3(x, y, z);
        const topP = base.clone().addScaledVector(dir, H);
        m.compose(base.clone().addScaledVector(dir, H / 2), quat, new THREE.Vector3(radius, H, radius)); trunkIM.setMatrixAt(i, m);
        m.compose(topP.clone().addScaledVector(dir, -0.1), quat, new THREE.Vector3(radius * 1.35, radius * 1.1, radius * 1.35)); bulbIM.setMatrixAt(i, m);
        const crownQ = new THREE.Quaternion().setFromAxisAngle(up, r2 * 6.28).premultiply(quat);
        const cs = crownScale * (0.85 + r1 * 0.35);
        m.compose(topP, crownQ, new THREE.Vector3(cs, cs, cs)); crownIM.setMatrixAt(i, m);
        const g = 0.82 + r3 * 0.34;
        tint.setRGB(g, g * (0.96 + r1 * 0.1), g * 0.9);
        crownIM.setColorAt(i, tint);
        if (skirtIM) { m.compose(topP.clone().addScaledVector(dir, -0.95), quat, one); skirtIM.setMatrixAt(i, m); }
      });
      [trunkIM, crownIM, bulbIM, skirtIM].forEach((im) => { if (im) im.instanceMatrix.needsUpdate = true; });
      if (crownIM.instanceColor) crownIM.instanceColor.needsUpdate = true;
    };
    planting(
      phoenix,
      mk(assets.phoenix.trunk, assets.phoenix.trunkMat, phoenix.length, true),
      mk(assets.phoenix.crown, assets.phoenix.crownMat, phoenix.length),
      mk(assets.bulbGeo, assets.phoenix.trunkMat, phoenix.length),
      null, 6.2, 9.8, 1, 1.0
    );
    planting(
      wash,
      mk(assets.wash.trunk, assets.wash.trunkMat, wash.length, true),
      mk(assets.wash.crown, assets.wash.crownMat, wash.length),
      mk(assets.bulbGeo, assets.wash.trunkMat, wash.length),
      mk(assets.wash.skirt, assets.wash.skirtMat, wash.length),
      9.0, 14.5, 1, 1.0
    );
  }

  /** Cúpula de cielo con degradado, nubes en billboard y resplandor del sol. */
  private buildSky() {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1800, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyU,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec3 vDir; uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon;
          void main(){ float h = clamp(vDir.y, 0.0, 1.0);
            vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.28, h)); c = mix(c, uZenith, smoothstep(0.22, 0.9, h));
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }`,
      })
    );
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    this.scene.add(dome);
    this.sky = dome;

    // textura de nube: varias bolsas suaves y la base algo más gris
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 128;
    const c = cv.getContext('2d')!;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 16; i++) {
      const x = 44 + rnd() * 168, y = 66 + (rnd() - 0.5) * 24, r = 20 + rnd() * 30;
      const g = c.createRadialGradient(x, y, 2, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.fillRect(0, 0, 256, 128);
    }
    c.globalCompositeOperation = 'source-atop';
    const shade = c.createLinearGradient(0, 30, 0, 100);
    shade.addColorStop(0, 'rgba(255,255,255,0)'); shade.addColorStop(1, 'rgba(120,132,160,0.55)');
    c.fillStyle = shade; c.fillRect(0, 0, 256, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < 72; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      const size = 420 + rnd() * 420;
      sprite.scale.set(size, size * 0.46, 1);
      sprite.frustumCulled = false;
      this.scene.add(sprite);
      this.clouds.push({ sprite, ox: (rnd() - 0.5) * 3600, oz: (rnd() - 0.5) * 3600, alt: 260 + rnd() * 280, seed: rnd() });
    }

    // sol (o luna): resplandor aditivo
    const sc = document.createElement('canvas');
    sc.width = sc.height = 128;
    const sx = sc.getContext('2d')!;
    const sg = sx.createRadialGradient(64, 64, 2, 64, 64, 62);
    sg.addColorStop(0, 'rgba(255,255,255,1)'); sg.addColorStop(0.2, 'rgba(255,240,210,0.85)'); sg.addColorStop(0.5, 'rgba(255,200,140,0.25)'); sg.addColorStop(1, 'rgba(255,180,120,0)');
    sx.fillStyle = sg; sx.fillRect(0, 0, 128, 128);
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    sun.frustumCulled = false;
    this.scene.add(sun);
    this.sunSprite = sun;
  }

  private updateSky() {
    const set = (z: number, m: number, h: number) => {
      this.skyU.uZenith.value.setHex(z); this.skyU.uMid.value.setHex(m); this.skyU.uHorizon.value.setHex(h);
    };
    const tint = this.mode === 'night' ? 0x39446e : this.mode === 'sunset' ? 0xffc9a8 : 0xffffff;
    if (this.mode === 'night') set(0x04060f, 0x0b1633, 0x16254f);
    else if (this.mode === 'sunset') set(0x34457f, 0xd98d84, 0xf6b184);
    else set(0x3a7fd0, 0x86bdea, 0xd2e8f6);
    for (const c of this.clouds) (c.sprite.material as THREE.SpriteMaterial).color.setHex(tint);
    if (this.sunSprite) {
      const m = this.sunSprite.material as THREE.SpriteMaterial;
      m.color.setHex(this.mode === 'night' ? 0xbfd0ff : this.mode === 'sunset' ? 0xff9a5a : 0xfff4d6);
      m.opacity = this.mode === 'night' ? 0.55 : 1;
      const sz = this.mode === 'sunset' ? 640 : this.mode === 'night' ? 150 : 300;
      this.sunSprite.scale.set(sz, sz, 1);
    }
  }

  /** Ruido de valor suave para decidir dónde hay nubes. */
  private cloudNoise(x: number, z: number): number {
    const h = (i: number, j: number) => { const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return v - Math.floor(v); };
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }

  private tickSky(px: number, pz: number, dt: number) {
    if (!this.sky) return;
    this.skyTime += dt;
    const cam = this.camera.position;
    this.sky.position.copy(cam);
    const base = this.mode === 'night' ? 0.32 : this.mode === 'sunset' ? 0.92 : 0.95;
    const R = 3600, wind = 5;
    for (const c of this.clouds) {
      const wx = ((((c.ox + wind * this.skyTime - px) % R) + R + R / 2) % R) - R / 2;
      const wz = ((((c.oz + wind * 0.3 * this.skyTime - pz) % R) + R + R / 2) % R) - R / 2;
      const x = px + wx, z = pz + wz;
      c.sprite.position.set(x, c.alt, z);
      // cobertura según la zona: hay barrios despejados y otros nubosos
      const n = this.cloudNoise(x / 2600 + 3.1, z / 2600 + 7.7);
      const cover = Math.min(Math.max((n - 0.4) / 0.25, 0), 1);
      const edge = 1 - Math.pow(Math.abs(wx) / (R / 2), 6);   // se desvanecen al envolver por los bordes
      (c.sprite.material as THREE.SpriteMaterial).opacity = base * cover * Math.max(edge, 0) * (0.6 + 0.4 * c.seed);
    }
    if (this.sunSprite) {
      const kp = ATMOSPHERE_SPECS[this.mode].keyPosition;
      const d = new THREE.Vector3(kp[0], Math.abs(kp[1]) + 8, kp[2]).normalize();
      this.sunSprite.position.set(cam.x + d.x * 1700, cam.y + d.y * 1700, cam.z + d.z * 1700);
    }
  }

  private applySky() {
    const s = SKY[this.mode];
    this.scene.environmentIntensity = this.mode === 'night' ? 0.4 : this.mode === 'sunset' ? 0.55 : 0.9;
    this.scene.background = null;
    this.updateSky();
    this.fog.color.setHex(s.fog);
    this.fog.far = s.fogFar;
    this.fog.near = s.fogFar * 0.12;
    this.rebuildEnv();
    this.applyFx();
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
    this.applyLamps();
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
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
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
    if (this.camSnap) this.carY = heightAt(p.x, p.z);
    const gy = this.groundY(p.x, p.z, this.carY, this.camSnap);
    this.carY = gy;
    const hd = state.headingDeg * DEG;
    const ahead = this.groundY(p.x + Math.sin(hd) * 1.9, p.z - Math.cos(hd) * 1.9, gy);
    const behind = this.groundY(p.x - Math.sin(hd) * 1.9, p.z + Math.cos(hd) * 1.9, gy);
    const side =
      this.groundY(p.x + Math.cos(hd) * 0.9, p.z + Math.sin(hd) * 0.9, gy) -
      this.groundY(p.x - Math.cos(hd) * 0.9, p.z - Math.sin(hd) * 0.9, gy);
    this.groundPitch += (Math.atan2(ahead - behind, 3.8) - this.groundPitch) * (1 - Math.exp(-10 * dt));
    this.groundRoll += (Math.atan2(side, 1.8) - this.groundRoll) * (1 - Math.exp(-10 * dt));
    if (this.camSnap) this.camGround = gy;
    this.camGround += (gy - this.camGround) * (1 - Math.exp(-6 * dt));
    this.rig.root.rotation.order = 'YXZ';
    this.rig.root.position.set(p.x, gy + 0.05, p.z);
    this.rig.root.rotation.y = -hd - state.driftSlipRad * 0.45;
    this.rig.root.rotation.x = this.groundPitch;
    this.rig.root.rotation.z = this.groundRoll;

    const cfg = this.preset === 'aerial' && this.aerialZoom !== 1 ? { ...CAM.aerial, dist: CAM.aerial.dist * this.aerialZoom, height: CAM.aerial.height * this.aerialZoom } : CAM[this.preset];
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
    // sensaciones de conducción: vibración por la velocidad, sacudida en impactos, mirada hacia el interior de la curva e inclinación
    state.shake = Math.max(0, state.shake - dt * 2.2);
    this.camClock += dt * (8 + Math.abs(state.speedMps) * 0.9);
    const spd = Math.min(Math.abs(state.speedMps) / 40, 1);
    const vib = spd * (driver ? 0.012 : 0.006) + state.shake * 0.12;
    this.camera.position.set(
      this.camPos.x + Math.sin(this.camClock * 1.7) * vib,
      this.camPos.y + Math.sin(this.camClock * 2.3) * vib + Math.sin(this.camClock * 0.9) * state.shake * 0.05,
      this.camPos.z + Math.cos(this.camClock * 1.3) * vib);
    const lookSide = state.steerCmd * 2.2 * (driver ? 1.4 : 1);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.x + fx * cfg.look - fz * lookSide, this.camGround + (driver ? 1.1 : 1.0), p.z + fz * cfg.look + fx * lookSide);
    this.camRoll += ((driver ? -state.bodyRollRad * 0.9 : state.bodyRollRad * 0.5) - this.camRoll) * (1 - Math.exp(-6 * dt));
    this.camera.rotateZ(this.camRoll);
    const accelKick = Math.max(-1, Math.min(1, state.bodyPitchRad * -25));
    const fov = cfg.fov + spd * 8 + accelKick * 1.5 + (state.isBraking ? 0 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // sombra y luz siguen al coche
    const kp = ATMOSPHERE_SPECS[this.mode].keyPosition;
    this.key.position.set(p.x + kp[0] * 6, gy + Math.abs(kp[1]) * 6 + 40, p.z + kp[2] * 6);
    this.key.target.position.set(p.x, gy, p.z);
    this.rim.position.set(p.x + 14, 9, p.z + 16);

    this.updateLampLights(p.x, p.z);
    this.signals.update(dt);
    this.traffic.update(dt, p.x, p.z, hd, state.speedMps, this.mode === 'night' ? 0.5 : 1, this.peds.onRoad());
    if (this.carTest) { this.carTest = false; this.traffic.debugShowroom(p.x, p.z, Math.sin(hd), -Math.cos(hd)); }
    if (this.pedTest) { this.pedTest = false; this.peds.debugAhead(p.x, p.z, Math.sin(hd), -Math.cos(hd)); }
    this.peds.update(dt, p.x, p.z, hd, Math.abs(state.speedMps), this.mode === 'night' ? 0.4 : this.mode === 'sunset' ? 0.8 : 1);
    this.tickSky(p.x, p.z, dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.ro.disconnect();
    this.rig.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.composer?.dispose();
    this.peds.dispose();
    this.traffic.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
