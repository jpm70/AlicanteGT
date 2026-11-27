import { TILE, toLatLng, toLocal } from './geo';
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

export interface DriveMask { x0: number; z0: number; cell: number; nx: number; nz: number; bits: string }

/** Esquinas del coche (m): delante/detrás x izquierda/derecha. */
const CORNERS: [number, number][] = [[1.0, 2.3], [-1.0, 2.3], [1.0, -2.3], [-1.0, -2.3]];

interface TileData {
  grid: Map<string, Prepared[]>;
  walk: Uint8Array | null;
  drive: Uint8Array | null;
  dm: DriveMask | null;
  count: number;
}

export class CollisionWorld {
  private tiles = new Map<string, TileData>();
  private bounds: [number, number, number, number] | null = null;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;
  public count = 0;

  /** Región total del mundo (m): fuera de ella no se puede conducir. */
  setBounds(x0: number, z0: number, x1: number, z1: number) { this.bounds = [x0, z0, x1, z1]; }

  addTile(key: string, buildings: BuildingCollider[], drive: DriveMask | null, walk: string | null = null) {
    this.removeTile(key);
    const td: TileData = { grid: new Map(), walk: null, drive: null, dm: drive, count: 0 };
    if (walk) {
      const bw = atob(walk);
      td.walk = new Uint8Array(bw.length);
      for (let i = 0; i < bw.length; i++) td.walk[i] = bw.charCodeAt(i);
    }
    if (drive) {
      const bin = atob(drive.bits);
      td.drive = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) td.drive[i] = bin.charCodeAt(i);
    }
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
          const arr = td.grid.get(k);
          if (arr) arr.push(prep); else td.grid.set(k, [prep]);
        }
      td.count++;
    }
    this.tiles.set(key, td);
    this.count += td.count;
  }

  removeTile(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    this.count -= t.count;
    this.tiles.delete(key);
  }

  /** ¿Se puede conducir en (x, z)? Fuera del mundo = no; teselas aún sin cargar = sí (hueco breve). */
  private canDrive(x: number, z: number): boolean {
    const bd = this.bounds;
    if (bd && (x < bd[0] || z < bd[1] || x >= bd[2] || z >= bd[3])) return false;
    const t = this.tiles.get(Math.floor(x / TILE) + '_' + Math.floor(z / TILE));
    if (!t || !t.dm || !t.drive) return true;
    const d = t.dm;
    const ix = Math.floor((x - d.x0) / d.cell), iz = Math.floor((z - d.z0) / d.cell);
    if (ix < 0 || iz < 0 || ix >= d.nx || iz >= d.nz) return true;
    const k = iz * d.nx + ix;
    return ((t.drive[k >> 3] >> (7 - (k & 7))) & 1) === 1;
  }

  /** ¿Es calzada o acera (transitable a pie) en (x, z)? */
  walkable(x: number, z: number): boolean { return this.canDrive(x, z); }

  /** ¿Es acera, plaza o paseo (no calzada)? Sin máscara de aceras en la tesela, cae en `walkable`. */
  sidewalk(x: number, z: number): boolean {
    const t = this.tiles.get(Math.floor(x / TILE) + '_' + Math.floor(z / TILE));
    if (!t || !t.dm || !t.walk) return this.canDrive(x, z);
    const d = t.dm;
    const ix = Math.floor((x - d.x0) / d.cell), iz = Math.floor((z - d.z0) / d.cell);
    if (ix < 0 || iz < 0 || ix >= d.nx || iz >= d.nz) return false;
    const k = iz * d.nx + ix;
    return ((t.walk[k >> 3] >> (7 - (k & 7))) & 1) === 1;
  }

  private carFits(x: number, z: number, hd: number): boolean {
    const sn = Math.sin(hd), cs = Math.cos(hd);
    const fx = sn, fz = -cs;        // adelante
    const rx = cs, rz = sn;         // derecha
    for (const [side, along] of CORNERS) {
      if (!this.canDrive(x + fx * along + rx * side, z + fz * along + rz * side)) return false;
    }
    return true;
  }

  /** Mantiene el coche sobre calzada/acera: si la nueva posición sale, desliza por un eje o vuelve atrás. */
  private keepOnRoad(state: CarState, x: number, z: number): { x: number; z: number; blocked: boolean; slid?: boolean } {
    const hd = (state.headingDeg * Math.PI) / 180;
    if (!this.hasLast || Math.hypot(x - this.lastX, z - this.lastZ) > 15) {
      this.hasLast = true; this.lastX = x; this.lastZ = z;   // teletransporte / primer frame
      return { x, z, blocked: false };
    }
    if (this.carFits(x, z, hd)) { this.lastX = x; this.lastZ = z; return { x, z, blocked: false }; }
    if (!this.carFits(this.lastX, this.lastZ, hd)) { this.lastX = x; this.lastZ = z; return { x, z, blocked: false }; }  // ya estaba fuera: no atrapar
    if (this.carFits(x, this.lastZ, hd)) { this.lastX = x; return { x, z: this.lastZ, blocked: true, slid: true }; }
    if (this.carFits(this.lastX, z, hd)) { this.lastZ = z; return { x: this.lastX, z, blocked: true, slid: true }; }
    return { x: this.lastX, z: this.lastZ, blocked: true, slid: false };
  }

  reset() { this.hasLast = false; }

  /** Empuja un círculo fuera de los edificios. Devuelve la normal del mayor impacto (o null). */
  private pushOut(pos: { x: number; z: number }, r: number): { nx: number; nz: number; depth: number } | null {
    let best: { nx: number; nz: number; depth: number } | null = null;
    const cx = Math.floor(pos.x / CELL), cz = Math.floor(pos.z / CELL);
    const seen = new Set<Prepared>();
    const tx = Math.floor(pos.x / TILE), tz = Math.floor(pos.z / TILE);
    for (let ti = -1; ti <= 1; ti++) for (let tj = -1; tj <= 1; tj++) {
    const td = this.tiles.get(tx + ti + '_' + (tz + tj));
    if (!td) continue;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = td.grid.get(cx + i + ',' + (cz + j));
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
    const road = this.keepOnRoad(state, cx, cz);
    if (road.blocked) {
      impact = Math.max(impact, road.slid ? 0.03 : 0.5);   // rozar el bordillo apenas frena; chocar de frente sí
      cx = road.x; cz = road.z;
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
