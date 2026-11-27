import { toLatLng } from '../world/geo';
import type { PlaceRef } from '../types/game';

/** Calle del índice public/world/addresses.json (tools/pbf_addresses.py). Coordenadas locales en metros (x = este, z = sur). */
export interface Street {
  n: string;
  /** nombres alternativos ya normalizados (castellano, valenciano…) */
  a: string[];
  /** polilíneas de la calle */
  p: [number, number][][];
  /** portales conocidos: [número, sufijo, x, z] */
  h: [number, string, number, number][];
}

// Mismo criterio que norm() de tools/pbf_addresses.py
const STOP = new Set(['calle', 'carrer', 'c', 'avenida', 'avinguda', 'av', 'avda', 'plaza', 'placa', 'pl', 'paseo', 'passeig', 'pso', 'camino', 'cami', 'ronda', 'carretera', 'ctra',
  'travesia', 'travessera', 'rambla', 'via', 'de', 'del', 'la', 'el', 'los', 'las', 'els', 'les', 'l', 'd', 'dels', 'i', 'y']);

export function normalizeStreet(s: string): string {
  const t = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).join(' ');
}

let cache: Promise<Street[]> | null = null;
/** Descarga (una vez) el índice de calles y portales. */
export function loadAddresses(): Promise<Street[]> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}world/addresses.json`)
      .then((r) => r.json())
      .then((d: { streets: Street[] }) => d.streets)
      .catch(() => []);
  }
  return cache;
}

/** Separa «Alfonso X el Sabio 15», «calle Maisonnave, nº 3 B»… en calle y número. */
export function parseQuery(q: string): { street: string; num: number | null; suffix: string } {
  const m = q.trim().match(/^(.*?)[\s,]*(?:n[º°o.]*\s*)?(\d{1,4})\s*([a-zA-Z]?)\s*$/i);
  if (m && m[1].trim()) return { street: m[1].trim(), num: parseInt(m[2], 10), suffix: m[3].toUpperCase() };
  return { street: q.trim(), num: null, suffix: '' };
}

interface Snap { x: number; z: number; bearing: number; d: number }

/** Punto más cercano de las polilíneas de la calle y rumbo (grados, 0 = norte) del tramo. */
function snapToStreet(st: Street, x: number, z: number): Snap | null {
  let best: Snap | null = null;
  for (const line of st.p) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { x: px, z: pz, bearing: ((Math.atan2(ex, -ez) * 180) / Math.PI + 360) % 360, d };
    }
  }
  return best;
}

/** Punto medio (por longitud) de la polilínea más larga: «el centro de la calle». */
function streetMiddle(st: Street): { x: number; z: number } | null {
  let bestLine: [number, number][] | null = null, bestLen = -1;
  for (const line of st.p) {
    let len = 0;
    for (let i = 0; i < line.length - 1; i++) len += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (len > bestLen) { bestLen = len; bestLine = line; }
  }
  if (!bestLine) return null;
  let acc = 0;
  for (let i = 0; i < bestLine.length - 1; i++) {
    const seg = Math.hypot(bestLine[i + 1][0] - bestLine[i][0], bestLine[i + 1][1] - bestLine[i][1]);
    if (acc + seg >= bestLen / 2) {
      const t = seg > 0 ? (bestLen / 2 - acc) / seg : 0;
      return { x: bestLine[i][0] + (bestLine[i + 1][0] - bestLine[i][0]) * t, z: bestLine[i][1] + (bestLine[i + 1][1] - bestLine[i][1]) * t };
    }
    acc += seg;
  }
  return { x: bestLine[0][0], z: bestLine[0][1] };
}

/** Posición de un portal: el conocido, o interpolado entre los dos vecinos (mismo lado de la calle si se puede). */
function locateNumber(st: Street, num: number, suffix: string): { x: number; z: number; exact: boolean } | null {
  if (!st.h.length) return null;
  const exact = st.h.find((h) => h[0] === num && h[1] === suffix) ?? st.h.find((h) => h[0] === num);
  if (exact) return { x: exact[2], z: exact[3], exact: true };
  const sameSide = st.h.filter((h) => h[0] % 2 === num % 2);
  const pool = sameSide.length >= 2 ? sameSide : st.h;
  const lower = pool.filter((h) => h[0] < num).sort((a, b) => b[0] - a[0])[0];
  const upper = pool.filter((h) => h[0] > num).sort((a, b) => a[0] - b[0])[0];
  if (lower && upper) {
    const t = (num - lower[0]) / (upper[0] - lower[0]);
    return { x: lower[2] + (upper[2] - lower[2]) * t, z: lower[3] + (upper[3] - lower[3]) * t, exact: false };
  }
  const near = lower ?? upper;
  return near ? { x: near[2], z: near[3], exact: false } : null;
}

function matches(tokens: string[], alias: string): number | null {
  const words = alias.split(' ');
  let used = 0;
  for (const t of tokens) {
    if (!words.some((w) => w.startsWith(t))) return null;
    used++;
  }
  return words.length - used;
}

/** Busca direcciones («calle» o «calle número») y las devuelve como lugares ya colocados sobre la calzada. */
export function searchAddresses(streets: Street[], q: string, limit = 6): PlaceRef[] {
  const { street, num, suffix } = parseQuery(q);
  const tokens = normalizeStreet(street).split(' ').filter(Boolean);
  if (!tokens.length || tokens.join('').length < 2) return [];
  const scored: { st: Street; score: number }[] = [];
  for (const st of streets) {
    let best: number | null = null;
    for (const a of st.a) {
      const extra = matches(tokens, a);
      if (extra !== null && (best === null || extra < best)) best = extra;
    }
    if (best !== null) scored.push({ st, score: best * 10 + Math.min(st.n.length, 60) / 60 - Math.min(st.h.length, 40) / 400 });
  }
  scored.sort((a, b) => a.score - b.score);
  const out: PlaceRef[] = [];
  for (const { st } of scored.slice(0, limit)) {
    let pt: { x: number; z: number } | null = null;
    let label = st.n;
    if (num !== null) {
      const loc = locateNumber(st, num, suffix);
      if (loc) { pt = loc; label = `${st.n} ${num}${suffix}${loc.exact ? '' : ' (aprox.)'}`; }
    }
    if (!pt) pt = streetMiddle(st) ?? (st.h[0] ? { x: st.h[0][2], z: st.h[0][3] } : null);
    if (!pt) continue;
    const snap = snapToStreet(st, pt.x, pt.z);
    const at = snap && snap.d < 40 ? { x: snap.x, z: snap.z } : pt;
    const ll = toLatLng(at.x, at.z);
    out.push({ n: label, la: ll.lat, lo: ll.lng, b: snap && snap.d < 40 ? snap.bearing : undefined, ax: !!(snap && snap.d < 40), c: 'address' });
  }
  return out;
}
