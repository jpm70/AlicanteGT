import type { AtmosphereMode } from '../types/game';

/** Degradado CSS de fondo (se ve mientras carga el mundo 3D). */
export function getSkyBackdropCss(mode: AtmosphereMode): string {
  switch (mode) {
    case 'sunset':
      return 'linear-gradient(180deg, #232e5e 0%, #804a62 50%, #f09459 100%)';
    case 'night':
      return 'linear-gradient(180deg, #040712 0%, #0b1633 56%, #13244a 100%)';
    case 'day':
      return 'linear-gradient(180deg, #449ae3 0%, #9acdf2 56%, #d7ecfa 100%)';
  }
}
