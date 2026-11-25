import { useCallback, useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { DriverCockpitOverlay } from './components/DriverCockpitOverlay';
import { RacingHud } from './components/RacingHud';
import {
  ALICANTE_LANDMARKS,
  CAR_PAINT_PRESETS,
  INITIAL_VIEW,
  OPENFREEMAP_STYLE_URL,
} from './game/constants';
import {
  createInitialCarState,
  getNearestAlicanteZone,
  stepCarPhysics,
} from './game/carPhysics';
import { EngineAudioSynth } from './game/engineAudio';
import { applyMapAtmosphere, getSkyBackdropCss } from './map/atmosphereStyler';
import { CarCustomLayer } from './scene/CarCustomLayer';
import type {
  AtmosphereMode,
  CameraPreset,
  CarPaintPreset,
  CarState,
  ControlInput,
  HudTelemetry,
  LandmarkPreset,
} from './types/game';

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function dampAngleDeg(current: number, target: number, lambda: number, dt: number): number {
  let diff = ((target - current + 540) % 360) - 180;
  diff *= 1 - Math.exp(-lambda * dt);
  return (current + diff + 360) % 360;
}

const CAMERA_CONFIG: Record<
  CameraPreset,
  {
    baseZoom: number;
    speedZoomDrop: number;
    basePitch: number;
    speedPitchAdd: number;
    leadBase: number;
    leadSpeedFactor: number;
    bearingLambda: number;
  }
> = {
  // 1) Tercera Persona (Persecución): baja y pegada al coche
  chase: {
    baseZoom: INITIAL_VIEW.zoom, // 19.6
    speedZoomDrop: 0.72,
    basePitch: INITIAL_VIEW.pitch, // 74
    speedPitchAdd: 5.5,
    leadBase: 5.5,
    leadSpeedFactor: 0.25,
    bearingLambda: 5.4,
  },
  // 2) Modo Conductor (Cockpit): a ras de carretera mirando hacia delante
  driver: {
    baseZoom: 21.2,
    speedZoomDrop: 0.28,
    basePitch: 83,
    speedPitchAdd: 1.5,
    leadBase: 14.5,
    leadSpeedFactor: 0.18,
    bearingLambda: 13.0,
  },
  // 3) Vista Aérea / Drone
  aerial: {
    baseZoom: 18.2,
    speedZoomDrop: 0.65,
    basePitch: 50,
    speedPitchAdd: 5.0,
    leadBase: 6.0,
    leadSpeedFactor: 0.26,
    bearingLambda: 4.5,
  },
};

function computeCameraTargetLngLat(
  lng: number,
  lat: number,
  headingDeg: number,
  leadMeters: number
): [number, number] {
  const headingRad = headingDeg * DEG_TO_RAD;
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(lat * DEG_TO_RAD);
  const targetLat = lat + (Math.cos(headingRad) * leadMeters) / METERS_PER_DEG_LAT;
  const targetLng = lng + (Math.sin(headingRad) * leadMeters) / metersPerDegLng;
  return [targetLng, targetLat]; // Strict [lng, lat] order for MapLibre
}

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const carLayerRef = useRef<CarCustomLayer | null>(null);
  const audioRef = useRef<EngineAudioSynth | null>(null);

  const carStateRef = useRef<CarState>(
    createInitialCarState(INITIAL_VIEW.lat, INITIAL_VIEW.lng, INITIAL_VIEW.bearing)
  );
  const controlsRef = useRef<ControlInput>({
    throttle: false,
    brake: false,
    left: false,
    right: false,
    handbrake: false,
  });

  const [initialCamLng, initialCamLat] = computeCameraTargetLngLat(
    INITIAL_VIEW.lng,
    INITIAL_VIEW.lat,
    INITIAL_VIEW.bearing,
    CAMERA_CONFIG.chase.leadBase
  );

  const camStateRef = useRef({
    lng: initialCamLng,
    lat: initialCamLat,
    bearing: INITIAL_VIEW.bearing,
    zoom: INITIAL_VIEW.zoom,
    pitch: INITIAL_VIEW.pitch,
  });

  const tileHealthRef = useRef<{ status: 'loading' | 'ready' | 'error'; text: string }>({
    status: 'loading',
    text: 'Cargando teselas…',
  });

  const [atmosphere, setAtmosphere] = useState<AtmosphereMode>('sunset');
  const atmosphereRef = useRef<AtmosphereMode>('sunset');

  const [paint, setPaint] = useState<CarPaintPreset>(CAR_PAINT_PRESETS[0]);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('chase');
  const cameraPresetRef = useRef<CameraPreset>('chase');

  const [currentLandmarkId, setCurrentLandmarkId] = useState<string>(ALICANTE_LANDMARKS[0].id);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [webglLost, setWebglLost] = useState(false);

  const [telemetry, setTelemetry] = useState<HudTelemetry>({
    speedKmh: 0,
    gear: 'N',
    rpm: 0.16,
    isBraking: false,
    isDrifting: false,
    zoneName: ALICANTE_LANDMARKS[0].zone,
    headingDeg: INITIAL_VIEW.bearing,
    lat: INITIAL_VIEW.lat,
    lng: INITIAL_VIEW.lng,
    tilesStatus: 'loading',
    tileStatusText: 'Cargando teselas…',
  });

  const applyAtmosphereMode = useCallback((nextMode: AtmosphereMode) => {
    atmosphereRef.current = nextMode;
    setAtmosphere(nextMode);
    if (mapRef.current) {
      applyMapAtmosphere(mapRef.current, nextMode, carLayerRef.current?.id);
    }
    carLayerRef.current?.setAtmosphere(nextMode);
  }, []);

  const handlePaintChange = useCallback((nextPaint: CarPaintPreset) => {
    setPaint(nextPaint);
    carLayerRef.current?.setPaint(nextPaint);
  }, []);

  const teleportToLandmark = useCallback((landmark: LandmarkPreset) => {
    setCurrentLandmarkId(landmark.id);
    carStateRef.current = createInitialCarState(landmark.lat, landmark.lng, landmark.bearing);

    const cfg = CAMERA_CONFIG[cameraPresetRef.current];
    const [camLng, camLat] = computeCameraTargetLngLat(
      landmark.lng,
      landmark.lat,
      landmark.bearing,
      cfg.leadBase
    );

    camStateRef.current = {
      lng: camLng,
      lat: camLat,
      bearing: landmark.bearing,
      zoom: cfg.baseZoom,
      pitch: cfg.basePitch,
    };

    // Strict [lng, lat] center order
    mapRef.current?.jumpTo({
      center: [camLng, camLat],
      bearing: landmark.bearing,
      zoom: cfg.baseZoom,
      pitch: cfg.basePitch,
    });
  }, []);

  const handleReset = useCallback(() => {
    const landmark =
      ALICANTE_LANDMARKS.find((l) => l.id === currentLandmarkId) ?? ALICANTE_LANDMARKS[0];
    teleportToLandmark(landmark);
  }, [currentLandmarkId, teleportToLandmark]);

  const handleCycleCamera = useCallback(() => {
    setCameraPreset((prev) => {
      const order: CameraPreset[] = ['chase', 'driver', 'aerial'];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      cameraPresetRef.current = next;
      carLayerRef.current?.setBodyVisible(next !== 'driver');
      return next;
    });
  }, []);

  const handleToggleAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new EngineAudioSynth();
    }
    const next = !audioRef.current.isEnabled();
    audioRef.current.setEnabled(next);
    setAudioEnabled(next);
  }, []);

  const handleTouchControl = useCallback(
    (key: keyof ControlInput, active: boolean) => {
      controlsRef.current[key] = active;
    },
    []
  );

  // Keyboard controls (WASD / Arrow keys + Space + shortcuts)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') {
        controlsRef.current.throttle = true;
        e.preventDefault();
      } else if (code === 'KeyS' || code === 'ArrowDown') {
        controlsRef.current.brake = true;
        e.preventDefault();
      } else if (code === 'KeyA' || code === 'ArrowLeft') {
        controlsRef.current.left = true;
        e.preventDefault();
      } else if (code === 'KeyD' || code === 'ArrowRight') {
        controlsRef.current.right = true;
        e.preventDefault();
      } else if (code === 'Space') {
        controlsRef.current.handbrake = true;
        e.preventDefault();
      } else if (code === 'KeyR' && !e.repeat) {
        handleReset();
      } else if (code === 'KeyC' && !e.repeat) {
        handleCycleCamera();
      } else if (code === 'KeyH' && !e.repeat) {
        setDockCollapsed((prev) => !prev);
      } else if (code === 'Digit1' && !e.repeat) {
        applyAtmosphereMode('sunset');
      } else if (code === 'Digit2' && !e.repeat) {
        applyAtmosphereMode('night');
      } else if (code === 'Digit3' && !e.repeat) {
        applyAtmosphereMode('day');
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') {
        controlsRef.current.throttle = false;
      } else if (code === 'KeyS' || code === 'ArrowDown') {
        controlsRef.current.brake = false;
      } else if (code === 'KeyA' || code === 'ArrowLeft') {
        controlsRef.current.left = false;
      } else if (code === 'KeyD' || code === 'ArrowRight') {
        controlsRef.current.right = false;
      } else if (code === 'Space') {
        controlsRef.current.handbrake = false;
      }
    };

    const onBlur = () => {
      controlsRef.current = {
        throttle: false,
        brake: false,
        left: false,
        right: false,
        handbrake: false,
      };
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [applyAtmosphereMode, handleCycleCamera, handleReset]);

  // Mount MapLibre GL JS + Three.js Custom Layer + Driving/Chase-Cam Loop once
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const initCam = camStateRef.current;

    // Explicit Vite ?url worker path so Vite 8 never breaks MapLibre's internal Web Worker
    maplibregl.setWorkerUrl(maplibreWorkerUrl);

    // STRICT [lng, lat] order: [-0.4820, 38.3432] for Paseo Mártires / Explanada de Alicante
    const map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_STYLE_URL,
      center: [initCam.lng, initCam.lat],
      zoom: initCam.zoom,
      pitch: initCam.pitch,
      bearing: initCam.bearing,
      maxPitch: 85,
      minZoom: 14,
      maxZoom: 22,
      interactive: false,
      canvasContextAttributes: { antialias: !isSoftwareGl },
      pixelRatio: isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
      attributionControl: { compact: true },
    });

    mapRef.current = map;

    const carLayer = new CarCustomLayer(carStateRef, CAR_PAINT_PRESETS[0], atmosphereRef.current);
    carLayerRef.current = carLayer;

    const canvas = map.getCanvas();
    const onContextLost = (ev: Event) => {
      ev.preventDefault();
      setWebglLost(true);
    };
    const onContextRestored = () => {
      setWebglLost(false);
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    let styleInitialized = false;

    map.on('style.load', () => {
      styleInitialized = true;
      const audit = applyMapAtmosphere(map, atmosphereRef.current, carLayer.id);
      // Add Three.js 3D CustomLayer last (no beforeId) so it always renders above roads cleanly
      if (!map.getLayer(carLayer.id)) {
        map.addLayer(carLayer);
      }
      carLayer.setBodyVisible(cameraPresetRef.current !== 'driver');
      console.info(
        `[Alicante GT] Estilo OpenFreeMap cargado en [lng=${INITIAL_VIEW.lng}, lat=${INITIAL_VIEW.lat}] | ` +
          `Edificios 3D: ${audit.buildingLayerId} | Capas de calles visibles: ${audit.roadLayersVisible} | Agua visible: ${audit.waterLayerVisible}`
      );
      setMapReady(true);
    });

    map.on('sourcedata', (ev) => {
      if (ev.sourceId === 'openmaptiles' && ev.isSourceLoaded && tileHealthRef.current.status !== 'ready') {
        tileHealthRef.current = { status: 'ready', text: 'Teselas vectoriales OK' };
        console.info(
          `[Alicante GT] Teselas vectoriales openmaptiles cargadas sin errores en [lng=${carStateRef.current.lng.toFixed(4)}, lat=${carStateRef.current.lat.toFixed(4)}]`
        );
      }
    });

    map.on('load', () => {
      if (tileHealthRef.current.status === 'loading') {
        tileHealthRef.current = { status: 'ready', text: 'Teselas vectoriales OK' };
      }
      console.info(
        `[Alicante GT] Mapa listo | Centro [lng=${map.getCenter().lng.toFixed(4)}, lat=${map.getCenter().lat.toFixed(4)}] | Zoom ${map.getZoom().toFixed(2)} | Pitch ${map.getPitch().toFixed(1)}°`
      );
      setMapReady(true);
    });

    map.on('styleimagemissing', () => {
      // POI/icon symbol layers are intentionally hidden for a clean racing view
    });

    map.on('error', (ev) => {
      const msg = ev?.error?.message || 'Error al cargar teselas';
      console.warn('[Alicante GT] Error de MapLibre:', msg, ev);
      if (tileHealthRef.current.status !== 'ready') {
        tileHealthRef.current = { status: 'error', text: 'Error en teselas' };
      }
    });

    const readyTimer = window.setTimeout(() => setMapReady(true), 4500);

    // Smooth third-person chase camera & physics animation loop
    let frameId = 0;
    let lastTime = performance.now();
    let lastHudUpdate = 0;
    let disposed = false;

    const scheduleNext = (cb: () => void) => {
      if (disposed) return;
      if (isSoftwareGl) {
        try {
          const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
          if (gl && typeof gl.fenceSync === 'function') {
            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            const poll = () => {
              if (disposed) {
                if (sync) gl.deleteSync(sync);
                return;
              }
              const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
              if (status === gl.UNSIGNALED) {
                frameId = window.setTimeout(poll, 8);
              } else {
                if (sync) gl.deleteSync(sync);
                frameId = window.setTimeout(cb, 65);
              }
            };
            frameId = window.setTimeout(poll, 8);
            return;
          }
        } catch {
          // fall through
        }
        frameId = window.setTimeout(cb, 80);
      } else {
        frameId = requestAnimationFrame(cb);
      }
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
      lastTime = now;

      const state = carStateRef.current;
      const input = controlsRef.current;

      stepCarPhysics(state, input, dt);

      if (audioRef.current) {
        audioRef.current.update(state.rpm, state.speedKmh, state.driftIntensity, input.throttle);
      }

      // Compute dynamic chase / cockpit / aerial camera target
      const cfg = CAMERA_CONFIG[cameraPresetRef.current];
      const isDriverMode = cameraPresetRef.current === 'driver';
      const speedNorm = Math.min(Math.abs(state.speedMps) / 56, 1);

      const camFollowLambda = isDriverMode
        ? cfg.bearingLambda
        : state.isDrifting
          ? 3.2
          : cfg.bearingLambda;
      const cam = camStateRef.current;
      const prevLng = cam.lng;
      const prevLat = cam.lat;
      const prevBearing = cam.bearing;
      const prevZoom = cam.zoom;
      const prevPitch = cam.pitch;

      cam.bearing = dampAngleDeg(cam.bearing, state.headingDeg, camFollowLambda, dt);

      const leadMeters = cfg.leadBase + Math.max(0, state.speedMps) * cfg.leadSpeedFactor;
      const [targetLng, targetLat] = computeCameraTargetLngLat(
        state.lng,
        state.lat,
        state.headingDeg,
        leadMeters
      );

      const posLambda = isDriverMode ? 18.0 : 9.5;
      cam.lng = damp(cam.lng, targetLng, posLambda, dt);
      cam.lat = damp(cam.lat, targetLat, posLambda, dt);

      const targetZoom = cfg.baseZoom - speedNorm * cfg.speedZoomDrop;
      const targetPitch = Math.min(84.5, cfg.basePitch + speedNorm * cfg.speedPitchAdd);

      cam.zoom = damp(cam.zoom, targetZoom, 5.5, dt);
      cam.pitch = damp(cam.pitch, targetPitch, 5.5, dt);

      const cameraMoved =
        Math.abs(cam.lng - prevLng) > 1e-7 ||
        Math.abs(cam.lat - prevLat) > 1e-7 ||
        Math.abs(cam.bearing - prevBearing) > 0.01 ||
        Math.abs(cam.zoom - prevZoom) > 0.001 ||
        Math.abs(cam.pitch - prevPitch) > 0.01;

      const carActive =
        Math.abs(state.speedMps) > 0.05 ||
        Math.abs(state.steerAngleRad) > 0.01 ||
        state.brakeIntensity > 0.02 ||
        input.left ||
        input.right ||
        input.throttle ||
        input.brake ||
        input.handbrake;

      if (styleInitialized) {
        if (cameraMoved) {
          // STRICT [lng, lat] order
          map.jumpTo({
            center: [cam.lng, cam.lat],
            bearing: cam.bearing,
            zoom: cam.zoom,
            pitch: cam.pitch,
          });
        }
        if (cameraMoved || carActive) {
          map.triggerRepaint();
        }
      }

      // Throttle React HUD state updates (~20 Hz)
      if (now - lastHudUpdate > 50) {
        lastHudUpdate = now;
        setTelemetry({
          speedKmh: state.speedKmh,
          gear: state.gear,
          rpm: state.rpm,
          isBraking: state.isBraking,
          isDrifting: state.isDrifting,
          zoneName: getNearestAlicanteZone(state.lat, state.lng),
          headingDeg: state.headingDeg,
          lat: state.lat,
          lng: state.lng,
          tilesStatus: tileHealthRef.current.status,
          tileStatusText: tileHealthRef.current.text,
        });
      }

      scheduleNext(tick);
    };

    scheduleNext(tick);

    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
      cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      audioRef.current?.dispose();
      audioRef.current = null;
      map.remove();
      mapRef.current = null;
      carLayerRef.current = null;
    };
  }, []);

  return (
    <main
      className="relative h-full w-full overflow-hidden"
      style={{ background: getSkyBackdropCss(atmosphere) }}
    >
      {/* Isolated MapLibre GL + Three.js WebGL Viewport */}
      <div
        ref={mapContainerRef}
        className="h-full w-full"
        aria-label="Mapa 3D interactivo de Alicante con coche deportivo"
      />

      {/* Polished Initialization Scrim */}
      <div
        className={`pointer-events-none fixed inset-0 z-30 flex flex-col items-center justify-center bg-[#090d16] transition-opacity duration-500 ${
          mapReady ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <div className="text-center">
          <h2 className="font-display text-2xl font-bold tracking-tight text-white">
            Alicante GT
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Cargando calles y edificios 3D de la Explanada de España, Alicante…
          </p>
        </div>
      </div>

      {/* WebGL Context Loss Fallback */}
      {webglLost && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#090d16]/95 p-6">
          <div className="max-w-sm rounded-2xl border border-white/15 bg-[#101726] p-6 text-center shadow-2xl">
            <h2 className="font-display text-lg font-bold text-white">
              Contexto gráfico interrumpido
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              El motor WebGL se ha reiniciado temporalmente. Recarga la vista para continuar conduciendo por Alicante.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400"
            >
              Recargar escena 3D
            </button>
          </div>
        </div>
      )}

      {/* First-Person Sports Car Cockpit Overlay (Modo Conductor) */}
      {cameraPreset === 'driver' && (
        <DriverCockpitOverlay
          carStateRef={carStateRef}
          controlsRef={controlsRef}
          paint={paint}
          atmosphere={atmosphere}
          telemetry={telemetry}
          dockCollapsed={dockCollapsed}
        />
      )}

      {/* Semantic Motorsport HUD Overlay */}
      <RacingHud
        telemetry={telemetry}
        atmosphere={atmosphere}
        onAtmosphereChange={applyAtmosphereMode}
        paint={paint}
        onPaintChange={handlePaintChange}
        cameraPreset={cameraPreset}
        onCycleCamera={handleCycleCamera}
        currentLandmarkId={currentLandmarkId}
        onSelectLandmark={teleportToLandmark}
        audioEnabled={audioEnabled}
        onToggleAudio={handleToggleAudio}
        onReset={handleReset}
        dockCollapsed={dockCollapsed}
        onToggleDock={() => setDockCollapsed((prev) => !prev)}
        onTouchControl={handleTouchControl}
      />
    </main>
  );
}
