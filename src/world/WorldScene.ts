import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ATMOSPHERE_SPECS } from '../game/constants';
import type { AtmosphereMode, CameraPreset, CarPaintPreset, CarState } from '../types/game';
import { createSportsCar, type SportsCarRig } from '../scene/createSportsCar';
import { CollisionWorld, type BuildingCollider } from './collision';
import { toLocal } from './geo';
import { createFacadeAtlas, FACADE_STYLES } from './facades';

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
  aerial: { dist: 26, height: 20, look: 6, fov: 55 },
};

/** Escena Three.js propia: mundo .glb de Alicante + coche + cámara + colisiones. Sin MapLibre. */
export class WorldScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 2500);
  readonly rig: SportsCarRig;
  collision: CollisionWorld | null = null;
  world: THREE.Object3D | null = null;

  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private fog = new THREE.Fog(0xcfe6f5, 60, 700);
  private preset: CameraPreset = 'chase';
  private camBearing = 0;
  private camSnap = true;
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

  /** Carga el .glb del mundo y los colisionadores. */
  async loadWorld(base: string, onProgress?: (t: string) => void): Promise<void> {
    onProgress?.('Descargando Alicante 3D…');
    const loader = new GLTFLoader();
    const [gltf, col] = await Promise.all([
      loader.loadAsync(`${base}world/alicante.glb`),
      fetch(`${base}world/colliders.json`).then((r) => r.json()),
    ]);
    this.world = gltf.scene;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const n = o.name;
      // los colores del GLB están en sRGB; Three espera lineal en COLOR_0
      const ca = m.geometry.getAttribute('color');
      if (ca) {
        const c = new THREE.Color();
        for (let i = 0; i < ca.count; i++) {
          c.setRGB(ca.getX(i), ca.getY(i), ca.getZ(i), THREE.SRGBColorSpace);
          ca.setXYZ(i, c.r, c.g, c.b);
        }
        ca.needsUpdate = true;
      }
      m.receiveShadow = true;
      m.castShadow = n === 'Walls' || n === 'Roofs';
      m.material = n === 'Walls'
        ? this.makeWallMaterial()
        : new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            roughness: n === 'Road' ? 0.92 : n === 'Water' ? 0.12 : 0.85,
            metalness: n === 'Water' ? 0.25 : 0,
          });
      if (n === 'Water') m.receiveShadow = false;
    });
    this.scene.add(gltf.scene);
    this.collision = new CollisionWorld([
      ...(col.buildings as BuildingCollider[]),
      ...((col.obstacles ?? []) as BuildingCollider[]),
    ]);
    this.addTrees((col.trees ?? []) as [number, number, number][]);
    onProgress?.(`Mundo listo · ${this.collision.count} edificios`);
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

  /** Árboles y palmeras instanciados (posiciones reales de OSM). */
  private addTrees(trees: [number, number, number][]) {
    const palms = trees.filter((t) => t[2] === 1);
    const broad = trees.filter((t) => t[2] === 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4f35, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.9 });
    const frondMat = new THREE.MeshStandardMaterial({ color: 0x4f8f3c, roughness: 0.85, side: THREE.DoubleSide });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
      im.castShadow = true;
      im.frustumCulled = false;
      this.scene.add(im);
      return im;
    };
    // árboles de hoja ancha: tronco + copa
    const bt = mk(new THREE.CylinderGeometry(0.12, 0.2, 2.6, 6), trunkMat, broad.length);
    const bc = mk(new THREE.IcosahedronGeometry(1.9, 1), leafMat, broad.length);
    broad.forEach(([x, z], i) => {
      const sc = 0.8 + ((i * 37) % 10) / 25;
      m.compose(new THREE.Vector3(x, 1.3, z), q, new THREE.Vector3(1, 1, 1)); bt.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 3.6 * sc, z), q, new THREE.Vector3(sc, sc * 0.85, sc)); bc.setMatrixAt(i, m);
    });
    // palmeras: tronco alto y fina corona de frondas
    const pt = mk(new THREE.CylinderGeometry(0.16, 0.26, 7, 6), trunkMat, palms.length);
    const pf = mk(new THREE.ConeGeometry(2.6, 1.1, 8, 1, true), frondMat, palms.length);
    palms.forEach(([x, z], i) => {
      const sc = 0.85 + ((i * 53) % 10) / 30;
      m.compose(new THREE.Vector3(x, 3.5 * sc, z), q, new THREE.Vector3(sc, sc, sc)); pt.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 7.2 * sc, z), q, new THREE.Vector3(sc, sc, sc)); pf.setMatrixAt(i, m);
    });
    [bt, bc, pt, pf].forEach((im) => { im.instanceMatrix.needsUpdate = true; });
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
    this.rig.updateFromState(state, dt);
    this.rig.root.position.set(p.x, 0.02, p.z);
    this.rig.root.rotation.y = -(state.headingDeg * DEG) - state.driftSlipRad * 0.45;

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
    const ty = cfg.height;
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
    this.camera.lookAt(p.x + fx * cfg.look, driver ? 1.1 : 1.0, p.z + fz * cfg.look);
    const fov = cfg.fov + Math.min(Math.abs(state.speedMps) / 56, 1) * 8;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // sombra y luz siguen al coche
    const kp = ATMOSPHERE_SPECS[this.mode].keyPosition;
    this.key.position.set(p.x + kp[0] * 6, Math.abs(kp[1]) * 6 + 40, p.z + kp[2] * 6);
    this.key.target.position.set(p.x, 0, p.z);
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
