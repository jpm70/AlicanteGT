/** Desplazamiento suave de peatones y ciclistas para apartarse del coche del jugador cuando se les echa encima. */
export interface Dodge { ox: number; oz: number }

/**
 * Actualiza el desvío (ox, oz) de alguien situado en (x, z) respecto al coche en (px, pz) con rumbo (hx, hz).
 * El radio crece con la velocidad; se aparta hacia el lado en que ya estaba (nunca cruzándose por delante) y vuelve solo.
 * `ok(x, z)` permite rechazar destinos no transitables (edificios, calzada).
 */
export function stepDodge(d: Dodge, x: number, z: number, px: number, pz: number, hx: number, hz: number, carSpeed: number, dt: number, ok?: (x: number, z: number) => boolean) {
  const rx = x - px, rz = z - pz, dist = Math.hypot(rx, rz);
  const speed = Math.abs(carSpeed);
  const R = 2.6 + Math.min(speed, 25) * 0.22;                       // 2,6 m parado … ~8 m a 90 km/h
  const ahead = rx * hx + rz * hz;
  let tx = 0, tz = 0;
  if (dist < R && ahead > -2.5 && (speed > 1.2 || dist < 2.4)) {
    const side = rx * -hz + rz * hx;                                 // lado del coche en el que está (+ derecha)
    const sgn = side >= 0 ? 1 : -1;
    const k = (R - dist) / R;                                        // 0 lejos … 1 encima
    const mag = Math.min(3.2, 1.0 + k * 3.0);
    tx = -hz * sgn * mag; tz = hx * sgn * mag;                        // perpendicular al rumbo, hacia su lado
    if (ok && !ok(x + tx, z + tz)) {                                  // ese lado está cerrado: prueba medio desvío y, si no, el otro
      if (ok(x + tx * 0.5, z + tz * 0.5)) { tx *= 0.5; tz *= 0.5; }
      else if (ok(x - tx, z - tz) && speed < 6) { tx = -tx; tz = -tz; }
      else { tx = 0; tz = 0; }
    }
  }
  const f = 1 - Math.exp(-(tx === 0 && tz === 0 ? 2.5 : 7) * dt);
  d.ox += (tx - d.ox) * f; d.oz += (tz - d.oz) * f;
}
