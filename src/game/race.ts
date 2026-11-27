import type { RaceConfig } from '../types/game';

/** Distancia en metros entre dos puntos (aprox. plana, suficiente para una ciudad). */
export function distM(la1: number, lo1: number, la2: number, lo2: number): number {
  const dy = (la2 - la1) * 111320, dx = (lo2 - lo1) * 111320 * Math.cos((la1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Rumbo en grados (0 = norte, 90 = este) de un punto a otro. */
export function bearingTo(la1: number, lo1: number, la2: number, lo2: number): number {
  const dy = la2 - la1, dx = (lo2 - lo1) * Math.cos((la1 * Math.PI) / 180);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

export function formatTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), c = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export function formatDist(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function routeKey(c: Pick<RaceConfig, 'start' | 'dest'>): string | null {
  return c.dest ? `${c.start.n}→${c.dest.n}` : null;
}

const BEST_KEY = 'alicantegt.best.v1';
const MENU_KEY = 'alicantegt.menu.v1';

function readJson<T>(key: string): T | null {
  try { const s = window.localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function writeJson(key: string, v: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* sin almacenamiento: no pasa nada */ }
}

export function loadBest(key: string | null): number | null {
  if (!key) return null;
  const m = readJson<Record<string, number>>(BEST_KEY);
  return m && typeof m[key] === 'number' ? m[key] : null;
}

/** Guarda el tiempo si mejora el récord. Devuelve true si es nuevo récord. */
export function saveBest(key: string | null, ms: number): boolean {
  if (!key) return false;
  const m = readJson<Record<string, number>>(BEST_KEY) ?? {};
  if (typeof m[key] === 'number' && m[key] <= ms) return false;
  m[key] = ms; writeJson(BEST_KEY, m);
  return true;
}

export function loadMenu(): Partial<RaceConfig> | null { return readJson<Partial<RaceConfig>>(MENU_KEY); }
export function saveMenu(c: RaceConfig) { writeJson(MENU_KEY, c); }
