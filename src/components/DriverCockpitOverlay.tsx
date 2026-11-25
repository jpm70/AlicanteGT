import React, { useEffect, useRef } from 'react';
import type { AtmosphereMode, CarPaintPreset, CarState, ControlInput, HudTelemetry } from '../types/game';

interface DriverCockpitOverlayProps {
  carStateRef: React.RefObject<CarState>;
  controlsRef: React.RefObject<ControlInput>;
  paint: CarPaintPreset;
  atmosphere: AtmosphereMode;
  telemetry: HudTelemetry;
  dockCollapsed: boolean;
}

/**
 * Lightweight, GPU-composited first-person GT sports car cockpit overlay:
 * - Paint-matched aerodynamic hood edge over the cowl
 * - Carbon-fiber & dark stitched leather dashboard binnacle
 * - Interactive bottom-left GT steering wheel rotating smoothly at 60fps with front wheel steer angle
 * - Subtle windshield glass sheen & top-center frameless rearview mirror with speed/heading readout
 * - Subtle road & acceleration/braking micro-vibration (respects prefers-reduced-motion)
 */
export const DriverCockpitOverlay: React.FC<DriverCockpitOverlayProps> = ({
  carStateRef,
  controlsRef,
  paint,
  atmosphere,
  telemetry,
  dockCollapsed,
}) => {
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const dashShakeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let rafId = 0;
    let phase = 0;
    let lastTime = performance.now();

    const animateCockpit = (now: number) => {
      const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
      lastTime = now;

      const state = carStateRef.current;
      const controls = controlsRef.current;

      if (state && wheelRef.current) {
        // Authentic sports car steering ratio: max front wheel ~0.56 rad -> ~125 deg wheel turn
        const wheelDeg = (state.steerAngleRad / 0.56) * 125;
        wheelRef.current.style.transform = `rotate(${wheelDeg.toFixed(2)}deg)`;
      }

      if (state && dashShakeRef.current) {
        if (prefersReducedMotion) {
          dashShakeRef.current.style.transform = 'translate3d(0, 0, 0)';
        } else {
          const speedRatio = Math.min(state.speedKmh / 180, 1);
          const accelBoost = controls?.throttle ? 1.15 : 0;
          const brakeBoost = state.isBraking ? 1.45 : 0;
          const driftBoost = state.isDrifting ? 1.8 : 0;

          const activeEnergy =
            state.speedKmh > 4 ? speedRatio * 1.4 + accelBoost * speedRatio + brakeBoost * speedRatio + driftBoost : 0;

          phase += dt * (28 + speedRatio * 42);
          const jitterX = Math.sin(phase * 1.3) * activeEnergy * 0.75;
          const jitterY = Math.cos(phase * 1.9) * activeEnergy * 0.9;
          // Subtle pitch immersion: dashboard dips slightly under acceleration, lifts under hard braking
          const pitchShiftY = -state.bodyPitchRad * 110;
          const rollShiftX = state.bodyRollRad * 65;

          dashShakeRef.current.style.transform = `translate3d(${(jitterX + rollShiftX).toFixed(2)}px, ${(jitterY + pitchShiftY).toFixed(2)}px, 0)`;
        }
      }

      rafId = requestAnimationFrame(animateCockpit);
    };

    rafId = requestAnimationFrame(animateCockpit);
    return () => cancelAnimationFrame(rafId);
  }, [carStateRef, controlsRef]);

  const speedRounded = Math.round(telemetry.speedKmh);
  const headingRounded = String(Math.round(telemetry.headingDeg) % 360).padStart(3, '0');

  const windshieldGradient =
    atmosphere === 'sunset'
      ? 'linear-gradient(118deg, rgba(255,196,142,0.08) 0%, rgba(255,255,255,0.02) 28%, transparent 52%, rgba(40,48,88,0.06) 100%)'
      : atmosphere === 'night'
        ? 'linear-gradient(118deg, rgba(100,180,255,0.06) 0%, rgba(255,255,255,0.015) 24%, transparent 48%, rgba(8,14,28,0.14) 100%)'
        : 'linear-gradient(118deg, rgba(255,255,255,0.11) 0%, rgba(215,236,255,0.03) 26%, transparent 50%, rgba(15,23,42,0.04) 100%)';

  const mirrorSkyGradient =
    atmosphere === 'sunset'
      ? 'linear-gradient(180deg, #2b3564 0%, #d47b59 58%, #262934 60%, #171a22 100%)'
      : atmosphere === 'night'
        ? 'linear-gradient(180deg, #060b1a 0%, #15254a 56%, #0c1220 58%, #070b14 100%)'
        : 'linear-gradient(180deg, #5ba9e6 0%, #d3ebfa 56%, #3f4754 58%, #2a303a 100%)';

  const rpmBars = 10;
  const litRpmBars = Math.round(Math.min(1, Math.max(0, telemetry.rpm)) * rpmBars);

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[5] overflow-hidden select-none"
      aria-hidden="true"
    >
      {/* Subtle Windshield Specular Glare & Edge Vignette */}
      <div
        className="absolute inset-0"
        style={{ background: windshieldGradient }}
      />

      {/* Slim Aerodynamic A-Pillar Frame Silhouettes (far edges only, zero center occlusion) */}
      <svg
        viewBox="0 0 1440 900"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          <linearGradient id="pillarLeft" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#080b12" stopOpacity="0.96" />
            <stop offset="82%" stopColor="#141925" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#263042" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="pillarRight" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="#080b12" stopOpacity="0.96" />
            <stop offset="82%" stopColor="#141925" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#263042" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {/* Top roof header strip */}
        <path d="M 0 0 L 1440 0 L 1440 16 Q 720 30 0 16 Z" fill="#090c14" fillOpacity="0.92" />
        {/* Left A-pillar */}
        <path d="M 0 0 L 58 0 L 18 700 L 0 700 Z" fill="url(#pillarLeft)" />
        {/* Right A-pillar */}
        <path d="M 1440 0 L 1382 0 L 1422 700 L 1440 700 Z" fill="url(#pillarRight)" />
      </svg>

      {/* Top-Center Frameless Sports Car Rearview Mirror */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex flex-col items-center">
        <div className="h-3 w-3.5 rounded-b-sm bg-[#0b0f18] border-x border-white/10" />
        <div
          className="relative flex h-12 w-52 items-center justify-between overflow-hidden rounded-[14px] border-2 border-[#181f2e] px-4 shadow-2xl sm:h-14 sm:w-60"
          style={{ background: mirrorSkyGradient }}
        >
          {/* Subtle glass reflection diagonal across rearview mirror */}
          <div
            className="absolute inset-0 opacity-30"
            style={{
              background:
                'linear-gradient(125deg, rgba(255,255,255,0.45) 0%, transparent 42%, transparent 100%)',
            }}
          />
          <div className="relative flex flex-col">
            <span className="text-[9px] font-medium tracking-wide text-white/70">Retrovisor</span>
            <span className="font-telemetry text-xs font-semibold text-white/95">
              {headingRounded}°
            </span>
          </div>
          <div className="relative flex items-baseline gap-1">
            <span className="font-display font-telemetry text-lg font-bold text-white drop-shadow">
              {speedRounded}
            </span>
            <span className="text-[10px] font-medium text-white/75">km/h</span>
          </div>
        </div>
      </div>

      {/* Micro-Vibrating Hood Edge + Carbon/Leather Dashboard + Interactive Steering Wheel */}
      <div
        ref={dashShakeRef}
        className={`absolute inset-x-0 h-[35vh] min-h-[235px] max-h-[320px] transition-[bottom] duration-200 will-change-transform ${
          dockCollapsed ? '-bottom-4' : 'bottom-6 sm:bottom-10'
        }`}
      >
        <svg
          viewBox="0 0 1440 320"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <defs>
            {/* Procedural subtle woven carbon fiber texture */}
            <pattern
              id="carbonWeave"
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
            >
              <rect width="8" height="8" fill="#10141e" />
              <rect x="0" y="0" width="4" height="4" fill="#181e2c" />
              <rect x="4" y="4" width="4" height="4" fill="#161c29" />
              <rect x="0" y="4" width="4" height="2" fill="#0c1018" />
              <rect x="4" y="0" width="4" height="2" fill="#0c1018" />
            </pattern>

            {/* Paint-matched metallic hood gradient */}
            <linearGradient id="carHoodPaint" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={paint.css} stopOpacity="0.98" />
              <stop offset="55%" stopColor={paint.css} stopOpacity="0.88" />
              <stop offset="100%" stopColor="#090c14" stopOpacity="0.98" />
            </linearGradient>

            {/* Hood specular highlight */}
            <linearGradient id="hoodSheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.02" />
              <stop offset="22%" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="50%" stopColor="#ffffff" stopOpacity="0.06" />
              <stop offset="78%" stopColor="#ffffff" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.02" />
            </linearGradient>

            {/* Stitched dark leather upper dash gradient */}
            <linearGradient id="dashLeather" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1b2130" />
              <stop offset="28%" stopColor="#111520" />
              <stop offset="100%" stopColor="#070a10" />
            </linearGradient>
          </defs>

          {/* 1. Sculpted Paint-Matched Hood Edge peeking over the windshield cowl */}
          <path
            d="M 110 154 Q 360 98 720 96 Q 1080 98 1330 154 L 1360 198 L 80 198 Z"
            fill="url(#carHoodPaint)"
          />
          <path
            d="M 110 154 Q 360 98 720 96 Q 1080 98 1330 154 L 1340 166 Q 1080 112 720 110 Q 360 112 100 166 Z"
            fill="url(#hoodSheen)"
          />
          {/* Aerodynamic hood power-dome crease lines */}
          <path
            d="M 390 108 Q 435 135 455 170"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="2"
            fill="none"
          />
          <path
            d="M 1050 108 Q 1005 135 985 170"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="2"
            fill="none"
          />

          {/* 2. Sweeping Upper Dashboard (Dark Leather + Carbon Fiber Trim) */}
          <path
            d="M 0 185 Q 110 158 260 132 Q 375 112 490 136 Q 600 162 760 162 Q 1120 162 1440 186 L 1440 320 L 0 320 Z"
            fill="url(#dashLeather)"
          />

          {/* Carbon-fiber center & binnacle inlay */}
          <path
            d="M 160 172 Q 360 128 530 168 L 1380 202 L 1380 320 L 120 320 Z"
            fill="url(#carbonWeave)"
            fillOpacity="0.88"
          />

          {/* Motorsport contrast leather stitching line along upper brow */}
          <path
            d="M 12 190 Q 120 164 265 139 Q 375 120 486 143 Q 600 169 760 169 Q 1120 169 1432 192"
            stroke={paint.css}
            strokeOpacity="0.65"
            strokeWidth="1.8"
            strokeDasharray="6 6"
            fill="none"
          />

          {/* Subtle top specular rim on instrument hood */}
          <path
            d="M 185 151 Q 365 116 498 144"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="2"
            fill="none"
          />
        </svg>

        {/* Recessed Driver Instrument Shift-Light LED Strip inside Binnacle */}
        <div className="absolute bottom-[174px] left-[22%] hidden -translate-x-1/2 items-center gap-1 rounded-md border border-white/10 bg-[#060911]/95 px-3 py-1.5 shadow-inner sm:flex">
          {Array.from({ length: rpmBars }).map((_, i) => {
            const active = i < litRpmBars;
            const colorClass =
              i >= 8
                ? active
                  ? 'bg-rose-500'
                  : 'bg-rose-950/60'
                : i >= 5
                  ? active
                    ? 'bg-amber-400'
                    : 'bg-amber-950/50'
                  : active
                    ? 'bg-sky-400'
                    : 'bg-slate-800';
            return <span key={i} className={`h-1.5 w-3 rounded-[2px] ${colorClass}`} />;
          })}
          <span className="font-display font-telemetry ml-2 text-xs font-bold text-amber-400">
            {telemetry.gear}
          </span>
        </div>

        {/* 3. Interactive Flat-Bottom GT Sport Steering Wheel (Bottom-Left) */}
        <div className="absolute bottom-2 left-[22%] -translate-x-1/2 sm:bottom-4">
          <div
            ref={wheelRef}
            className="h-52 w-52 origin-center will-change-transform sm:h-64 sm:w-64"
          >
            <svg viewBox="0 0 260 260" className="h-full w-full drop-shadow-2xl">
              <defs>
                <linearGradient id="rimMetal" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#64748b" />
                  <stop offset="50%" stopColor="#cbd5e1" />
                  <stop offset="100%" stopColor="#334155" />
                </linearGradient>
                <linearGradient id="rimGrip" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#232938" />
                  <stop offset="50%" stopColor="#121620" />
                  <stop offset="100%" stopColor="#090c12" />
                </linearGradient>
              </defs>

              {/* Shift paddles behind wheel spokes */}
              <path d="M 52 98 L 76 92 L 76 124 L 54 126 Z" fill="#1e2533" stroke="#475569" strokeWidth="1.5" />
              <path d="M 208 98 L 184 92 L 184 124 L 206 126 Z" fill="#1e2533" stroke="#475569" strokeWidth="1.5" />

              {/* Outer flat-bottom steering wheel rim */}
              <path
                d="M 130 22 A 108 108 0 1 1 56 208 Q 130 222 204 208 A 108 108 0 0 1 130 22 Z"
                fill="none"
                stroke="#070a10"
                strokeWidth="26"
                strokeLinecap="round"
              />
              <path
                d="M 130 22 A 108 108 0 1 1 56 208 Q 130 222 204 208 A 108 108 0 0 1 130 22 Z"
                fill="none"
                stroke="url(#rimGrip)"
                strokeWidth="21"
                strokeLinecap="round"
              />
              {/* Subtle inner rim highlight */}
              <path
                d="M 130 22 A 108 108 0 1 1 56 208 Q 130 222 204 208 A 108 108 0 0 1 130 22 Z"
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="1.5"
              />

              {/* Motorsport 12-o'clock top center stripe matching car paint */}
              <rect
                x="125"
                y="11"
                width="10"
                height="22"
                rx="2"
                fill={paint.css}
              />

              {/* Three sculpted metallic & carbon GT wheel spokes */}
              {/* Left horizontal spoke */}
              <path
                d="M 28 124 L 106 120 L 106 144 L 32 146 Z"
                fill="#151b26"
                stroke="url(#rimMetal)"
                strokeWidth="2"
              />
              {/* Right horizontal spoke */}
              <path
                d="M 232 124 L 154 120 L 154 144 L 228 146 Z"
                fill="#151b26"
                stroke="url(#rimMetal)"
                strokeWidth="2"
              />
              {/* Lower twin-bar vertical spoke */}
              <path
                d="M 112 152 L 148 152 L 142 214 L 118 214 Z"
                fill="#151b26"
                stroke="url(#rimMetal)"
                strokeWidth="2"
              />

              {/* Center airbag hub & GT crest */}
              <circle cx="130" cy="132" r="34" fill="#0d111a" stroke="#334155" strokeWidth="2.5" />
              <circle cx="130" cy="132" r="24" fill="#151c29" stroke="rgba(255,255,255,0.12)" strokeWidth="1.2" />
              <polygon
                points="130,118 141,132 130,146 119,132"
                fill={paint.css}
                stroke="#f8fafc"
                strokeWidth="1.2"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
};
