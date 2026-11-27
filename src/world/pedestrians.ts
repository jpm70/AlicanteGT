import * as THREE from 'three';
import { heightAt } from './geo';
import { buildPedGeometry, F, patchPedMaterial, randomLook, type Look } from './pedlook';
import { Dogs, type DogItem } from './dogs';
import { nodeKey, type Traffic, type Way } from './traffic';
import type { Signals } from './signals';
import { stepDodge } from './dodge';

interface Ped {
  way: Way; dir: 1 | -1; s: number; side: 1 | -1; off: number;
  v: number; vwalk: number; x: number; z: number; fx: number; fz: number;
  phase: number; look: Look; pause: number; flee: number; bad: number; test?: boolean;
  cw?: Cross;
  /** desvío suave para apartarse del coche */
  ox?: number; oz?: number;
  /** si pasea un perro: semilla del perro (aspecto y recorrido) */
  dog?: number;
}

/** Peatón que cruza por un paso de cebra: espera en una acera, cruza cuando los coches de esa vía tienen rojo y vuelve a esperar. */
interface Cross { cx: number; cz: number; fx: number; fz: number; w: number; side: 1 | -1; a: number; go: boolean; timer: number; trips: number }

const MAX_PEDS = 200;
/** Peatón sentado en una terraza (fijo): posición del asiento, hacia dónde mira y aspecto. */
interface Seated { x: number; z: number; yaw: number; look: Look }
const WALK_V = 1.35;

/** Peatones por las aceras: siguen las calles de OSM por el lado de la acera, se paran un rato y se apartan del coche. */
export class Pedestrians {
  private geo = buildPedGeometry();
  private dogs: Dogs;
  private timeU = { value: 0 };
  private mat: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private inst: Record<string, THREE.InstancedBufferAttribute> = {};
  private peds: Ped[] = [];
  private crosswalks = new Map<string, number[][]>();
  private roadObst: { x: number; z: number }[] = [];
  private car = { x: 0, z: 0, hx: 0, hz: 1, v: 0 };
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private ay = new THREE.Vector3(0, 1, 0);
  enabled = true;

  constructor(private scene: THREE.Scene, private traffic: Traffic, private walkable: (x: number, z: number) => boolean, private signals: Signals | null = null) {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    patchPedMaterial(this.mat, this.timeU);
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_PEDS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (const name of ['aLook', 'aMisc']) this.inst[name] = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEDS * 4), 4);
    for (const [name, at] of Object.entries(this.inst)) this.geo.setAttribute(name, at);
    scene.add(this.mesh);
    this.dogs = new Dogs(scene);
  }

  private seated = new Map<string, Seated[]>();

  addCrosswalks(key: string, list: number[][]) { this.crosswalks.set(key, list); }

  /** Asientos ocupados de las terrazas de la tesela: [x, z, yaw]. */
  addSeats(key: string, list: number[][]) {
    this.seated.set(key, list.map(([x, z, yaw]) => {
      const look = randomLook();
      look.flags |= 1 << F.SEATED; look.flags &= ~((1 << F.BACKPACK) | (1 << F.BAG));
      return { x, z, yaw, look };
    }));
  }
  removeSeats(key: string) { this.seated.delete(key); }
  removeCrosswalks(key: string) { this.crosswalks.delete(key); }

  /** Peatones que están ahora en la calzada (los coches les ceden el paso). */
  onRoad(): { x: number; z: number }[] { return this.roadObst; }

  /** Posición de un cruzante: de una acera a la otra por la perpendicular de la vía. */
  private placeCross(p: Ped) {
    const c = p.cw!, half = c.w / 2 + 0.9;
    const nx = -c.fz, nz = c.fx;
    const s0 = c.side * half, s1 = -c.side * half;
    const o = s0 + (s1 - s0) * c.a;
    p.x = c.cx + nx * o; p.z = c.cz + nz * o;
    p.fx = -nx * c.side; p.fz = -nz * c.side;
  }

  private crossReady(c: Cross): boolean {
    const need = (c.w + 1.8) / WALK_V + 1.0;
    if (this.signals) {
      const st = this.signals.stateAt(c.cx, c.cz, c.fx, c.fz);
      if (st) return st.state === 'r' && st.left > need;
    }
    if (this.car.v > 3 && Math.hypot(this.car.x - c.cx, this.car.z - c.cz) < 24 && (c.cx - this.car.x) * this.car.hx + (c.cz - this.car.z) * this.car.hz > 0) return false;   // viene el coche del jugador: espera
    return !this.traffic.carWithin(c.cx, c.cz, 28);                         // sin semáforo: cruza cuando no vienen coches
  }

  private spawnCross(px: number, pz: number) {
    const all: number[][] = [];
    for (const l of this.crosswalks.values()) for (const c of l) all.push(c);
    for (let tries = 0; tries < 8 && all.length; tries++) {
      const c = all[Math.floor(Math.random() * all.length)];
      const d = Math.hypot(c[0] - px, c[1] - pz);
      if (d < 15 || d > 110) continue;
      if (this.peds.filter((q) => q.cw && Math.hypot(q.cw.cx - c[0], q.cw.cz - c[1]) < 3).length >= 2) continue;
      const side: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const p: Ped = {
        way: this.dummyWay, dir: 1, s: 0, side: 1, off: 0, v: 0, vwalk: WALK_V, x: 0, z: 0, fx: 0, fz: 1, phase: Math.random() * 6.28,
        look: randomLook(), pause: 0, flee: 0, bad: 0,
        cw: { cx: c[0], cz: c[1], fx: c[2], fz: c[3], w: c[4], side, a: 0, go: false, timer: Math.random() * 6, trips: 0 },
      };
      this.placeCross(p);
      this.peds.push(p);
      return;
    }
  }

  private dummyWay: Way = { id: -2, cls: 'x', ow: 0, w: 0, pts: [[0, 0], [1, 0]], cum: [0, 1], len: 1, tiles: new Set() };

  private place(p: Ped) {
    const w = p.way, cum = w.cum;
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < p.s) i++;
    const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
    const sl = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (p.s - cum[i]) / sl));
    const dx = (bx - ax) / sl * p.dir, dz = (bz - az) / sl * p.dir;
    p.fx = dx; p.fz = dz;
    const o = p.off * p.side;
    p.x = ax + (bx - ax) * t - dz * o;
    p.z = az + (bz - az) * t + dx * o;
  }

  /** Acera libre a este lado de la vía: prueba varios desplazamientos; devuelve el que cae en zona transitable. */
  private pickOffset(p: Ped): boolean {
    const base = p.way.w / 2;
    for (const e of [1.5, 1.1, 1.9, 0.8, 2.6, 3.5, 4.8, 6.5, 0.3]) {
      p.off = base + e;
      this.place(p);
      if (this.walkable(p.x, p.z)) return true;
    }
    return false;
  }

  private spawn(px: number, pz: number, ways: Way[]) {
    for (let tries = 0; tries < 12; tries++) {
      const w = ways[Math.floor(Math.random() * ways.length)];
      if (!w) return;
      const look = randomLook();
      const p: Ped = {
        way: w, dir: Math.random() < 0.5 ? 1 : -1, s: 2 + Math.random() * (w.len - 4), side: Math.random() < 0.5 ? 1 : -1, off: 0,
        v: 0, vwalk: (1.05 + Math.random() * 0.5) * look.speed, x: 0, z: 0, fx: 0, fz: 1, phase: Math.random() * 6.28,
        look, pause: Math.random() < 0.2 ? 2 + Math.random() * 8 : 0, flee: 0, bad: 0,
      };
      if (!this.pickOffset(p)) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < 20 || d > 120) continue;
      p.v = p.vwalk;
      if (!look.child && Math.random() < 0.13) p.dog = Math.random();
      this.peds.push(p);
      if (Math.random() < 0.24 && !look.child) {                                  // van en pareja: uno al lado del otro, al mismo paso
        const q: Ped = { ...p, look: randomLook(), phase: p.phase + 1.7, off: p.off + 0.75 * (p.side === 1 ? 1 : 1), vwalk: p.vwalk, pause: p.pause };
        q.vwalk = p.vwalk; q.v = p.v;
        this.place(q);
        if (this.walkable(q.x, q.z)) this.peds.push(q); else { q.off = p.off - 0.75; this.place(q); if (this.walkable(q.x, q.z)) this.peds.push(q); }
      }
      return;
    }
  }

  private turn(p: Ped): boolean {
    const w = p.way, end = p.dir > 0 ? w.pts[w.pts.length - 1] : w.pts[0];
    const { ends } = this.traffic.graph();
    const cands = (ends.get(nodeKey(end[0], end[1])) ?? []).filter((c) => c.way !== w);
    if (!cands.length) return false;
    let tot = 0;
    const wts = cands.map((c) => {
      const q = c.atStart ? c.way.pts[1] : c.way.pts[c.way.pts.length - 2];
      let dx = q[0] - end[0], dz = q[1] - end[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const wt = Math.exp(1.4 * (dx * p.fx + dz * p.fz)); tot += wt; return wt;
    });
    let r = Math.random() * tot, k = 0;
    while (k < cands.length - 1 && r > wts[k]) { r -= wts[k]; k++; }
    const c = cands[k];
    const ox = p.x, oz = p.z;
    p.way = c.way; p.dir = c.atStart ? 1 : -1; p.s = c.atStart ? 0.1 : c.way.len - 0.1;
    // lado de la nueva vía más cercano a donde estaba: sigue en la misma esquina sin cruzar la calzada
    let best: 1 | -1 = 1, bd = Infinity;
    for (const sd of [1, -1] as const) {
      p.side = sd; this.pickOffset(p);
      const d = Math.hypot(p.x - ox, p.z - oz);
      if (d < bd) { bd = d; best = sd; }
    }
    p.side = best;
    return this.pickOffset(p);
  }

  update(dt: number, px: number, pz: number, headingRad: number, carSpeed: number, density: number) {
    if (!this.enabled) { this.mesh.count = 0; this.dogs.sync([], 0); return; }
    this.timeU.value += dt;
    const { ways } = this.traffic.graph();
    const target = Math.round(60 * density);
    const nCross = this.peds.filter((q) => q.cw).length;
    if (nCross < Math.round(16 * density)) this.spawnCross(px, pz);
    if (this.peds.length - nCross < target && ways.length) { this.spawn(px, pz, ways); this.spawn(px, pz, ways); }
    this.roadObst = [];
    const hx = Math.sin(headingRad), hz = -Math.cos(headingRad);
    this.car = { x: px, z: pz, hx, hz, v: Math.abs(carSpeed) };
    const keep: Ped[] = [];
    for (const p of this.peds) {
      if (p.cw) {                                                    // peatón de paso de cebra
        const c = p.cw;
        if (Math.hypot(p.x - px, p.z - pz) > 150) continue;
        if (!c.go) {
          p.v += Math.max(-4 * dt, Math.min(2.5 * dt, 0 - p.v));
          c.timer -= dt;
          if (c.timer <= 0 && this.crossReady(c)) c.go = true;
        } else {
          p.v += Math.max(-4 * dt, Math.min(2.5 * dt, WALK_V * p.look.speed - p.v));
          c.a += (p.v * dt) / (c.w + 1.8);
          if (c.a >= 1) { c.a = 0; c.go = false; c.side = (c.side * -1) as 1 | -1; c.timer = 3 + Math.random() * 10; c.trips++; }
          if (c.a > 0.08 && c.a < 0.92) this.roadObst.push({ x: p.x, z: p.z });
        }
        this.placeCross(p);
        if (c.trips >= 3) continue;                                  // tras unas idas y venidas, se va
        keep.push(p);
        continue;
      }
      if (!p.test && (Math.hypot(p.x - px, p.z - pz) > 150 || (this.peds.length > target + 8 && Math.random() < 0.002))) continue;
      // se aparta si un coche rápido se le echa encima
      const dxc = p.x - px, dzc = p.z - pz, dc = Math.hypot(dxc, dzc);
      if (dc < 9 && carSpeed > 3 && (dxc * hx + dzc * hz) / (dc || 1) > 0.3 && p.flee <= 0) {
        p.flee = 1.6;
        const away = (p.fx * dxc + p.fz * dzc) >= 0 ? 1 : -1;
        p.dir = (p.dir * away) as 1 | -1;
      }
      if (p.flee > 0) p.flee -= dt;
      let target_v = p.flee > 0 ? 3.2 : p.pause > 0 ? 0 : p.vwalk;
      if (p.pause > 0) p.pause -= dt;
      else if (p.flee <= 0 && Math.random() < dt * 0.01) p.pause = 2 + Math.random() * 6;
      p.v += Math.max(-4 * dt, Math.min(2.5 * dt, target_v - p.v));
      if (!p.test) p.s += p.dir * p.v * dt;                      // los de prueba (?pedtest=1) caminan sin avanzar
      if (p.s < 0 || p.s > p.way.len) {
        if (!this.turn(p)) { p.dir = (p.dir * -1) as 1 | -1; p.s = Math.max(0.1, Math.min(p.way.len - 0.1, p.s)); }
      }
      this.place(p);
      if (!p.test && !this.walkable(p.x, p.z) && !this.pickOffset(p)) {
        if (++p.bad > 6) continue;
        p.dir = (p.dir * -1) as 1 | -1; p.s += p.dir * p.v * dt * 2;
        this.place(p);
      } else p.bad = 0;
      keep.push(p);
    }
    this.peds = keep;
    const n = Math.min(this.peds.length, MAX_PEDS);
    for (let i = 0; i < n; i++) {
      const p = this.peds[i], lk = p.look;
      const yaw = Math.atan2(p.fx, p.fz);
      this.tmpQ.setFromAxisAngle(this.ay, yaw);
      const dd = p as Ped & { ox: number; oz: number };
      if (dd.ox === undefined) { dd.ox = 0; dd.oz = 0; }
      stepDodge(dd, p.x, p.z, px, pz, hx, hz, carSpeed, dt, p.cw ? undefined : this.walkable);
      const qx = p.x + dd.ox, qz = p.z + dd.oz;
      this.tmpM.compose(this.tmpV.set(qx, heightAt(qx, qz) + 0.02, qz), this.tmpQ, this.tmpS.set(lk.scale[0], lk.scale[1], lk.scale[2]));
      this.mesh.setMatrixAt(i, this.tmpM);
      this.inst.aLook.setXYZW(i, lk.shirt, lk.pants, lk.skin, lk.hair);
      this.inst.aMisc.setXYZW(i, lk.acc, lk.flags, p.phase, p.v / 1.2);
    }
    let total = n;
    for (const list of this.seated.values()) {                      // gente sentada en las terrazas cercanas
      for (const s of list) {
        if (total >= MAX_PEDS) break;
        if ((s.x - px) ** 2 + (s.z - pz) ** 2 > 140 * 140) continue;
        const lk = s.look;
        this.tmpQ.setFromAxisAngle(this.ay, s.yaw);
        this.tmpM.compose(this.tmpV.set(s.x, heightAt(s.x, s.z) + 0.12, s.z), this.tmpQ, this.tmpS.set(lk.scale[0], lk.scale[1], lk.scale[2]));
        this.mesh.setMatrixAt(total, this.tmpM);
        this.inst.aLook.setXYZW(total, lk.shirt, lk.pants, lk.skin, lk.hair);
        this.inst.aMisc.setXYZW(total, lk.acc, lk.flags, 0, 0);
        total++;
      }
    }
    this.mesh.count = total;
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const at of Object.values(this.inst)) at.needsUpdate = true;
    // perros: junto a su dueño, del lado de la fachada, con un pequeño vaivén
    const items: DogItem[] = [];
    const tt = this.timeU.value;
    for (let i = 0; i < n; i++) {
      const p = this.peds[i];
      if (p.dog === undefined) continue;
      const rx = -p.fz, rz = p.fx, sd = p.cw ? 1 : p.side;
      const along = -0.5 + Math.sin(tt * 0.8 + p.dog * 40) * 0.45, lat = sd * (0.75 + Math.sin(tt * 1.3 + p.dog * 17) * 0.18);
      items.push({ x: p.x + p.fx * along + rx * lat, z: p.z + p.fz * along + rz * lat, fx: p.fx + rx * Math.sin(tt * 1.7 + p.dog * 9) * 0.25, fz: p.fz + rz * Math.sin(tt * 1.7 + p.dog * 9) * 0.25, v: Math.max(p.v, 0.2), seed: p.dog });
    }
    this.dogs.sync(items, dt);
  }

  /** Solo para depuración (?pedtest=1): 6 peatones andando en línea recta delante del coche. */
  debugAhead(px: number, pz: number, hx: number, hz: number) {
    const way: Way = { id: -1, cls: 'test', ow: 0, w: 0, pts: [[px + hx * 6, pz + hz * 6], [px + hx * 80, pz + hz * 80]], cum: [0, 74], len: 74, tiles: new Set() };
    for (let i = 0; i < 10; i++) {
      this.peds.push({ way, dir: 1, s: 4 + i * 2.2, side: i % 2 ? 1 : -1, off: 0.7 + (i % 3) * 0.9, v: 1.3, vwalk: 1.3, x: 0, z: 0, fx: 0, fz: 1, phase: i * 1.3,
        look: randomLook(), pause: 0, flee: 0, bad: 0, test: true, dog: i % 3 === 0 ? 0.1 + i * 0.07 : undefined });
    }
  }

  stats() { return { peds: this.peds.length, sample: this.peds.slice(0, 3).map((q) => [Math.round(q.x), Math.round(q.z), +q.v.toFixed(2)]) }; }

  dispose() {
    this.dogs.dispose();
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
