import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ATMOSPHERE_SPECS } from '../game/constants';
import type { AtmosphereMode, CarPaintPreset, CarState } from '../types/game';
import { createSportsCar, type SportsCarRig } from './createSportsCar';

const DEG_TO_RAD = Math.PI / 180;

// Pre-allocated math helpers outside render loop (zero per-frame GC)
const _mapMatrix = new THREE.Matrix4();
const _modelMatrix = new THREE.Matrix4();
const _rotXHalfPi = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const _scaleVec = new THREE.Vector3();

/**
 * Safely generates a PMREM RoomEnvironment texture on MapLibre's shared WebGL context
 * while preserving and restoring critical GL state (FBO, viewport, scissor, VAO, pixelStore)
 * so MapLibre's vector tile renderer is completely unaffected.
 */
function buildStudioEnvironmentSafely(
  renderer: THREE.WebGLRenderer,
  gl: WebGLRenderingContext | WebGL2RenderingContext
): THREE.WebGLRenderTarget | null {
  const gl2 = gl as WebGL2RenderingContext;
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const prevScissor = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
  const prevScissorTest = gl.isEnabled(gl.SCISSOR_TEST);
  const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM);
  const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);
  const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const prevVao =
    typeof gl2.bindVertexArray === 'function'
      ? gl2.getParameter(gl2.VERTEX_ARRAY_BINDING)
      : null;

  let envTarget: THREE.WebGLRenderTarget | null = null;
  try {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    roomEnv.dispose();
    pmremGenerator.dispose();
  } catch {
    envTarget = null;
  } finally {
    // Restore exact GL bindings for MapLibre's internal WebGL state cache
    if (typeof gl2.bindVertexArray === 'function') {
      gl2.bindVertexArray(prevVao);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    gl.scissor(prevScissor[0], prevScissor[1], prevScissor[2], prevScissor[3]);
    if (prevScissorTest) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prevProgram);
    gl.activeTexture(prevActiveTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY);
    renderer.resetState();
  }
  return envTarget;
}

/**
 * MapLibre GL CustomLayerInterface that renders the 3D Three.js sports car
 * directly into MapLibre's shared WebGL depth buffer without clearing MapLibre's color buffer
 * and with clean WebGL2 VAO restoration after every frame.
 */
export class CarCustomLayer implements maplibregl.CustomLayerInterface {
  public readonly id = 'alicante-sports-car-3d';
  public readonly type = 'custom' as const;
  public readonly renderingMode = '3d' as const;

  private map: maplibregl.Map | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private carRig: SportsCarRig;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;

  private keyLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private rimLight: THREE.DirectionalLight;

  private carStateRef: { current: CarState };
  private lastRenderTime = performance.now();

  constructor(
    carStateRef: { current: CarState },
    initialPaint: CarPaintPreset,
    initialAtmosphere: AtmosphereMode
  ) {
    this.carStateRef = carStateRef;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();

    // 3-point outdoor/studio lighting rig synced with atmosphere mode
    const spec = ATMOSPHERE_SPECS[initialAtmosphere];
    this.keyLight = new THREE.DirectionalLight(spec.keyColor, spec.keyIntensity);
    this.keyLight.position.set(...spec.keyPosition);
    this.scene.add(this.keyLight);

    this.hemiLight = new THREE.HemisphereLight(
      spec.hemiSkyColor,
      spec.hemiGroundColor,
      spec.hemiIntensity
    );
    this.scene.add(this.hemiLight);

    this.rimLight = new THREE.DirectionalLight(spec.rimColor, spec.rimIntensity);
    this.rimLight.position.set(14, 9, 16);
    this.scene.add(this.rimLight);

    this.carRig = createSportsCar(initialPaint, initialAtmosphere);
    this.carRig.root.traverse((obj) => {
      obj.frustumCulled = false;
    });
    this.scene.add(this.carRig.root);
  }

  public onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    // CRITICAL: Never clear MapLibre's color/depth buffer before drawing the 3D car
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.envRenderTarget = buildStudioEnvironmentSafely(this.renderer, gl);
    if (this.envRenderTarget) {
      this.scene.environment = this.envRenderTarget.texture;
    }
  }

  public onRemove(): void {
    this.carRig.dispose();
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
    }
    this.scene.environment = null;
    this.map = null;
    this.renderer = null;
  }

  public setAtmosphere(mode: AtmosphereMode): void {
    const spec = ATMOSPHERE_SPECS[mode];
    this.keyLight.color.setHex(spec.keyColor);
    this.keyLight.intensity = spec.keyIntensity;
    this.keyLight.position.set(...spec.keyPosition);

    this.hemiLight.color.setHex(spec.hemiSkyColor);
    this.hemiLight.groundColor.setHex(spec.hemiGroundColor);
    this.hemiLight.intensity = spec.hemiIntensity;

    this.rimLight.color.setHex(spec.rimColor);
    this.rimLight.intensity = spec.rimIntensity;

    this.carRig.setAtmosphere(mode);
    this.map?.triggerRepaint();
  }

  public setPaint(paint: CarPaintPreset): void {
    this.carRig.setPaint(paint);
    this.map?.triggerRepaint();
  }

  public setBodyVisible(visible: boolean): void {
    this.carRig.setBodyVisible(visible);
    this.map?.triggerRepaint();
  }

  public render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: maplibregl.CustomRenderMethodInput | number[]
  ): void {
    if (!this.renderer || !this.map) return;

    // Support both MapLibre GL v5 (CustomRenderMethodInput) and v4 (number[])
    const rawMatrix = Array.isArray(args)
      ? args
      : (args as maplibregl.CustomRenderMethodInput)?.defaultProjectionData?.mainMatrix;
    if (!rawMatrix) return;

    const now = performance.now();
    const dt = Math.min(Math.max((now - this.lastRenderTime) / 1000, 0.001), 0.05);
    this.lastRenderTime = now;

    const state = this.carStateRef.current;

    // Update car visual articulation (steering, spinning wheels, brake flare, suspension, drift smoke)
    this.carRig.updateFromState(state, dt);
    this.carRig.root.rotation.y = -(state.headingDeg * DEG_TO_RAD) - state.driftSlipRad * 0.45;

    // STRICT [lng, lat] order with Z = 0.2m elevation to prevent asphalt z-fighting
    const carMercator = maplibregl.MercatorCoordinate.fromLngLat([state.lng, state.lat], 0.2);
    const meterScale = carMercator.meterInMercatorCoordinateUnits();

    // Local metric right-handed space -> MapLibre Mercator space
    _scaleVec.set(meterScale, -meterScale, meterScale);
    _modelMatrix
      .makeTranslation(carMercator.x, carMercator.y, carMercator.z)
      .scale(_scaleVec)
      .multiply(_rotXHalfPi);

    _mapMatrix.fromArray(rawMatrix as number[]);

    // Align Three.js camera eye in local metric space for physically accurate metallic reflections
    const bearingRad = this.map.getBearing() * DEG_TO_RAD;
    const pitchRad = this.map.getPitch() * DEG_TO_RAD;
    const zoom = this.map.getZoom();
    const camDist =
      ((40075016.686 * Math.cos(state.lat * DEG_TO_RAD)) / Math.pow(2, zoom)) * 0.35;
    const horizDist = camDist * Math.sin(pitchRad);
    const camX = -Math.sin(bearingRad) * horizDist;
    const camY = Math.max(1.8, camDist * Math.cos(pitchRad));
    const camZ = Math.cos(bearingRad) * horizDist;

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(0, 0.9, 0);
    this.camera.updateMatrixWorld(true);
    this.camera.projectionMatrix
      .copy(_mapMatrix)
      .multiply(_modelMatrix)
      .multiply(this.camera.matrixWorld);

    // CRITICAL WebGL synchronization: reset Three.js state, NEVER call renderer.clear(),
    // and unbind WebGL2 VAO afterwards so MapLibre's tile/building shaders stay pristine.
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);

    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.bindVertexArray === 'function') {
      gl2.bindVertexArray(null);
    }
  }
}
