/** Conversión lat/lng <-> metros locales. Origen = Explanada. x = este, z = sur (Three.js). */
export const ORIGIN = { lat: 38.3432, lng: -0.4820 };
const KLAT = 111320;
const KLNG = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function toLocal(lat: number, lng: number): { x: number; z: number } {
  return { x: (lng - ORIGIN.lng) * KLNG, z: -(lat - ORIGIN.lat) * KLAT };
}
export function toLatLng(x: number, z: number): { lat: number; lng: number } {
  return { lat: ORIGIN.lat - z / KLAT, lng: ORIGIN.lng + x / KLNG };
}
