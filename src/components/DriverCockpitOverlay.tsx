import React, { useEffect, useMemo, useRef } from 'react';
import type { AtmosphereMode, CarPaintPreset, CarState, ControlInput, HudTelemetry } from '../types/game';

interface DriverCockpitOverlayProps {
  carStateRef: React.RefObject<CarState>;
  controlsRef: React.RefObject<ControlInput>;
  paint: CarPaintPreset;
  atmosphere: AtmosphereMode;
  telemetry: HudTelemetry;
  dockCollapsed: boolean;
}

/* Geometría del cockpit en un lienzo de 1440 x 420 (conducción a la izquierda). */
const W = 1440;
const H = 520;
const WHEEL = { cx: 505, cy: 452, size: 360 };   // centro del volante y lado de su caja cuadrada
const SPEEDO = { cx: 428, cy: 236, r: 66, max: 300 };
const TACHO = { cx: 584, cy: 236, r: 66, max: 9 };

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

/** Punto sobre una circunferencia; el ángulo 0 apunta hacia arriba y crece en sentido horario. */
const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
};

const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

const valueToAngle = (v: number, max: number) => -135 + (Math.min(Math.max(v, 0), max) / max) * 270;

interface DialProps {
  cx: number;
  cy: number;
  r: number;
  max: number;
  majorStep: number;
  minorStep: number;
  labelDiv?: number;
  redFrom?: number;
  unit: string;
  accent: string;
}

/** Esfera analógica estática: aro, marcas, números y zona roja. */
const Dial: React.FC<DialProps> = ({ cx, cy, r, max, majorStep, minorStep, labelDiv = 1, redFrom, unit, accent }) => {
  const ticks = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (let v = 0; v <= max + 1e-6; v += minorStep) {
      const major = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
      const ang = valueToAngle(v, max);
      const [x0, y0] = polar(cx, cy, r - (major ? 12 : 7), ang);
      const [x1, y1] = polar(cx, cy, r - 3, ang);
      const red = redFrom !== undefined && v >= redFrom;
      out.push(
        <line key={`t${v}`} x1={x0} y1={y0} x2={x1} y2={y1} stroke={red ? '#ff4a3d' : '#e8edf5'} strokeWidth={major ? 2.2 : 1} strokeLinecap="round" opacity={major ? 1 : 0.7} />
      );
      if (major) {
        const [tx, ty] = polar(cx, cy, r - 25, ang);
        out.push(
          <text key={`n${v}`} x={tx} y={ty + 3.5} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={red ? '#ff6a5c' : '#f1f5fb'} fontFamily="Oxanium, sans-serif">
            {Math.round(v / labelDiv)}
          </text>
        );
      }
    }
    return out;
  }, [cx, cy, r, max, majorStep, minorStep, labelDiv, redFrom]);

  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 6} fill="#05070b" stroke="#2a313f" strokeWidth="2" />
      <circle cx={cx} cy={cy} r={r + 2} fill="url(#gaugeFace)" />
      {redFrom !== undefined && (
        <path d={arc(cx, cy, r - 1.5, valueToAngle(redFrom, max), 135)} stroke="#e23b30" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.9" />
      )}
      <path d={arc(cx, cy, r - 1.5, -135, redFrom !== undefined ? valueToAngle(redFrom, max) : 135)} stroke={accent} strokeWidth="1.4" fill="none" opacity="0.55" />
      {ticks}
      <text x={cx} y={cy + r * 0.62} textAnchor="middle" fontSize="8.5" fontWeight="600" letterSpacing="1.2" fill="#9aa7bb" fontFamily="Oxanium, sans-serif">
        {unit}
      </text>
    </g>
  );
};

/**
 * Cockpit en primera persona de un GT, en tres capas para que solo se repinte lo que se mueve:
 *  1. salpicadero estático (capó, cuero con costuras, cuadro, consola, salidas de aire, pantalla),
 *  2. agujas y cifras de los relojes (se actualizan a 60 fps desde el estado del coche),
 *  3. volante achatado de cuero perforado, que gira con las ruedas delanteras (transform solo de composición).
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
  const shakeRef = useRef<HTMLDivElement | null>(null);
  const speedNeedleRef = useRef<SVGGElement | null>(null);
  const tachNeedleRef = useRef<SVGGElement | null>(null);
  const speedTextRef = useRef<SVGTextElement | null>(null);
  const gearTextRef = useRef<SVGTextElement | null>(null);
  const compassRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let rafId = 0;
    let phase = 0;
    let lastTime = performance.now();
    let sNeedle = 0;
    let tNeedle = 0;

    const tick = (now: number) => {
      const dt = Math.min(Math.max((now - lastTime) / 1000, 0.001), 0.05);
      lastTime = now;
      const state = carStateRef.current;
      const controls = controlsRef.current;

      if (state) {
        if (wheelRef.current) {
          const wheelDeg = (state.steerAngleRad / 0.56) * 125;
          wheelRef.current.style.transform = `rotate(${wheelDeg.toFixed(2)}deg)`;
        }
        // agujas con algo de inercia, como un cuadro real
        const sTarget = valueToAngle(state.speedKmh, SPEEDO.max);
        const tTarget = valueToAngle(state.rpm * TACHO.max, TACHO.max);
        sNeedle += (sTarget - sNeedle) * (1 - Math.exp(-14 * dt));
        tNeedle += (tTarget - tNeedle) * (1 - Math.exp(-18 * dt));
        speedNeedleRef.current?.setAttribute('transform', `rotate(${sNeedle.toFixed(2)} ${SPEEDO.cx} ${SPEEDO.cy})`);
        tachNeedleRef.current?.setAttribute('transform', `rotate(${tNeedle.toFixed(2)} ${TACHO.cx} ${TACHO.cy})`);
        if (speedTextRef.current) speedTextRef.current.textContent = String(Math.round(state.speedKmh));
        if (gearTextRef.current) gearTextRef.current.textContent = state.gear;
        compassRef.current?.setAttribute('transform', `rotate(${(-state.headingDeg).toFixed(1)} 1128 232)`);

        if (shakeRef.current) {
          if (reduced) {
            shakeRef.current.style.transform = 'translate3d(0,0,0)';
          } else {
            const speedRatio = Math.min(state.speedKmh / 180, 1);
            const energy =
              state.speedKmh > 4
                ? speedRatio * 1.4 + (controls?.throttle ? 1.15 : 0) * speedRatio + (state.isBraking ? 1.45 : 0) * speedRatio + (state.isDrifting ? 1.8 : 0)
                : 0;
            phase += dt * (28 + speedRatio * 42);
            const jx = Math.sin(phase * 1.3) * energy * 0.75 + state.bodyRollRad * 65;
            const jy = Math.cos(phase * 1.9) * energy * 0.9 - state.bodyPitchRad * 110;
            shakeRef.current.style.transform = `translate3d(${jx.toFixed(2)}px, ${jy.toFixed(2)}px, 0)`;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [carStateRef, controlsRef]);

  const night = atmosphere === 'night';
  const headingRounded = String(Math.round(telemetry.headingDeg) % 360).padStart(3, '0');
  const mirrorSky =
    atmosphere === 'sunset'
      ? 'linear-gradient(180deg, #2b3564 0%, #d47b59 58%, #262934 60%, #171a22 100%)'
      : night
        ? 'linear-gradient(180deg, #060b1a 0%, #15254a 56%, #0c1220 58%, #070b14 100%)'
        : 'linear-gradient(180deg, #5ba9e6 0%, #d3ebfa 56%, #3f4754 58%, #2a303a 100%)';
  const glare =
    atmosphere === 'sunset'
      ? 'linear-gradient(118deg, rgba(255,196,142,0.08) 0%, rgba(255,255,255,0.02) 28%, transparent 52%, rgba(40,48,88,0.06) 100%)'
      : night
        ? 'linear-gradient(118deg, rgba(100,180,255,0.05) 0%, transparent 48%, rgba(8,14,28,0.14) 100%)'
        : 'linear-gradient(118deg, rgba(255,255,255,0.1) 0%, rgba(215,236,255,0.03) 26%, transparent 50%, rgba(15,23,42,0.04) 100%)';
  const backlight = night ? 1 : 0.55;

  return (
    <div className="pointer-events-none fixed inset-0 z-[5] overflow-hidden select-none" aria-hidden="true">
      <div className="absolute inset-0" style={{ background: glare }} />

      {/* Montantes A y borde del techo */}
      <svg viewBox="0 0 1440 900" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="pillarL" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#06080d" stopOpacity="0.98" />
            <stop offset="80%" stopColor="#111620" stopOpacity="0.94" />
            <stop offset="100%" stopColor="#2a3446" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="pillarR" x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="#06080d" stopOpacity="0.98" />
            <stop offset="80%" stopColor="#111620" stopOpacity="0.94" />
            <stop offset="100%" stopColor="#2a3446" stopOpacity="0.5" />
          </linearGradient>
        </defs>
        <path d="M 0 0 L 1440 0 L 1440 14 Q 720 26 0 14 Z" fill="#07090f" fillOpacity="0.94" />
        <path d="M 0 0 L 60 0 L 20 720 L 0 720 Z" fill="url(#pillarL)" />
        <path d="M 1440 0 L 1380 0 L 1420 720 L 1440 720 Z" fill="url(#pillarR)" />
      </svg>

      {/* Retrovisor interior */}
      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center">
        <div className="h-3 w-3.5 rounded-b-sm border-x border-white/10 bg-[#0b0f18]" />
        <div className="relative flex h-12 w-52 items-center justify-between overflow-hidden rounded-[14px] border-2 border-[#181f2e] px-4 shadow-2xl sm:h-14 sm:w-60" style={{ background: mirrorSky }}>
          <div className="absolute inset-0 opacity-30" style={{ background: 'linear-gradient(125deg, rgba(255,255,255,0.45) 0%, transparent 42%)' }} />
          <span className="relative font-telemetry text-xs font-semibold text-white/90">{headingRounded}°</span>
          <span className="relative font-telemetry text-lg font-bold text-white drop-shadow">{Math.round(telemetry.speedKmh)}<span className="ml-1 text-[10px] font-medium text-white/75">km/h</span></span>
        </div>
      </div>

      {/* Cockpit: contenedor con la proporción exacta del lienzo, centrado y pegado abajo */}
      <div
        ref={shakeRef}
        className={`absolute left-1/2 -translate-x-1/2 will-change-transform transition-[bottom] duration-200 ${dockCollapsed ? '-bottom-4' : 'bottom-6 sm:bottom-10'}`}
        style={{ width: 'min(max(100vw, 100vh), 127vh)', aspectRatio: `${W} / ${H}` }}
      >
        {/* alas laterales: el cuero del salpicadero continúa hasta los bordes en pantallas anchas */}
        <div
          className="absolute bottom-0"
          style={{ left: '-100vw', right: '-100vw', height: '73%', background: 'linear-gradient(180deg, #151922 0%, #0b0e15 40%, #05070a 100%)', zIndex: -1 }}
        />
        {/* 1) Capa estática */}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs>
            <linearGradient id="hoodPaint" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={paint.css} />
              <stop offset="60%" stopColor={paint.css} stopOpacity="0.82" />
              <stop offset="100%" stopColor="#06080d" />
            </linearGradient>
            <linearGradient id="hoodSheen" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.02" />
              <stop offset="24%" stopColor="#fff" stopOpacity="0.3" />
              <stop offset="52%" stopColor="#fff" stopOpacity="0.05" />
              <stop offset="80%" stopColor="#fff" stopOpacity="0.26" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="dashTop" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#262c3a" />
              <stop offset="35%" stopColor="#151922" />
              <stop offset="100%" stopColor="#090b11" />
            </linearGradient>
            <linearGradient id="dashLower" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10141c" />
              <stop offset="100%" stopColor="#05070a" />
            </linearGradient>
            <radialGradient id="gaugeFace" cx="50%" cy="42%" r="62%">
              <stop offset="0%" stopColor="#1b2230" />
              <stop offset="100%" stopColor="#06080d" />
            </radialGradient>
            <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#d9e0ea" />
              <stop offset="45%" stopColor="#7d889a" />
              <stop offset="100%" stopColor="#2b3342" />
            </linearGradient>
            <linearGradient id="screenGlass" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#10243c" />
              <stop offset="100%" stopColor="#07101c" />
            </linearGradient>
            <pattern id="leatherGrain" width="5" height="5" patternUnits="userSpaceOnUse">
              <rect width="5" height="5" fill="transparent" />
              <circle cx="1.2" cy="1.2" r="0.55" fill="#ffffff" fillOpacity="0.045" />
              <circle cx="3.7" cy="3.4" r="0.5" fill="#000000" fillOpacity="0.16" />
            </pattern>
            <pattern id="carbon" width="8" height="8" patternUnits="userSpaceOnUse">
              <rect width="8" height="8" fill="#0e121a" />
              <rect width="4" height="4" fill="#171d2b" />
              <rect x="4" y="4" width="4" height="4" fill="#151b29" />
            </pattern>
            <filter id="softShadow" x="-10%" y="-10%" width="120%" height="140%">
              <feDropShadow dx="0" dy="6" stdDeviation="6" floodColor="#000" floodOpacity="0.55" />
            </filter>
          </defs>

          {/* capó con power dome visible sobre el cowl */}
          <path d="M 120 78 Q 380 28 720 26 Q 1060 28 1320 78 L 1352 130 L 88 130 Z" fill="url(#hoodPaint)" />
          <path d="M 120 78 Q 380 28 720 26 Q 1060 28 1320 78 L 1336 92 Q 1060 44 720 42 Q 380 44 104 92 Z" fill="url(#hoodSheen)" />
          <path d="M 420 40 Q 470 70 492 120" stroke="rgba(255,255,255,0.28)" strokeWidth="2" fill="none" />
          <path d="M 1020 40 Q 970 70 948 120" stroke="rgba(255,255,255,0.28)" strokeWidth="2" fill="none" />
          {/* base del parabrisas: goma y vierteaguas */}
          <path d="M 0 118 Q 360 96 720 96 Q 1080 96 1440 118 L 1440 150 L 0 150 Z" fill="#05070b" />

          {/* parte superior del salpicadero: cuero con visera sobre el cuadro */}
          <path d="M 0 134 Q 160 122 330 112 Q 505 102 700 112 Q 760 116 830 128 Q 1130 130 1440 140 L 1440 520 L 0 520 Z" fill="url(#dashTop)" />
          <path d="M 0 134 Q 160 122 330 112 Q 505 102 700 112 Q 760 116 830 128 Q 1130 130 1440 140 L 1440 520 L 0 520 Z" fill="url(#leatherGrain)" />
          <path d="M 0 150 Q 160 138 330 128 Q 505 118 700 128 Q 760 132 830 144 Q 1130 146 1440 156" stroke={paint.css} strokeOpacity="0.7" strokeWidth="1.8" strokeDasharray="7 6" fill="none" />
          <path d="M 330 112 Q 505 102 700 112" stroke="rgba(255,255,255,0.22)" strokeWidth="2" fill="none" />

          {/* visera del cuadro de instrumentos */}
          <path d="M 318 172 Q 330 138 380 134 L 640 134 Q 690 138 704 172 L 708 300 L 314 300 Z" fill="#06080c" stroke="#1d2431" strokeWidth="2" filter="url(#softShadow)" />
          <path d="M 330 174 Q 340 146 384 142 L 636 142 Q 680 146 692 174" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" fill="none" />

          {/* relojes */}
          <Dial {...SPEEDO} majorStep={50} minorStep={10} labelDiv={10} unit="km/h" accent="#42b4ff" />
          <Dial {...TACHO} majorStep={1} minorStep={0.5} redFrom={7.5} unit="x1000 rpm" accent="#ffb347" />
          {/* ventana digital entre relojes */}
          <rect x="488" y="262" width="52" height="22" rx="4" fill="#04060a" stroke="#1d2535" />
          <text x="514" y="277" textAnchor="middle" fontSize="11" fontWeight="700" fill="#8fd0ff" fontFamily="JetBrains Mono, monospace">{telemetry.zoneName.length > 9 ? 'ALC' : 'ALC'}</text>
          {/* testigos */}
          <circle cx="452" cy="156" r="3" fill="#35d06a" opacity={0.85 * backlight + 0.15} />
          <circle cx="470" cy="156" r="3" fill="#42b4ff" opacity={0.85 * backlight + 0.15} />
          <circle cx="560" cy="156" r="3" fill="#ffb020" opacity="0.4" />
          <circle cx="578" cy="156" r="3" fill="#e23b30" opacity="0.28" />

          {/* consola central: salidas de aire cromadas y pantalla */}
          {[[735, 184], [1196, 184]].map(([vx, vy], i) => (
            <g key={`vent${i}`}>
              <rect x={vx} y={vy} width="82" height="44" rx="10" fill="url(#chrome)" />
              <rect x={vx + 4} y={vy + 4} width="74" height="36" rx="7" fill="#07090d" />
              {[0, 1, 2, 3].map((s) => (
                <rect key={s} x={vx + 8} y={vy + 8 + s * 8} width="66" height="3.4" rx="1.5" fill="#1a202b" />
              ))}
            </g>
          ))}
          <g filter="url(#softShadow)">
            <rect x="838" y="170" width="276" height="136" rx="14" fill="#06080c" stroke="#252d3c" strokeWidth="2.5" />
            <rect x="846" y="178" width="260" height="120" rx="9" fill="url(#screenGlass)" />
            <path d="M 846 178 L 1106 178 L 846 262 Z" fill="#ffffff" fillOpacity="0.04" />
          </g>
          {/* mapa esquemático en la pantalla */}
          <g opacity="0.9">
            <path d="M 862 282 L 905 230 L 950 238 L 996 196" stroke="#3b6aa5" strokeWidth="5" fill="none" strokeLinecap="round" />
            <path d="M 880 192 L 1090 264" stroke="#27466d" strokeWidth="3" fill="none" />
            <path d="M 1000 290 L 1060 214" stroke="#27466d" strokeWidth="3" fill="none" />
            <path d="M 862 220 Q 930 262 1020 252 Q 1070 248 1100 286" stroke="#2f7fbf" strokeWidth="4" fill="none" opacity="0.7" />
          </g>
          <rect x="1124" y="258" width="6" height="6" fill="none" />
          <text x="858" y="194" fontSize="10.5" fontWeight="700" fill="#cfe6ff" fontFamily="Oxanium, sans-serif">NAV · ALICANTE</text>
          <text x="858" y="291" fontSize="9" fill="#7fa9d6" fontFamily="JetBrains Mono, monospace">{telemetry.lat.toFixed(4)}  {telemetry.lng.toFixed(4)}</text>

          {/* mandos de la consola */}
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={`btn${i}`} x={858 + i * 40} y="324" width="30" height="14" rx="4" fill="#0a0d14" stroke="#262e3d" />
          ))}
          <circle cx="905" cy="368" r="22" fill="url(#chrome)" />
          <circle cx="905" cy="368" r="16" fill="#0b0e15" />
          <circle cx="1020" cy="368" r="22" fill="url(#chrome)" />
          <circle cx="1020" cy="368" r="16" fill="#0b0e15" />
          <rect x="948" y="358" width="42" height="20" rx="6" fill="#0a0d14" stroke="#262e3d" />

          {/* lado del acompañante: tapa de guantera y costura */}
          <path d="M 1190 262 Q 1320 258 1440 270 L 1440 520 L 1190 520 Z" fill="url(#dashLower)" />
          <path d="M 1190 262 Q 1320 258 1440 270 L 1440 520 L 1190 520 Z" fill="url(#leatherGrain)" />
          <path d="M 1206 288 Q 1330 284 1428 294" stroke={paint.css} strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="6 6" fill="none" />
          <text x="1300" y="344" textAnchor="middle" fontSize="20" fontWeight="800" letterSpacing="6" fill="#aab4c6" fillOpacity="0.55" fontFamily="Oxanium, sans-serif">GT</text>

          {/* zona inferior: carbono bajo el cuadro */}
          <path d="M 120 300 L 700 300 L 760 520 L 40 520 Z" fill="url(#carbon)" fillOpacity="0.9" />
          <path d="M 120 300 L 700 300" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />

          {/* brújula del salpicadero (se gira en la capa dinámica) */}
          <circle cx="1128" cy="232" r="0.1" fill="none" />
        </svg>

        {/* 2) Agujas y cifras */}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          <defs>
            <filter id="needleGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <text ref={speedTextRef} x={SPEEDO.cx} y={SPEEDO.cy + 14} textAnchor="middle" fontSize="22" fontWeight="800" fill="#ffffff" fontFamily="Oxanium, sans-serif">0</text>
          <text ref={gearTextRef} x={TACHO.cx} y={TACHO.cy + 16} textAnchor="middle" fontSize="22" fontWeight="800" fill="#ffb347" fontFamily="Oxanium, sans-serif">N</text>
          <g ref={speedNeedleRef} filter="url(#needleGlow)">
            <polygon points={`${SPEEDO.cx - 2.4},${SPEEDO.cy + 12} ${SPEEDO.cx + 2.4},${SPEEDO.cy + 12} ${SPEEDO.cx + 1},${SPEEDO.cy - SPEEDO.r + 6} ${SPEEDO.cx - 1},${SPEEDO.cy - SPEEDO.r + 6}`} fill="#ff7a2e" />
            <circle cx={SPEEDO.cx} cy={SPEEDO.cy} r="5" fill="#0a0d14" stroke="#ff7a2e" strokeWidth="1.5" />
          </g>
          <g ref={tachNeedleRef} filter="url(#needleGlow)">
            <polygon points={`${TACHO.cx - 2.4},${TACHO.cy + 12} ${TACHO.cx + 2.4},${TACHO.cy + 12} ${TACHO.cx + 1},${TACHO.cy - TACHO.r + 6} ${TACHO.cx - 1},${TACHO.cy - TACHO.r + 6}`} fill="#ff7a2e" />
            <circle cx={TACHO.cx} cy={TACHO.cy} r="5" fill="#0a0d14" stroke="#ff7a2e" strokeWidth="1.5" />
          </g>
          {/* brújula pequeña sobre la pantalla */}
          <g ref={compassRef}>
            <circle cx="1128" cy="232" r="22" fill="#07101c" stroke="#2f7fbf" strokeWidth="1.5" opacity="0.92" />
            <polygon points="1128,214 1133,232 1123,232" fill="#ff5a4d" />
            <polygon points="1128,250 1133,232 1123,232" fill="#cfe6ff" opacity="0.8" />
          </g>
          <polygon points="1128,196 1124,204 1132,204" fill="#ffb347" />
        </svg>

        {/* 3) Volante achatado de cuero perforado */}
        <div
          ref={wheelRef}
          className="absolute will-change-transform"
          style={{
            left: pct(WHEEL.cx - WHEEL.size / 2, W),
            top: pct(WHEEL.cy - WHEEL.size / 2, H),
            width: pct(WHEEL.size, W),
            height: pct(WHEEL.size, H),
            transformOrigin: '50% 50%',
          }}
        >
          <svg viewBox="0 0 380 380" className="h-full w-full">
            <defs>
              <linearGradient id="gripLeather" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#2a3040" />
                <stop offset="45%" stopColor="#10141c" />
                <stop offset="100%" stopColor="#05070b" />
              </linearGradient>
              <pattern id="perf" width="7" height="7" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.9" fill="#000" fillOpacity="0.55" />
                <circle cx="5.5" cy="5.5" r="0.9" fill="#000" fillOpacity="0.55" />
              </pattern>
              <linearGradient id="spokeMetal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c9d1dd" />
                <stop offset="40%" stopColor="#6c7686" />
                <stop offset="100%" stopColor="#262d3a" />
              </linearGradient>
              <linearGradient id="hubGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#1a2130" />
                <stop offset="100%" stopColor="#06080c" />
              </linearGradient>
              <filter id="wheelShadow" x="-15%" y="-15%" width="130%" height="140%">
                <feDropShadow dx="0" dy="10" stdDeviation="8" floodColor="#000" floodOpacity="0.6" />
              </filter>
            </defs>

            <g filter="url(#wheelShadow)">
              {/* levas del cambio detrás del aro */}
              <path d="M 52 110 L 86 100 L 88 150 L 56 156 Z" fill="#1d2431" stroke="#8b97aa" strokeWidth="1.6" />
              <path d="M 328 110 L 294 100 L 292 150 L 324 156 Z" fill="#1d2431" stroke="#8b97aa" strokeWidth="1.6" />

              {/* aro achatado por abajo: sombra, cuero, perforado y costura */}
              <path d="M 190 24 A 166 166 0 1 1 80 316 Q 190 338 300 316 A 166 166 0 0 1 190 24 Z" fill="none" stroke="#020305" strokeWidth="40" strokeLinejoin="round" />
              <path d="M 190 24 A 166 166 0 1 1 80 316 Q 190 338 300 316 A 166 166 0 0 1 190 24 Z" fill="none" stroke="url(#gripLeather)" strokeWidth="34" strokeLinejoin="round" />
              <path d="M 190 24 A 166 166 0 1 1 80 316 Q 190 338 300 316 A 166 166 0 0 1 190 24 Z" fill="none" stroke="url(#perf)" strokeWidth="34" strokeLinejoin="round" opacity="0.9" />
              <path d="M 190 24 A 166 166 0 1 1 80 316 Q 190 338 300 316 A 166 166 0 0 1 190 24 Z" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="2" transform="translate(0,-14)" />
              <path d="M 190 24 A 166 166 0 1 1 80 316 Q 190 338 300 316 A 166 166 0 0 1 190 24 Z" fill="none" stroke="#c9d1dd" strokeOpacity="0.55" strokeWidth="1.4" strokeDasharray="4 4" />
              {/* marca de las 12 h */}
              <rect x="183" y="6" width="14" height="36" rx="3" fill={paint.css} />
              <rect x="183" y="6" width="14" height="36" rx="3" fill="url(#perf)" opacity="0.4" />
              {/* agarres de pulgar */}
              <rect x="22" y="168" width="22" height="64" rx="10" fill="#0b0f16" stroke="rgba(255,255,255,0.12)" />
              <rect x="336" y="168" width="22" height="64" rx="10" fill="#0b0f16" stroke="rgba(255,255,255,0.12)" />

              {/* radios: dos laterales y uno inferior, con insertos de aluminio */}
              <path d="M 40 188 L 142 176 L 146 216 L 46 224 Z" fill="url(#hubGrad)" stroke="url(#spokeMetal)" strokeWidth="3" />
              <path d="M 340 188 L 238 176 L 234 216 L 334 224 Z" fill="url(#hubGrad)" stroke="url(#spokeMetal)" strokeWidth="3" />
              <path d="M 160 236 L 220 236 L 212 318 L 168 318 Z" fill="url(#hubGrad)" stroke="url(#spokeMetal)" strokeWidth="3" />
              {/* botones de los radios */}
              {[0, 1, 2].map((i) => (
                <rect key={`bl${i}`} x={74 + i * 20} y={192 + i * -1} width="14" height="10" rx="3" fill="#06080c" stroke="#3b4658" />
              ))}
              {[0, 1, 2].map((i) => (
                <rect key={`br${i}`} x={292 - i * 20} y={192 + i * -1} width="14" height="10" rx="3" fill="#06080c" stroke="#3b4658" />
              ))}
              <circle cx="190" cy="262" r="8" fill="#06080c" stroke="#3b4658" />

              {/* cubo con airbag y emblema */}
              <circle cx="190" cy="196" r="58" fill="url(#hubGrad)" stroke="url(#spokeMetal)" strokeWidth="4" />
              <circle cx="190" cy="196" r="44" fill="#0c1018" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
              <path d="M 158 176 Q 190 160 222 176" stroke="rgba(255,255,255,0.16)" strokeWidth="2" fill="none" />
              <polygon points="190,176 208,196 190,216 172,196" fill={paint.css} stroke="#f8fafc" strokeWidth="1.8" />
              <polygon points="190,184 200,196 190,208 180,196" fill="#fff" fillOpacity="0.18" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
};
