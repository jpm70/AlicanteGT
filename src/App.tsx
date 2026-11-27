import { useCallback, useEffect, useRef, useState } from 'react';
import { DriverCockpitOverlay } from './components/DriverCockpitOverlay';
import { RacingHud } from './components/RacingHud';
import { PlacesPanel, type Place } from './components/PlacesPanel';
import {
  ALICANTE_LANDMARKS,
  CAR_PAINT_PRESETS,
  INITIAL_VIEW,
} from './game/constants';
import {
  createInitialCarState,
  getNearestAlicanteZone,
  stepCarPhysics,
} from './game/carPhysics';
import { EngineAudioSynth } from './game/engineAudio';
import { getSkyBackdropCss } from './game/sky';
import { WorldScene } from './world/WorldScene';
import { toLocal } from './world/geo';
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

/** Parámetros opcionales de la URL: ?lat=38.35&lng=-0.47&brg=90&cam=driver|chase|aerial (para compartir o probar un sitio). */
function readStartOverrides(): { lat: number; lng: number; bearing: number; cam: CameraPreset | null } | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const lat = parseFloat(q.get('lat') ?? ''), lng = parseFloat(q.get('lng') ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const brg = parseFloat(q.get('brg') ?? '');
    const cam = q.get('cam');
    return {
      lat, lng,
      bearing: Number.isFinite(brg) ? ((brg % 360) + 360) % 360 : INITIAL_VIEW.bearing,
      cam: cam === 'driver' || cam === 'chase' || cam === 'aerial' ? cam : null,
    };
  } catch {
    return null;
  }
}
const START_OVERRIDE = typeof window !== 'undefined' ? readStartOverrides() : null;

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldScene | null>(null);
  const audioRef = useRef<EngineAudioSynth | null>(null);

  const carStateRef = useRef<CarState>(
    createInitialCarState(START_OVERRIDE?.lat ?? INITIAL_VIEW.lat, START_OVERRIDE?.lng ?? INITIAL_VIEW.lng, START_OVERRIDE?.bearing ?? INITIAL_VIEW.bearing)
  );
  const controlsRef = useRef<ControlInput>({
    throttle: false,
    brake: false,
    left: false,
    right: false,
    handbrake: false,
  });

  const tileHealthRef = useRef<{ status: 'loading' | 'ready' | 'error'; text: string }>({
    status: 'loading',
    text: 'Cargando mundo 3D…',
  });

  const [atmosphere, setAtmosphere] = useState<AtmosphereMode>('sunset');
  const atmosphereRef = useRef<AtmosphereMode>('sunset');

  const [paint, setPaint] = useState<CarPaintPreset>(CAR_PAINT_PRESETS[0]);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>(START_OVERRIDE?.cam ?? 'chase');
  const cameraPresetRef = useRef<CameraPreset>(START_OVERRIDE?.cam ?? 'chase');

  const [currentLandmarkId, setCurrentLandmarkId] = useState<string>(ALICANTE_LANDMARKS[0].id);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [places, setPlaces] = useState<Place[] | null>(null);
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
    tileStatusText: 'Cargando mundo 3D…',
  });

  const applyAtmosphereMode = useCallback((nextMode: AtmosphereMode) => {
    atmosphereRef.current = nextMode;
    setAtmosphere(nextMode);
    worldRef.current?.setAtmosphere(nextMode);
  }, []);

  const handlePaintChange = useCallback((nextPaint: CarPaintPreset) => {
    setPaint(nextPaint);
    worldRef.current?.setPaint(nextPaint);
  }, []);

  const teleportToLandmark = useCallback((landmark: LandmarkPreset) => {
    setCurrentLandmarkId(landmark.id);
    carStateRef.current = createInitialCarState(landmark.lat, landmark.lng, landmark.bearing);

    if (landmark.camera && landmark.camera !== cameraPresetRef.current) {
      cameraPresetRef.current = landmark.camera;
      setCameraPreset(landmark.camera);
      worldRef.current?.setCameraPreset(landmark.camera);
    }
    worldRef.current?.snapCamera();
    worldRef.current?.collision?.reset();
  }, []);

  const teleportToPlace = useCallback((pl: Place) => {
    carStateRef.current = createInitialCarState(pl.la, pl.lo, carStateRef.current.headingDeg);
    worldRef.current?.snapCamera();
    worldRef.current?.collision?.reset();
    setPlacesOpen(false);
  }, []);

  const handleReset = useCallback(() => {
    const landmark =
      ALICANTE_LANDMARKS.find((l) => l.id === currentLandmarkId) ?? ALICANTE_LANDMARKS[0];
    teleportToLandmark(landmark);
  }, [currentLandmarkId, teleportToLandmark]);

  useEffect(() => {
    if (!placesOpen || places) return;
    fetch(`${import.meta.env.BASE_URL}world/places.json`).then((r) => r.json()).then((d: Place[]) => setPlaces(d)).catch(() => setPlaces([]));
  }, [placesOpen, places]);

  const handleCycleCamera = useCallback(() => {
    setCameraPreset((prev) => {
      const order: CameraPreset[] = ['chase', 'driver', 'aerial'];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      cameraPresetRef.current = next;
      worldRef.current?.setCameraPreset(next);
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
      } else if (code === 'KeyL' && !e.repeat) {
        setPlacesOpen((o) => !o);                          // L: lista de lugares
      } else if (code === 'KeyT' && !e.repeat) {
        const w = worldRef.current;                       // T: tráfico y peatones sí/no
        if (w) { const on = !w.traffic.enabled; w.traffic.enabled = on; w.peds.enabled = on; }
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

  // Escena Three.js propia (mundo .glb + coche + colisiones) y bucle de juego
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const world = new WorldScene(container, CAR_PAINT_PRESETS[0], atmosphereRef.current, isSoftwareGl);
    worldRef.current = world;
    world.setCameraPreset(cameraPresetRef.current);
    (window as unknown as { __world?: WorldScene }).__world = world;

    const canvas = world.renderer.domElement;
    const onContextLost = (ev: Event) => {
      ev.preventDefault();
      setWebglLost(true);
    };
    const onContextRestored = () => setWebglLost(false);
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    let disposed = false;
    const startPos = toLocal(carStateRef.current.lat, carStateRef.current.lng);
    world
      .init(import.meta.env.BASE_URL, startPos.x, startPos.z)
      .then(() => {
        if (disposed) return;
        // si el punto de salida cae dentro de un edificio, lo saca
        world.collision?.resolve(carStateRef.current);
        tileHealthRef.current = { status: 'ready', text: 'Mundo 3D OK' };
        setMapReady(true);
      })
      .catch((err) => {
        console.warn('[Alicante GT] Error cargando el mundo 3D:', err);
        tileHealthRef.current = { status: 'error', text: 'Error cargando el mundo' };
        setMapReady(true);
      });

    let frameId = 0;
    let lastTime = performance.now();
    let lastHudUpdate = 0;

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
      lastTime = now;

      const state = carStateRef.current;
      const input = controlsRef.current;

      stepCarPhysics(state, input, dt);
      const impact = Math.max(world.collision?.resolve(state) ?? 0, world.traffic.collide(state));
      if (impact > 0.25 && Math.abs(state.speedMps) > 4) state.shake = Math.min(1, Math.max(state.shake, impact * Math.min(Math.abs(state.speedMps) / 25, 1)));

      if (audioRef.current) {
        audioRef.current.update(state.rpm, state.speedKmh, state.driftIntensity, input.throttle);
      }

      world.render(state, dt);

      // HUD de React a ~20 Hz
      if (now - lastHudUpdate > 50) {
        lastHudUpdate = now;
        setTelemetry({
          speedKmh: state.speedKmh,
          gear: state.gear,
          rpm: state.rpm,
          isBraking: state.isBraking,
          isDrifting: state.isDrifting,
          zoneName: (() => {
            const zone = getNearestAlicanteZone(state.lat, state.lng);
            const pl = toLocal(state.lat, state.lng);
            const street = world.streetAt(pl.x, pl.z);
            return street ? `${street} · ${zone}` : zone;
          })(),
          headingDeg: state.headingDeg,
          lat: state.lat,
          lng: state.lng,
          tilesStatus: tileHealthRef.current.status,
          tileStatusText: tileHealthRef.current.text,
        });
      }

      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);

    const readyTimer = window.setTimeout(() => setMapReady(true), 15000);

    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
      cancelAnimationFrame(frameId);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      audioRef.current?.dispose();
      audioRef.current = null;
      world.dispose();
      worldRef.current = null;
    };
  }, []);

  return (
    <main
      className="relative h-full w-full overflow-hidden"
      style={{ background: getSkyBackdropCss(atmosphere) }}
    >
      {/* Viewport WebGL (Three.js) */}
      <div
        ref={mapContainerRef}
        className="h-full w-full"
        aria-label="Alicante en 3D con coche deportivo"
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
            Cargando Alicante en 3D…
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

      <p className="pointer-events-none fixed bottom-1 right-2 z-20 text-[10px] text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
        Ortofoto © IGN · PNOA (CC BY 4.0) · Edificios © Catastro · Datos © colaboradores de OpenStreetMap · Relieve EU-DEM
      </p>

      {/* Semantic Motorsport HUD Overlay */}
      <button
        type="button"
        onClick={() => setPlacesOpen((o) => !o)}
        className="fixed right-3 top-3 z-30 flex items-center gap-1.5 rounded-lg border border-white/20 bg-[#0b1220]/80 px-2.5 py-1.5 text-xs font-medium text-slate-100 shadow-lg backdrop-blur hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        title="Lugares: gasolineras, hospitales, estaciones… (L)"
      >
        <span aria-hidden="true">📍</span> Lugares
      </button>
      <PlacesPanel open={placesOpen} places={places} from={{ lat: telemetry.lat, lng: telemetry.lng }} onClose={() => setPlacesOpen(false)} onGo={teleportToPlace} />

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
