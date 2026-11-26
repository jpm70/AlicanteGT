import * as THREE from 'three';

/** Ciclo de un cruce (s): eje A verde 18 + ámbar 3, todo rojo 1, eje B verde 18 + ámbar 3, todo rojo 1. */
const CYCLE = 44;
export type SigState = 'g' | 'a' | 'r';

interface Sig { x: number; z: number; ax: number; az: number; cl: number; grp: 0 | 1; idx: number; tile: string }
interface Cluster { ax: number; az: number; off: number }

/** Estado de un eje en el instante t del ciclo (con el tiempo que le queda a ese estado). */
function axisState(tt: number): { state: SigState; left: number } {
  if (tt < 18) return { state: 'g', left: 18 - tt };
  if (tt < 21) return { state: 'a', left: 21 - tt };
  return { state: 'r', left: CYCLE - tt };
}

const LIT: [number, number, number][] = [[2.2, 0.25, 0.18], [2.2, 1.5, 0.2], [0.25, 2.2, 0.7]];     // rojo, ámbar, verde (HDR: dan bloom de noche)
const DIM: [number, number, number][] = [[0.18, 0.03, 0.03], [0.16, 0.1, 0.02], [0.03, 0.14, 0.06]];

/** Semáforos con ciclo: agrupa los semáforos de un cruce, reparte los ejes en fase y decide qué color ve cada vía. */
export class Signals {
  private tiles = new Map<string, { sigs: Sig[]; lens: THREE.InstancedMesh | null }>();
  private grid = new Map<string, Sig[]>();
  private clusters: Cluster[] = [];
  private dirty = true;
  private t = 0;
  private acc = 1;

  register(key: string, sigs: [number, number, number][]) {
    this.tiles.set(key, { sigs: sigs.map(([x, z, yaw], idx) => ({ x, z, ax: Math.sin(yaw), az: Math.cos(yaw), cl: 0, grp: 0 as 0 | 1, idx, tile: key })), lens: null });
    this.dirty = true;
  }

  attachLens(key: string, lens: THREE.InstancedMesh) {
    const t = this.tiles.get(key);
    if (t) { t.lens = lens; this.acc = 1; }
  }

  unregister(key: string) {
    this.tiles.delete(key);
    this.dirty = true;
  }

  private rebuild() {
    this.grid.clear(); this.clusters = [];
    const all: Sig[] = [];
    for (const t of this.tiles.values()) all.push(...t.sigs);
    const C = 30;
    for (const s of all) { s.cl = -1; const k = `${Math.floor(s.x / C)},${Math.floor(s.z / C)}`; const a = this.grid.get(k); if (a) a.push(s); else this.grid.set(k, [s]); }
    for (const s of all) {
      if (s.cl >= 0) continue;
      const id = this.clusters.length;
      const hash = Math.abs(Math.floor(s.x * 7.3 + s.z * 13.1)) % 1000;
      this.clusters.push({ ax: s.ax, az: s.az, off: (hash / 1000) * CYCLE });
      const stack = [s]; s.cl = id;
      while (stack.length) {
        const q = stack.pop()!;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          for (const o of this.grid.get(`${Math.floor(q.x / C) + i},${Math.floor(q.z / C) + j}`) ?? []) {
            if (o.cl >= 0 || Math.hypot(o.x - q.x, o.z - q.z) > C) continue;
            o.cl = id; stack.push(o);
          }
        }
      }
    }
    for (const s of all) s.grp = Math.abs(s.ax * this.clusters[s.cl].ax + s.az * this.clusters[s.cl].az) > 0.7 ? 0 : 1;
    this.dirty = false;
  }

  private groupState(cl: number, grp: 0 | 1) {
    const tt = (this.t + this.clusters[cl].off) % CYCLE;
    return axisState(grp === 0 ? tt : (tt - 22 + CYCLE) % CYCLE);
  }

  /** Color que ve un coche que llega a (x, z) circulando en el sentido (fx, fz); null si no hay semáforo cerca. */
  stateAt(x: number, z: number, fx: number, fz: number): { state: SigState; left: number } | null {
    if (this.dirty) this.rebuild();
    const C = 30;
    let best: Sig | null = null, bd = 26;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const s of this.grid.get(`${Math.floor(x / C) + i},${Math.floor(z / C) + j}`) ?? []) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bd) { bd = d; best = s; }
      }
    }
    if (!best) return null;
    const cl = this.clusters[best.cl];
    const grp: 0 | 1 = Math.abs(fx * cl.ax + fz * cl.az) > 0.7 ? 0 : 1;
    return this.groupState(best.cl, grp);
  }

  /** Avanza el reloj y repinta las lentes de los semáforos (cuatro veces por segundo). */
  update(dt: number) {
    this.t += dt;
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    if (this.dirty) this.rebuild();
    const c = new THREE.Color();
    for (const t of this.tiles.values()) {
      if (!t.lens) continue;
      for (const s of t.sigs) {
        const st = this.groupState(s.cl, s.grp).state;
        const on = st === 'r' ? 0 : st === 'a' ? 1 : 2;
        for (let f = 0; f < 2; f++) for (let k = 0; k < 3; k++) {
          const v = (k === on ? LIT : DIM)[k];
          c.setRGB(v[0], v[1], v[2]);
          t.lens.setColorAt(s.idx * 6 + f * 3 + k, c);
        }
      }
      if (t.lens.instanceColor) t.lens.instanceColor.needsUpdate = true;
    }
  }
}
