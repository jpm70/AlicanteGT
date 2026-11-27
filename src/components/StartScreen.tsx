import { useEffect, useMemo, useState } from 'react';
import { Camera, Car, ChevronDown, Compass, Flag, House, MapPin, Moon, Play, Search, Sun, Sunset, Timer, Users, Volume2, VolumeX, X } from 'lucide-react';
import { ALICANTE_LANDMARKS, CAR_PAINT_PRESETS } from '../game/constants';
import { loadAddresses, searchAddresses, type Street } from '../game/addresses';
import { bearingTo, distM, formatDist, formatTime, loadBest, routeKey, startBearing } from '../game/race';
import type { AtmosphereMode, CameraPreset, PlaceRef, RaceConfig } from '../types/game';
import { CATS, type Place } from './PlacesPanel';

/** Sitios que no están en OSM pero queremos poder elegir. */
const EXTRA_PLACES: PlaceRef[] = [
  { n: 'ATU Academia Técnica Universitaria', la: 38.34051, lo: -0.50106, c: 'university' },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const COMPASS: { label: string; deg: number }[] = [
  { label: 'N', deg: 0 }, { label: 'NE', deg: 45 }, { label: 'E', deg: 90 }, { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 }, { label: 'SO', deg: 225 }, { label: 'O', deg: 270 }, { label: 'NO', deg: 315 },
];

const CAMERAS: { id: CameraPreset; label: string }[] = [
  { id: 'chase', label: 'Persecución' }, { id: 'aerial', label: 'Aérea' }, { id: 'driver', label: 'Conductor' },
];

const MOMENTS: { id: AtmosphereMode; label: string; Icon: typeof Sun }[] = [
  { id: 'day', label: 'Día', Icon: Sun }, { id: 'sunset', label: 'Tarde', Icon: Sunset }, { id: 'night', label: 'Noche', Icon: Moon },
];

interface PickerProps {
  value: PlaceRef | null;
  onChange: (p: PlaceRef | null) => void;
  options: PlaceRef[];
  emptyLabel?: string;
  placeholder: string;
  /** resultados extra según lo escrito (direcciones) */
  extra?: (q: string) => PlaceRef[];
}

/** Desplegable con buscador para elegir un sitio. */
function PlacePicker({ value, onChange, options, emptyLabel, placeholder, extra }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const nq = norm(q.trim());
    const out = nq ? options.filter((o) => norm(o.n).includes(nq) || norm(CATS[o.c ?? '']?.label ?? '').includes(nq)) : options;
    return [...(extra && q.trim() ? extra(q) : []), ...out].slice(0, 60);
  }, [q, options, extra]);
  const iconOf = (c?: string) => (c === 'address' ? House : CATS[c ?? '']?.Icon ?? MapPin);
  const Icon = iconOf(value?.c);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-white/15 bg-white/8 px-3 py-2.5 text-left text-sm text-white transition hover:bg-white/14 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        aria-expanded={open}
      >
        <Icon className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate">{value ? value.n : placeholder}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-300 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-xl border border-white/15 bg-[#0b1220]/97 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Lugar o dirección: «Luceros», «Maisonnave 12»…"
              className="w-full bg-transparent text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {emptyLabel && !q && (
              <li>
                <button type="button" onClick={() => { onChange(null); setOpen(false); setQ(''); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-white/10">
                  <X className="h-3.5 w-3.5 text-slate-400" /> {emptyLabel}
                </button>
              </li>
            )}
            {list.length === 0 && <li className="px-3 py-3 text-xs text-slate-400">Sin resultados.</li>}
            {list.map((o) => {
              const I = iconOf(o.c);
              return (
                <li key={`${o.n}-${o.la}-${o.lo}`}>
                  <button type="button" onClick={() => { onChange(o); setOpen(false); setQ(''); }} className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/10">
                    <I className="h-4 w-4 shrink-0 text-amber-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-white">{o.n}</span>
                      <span className="block text-[10px] text-slate-400">{o.c === 'address' ? 'Dirección' : CATS[o.c ?? '']?.label ?? 'Lugar'}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Section({ title, Icon, children }: { title: string; Icon: typeof Sun; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/90">
        <Icon className="h-3.5 w-3.5" /> {title}
      </h3>
      {children}
    </section>
  );
}

const chip = (active: boolean) =>
  `rounded-lg border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${
    active ? 'border-amber-400/70 bg-amber-500/25 text-amber-100' : 'border-white/15 bg-white/6 text-slate-200 hover:bg-white/14'
  }`;

interface Props {
  config: RaceConfig;
  onChange: (c: RaceConfig) => void;
  places: Place[] | null;
  onStart: () => void;
  /** El mundo 3D ya está cargado: hasta entonces no se puede salir. */
  ready: boolean;
  /** Si hay una partida en curso: botón para volver a ella. */
  onResume?: () => void;
}

/** Pantalla de inicio: salida y rumbo, meta cronometrada, cámara, color, momento del día y opciones. */
export function StartScreen({ config, onChange, places, onStart, ready, onResume }: Props) {
  const set = (patch: Partial<RaceConfig>) => onChange({ ...config, ...patch });

  const options = useMemo<PlaceRef[]>(() => {
    const seen = new Set<string>();
    const out: PlaceRef[] = [];
    const add = (p: PlaceRef) => { const k = norm(p.n); if (!seen.has(k)) { seen.add(k); out.push(p); } };
    ALICANTE_LANDMARKS.forEach((l) => add({ n: l.name, la: l.lat, lo: l.lng, b: l.bearing, c: 'attraction' }));
    EXTRA_PLACES.forEach(add);
    [...(places ?? [])].sort((a, b) => a.n.localeCompare(b.n, 'es')).forEach((p) => add({ n: p.n, la: p.la, lo: p.lo, c: p.c }));
    return out;
  }, [places]);

  const [streets, setStreets] = useState<Street[]>([]);
  useEffect(() => { void loadAddresses().then(setStreets); }, []);
  const addrSearch = useMemo(() => (q: string) => searchAddresses(streets, q), [streets]);

  const { start, dest } = config;
  const autoBearing = startBearing({ start, dest, bearing: 'auto' });
  const key = routeKey(config);
  const best = loadBest(key);
  const straight = dest ? distM(start.la, start.lo, dest.la, dest.lo) : 0;
  const sameSpot = dest && straight < 80;
  const night = config.atmosphere === 'night';

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-[#090d16] text-slate-100"
      role="dialog"
      aria-label="Pantalla de inicio de Alicante GT"
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
    >
      {/* Fondo: la imagen cambia con el momento del día */}
      {(['tarde', 'noche'] as const).map((n) => (
        <img
          key={n}
          src={`${import.meta.env.BASE_URL}menu/${n}.webp`}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-[70%_50%] transition-opacity duration-700"
          style={{ opacity: (n === 'noche') === night ? 1 : 0, filter: config.atmosphere === 'day' && n === 'tarde' ? 'brightness(1.12) saturate(0.82) hue-rotate(-10deg)' : undefined }}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-r from-[#070b14]/92 via-[#070b14]/65 to-transparent sm:via-[#070b14]/40" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#070b14]/70 via-transparent to-transparent" />

      <div className="relative flex h-full w-full flex-col overflow-y-auto px-4 py-5 sm:px-8 sm:py-8">
        <div className="w-full max-w-[520px] space-y-5 rounded-2xl border border-white/12 bg-[#0b1220]/72 p-5 shadow-2xl backdrop-blur-md sm:p-6">
          <header>
            <h1 className="font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">Alicante <span className="text-amber-400">GT</span></h1>
            <p className="mt-1 text-sm text-slate-300">Conduce por la ciudad real. Elige salida y meta, y contra el reloj.</p>
          </header>

          <Section title="Salida" Icon={MapPin}>
            <PlacePicker
              value={start}
              onChange={(p) => p && set({ start: p })}
              options={options}
              extra={addrSearch}
              placeholder="Elige la salida (lugar o dirección)"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 flex items-center gap-1 text-[11px] text-slate-400"><Compass className="h-3.5 w-3.5" /> Dirección</span>
              <button type="button" onClick={() => set({ bearing: 'auto' })} className={chip(config.bearing === 'auto')} title={dest ? 'Mirando hacia la meta' : 'La del lugar'}>
                Auto
              </button>
              {COMPASS.map((c) => (
                <button key={c.label} type="button" onClick={() => set({ bearing: c.deg })} className={chip(config.bearing === c.deg)}>
                  {c.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">
              Saldrás mirando al {Math.round(config.bearing === 'auto' ? autoBearing : config.bearing)}°
              {config.bearing === 'auto' && (dest ? ' (hacia la meta).' : ' (el del lugar).')}
            </p>
          </Section>

          <Section title="Meta y cronómetro" Icon={Flag}>
            <PlacePicker value={dest} onChange={(p) => set({ dest: p })} options={options} extra={addrSearch} emptyLabel="Sin meta · conducción libre" placeholder="Sin meta · lugar o dirección" />
            {dest ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300">
                <span className="flex items-center gap-1"><Timer className="h-3.5 w-3.5 text-amber-400" /> En línea recta: {formatDist(straight)}</span>
                <span>{best != null ? `Tu mejor tiempo: ${formatTime(best)}` : 'Aún sin récord en esta ruta'}</span>
              </p>
            ) : (
              <p className="text-[11px] text-slate-400">Sin meta no hay cronómetro: pasea por la ciudad.</p>
            )}
            {sameSpot && <p className="text-[11px] text-amber-300">La salida y la meta están casi en el mismo sitio: elige una meta más lejana.</p>}
          </Section>

          <Section title="Cámara" Icon={Camera}>
            <div className="flex flex-wrap gap-1.5">
              {CAMERAS.map((c) => <button key={c.id} type="button" onClick={() => set({ camera: c.id })} className={chip(config.camera === c.id)}>{c.label}</button>)}
            </div>
          </Section>

          <Section title="Coche" Icon={Car}>
            <div className="flex flex-wrap items-center gap-2">
              {CAR_PAINT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => set({ paintId: p.id })}
                  title={p.label}
                  aria-label={p.label}
                  aria-pressed={config.paintId === p.id}
                  className={`h-8 w-8 rounded-full border-2 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400 ${config.paintId === p.id ? 'scale-110 border-white' : 'border-white/25 hover:border-white/60'}`}
                  style={{ background: p.css }}
                />
              ))}
              <span className="ml-1 text-[11px] text-slate-300">{CAR_PAINT_PRESETS.find((p) => p.id === config.paintId)?.label}</span>
            </div>
          </Section>

          <Section title="Momento del día" Icon={Sunset}>
            <div className="flex flex-wrap gap-1.5">
              {MOMENTS.map(({ id, label, Icon }) => (
                <button key={id} type="button" onClick={() => set({ atmosphere: id })} className={`${chip(config.atmosphere === id)} flex items-center gap-1.5`}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Opciones" Icon={Users}>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => set({ traffic: !config.traffic })} className={`${chip(config.traffic)} flex items-center gap-1.5`} aria-pressed={config.traffic}>
                <Users className="h-3.5 w-3.5" /> Tráfico y peatones {config.traffic ? 'sí' : 'no'}
              </button>
              <button type="button" onClick={() => set({ audio: !config.audio })} className={`${chip(config.audio)} flex items-center gap-1.5`} aria-pressed={config.audio}>
                {config.audio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />} Sonido del motor {config.audio ? 'sí' : 'no'}
              </button>
            </div>
          </Section>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onStart}
              disabled={!!sameSpot || !ready}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-sm font-bold text-slate-950 shadow-lg transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Play className="h-4 w-4" /> {!ready ? 'Cargando Alicante en 3D…' : dest ? 'Salir a cronometrar' : 'Conducir libre'}
            </button>
            {onResume && (
              <button type="button" onClick={onResume} className="rounded-xl border border-white/20 bg-white/8 px-4 py-3 text-sm font-medium text-white hover:bg-white/15">
                Continuar partida
              </button>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-slate-400">
            WASD o flechas: conducir · Espacio: freno de mano y derrape · C: cámara · M: mapa · L: lugares · R: reiniciar · Esc: volver a este menú
          </p>
        </div>
      </div>
    </div>
  );
}
