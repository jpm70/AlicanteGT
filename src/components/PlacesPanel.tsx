import { useMemo, useState } from 'react';
import {
  Bus, Church, Clapperboard, Flame, Fuel, GraduationCap, Hospital, Hotel, Landmark, MapPin, Plane, Search, Shield,
  ShoppingBag, Stethoscope, TrainFront, Trophy, X, Building2,
} from 'lucide-react';

export interface Place { n: string; c: string; la: number; lo: number }

const CATS: Record<string, { label: string; Icon: typeof Fuel }> = {
  fuel: { label: 'Gasolineras', Icon: Fuel },
  hospital: { label: 'Hospitales', Icon: Hospital },
  clinic: { label: 'Clínicas', Icon: Stethoscope },
  police: { label: 'Policía', Icon: Shield },
  fire: { label: 'Bomberos', Icon: Flame },
  admin: { label: 'Edificios públicos', Icon: Landmark },
  university: { label: 'Universidades', Icon: GraduationCap },
  bus: { label: 'Autobuses', Icon: Bus },
  train: { label: 'Estaciones', Icon: TrainFront },
  airport: { label: 'Aeropuerto', Icon: Plane },
  worship: { label: 'Iglesias', Icon: Church },
  museum: { label: 'Museos', Icon: Building2 },
  attraction: { label: 'Lugares de interés', Icon: MapPin },
  hotel: { label: 'Hoteles', Icon: Hotel },
  stadium: { label: 'Estadios', Icon: Trophy },
  mall: { label: 'Centros comerciales', Icon: ShoppingBag },
  culture: { label: 'Cine y teatro', Icon: Clapperboard },
};

function distKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const dy = (la2 - la1) * 111.32, dx = (lo2 - lo1) * 111.32 * Math.cos((la1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

interface Props {
  open: boolean;
  places: Place[] | null;
  from: { lat: number; lng: number };
  onClose: () => void;
  onGo: (p: Place) => void;
}

/** Lista de lugares singulares (gasolineras, hospitales, estaciones…) ordenados por distancia, con filtro por tipo y teletransporte. */
export function PlacesPanel({ open, places, from, onClose, onGo }: Props) {
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of places ?? []) m[p.c] = (m[p.c] ?? 0) + 1;
    return m;
  }, [places]);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (places ?? [])
      .filter((p) => (cat === 'all' || p.c === cat) && (!ql || p.n.toLowerCase().includes(ql) || (CATS[p.c]?.label ?? '').toLowerCase().includes(ql)))
      .map((p) => ({ p, d: distKm(from.lat, from.lng, p.la, p.lo) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 60);
  }, [places, cat, q, from.lat, from.lng]);

  if (!open) return null;
  return (
    <div
      className="fixed right-3 top-14 z-40 flex max-h-[72vh] w-[min(380px,92vw)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0b1220]/92 text-slate-100 shadow-2xl backdrop-blur-md"
      role="dialog"
      aria-label="Lugares de Alicante"
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <MapPin className="h-4 w-4 text-amber-400" />
        <h2 className="flex-1 text-sm font-semibold">Lugares</h2>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Cerrar lugares">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <Search className="h-3.5 w-3.5 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar (Repsol, hospital, estación…)"
          className="w-full bg-transparent text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-3 py-2">
        <button
          type="button"
          onClick={() => setCat('all')}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] ${cat === 'all' ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-white/15 text-slate-300 hover:bg-white/10'}`}
        >
          Todos
        </button>
        {Object.entries(CATS).filter(([k]) => counts[k]).map(([k, { label, Icon }]) => (
          <button
            key={k}
            type="button"
            onClick={() => setCat(k)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${cat === k ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-white/15 text-slate-300 hover:bg-white/10'}`}
          >
            <Icon className="h-3 w-3" />
            {label} <span className="text-slate-500">{counts[k]}</span>
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {!places && <li className="px-3 py-3 text-xs text-slate-400">Cargando lugares…</li>}
        {places && list.length === 0 && <li className="px-3 py-3 text-xs text-slate-400">Sin resultados.</li>}
        {list.map(({ p, d }) => {
          const Icon = CATS[p.c]?.Icon ?? MapPin;
          return (
            <li key={`${p.c}-${p.la}-${p.lo}`}>
              <button type="button" onClick={() => onGo(p)} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/8">
                <Icon className="h-4 w-4 shrink-0 text-amber-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-white">{p.n}</span>
                  <span className="block text-[10px] text-slate-400">{CATS[p.c]?.label ?? p.c}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-300">{d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
