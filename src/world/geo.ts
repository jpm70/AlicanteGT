/** Conversión lat/lng <-> metros locales. Origen = Explanada. x = este, z = sur (Three.js). */
/** Lado de cada tesela del mundo (m); coincide con tools/world_config.py. */
export const TILE = 1000;
export const ORIGIN = { lat: 38.3432, lng: -0.4820 };
const KLAT = 111320;
const KLNG = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function toLocal(lat: number, lng: number): { x: number; z: number } {
  return { x: (lng - ORIGIN.lng) * KLNG, z: -(lat - ORIGIN.lat) * KLAT };
}
export function toLatLng(x: number, z: number): { lat: number; lng: number } {
  return { lat: ORIGIN.lat - z / KLAT, lng: ORIGIN.lng + x / KLNG };
}

export interface DemData { x0: number; z0: number; step: number; nx: number; nz: number; h: number[] }
let dem: DemData | null = null;
export function setDem(d: DemData | null) { dem = d; }
const cr = (t: number, p0: number, p1: number, p2: number, p3: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
/** Altura del terreno (m) en coordenadas locales; Catmull-Rom bicúbico, igual que hf() de tools/build_tiles.py (sin quiebros de pendiente en la malla de 10 m). */
export function heightAt(x: number, z: number): number {
  if (!dem) return 0;
  const gx = Math.min(Math.max((x - dem.x0) / dem.step, 0), dem.nx - 1.001);
  const gz = Math.min(Math.max((z - dem.z0) / dem.step, 0), dem.nz - 1.001);
  const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
  const H = dem.h, n = dem.nx, m = dem.nz;
  const cx = (i: number) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);
  const row = (j: number) => {
    const o = (j < 0 ? 0 : j > m - 1 ? m - 1 : j) * n;
    return cr(fx, H[o + cx(ix - 1)], H[o + cx(ix)], H[o + cx(ix + 1)], H[o + cx(ix + 2)]);
  };
  return cr(fz, row(iz - 1), row(iz), row(iz + 1), row(iz + 2));
}
