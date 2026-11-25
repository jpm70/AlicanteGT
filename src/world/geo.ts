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
/** Altura del terreno (m) en coordenadas locales; bilineal, igual que build_world.py. */
export function heightAt(x: number, z: number): number {
  if (!dem) return 0;
  const gx = Math.min(Math.max((x - dem.x0) / dem.step, 0), dem.nx - 1.001);
  const gz = Math.min(Math.max((z - dem.z0) / dem.step, 0), dem.nz - 1.001);
  const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
  const H = dem.h, n = dem.nx;
  return (
    H[iz * n + ix] * (1 - fx) * (1 - fz) + H[iz * n + ix + 1] * fx * (1 - fz) +
    H[(iz + 1) * n + ix] * (1 - fx) * fz + H[(iz + 1) * n + ix + 1] * fx * fz
  );
}
