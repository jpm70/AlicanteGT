import { useCallback, useEffect, useRef, useState } from 'react';
import { DriverCockpitOverlay } from './components/DriverCockpitOverlay';
import { RacingHud } from './components/RacingHud';
import { PlacesPanel, type Place } from './components/PlacesPanel';
import { MiniMap } from './components/MiniMap';
import { StartScreen } from './components/StartScreen';
import { Countdown, FinishCard, RaceHud } from './components/RaceHud';
import { bearingTo, distM, loadBest, loadMenu, routeKey, saveBest, saveMenu, startBearing } from './game/race';
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
  RaceConfig,
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

type Phase = 'menu' | 'countdown' | 'racing' | 'free' | 'finished';
const NO_INPUT: ControlInput = { throttle: false, brake: false, left: false, right: false, handbrake: false };
/** Radio (m) a la meta para darla por alcanzada. */
const FINISH_R = 40;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function defaultConfig(): RaceConfig {
  const l = ALICANTE_LANDMARKS[0];
  const base: RaceConfig = {
    start: { n: l.name, la: l.lat, lo: l.lng, b: l.bearing, c: 'attraction' },
    bearing: 'auto', dest: null, camera: START_OVERRIDE?.cam ?? 'chase', paintId: CAR_PAINT_PRESETS[0].id, atmosphere: 'sunset', traffic: true, audio: false,
  };
  const m = typeof window !== 'undefined' ? loadMenu() : null;
  if (!m) return base;
  const okPlace = (v: unknown): v is RaceConfig['start'] => !!v && typeof (v as { n: unknown }).n === 'string' && Number.isFinite((v as { la: number }).la) && Number.isFinite((v as { lo: number }).lo);
  return {
    start: okPlace(m.start) ? m.start : base.start,
    bearing: m.bearing === 'auto' || (typeof m.bearing === 'number' && Number.isFinite(m.bearing)) ? m.bearing : 'auto',
    dest: okPlace(m.dest) ? m.dest : null,
    camera: m.camera === 'chase' || m.camera === 'aerial' || m.camera === 'driver' ? m.camera : base.camera,
    paintId: CAR_PAINT_PRESETS.some((c) => c.id === m.paintId) ? (m.paintId as string) : base.paintId,
    atmosphere: m.atmosphere === 'day' || m.atmosphere === 'sunset' || m.atmosphere === 'night' ? m.atmosphere : 'sunset',
    traffic: m.traffic !== false,
    audio: m.audio === true,
  };
}

const resolveBearing = startBearing;

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<WorldScene | null>(null);
  const audioRef = useRef<EngineAudioSynth | null>(null);

  const [config, setConfig] = useState<RaceConfig>(defaultConfig);
  const [phase, setPhaseState] = useState<Phase>(START_OVERRIDE ? 'free' : 'menu');
  const phaseRef = useRef<Phase>(START_OVERRIDE ? 'free' : 'menu');
  const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);
  const sessionRef = useRef<RaceConfig | null>(null);
  const resumeRef = useRef<'racing' | 'free' | null>(null);
  const [canResume, setCanResume] = useState(false);
  const raceRef = useRef({ tStart: 0, pausedAt: 0, token: 0 });
  const [countdown, setCountdown] = useState<number | 'go' | null>(null);
  const [chrono, setChrono] = useState({ ms: 0, dist: 0, rel: 0 });
  const [finish, setFinish] = useState<{ timeMs: number; bestMs: number | null; record: boolean } | null>(null);

  const carStateRef = useRef<CarState>(
    START_OVERRIDE
      ? createInitialCarState(START_OVERRIDE.lat, START_OVERRIDE.lng, START_OVERRIDE.bearing)
      : createInitialCarState(config.start.la, config.start.lo, resolveBearing(config))
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

  const [atmosphere, setAtmosphere] = useState<AtmosphereMode>(config.atmosphere);
  const atmosphereRef = useRef<AtmosphereMode>(config.atmosphere);

  const initialPaint = CAR_PAINT_PRESETS.find((c) => c.id === config.paintId) ?? CAR_PAINT_PRESETS[0];
  const [paint, setPaint] = useState<CarPaintPreset>(initialPaint);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>(START_OVERRIDE?.cam ?? config.camera);
  const cameraPresetRef = useRef<CameraPreset>(START_OVERRIDE?.cam ?? config.camera);

  const [currentLandmarkId, setCurrentLandmarkId] = useState<string>(ALICANTE_LANDMARKS[0].id);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
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
    setMapOpen(false);
  }, []);

  const handleToggleAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new EngineAudioSynth();
    }
    const next = !audioRef.current.isEnabled();
    audioRef.current.setEnabled(next);
    setAudioEnabled(next);
  }, []);

  /** Aplica la configuración elegida, coloca el coche en la salida y arranca (con cuenta atrás si hay meta). */
  const beginSession = useCallback(async (cfg: RaceConfig, quick = false) => {
    const w = worldRef.current;
    if (!w) return;
    saveMenu(cfg);
    sessionRef.current = cfg;
    resumeRef.current = null; setCanResume(false);
    setFinish(null);
    const token = ++raceRef.current.token;
    applyAtmosphereMode(cfg.atmosphere);
    handlePaintChange(CAR_PAINT_PRESETS.find((c) => c.id === cfg.paintId) ?? CAR_PAINT_PRESETS[0]);
    cameraPresetRef.current = cfg.camera; setCameraPreset(cfg.camera); w.setCameraPreset(cfg.camera);
    w.traffic.enabled = cfg.traffic; w.peds.enabled = cfg.traffic; w.cyclists.enabled = cfg.traffic;
    if (cfg.audio !== (audioRef.current?.isEnabled() ?? false)) handleToggleAudio();
    carStateRef.current = createInitialCarState(cfg.start.la, cfg.start.lo, resolveBearing(cfg));
    w.snapCamera();
    w.collision?.reset();
    w.setDestination(cfg.dest ? toLocal(cfg.dest.la, cfg.dest.lo) : null);
    setChrono({ ms: 0, dist: 0, rel: 0 });
    setPhase(quick ? (cfg.dest ? 'racing' : 'free') : 'countdown');
    if (quick) { raceRef.current.tStart = performance.now(); return; }
    setCountdown(null);
    // espera a que el mundo de la salida esté dibujado (como mucho 15 s)
    await sleep(500);
    let calm = 0;
    for (let i = 0; i < 100 && calm < 3; i++) { await sleep(150); calm = w.isStreaming() ? 0 : calm + 1; }
    for (const n of [3, 2, 1]) {
      if (token !== raceRef.current.token) return;
      setCountdown(n); await sleep(800);
    }
    if (token !== raceRef.current.token) return;
    setCountdown('go');
    raceRef.current.tStart = performance.now();
    setPhase(cfg.dest ? 'racing' : 'free');
    await sleep(700);
    if (token === raceRef.current.token) setCountdown(null);
  }, [applyAtmosphereMode, handlePaintChange, handleToggleAudio, setPhase]);

  const handleReset = useCallback(() => {
    const cfg = sessionRef.current;
    if (cfg && phaseRef.current !== 'menu' && phaseRef.current !== 'countdown') { void beginSession(cfg, !cfg.dest); return; }
    const landmark =
      ALICANTE_LANDMARKS.find((l) => l.id === currentLandmarkId) ?? ALICANTE_LANDMARKS[0];
    teleportToLandmark(landmark);
  }, [beginSession, currentLandmarkId, teleportToLandmark]);

  /** Esc: pausa y vuelve a la pantalla de inicio (o la cierra si hay partida que continuar). */
  const toggleMenu = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === 'racing' || ph === 'free') {
      resumeRef.current = ph; raceRef.current.pausedAt = performance.now(); setCanResume(true); setPhase('menu');
    } else if (ph === 'menu' && resumeRef.current) {
      raceRef.current.tStart += performance.now() - raceRef.current.pausedAt;
      const back = resumeRef.current; resumeRef.current = null; setCanResume(false); setPhase(back);
    } else if (ph === 'finished') {
      setFinish(null); setPhase('menu');
    }
  }, [setPhase]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}world/places.json`).then((r) => r.json()).then((d: Place[]) => setPlaces(d)).catch(() => setPlaces([]));
  }, []);

  const handleCycleCamera = useCallback(() => {
    setCameraPreset((prev) => {
      const order: CameraPreset[] = ['chase', 'driver', 'aerial'];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      cameraPresetRef.current = next;
      worldRef.current?.setCameraPreset(next);
      return next;
    });
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
      } else if (code === 'Escape' && !e.repeat) {
        toggleMenu();
      } else if (code === 'KeyR' && !e.repeat) {
        handleReset();
      } else if (code === 'KeyC' && !e.repeat) {
        handleCycleCamera();
      } else if (code === 'KeyH' && !e.repeat) {
        setDockCollapsed((prev) => !prev);
      } else if (code === 'KeyM' && !e.repeat) {
        setMapOpen((o) => !o);                              // M: mapa grande
      } else if (code === 'KeyL' && !e.repeat) {
        setPlacesOpen((o) => !o);                          // L: lista de lugares
      } else if (code === 'KeyT' && !e.repeat) {
        const w = worldRef.current;                       // T: tráfico y peatones sí/no
        if (w) { const on = !w.traffic.enabled; w.traffic.enabled = on; w.peds.enabled = on; w.cyclists.enabled = on; }
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
  }, [applyAtmosphereMode, handleCycleCamera, handleReset, toggleMenu]);

  // Escena Three.js propia (mundo .glb + coche + colisiones) y bucle de juego
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    const world = new WorldScene(container, initialPaint, atmosphereRef.current, isSoftwareGl);
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
      const ph = phaseRef.current;
      const live = ph === 'racing' || ph === 'free';
      const input = live ? controlsRef.current : NO_INPUT;

      if (ph !== 'menu') {                                  // en el menú el coche queda congelado
        stepCarPhysics(state, input, dt);
        const impact = Math.max(world.collision?.resolve(state) ?? 0, world.traffic.collide(state));
        if (impact > 0.25 && Math.abs(state.speedMps) > 4) state.shake = Math.min(1, Math.max(state.shake, impact * Math.min(Math.abs(state.speedMps) / 25, 1)));
      }
      const dest = sessionRef.current?.dest ?? null;
      if (ph === 'racing' && dest && distM(state.lat, state.lng, dest.la, dest.lo) < FINISH_R) {
        const timeMs = now - raceRef.current.tStart;
        const key = routeKey(sessionRef.current!);
        const prevBest = loadBest(key);
        const record = saveBest(key, timeMs);
        phaseRef.current = 'finished'; setPhaseState('finished');
        setFinish({ timeMs, bestMs: record ? timeMs : prevBest, record });
        setChrono((c) => ({ ...c, ms: timeMs, dist: 0 }));
      }

      if (audioRef.current) {
        audioRef.current.update(state.rpm, state.speedKmh, state.driftIntensity, input.throttle);
      }

      world.render(state, dt);

      // HUD de React a ~20 Hz
      if (now - lastHudUpdate > 50) {
        lastHudUpdate = now;
        if (phaseRef.current === 'racing' && dest) {
          let rel = bearingTo(state.lat, state.lng, dest.la, dest.lo) - state.headingDeg;
          rel = ((rel + 540) % 360) - 180;
          setChrono({ ms: now - raceRef.current.tStart, dist: distM(state.lat, state.lng, dest.la, dest.lo), rel });
        }
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

      {/* Pantalla de inicio */}
      {phase === 'menu' && (
        <StartScreen
          config={config}
          onChange={setConfig}
          places={places}
          ready={mapReady}
          onStart={() => { void beginSession(config); }}
          onResume={canResume ? toggleMenu : undefined}
        />
      )}
      {countdown !== null && phase !== 'menu' && <Countdown value={countdown} />}
      {phase === 'racing' && sessionRef.current?.dest && (
        <RaceHud chronoMs={chrono.ms} destName={sessionRef.current.dest.n} distM={chrono.dist} relDeg={chrono.rel} onMenu={toggleMenu} />
      )}
      {phase === 'finished' && finish && sessionRef.current?.dest && (
        <FinishCard
          destName={sessionRef.current.dest.n}
          timeMs={finish.timeMs}
          bestMs={finish.bestMs}
          record={finish.record}
          onRetry={() => { const c = sessionRef.current; if (c) void beginSession(c); }}
          onMenu={() => { setFinish(null); setPhase('menu'); }}
        />
      )}

      {/* First-Person Sports Car Cockpit Overlay (Modo Conductor) */}
      {phase !== 'menu' && cameraPreset === 'driver' && (
        <DriverCockpitOverlay
          carStateRef={carStateRef}
          controlsRef={controlsRef}
          paint={paint}
          atmosphere={atmosphere}
          telemetry={telemetry}
          dockCollapsed={dockCollapsed}
        />
      )}

      {phase !== 'menu' && (<>
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
      <MiniMap carStateRef={carStateRef} places={places} expanded={mapOpen} onToggle={() => setMapOpen((o) => !o)} onGo={teleportToPlace} />
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
      </>)}
    </main>
  );
}
