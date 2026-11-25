import { toLatLng, toLocal } from './geo';
import type { CarState } from '../types/game';

export interface BuildingCollider {
  id: number;
  h: number;
  p: [number, number][];
}
interface Prepared {
  pts: [number, number][];
  minX: number; maxX: number; minZ: number; maxZ: number;
}

const CELL = 40;
const CAR_R = 1.0;
const CIRCLE_OFFSETS = [-1.7, 0, 1.7]; // metros a lo largo del coche (trasero, centro, morro)

export class CollisionWorld {
  private grid = new Map<string, Prepared[]>();
  public count = 0;

  constructor(buildings: BuildingCollider[]) {
    for (const b of buildings) {
      const pts = b.p;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of pts) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const prep: Prepared = { pts, minX, maxX, minZ, maxZ };
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const k = cx + ',' + cz;
          const arr = this.grid.get(k);
          if (arr) arr.push(prep); else this.grid.set(k, [prep]);
        }
      this.count++;
    }
  }

  /** Empuja un círculo fuera de los edificios. Devuelve la normal del mayor impacto (o null). */
  private pushOut(pos: { x: number; z: number }, r: number): { nx: number; nz: number; depth: number } | null {
    let best: { nx: number; nz: number; depth: number } | null = null;
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const seen = new Set<Prepared>();
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = this.grid.get(cx + i + ',' + (cz + j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.has(b)) continue; seen.add(b);
        if (pos.x < b.minX - r || pos.x > b.maxX + r || pos.z < b.minZ - r || pos.z > b.maxZ + r) continue;
        const pts = b.pts;
        let inside = false;
        let bd = Infinity, bx = 0, bz = 0;
        for (let a = 0, c = pts.length - 1; a < pts.length; c = a++) {
          const [x1, z1] = pts[c], [x2, z2] = pts[a];
          if ((z1 > pos.z) !== (z2 > pos.z) && pos.x < ((x2 - x1) * (pos.z - z1)) / (z2 - z1) + x1) inside = !inside;
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((pos.x - x1) * dx + (pos.z - z1) * dz) / l2)) : 0;
          const px = x1 + t * dx, pz = z1 + t * dz;
          const d = Math.hypot(pos.x - px, pos.z - pz);
          if (d < bd) { bd = d; bx = px; bz = pz; }
        }
        if (!inside && bd >= r) continue;
        let nx: number, nz: number, depth: number;
        if (inside) { nx = bx - pos.x; nz = bz - pos.z; depth = bd + r; }
        else { nx = pos.x - bx; nz = pos.z - bz; depth = r - bd; }
        const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        if (inside) { /* la normal apunta hacia fuera: del interior al punto más cercano del borde */ }
        if (!best || depth > best.depth) best = { nx, nz, depth };
        pos.x += nx * depth; pos.z += nz * depth;
      }
    }
    return best;
  }

  /** Resuelve colisiones del coche con edificios; modifica lat/lng y speedMps. Devuelve fuerza del impacto [0..1]. */
  resolve(state: CarState): number {
    const l = toLocal(state.lat, state.lng);
    const h = (state.headingDeg * Math.PI) / 180;
    const fx = Math.sin(h), fz = -Math.cos(h); // adelante (x este, z sur)
    let impact = 0;
    let cx = l.x, cz = l.z;
    for (let it = 0; it < 2; it++) {
      for (const off of CIRCLE_OFFSETS) {
        const p = { x: cx + fx * off, z: cz + fz * off };
        const hit = this.pushOut(p, CAR_R);
        if (hit) {
          cx = p.x - fx * off; cz = p.z - fz * off;
          const along = Math.abs(hit.nx * fx + hit.nz * fz);
          impact = Math.max(impact, along);
        }
      }
    }
    if (cx !== l.x || cz !== l.z) {
      const ll = toLatLng(cx, cz);
      state.lat = ll.lat; state.lng = ll.lng;
      const v = state.speedMps;
      if (Math.abs(v) > 1) state.speedMps = v * (1 - Math.min(0.9, impact * 0.9));
    }
    return impact;
  }
}
