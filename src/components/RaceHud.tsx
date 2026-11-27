import { Flag, Navigation, RotateCcw, Trophy } from 'lucide-react';
import { formatDist, formatTime } from '../game/race';

interface HudProps {
  chronoMs: number;
  destName: string;
  distM: number;
  /** ángulo de la meta respecto al morro del coche (grados, + = a la derecha) */
  relDeg: number;
  onMenu: () => void;
}

/** Cronómetro, distancia y flecha hacia la meta durante la carrera. */
export function RaceHud({ chronoMs, destName, distM, relDeg, onMenu }: HudProps) {
  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-30 flex -translate-x-1/2 items-stretch gap-2">
      <div className="flex items-center gap-3 rounded-xl border border-white/20 bg-[#0b1220]/85 px-4 py-2 text-white shadow-lg backdrop-blur">
        <Navigation className="h-6 w-6 text-amber-400 transition-transform duration-100" style={{ transform: `rotate(${relDeg}deg)` }} aria-label="Dirección de la meta" />
        <div className="leading-tight">
          <div className="font-telemetry text-2xl font-bold tracking-tight">{formatTime(chronoMs)}</div>
          <div className="flex items-center gap-1 text-[11px] text-slate-300">
            <Flag className="h-3 w-3 text-amber-400" />
            <span className="max-w-[40vw] truncate sm:max-w-[260px]">{destName}</span>
            <span className="font-telemetry text-white">· {formatDist(distM)}</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onMenu}
        className="pointer-events-auto rounded-xl border border-white/20 bg-[#0b1220]/85 px-3 text-[11px] font-medium text-slate-100 shadow-lg backdrop-blur hover:bg-white/15"
        title="Pausar y volver al menú (Esc)"
      >
        Menú
      </button>
    </div>
  );
}

export function Countdown({ value }: { value: number | 'go' }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
      <div key={String(value)} className="animate-pulse font-display text-[22vw] font-bold leading-none text-white drop-shadow-[0_6px_24px_rgba(0,0,0,0.6)] sm:text-[160px]">
        {value === 'go' ? '¡YA!' : value}
      </div>
    </div>
  );
}

interface FinishProps {
  destName: string;
  timeMs: number;
  bestMs: number | null;
  record: boolean;
  onRetry: () => void;
  onMenu: () => void;
}

export function FinishCard({ destName, timeMs, bestMs, record, onRetry, onMenu }: FinishProps) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
      <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#0b1220]/95 p-6 text-center text-white shadow-2xl">
        <Trophy className={`mx-auto h-9 w-9 ${record ? 'text-amber-400' : 'text-slate-300'}`} />
        <h2 className="mt-2 font-display text-2xl font-bold">¡Meta alcanzada!</h2>
        <p className="mt-0.5 text-xs text-slate-300">{destName}</p>
        <div className="mt-4 font-telemetry text-4xl font-bold text-amber-300">{formatTime(timeMs)}</div>
        <p className="mt-1 text-xs text-slate-300">
          {record ? '¡Nuevo récord en esta ruta!' : bestMs != null ? `Tu récord: ${formatTime(bestMs)}` : ''}
        </p>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onRetry} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-400">
            <RotateCcw className="h-4 w-4" /> Repetir
          </button>
          <button type="button" onClick={onMenu} className="flex-1 rounded-xl border border-white/20 bg-white/8 px-4 py-2.5 text-sm font-medium hover:bg-white/15">
            Nueva ruta
          </button>
        </div>
      </div>
    </div>
  );
}
