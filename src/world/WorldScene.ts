import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ATMOSPHERE_SPECS } from '../game/constants';
import type { AtmosphereMode, CameraPreset, CarPaintPreset, CarState } from '../types/game';
import { createSportsCar, type SportsCarRig } from '../scene/createSportsCar';
import { CollisionWorld, type BuildingCollider } from './collision';
import { toLocal } from './geo';

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
      m.castShadow = n === 'Buildings';
      m.material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: n === 'Road' ? 0.92 : 0.85,
        metalness: 0,
      });
    });
    this.scene.add(gltf.scene);
    this.collision = new CollisionWorld(col.buildings as BuildingCollider[]);
    onProgress?.(`Mundo listo · ${this.collision.count} edificios`);
  }

  private applySky() {
    const s = SKY[this.mode];
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
