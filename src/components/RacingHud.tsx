import React from 'react';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  MapPin,
  Moon,
  RotateCcw,
  Sun,
  Sunset,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { ALICANTE_LANDMARKS, CAR_PAINT_PRESETS } from '../game/constants';
import type {
  AtmosphereMode,
  CameraPreset,
  CarPaintPreset,
  HudTelemetry,
  LandmarkPreset,
} from '../types/game';

interface RacingHudProps {
  telemetry: HudTelemetry;
  atmosphere: AtmosphereMode;
  onAtmosphereChange: (mode: AtmosphereMode) => void;
  paint: CarPaintPreset;
  onPaintChange: (paint: CarPaintPreset) => void;
  cameraPreset: CameraPreset;
  onCycleCamera: () => void;
  currentLandmarkId: string;
  onSelectLandmark: (landmark: LandmarkPreset) => void;
  audioEnabled: boolean;
  onToggleAudio: () => void;
  onReset: () => void;
  dockCollapsed: boolean;
  onToggleDock: () => void;
  onTouchControl: (key: 'throttle' | 'brake' | 'left' | 'right' | 'handbrake', active: boolean) => void;
}

const CAMERA_LABELS: Record<CameraPreset, string> = {
  chase: 'Persecución',
  driver: 'Conductor',
  aerial: 'Aérea',
};

const ATMOSPHERE_OPTIONS: Array<{
  id: AtmosphereMode;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'sunset', label: 'Atardecer Mediterráneo', shortLabel: 'Atardecer', icon: Sunset },
  { id: 'night', label: 'Noche Neón', shortLabel: 'Noche Neón', icon: Moon },
  { id: 'day', label: 'Día', shortLabel: 'Día', icon: Sun },
];

export const RacingHud: React.FC<RacingHudProps> = ({
  telemetry,
  atmosphere,
  onAtmosphereChange,
  paint,
  onPaintChange,
  cameraPreset,
  onCycleCamera,
  currentLandmarkId,
  onSelectLandmark,
  audioEnabled,
  onToggleAudio,
  onReset,
  dockCollapsed,
  onToggleDock,
  onTouchControl,
}) => {
  const speedRounded = Math.round(telemetry.speedKmh);
  const rpmPct = Math.round(Math.min(1, Math.max(0.08, telemetry.rpm)) * 100);
  const headingRounded = String(Math.round(telemetry.headingDeg) % 360).padStart(3, '0');

  const handleCycleLandmark = () => {
    const idx = ALICANTE_LANDMARKS.findIndex((l) => l.id === currentLandmarkId);
    const next = ALICANTE_LANDMARKS[(idx + 1) % ALICANTE_LANDMARKS.length];
    onSelectLandmark(next);
  };

  const activeLandmark =
    ALICANTE_LANDMARKS.find((l) => l.id === currentLandmarkId) ?? ALICANTE_LANDMARKS[0];

  const isLightDay = atmosphere === 'day';

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-4 sm:p-5">
      {/* Top-Left Minimal Architectural Title & Unboxed Location Metadata */}
      <header className="flex items-start justify-between">
        <div
          className={`pointer-events-auto rounded-xl border px-4 py-2.5 transition-colors duration-200 ${
            isLightDay
              ? 'border-slate-900/12 bg-white/88 text-slate-900 shadow-lg'
              : 'border-white/12 bg-[#0a0f1c]/88 text-slate-100 shadow-xl'
          }`}
        >
          <div className="flex items-baseline gap-3">
            <h1 className="font-display text-lg font-bold tracking-tight whitespace-nowrap sm:text-xl">
              Alicante GT
            </h1>
            <span
              className={`font-telemetry text-xs whitespace-nowrap ${
                isLightDay ? 'text-slate-600' : 'text-slate-400'
              }`}
            >
              {headingRounded}°
            </span>
          </div>
          <div
            className={`mt-0.5 flex items-center gap-2 text-xs ${
              isLightDay ? 'text-slate-600' : 'text-slate-400'
            }`}
          >
            <span className="max-w-[280px] truncate sm:max-w-[460px]">{telemetry.zoneName}</span>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">Alicante</span>
          </div>
          <div
            className={`font-telemetry mt-1 flex items-center gap-2 text-[11px] ${
              isLightDay ? 'text-slate-600' : 'text-slate-400'
            }`}
          >
            <span className="whitespace-nowrap">
              {telemetry.lat.toFixed(4)}, {telemetry.lng.toFixed(4)}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`whitespace-nowrap ${
                telemetry.tilesStatus === 'error'
                  ? 'text-rose-400'
                  : telemetry.tilesStatus === 'ready'
                    ? isLightDay
                      ? 'text-emerald-700'
                      : 'text-emerald-400'
                    : ''
              }`}
            >
              {telemetry.tileStatusText}
            </span>
          </div>
        </div>
      </header>

      {/* Mobile / Touch Pedals & Steering (hidden on desktop) */}
      <div className="pointer-events-none flex items-end justify-between pb-24 md:hidden">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            aria-label="Girar izquierda"
            onPointerDown={() => onTouchControl('left', true)}
            onPointerUp={() => onTouchControl('left', false)}
            onPointerLeave={() => onTouchControl('left', false)}
            onPointerCancel={() => onTouchControl('left', false)}
            className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/15 bg-[#0a0f1c]/88 font-display text-lg font-bold text-white active:bg-amber-500 active:text-slate-950"
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Girar derecha"
            onPointerDown={() => onTouchControl('right', true)}
            onPointerUp={() => onTouchControl('right', false)}
            onPointerLeave={() => onTouchControl('right', false)}
            onPointerCancel={() => onTouchControl('right', false)}
            className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/15 bg-[#0a0f1c]/88 font-display text-lg font-bold text-white active:bg-amber-500 active:text-slate-950"
          >
            →
          </button>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            aria-label="Freno de mano y derrape"
            onPointerDown={() => onTouchControl('handbrake', true)}
            onPointerUp={() => onTouchControl('handbrake', false)}
            onPointerLeave={() => onTouchControl('handbrake', false)}
            onPointerCancel={() => onTouchControl('handbrake', false)}
            className="flex h-12 items-center justify-center rounded-xl border border-amber-400/30 bg-[#0a0f1c]/88 px-3 font-display text-xs font-semibold text-amber-300 active:bg-amber-500 active:text-slate-950"
          >
            Derrape
          </button>
          <button
            type="button"
            aria-label="Frenar o marcha atrás"
            onPointerDown={() => onTouchControl('brake', true)}
            onPointerUp={() => onTouchControl('brake', false)}
            onPointerLeave={() => onTouchControl('brake', false)}
            onPointerCancel={() => onTouchControl('brake', false)}
            className="flex h-12 items-center justify-center rounded-xl border border-rose-400/30 bg-[#0a0f1c]/88 px-3 font-display text-xs font-semibold text-rose-300 active:bg-rose-500 active:text-white"
          >
            Freno
          </button>
          <button
            type="button"
            aria-label="Acelerar"
            onPointerDown={() => onTouchControl('throttle', true)}
            onPointerUp={() => onTouchControl('throttle', false)}
            onPointerLeave={() => onTouchControl('throttle', false)}
            onPointerCancel={() => onTouchControl('throttle', false)}
            className="flex h-12 items-center justify-center rounded-xl border border-white/20 bg-amber-500 px-4 font-display text-xs font-bold text-slate-950 active:bg-amber-400"
          >
            Gas
          </button>
        </div>
      </div>

      {/* Unified Collapsible Bottom Control Dock (Zero Center Occlusion) */}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-20 flex w-[min(940px,95vw)] -translate-x-1/2 flex-col items-center">
        {/* Collapse / Expand Handle */}
        <button
          type="button"
          onClick={onToggleDock}
          className="pointer-events-auto mb-1.5 flex items-center gap-1.5 rounded-lg border border-white/14 bg-[#0a0f1c]/90 px-3 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-white/25 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          title="Alternar panel (H)"
        >
          {dockCollapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap">Mostrar controles</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap">Ocultar controles</span>
            </>
          )}
        </button>

        {/* Main Dock Panel */}
        <div
          className={`pointer-events-auto w-full rounded-2xl border border-white/12 bg-[#0a0f1c]/92 px-4 py-3 text-slate-100 shadow-2xl transition-transform duration-200 ease-out ${
            dockCollapsed ? 'pointer-events-none translate-y-[120%] opacity-0' : 'translate-y-0 opacity-100'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
            {/* 1. Digital Speedometer, Gear & RPM Cluster */}
            <div className="flex items-center gap-4">
              <div className="flex items-baseline gap-1.5">
                <span className="font-display font-telemetry w-[3ch] text-right text-3xl font-bold leading-none tracking-tight text-white">
                  {speedRounded}
                </span>
                <span className="text-xs font-medium text-slate-400">km/h</span>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2.5">
                  <span className="font-display font-telemetry flex h-6 w-6 items-center justify-center rounded-md border border-white/15 bg-white/8 text-xs font-bold text-amber-400">
                    {telemetry.gear}
                  </span>
                  <span className="text-xs font-medium text-slate-300 whitespace-nowrap">
                    {telemetry.isDrifting
                      ? 'Derrape'
                      : telemetry.isBraking
                        ? 'Frenando'
                        : speedRounded > 130
                          ? 'Alta velocidad'
                          : 'En ruta'}
                  </span>
                </div>
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full transition-[width] duration-75 ${
                      telemetry.isDrifting
                        ? 'bg-amber-400'
                        : rpmPct > 84
                          ? 'bg-rose-500'
                          : 'bg-sky-400'
                    }`}
                    style={{ width: `${rpmPct}%` }}
                  />
                </div>
              </div>
            </div>

            {/* 2. Atmosphere Mode Switcher (Atardecer Mediterráneo / Noche Neón / Día) */}
            <div
              role="group"
              aria-label="Ambiente e iluminación"
              className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1"
            >
              {ATMOSPHERE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = atmosphere === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => onAtmosphereChange(opt.id)}
                    aria-pressed={active}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                      active
                        ? opt.id === 'sunset'
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : opt.id === 'night'
                            ? 'bg-sky-400 text-slate-950 font-semibold'
                            : 'bg-white text-slate-950 font-semibold'
                        : 'text-slate-300 hover:bg-white/8 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden sm:inline">{opt.label}</span>
                    <span className="sm:hidden">{opt.shortLabel}</span>
                  </button>
                );
              })}
            </div>

            {/* 3. Paint Swatches & Practical Driving Actions */}
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="Color de carrocería"
                className="hidden items-center gap-1.5 pr-1 lg:flex"
              >
                {CAR_PAINT_PRESETS.map((preset) => {
                  const selected = preset.id === paint.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => onPaintChange(preset)}
                      title={preset.label}
                      aria-label={`Color ${preset.label}`}
                      aria-pressed={selected}
                      className={`h-5 w-5 rounded-full border transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                        selected
                          ? 'scale-110 border-white ring-2 ring-white/40'
                          : 'border-white/25 hover:scale-105'
                      }`}
                      style={{ backgroundColor: preset.css }}
                    />
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleCycleLandmark}
                title={`Cambiar punto de salida (${activeLandmark.name})`}
                className="flex items-center gap-1.5 rounded-lg border border-white/12 bg-white/6 px-2.5 py-1.5 text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors hover:bg-white/12 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <span className="max-w-[110px] truncate">{activeLandmark.name}</span>
              </button>

              <button
                type="button"
                onClick={onCycleCamera}
                title="Cambiar modo de cámara: Persecución / Conductor / Aérea (C)"
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                  cameraPreset === 'driver'
                    ? 'border-amber-400/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                    : 'border-white/12 bg-white/6 text-slate-200 hover:bg-white/12 hover:text-white'
                }`}
              >
                <Camera className="h-3.5 w-3.5 shrink-0" />
                <span>{CAMERA_LABELS[cameraPreset]}</span>
              </button>

              <button
                type="button"
                onClick={onToggleAudio}
                aria-pressed={audioEnabled}
                title={audioEnabled ? 'Silenciar motor' : 'Activar sonido del motor'}
                className={`flex items-center justify-center rounded-lg border p-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
                  audioEnabled
                    ? 'border-amber-400/40 bg-amber-500/20 text-amber-300'
                    : 'border-white/12 bg-white/6 text-slate-300 hover:bg-white/12 hover:text-white'
                }`}
              >
                {audioEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>

              <button
                type="button"
                onClick={onReset}
                title="Reiniciar en Explanada de España (R)"
                className="flex items-center justify-center rounded-lg border border-white/12 bg-white/6 p-1.5 text-slate-300 transition-colors hover:bg-white/12 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Discreet Single-Line Keyboard Reference */}
          <div className="mt-2.5 hidden items-center justify-between border-t border-white/8 pt-2 text-[11px] text-slate-400 sm:flex">
            <span>WASD o Flechas: Conducir · Espacio: Freno de mano y derrape</span>
            <span>C: Cámara · 1 / 2 / 3: Ambiente · R: Reiniciar · T: Tráfico · H: Ocultar HUD</span>
          </div>
        </div>
      </div>
    </div>
  );
};
