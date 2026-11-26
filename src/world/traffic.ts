import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, toLatLng, toLocal } from './geo';
import type { CarState } from '../types/game';

/** Vía conducible de OSM: [id, clase, sentido (0 doble, 1 único, 2 único inverso), ancho, puntos]. */
export type RoadRec = [number, string, number, number, number[][]];
/** Coche aparcado: [x, z, yaw, color, tipo (0 turismo, 1 furgoneta, 2 pequeño)]. */
export type ParkedRec = number[];

export interface Way { id: number; cls: string; ow: number; w: number; pts: number[][]; cum: number[]; len: number; tiles: Set<string> }
interface Agent {
  way: Way; dir: 1 | -1; s: number; v: number; vmax: number; lane: number;
  x: number; z: number; fx: number; fz: number; col: number; kind: number; hold: number;
}

/** Colores de carrocería: mucho blanco, gris, plata y negro, como en la calle. */
const PAINT = [0xf2f2f0, 0xf2f2f0, 0xe4e6e8, 0xb9bec3, 0xb9bec3, 0x6d7278, 0x2a2c30, 0x2a2c30, 0x9c2b2b, 0x2d4f8c, 0x5b6b4f, 0xc8b79a];
const KIND_SCALE: [number, number, number][] = [[1, 1, 1], [1.1, 1.42, 1.2], [0.92, 0.96, 0.86]];
const SPEED: Record<string, number> = { trunk: 15, primary: 13, secondary: 11.5, tertiary: 10, residential: 7.5, unclassified: 7.5, living_street: 4.5, primary_link: 8, secondary_link: 8, tertiary_link: 7 };
const MAX_AGENTS = 56;
const TARGET_AGENTS = 16;

const NODE = 1.5;
export const nodeKey = (x: number, z: number) => `${Math.round(x / NODE)},${Math.round(z / NODE)}`;

/** Superelipse (esquinas redondeadas) de n puntos con semiejes a, b y exponente e. */
function squircle(n: number, a: number, b: number, e: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    out.push([a * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), b * Math.sign(s) * Math.pow(Math.abs(s), 2 / e)]);
  }
  return out;
}

/** Une anillos de N puntos en una malla cerrada con normales suaves y caras hacia fuera. */
function loft(rings: number[][][], capStart: boolean, capEnd: boolean): THREE.BufferGeometry {
  const N = rings[0].length, pos: number[] = [], idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p[0], p[1], p[2]);
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = i * N + ((j + 1) % N), c = (i + 1) * N + ((j + 1) % N), d = (i + 1) * N + j;
    idx.push(a, b, c, a, c, d);
  }
  const cap = (ri: number, flip: boolean) => {
    const r = rings[ri];
    const cx = r.reduce((q, p) => q + p[0], 0) / N, cy = r.reduce((q, p) => q + p[1], 0) / N, cz = r.reduce((q, p) => q + p[2], 0) / N;
    const ci = pos.length / 3;
    pos.push(cx, cy, cz);
    for (let j = 0; j < N; j++) {
      const a = ri * N + j, b = ri * N + ((j + 1) % N);
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(rings.length - 1, true);
  // orientación: las caras deben mirar hacia fuera del centro de la pieza
  const n = pos.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  let score = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), M = new THREE.Vector3(cx, cy, cz);
  for (let i = 0; i < idx.length; i += 3) {
    A.fromArray(pos, idx[i] * 3); B.fromArray(pos, idx[i + 1] * 3); C.fromArray(pos, idx[i + 2] * 3);
    const nrm = B.clone().sub(A).cross(C.clone().sub(A));
    score += nrm.dot(A.clone().add(B).add(C).multiplyScalar(1 / 3).sub(M));
  }
  if (score < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const ng = g.toNonIndexed();
  ng.deleteAttribute('uv');
  return ng;
}

function flatBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const ng = g.toNonIndexed();
  ng.deleteAttribute('uv');
  return ng;
}

function colorVerts(g: THREE.BufferGeometry, c: number[]): THREE.BufferGeometry {
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function cyl(r: number, w: number, x: number, y: number, z: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, w, seg).rotateZ(Math.PI / 2).translate(x, y, z);
  const ng = g.toNonIndexed();
  ng.deleteAttribute('uv');
  return ng;
}

/**
 * Turismo modelado por secciones (eje largo +Z, 4,3 m): carrocería redondeada, cabina inclinada con cristales y techo,
 * ruedas con llanta, faros, pilotos y retrovisores. Devuelve la parte que se tiñe con la pintura y la que no.
 */
function buildCarGeometries(): { paint: THREE.BufferGeometry; trim: THREE.BufferGeometry } {
  const paint: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [];
  const NB = 18;
  // carrocería: estaciones (z, semiancho, suelo, línea de cintura / capó)
  const st: [number, number, number, number][] = [
    [-2.15, 0.62, 0.42, 0.8], [-2.05, 0.78, 0.34, 0.93], [-1.75, 0.87, 0.3, 0.99], [-1.0, 0.9, 0.27, 0.99],
    [0.0, 0.91, 0.27, 0.96], [0.9, 0.9, 0.27, 0.94], [1.5, 0.87, 0.28, 0.88], [1.95, 0.8, 0.32, 0.77], [2.15, 0.66, 0.4, 0.64],
  ];
  const rings = st.map(([z, hw, yb, yt]) => squircle(NB, hw, (yt - yb) / 2, 3.2).map(([x, y]) => [x, (yt + yb) / 2 + y, z]));
  paint.push(loft(rings, true, true));
  // cabina: anillos horizontales; el frente (parabrisas) se retrasa más rápido que la luna trasera
  const cab: [number, number, number, number][] = [   // y, z trasero, z delantero, semiancho
    [0.94, -1.78, 0.98, 0.79], [1.1, -1.62, 0.66, 0.75], [1.28, -1.3, 0.28, 0.68], [1.42, -0.98, -0.02, 0.6],
  ];
  const cr = cab.map(([y, zr, zf, hw]) => squircle(NB, (zf - zr) / 2, hw, 3).map(([a, b]) => [b, y, (zf + zr) / 2 + a]));
  trim.push(colorVerts(loft(cr, false, false), [0.05, 0.07, 0.09]));
  const roofR = cr[cr.length - 1];
  paint.push(loft([roofR, roofR.map(([x, y, z]) => [x * 0.96, y + 0.045, z])], false, true));
  // faros, pilotos, retrovisores, ruedas y matrícula
  trim.push(colorVerts(flatBox(1.0, 0.1, 0.06, 0, 0.5, 2.1), [0.04, 0.04, 0.04]));
  for (const sx of [-1, 1]) {
    trim.push(colorVerts(flatBox(0.36, 0.12, 0.08, sx * 0.62, 0.72, 2.07), [0.95, 0.95, 0.88]));
    trim.push(colorVerts(flatBox(0.36, 0.12, 0.08, sx * 0.64, 0.84, -2.1), [0.85, 0.06, 0.06]));
    paint.push(flatBox(0.12, 0.09, 0.2, sx * 0.97, 1.0, 0.82));
    for (const sz of [-1.38, 1.36]) {
      trim.push(colorVerts(cyl(0.33, 0.24, sx * 0.84, 0.33, sz, 14), [0.03, 0.03, 0.035]));
      trim.push(colorVerts(cyl(0.2, 0.26, sx * 0.845, 0.33, sz, 10), [0.62, 0.64, 0.66]));
    }
  }
  trim.push(colorVerts(flatBox(0.46, 0.11, 0.03, 0, 0.62, -2.17), [0.92, 0.92, 0.9]));
  return { paint: mergeGeometries(paint, false)!, trim: mergeGeometries(trim, false)! };
}

/** Pareja de mallas instanciadas (pintura teñida por coche + accesorios sin teñir) que comparten matrices. */
class CarSet {
  readonly paint: THREE.InstancedMesh;
  readonly trim: THREE.InstancedMesh;
  constructor(parts: { paint: THREE.BufferGeometry; trim: THREE.BufferGeometry }, mats: { paint: THREE.Material; trim: THREE.Material }, count: number) {
    this.paint = new THREE.InstancedMesh(parts.paint, mats.paint, count);
    this.trim = new THREE.InstancedMesh(parts.trim, mats.trim, count);
    for (const m of [this.paint, this.trim]) { m.frustumCulled = false; m.castShadow = true; }
  }
  set(i: number, m: THREE.Matrix4, color: THREE.Color) { this.paint.setMatrixAt(i, m); this.trim.setMatrixAt(i, m); this.paint.setColorAt(i, color); }
  get count() { return this.paint.count; }
  set count(n: number) { this.paint.count = n; this.trim.count = n; }
  flush() {
    for (const m of [this.paint, this.trim]) m.instanceMatrix.needsUpdate = true;
    if (this.paint.instanceColor) this.paint.instanceColor.needsUpdate = true;
  }
  addTo(scene: THREE.Scene) { scene.add(this.paint, this.trim); }
  removeFrom(scene: THREE.Scene) { scene.remove(this.paint, this.trim); }
  dispose() { this.paint.dispose(); this.trim.dispose(); }
}

/** Tráfico: coches aparcados fijos (instanciados por tesela) y coches que circulan por la red de OSM. */
export class Traffic {
  private ways = new Map<number, Way>();
  private wayList: Way[] = [];
  private ends = new Map<string, { way: Way; atStart: boolean }[]>();
  private dirty = true;
  private agents: Agent[] = [];
  private parked = new Map<string, CarSet>();
  private geo = buildCarGeometries();
  private mats = {
    paint: new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.55 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 }),
  };
  private mesh: CarSet;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private rnd = Math.random;
  enabled = true;

  constructor(private scene: THREE.Scene) {
    this.mesh = new CarSet(this.geo, this.mats, MAX_AGENTS);
    this.mesh.count = 0;
    this.mesh.addTo(scene);
  }

  private pose(m: THREE.Matrix4, x: number, z: number, fx: number, fz: number, kind: number) {
    const yaw = Math.atan2(fx, fz);
    const y0 = heightAt(x, z);
    const yf = heightAt(x + fx * 1.8, z + fz * 1.8), yb = heightAt(x - fx * 1.8, z - fz * 1.8);
    this.tmpE.set(-Math.atan2(yf - yb, 3.6), yaw, 0);
    this.tmpQ.setFromEuler(this.tmpE);
    const k = KIND_SCALE[kind] ?? KIND_SCALE[0];
    m.compose(this.tmpV.set(x, y0 + 0.03, z), this.tmpQ, this.tmpS.set(k[0], k[1], k[2]));
  }

  addTile(key: string, roads: RoadRec[], parked: ParkedRec[]) {
    for (const [id, cls, ow, w, pts] of roads) {
      let way = this.ways.get(id);
      if (!way) {
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        way = { id, cls, ow, w, pts, cum, len: cum[cum.length - 1], tiles: new Set() };
        if (way.len < 6) continue;
        this.ways.set(id, way);
        this.dirty = true;
      }
      way.tiles.add(key);
    }
    if (parked.length) {
      const im = new CarSet(this.geo, this.mats, parked.length);
      parked.forEach(([x, z, yaw, col, kind], i) => {
        this.pose(this.tmpM, x, z, Math.sin(yaw), Math.cos(yaw), kind);
        im.set(i, this.tmpM, this.tmpC.setHex(PAINT[col % PAINT.length]));
      });
      im.flush();
      im.addTo(this.scene);
      this.parked.set(key, im);
    }
  }

  removeTile(key: string) {
    const im = this.parked.get(key);
    if (im) { im.removeFrom(this.scene); im.dispose(); this.parked.delete(key); }
    for (const [id, way] of this.ways) {
      if (way.tiles.delete(key) && way.tiles.size === 0) { this.ways.delete(id); this.dirty = true; }
    }
  }

  private rebuild() {
    this.wayList = [...this.ways.values()].filter((w) => w.len > 14);
    this.ends.clear();
    for (const w of this.ways.values()) {
      const a = w.pts[0], b = w.pts[w.pts.length - 1];
      for (const [p, atStart] of [[a, true], [b, false]] as [number[], boolean][]) {
        const k = nodeKey(p[0], p[1]);
        const arr = this.ends.get(k);
        const rec = { way: w, atStart };
        if (arr) arr.push(rec); else this.ends.set(k, [rec]);
      }
    }
    this.agents = this.agents.filter((a) => this.ways.has(a.way.id));
    this.dirty = false;
  }

  /** Posición y sentido de marcha en la vía a distancia s (con el desplazamiento lateral del carril). */
  private place(a: Agent) {
    const w = a.way, cum = w.cum;
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < a.s) i++;
    const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
    const sl = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (a.s - cum[i]) / sl));
    const dx = (bx - ax) / sl * a.dir, dz = (bz - az) / sl * a.dir;
    a.fx = dx; a.fz = dz;
    a.x = ax + (bx - ax) * t - dz * a.lane;
    a.z = az + (bz - az) * t + dx * a.lane;
  }

  private laneFor(w: Way): number {
    if (w.ow === 0) return w.w < 8 ? 0.85 : w.w / 4;
    return w.w >= 8 ? (this.rnd() < 0.5 ? -1 : 1) * w.w / 4 : 0;
  }

  private spawn(px: number, pz: number, hx: number, hz: number) {
    for (let tries = 0; tries < 10; tries++) {
      const w = this.wayList[Math.floor(this.rnd() * this.wayList.length)];
      if (!w) return;
      const dir: 1 | -1 = w.ow === 1 ? 1 : w.ow === 2 ? -1 : this.rnd() < 0.5 ? 1 : -1;
      const a: Agent = {
        way: w, dir, s: 4 + this.rnd() * (w.len - 8), v: 0, vmax: (SPEED[w.cls] ?? 7) * (0.8 + this.rnd() * 0.3), lane: this.laneFor(w),
        x: 0, z: 0, fx: 0, fz: 1, col: Math.floor(this.rnd() * PAINT.length), kind: this.rnd() < 0.78 ? 0 : this.rnd() < 0.5 ? 1 : 2, hold: 0,
      };
      this.place(a);
      const dx = a.x - px, dz = a.z - pz, d = Math.hypot(dx, dz);
      if (d < 70 || d > 200) continue;
      if (d < 130 && (dx * hx + dz * hz) / d > 0.35) continue;             // no aparecen a la vista, delante del coche
      if (this.agents.some((o) => Math.hypot(o.x - a.x, o.z - a.z) < 14)) continue;
      a.v = a.vmax * 0.7;
      this.agents.push(a);
      return;
    }
  }

  /** Elige la vía de salida en el extremo al que llega el coche; false = callejón sin salida (se da la vuelta o desaparece). */
  private turn(a: Agent): boolean {
    const w = a.way;
    const end = a.dir > 0 ? w.pts[w.pts.length - 1] : w.pts[0];
    const cands = (this.ends.get(nodeKey(end[0], end[1])) ?? []).filter((c) => c.way !== w && (c.atStart ? c.way.ow !== 2 : c.way.ow !== 1));
    if (!cands.length) return false;
    let tot = 0;
    const wts = cands.map((c) => {
      const p = c.way.pts, q = c.atStart ? p[1] : p[p.length - 2];
      let dx = q[0] - end[0], dz = q[1] - end[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const wt = Math.exp(2.2 * (dx * a.fx + dz * a.fz));
      tot += wt; return wt;
    });
    let r = this.rnd() * tot, k = 0;
    while (k < cands.length - 1 && r > wts[k]) { r -= wts[k]; k++; }
    const c = cands[k];
    a.way = c.way; a.dir = c.atStart ? 1 : -1; a.s = c.atStart ? 0.05 : c.way.len - 0.05; a.lane = this.laneFor(c.way); a.vmax = (SPEED[c.way.cls] ?? 7) * (0.8 + this.rnd() * 0.3);
    return true;
  }

  /** Red de vías cargada (para los peatones): vías y extremos por nodo. */
  graph(): { ways: Way[]; ends: Map<string, { way: Way; atStart: boolean }[]> } {
    if (this.dirty) this.rebuild();
    return { ways: this.wayList, ends: this.ends };
  }

  update(dt: number, px: number, pz: number, headingRad: number, playerSpeed: number, density = 1) {
    if (!this.enabled) { this.mesh.count = 0; return; }
    if (this.dirty) this.rebuild();
    const hx = Math.sin(headingRad), hz = -Math.cos(headingRad);
    if (this.agents.length < Math.round(TARGET_AGENTS * density) && this.wayList.length) this.spawn(px, pz, hx, hz);
    const keep: Agent[] = [];
    for (const a of this.agents) {
      if (!this.ways.has(a.way.id)) continue;
      if (Math.hypot(a.x - px, a.z - pz) > 250) continue;
      // objetivo de velocidad: la de su vía, más lenta al llegar a un cruce y frenando ante lo que tenga delante
      const toEnd = a.dir > 0 ? a.way.len - a.s : a.s;
      let target = a.vmax * (toEnd < 16 ? 0.4 + 0.6 * (toEnd / 16) : 1);
      const reach = 6 + a.v * 0.9;
      for (const o of this.agents) {
        if (o === a) continue;
        const rx = o.x - a.x, rz = o.z - a.z, along = rx * a.fx + rz * a.fz;
        if (along <= 0 || along > reach) continue;
        const lat = Math.abs(rx * -a.fz + rz * a.fx);
        if (lat < 1.15 && o.fx * a.fx + o.fz * a.fz > 0.3) target = Math.min(target, along < 5.2 ? 0 : Math.max(0, o.v + (along - 5.2) * 0.7));
      }
      {
        const rx = px - a.x, rz = pz - a.z, along = rx * a.fx + rz * a.fz;
        if (along > 0 && along < reach + 3 && Math.abs(rx * -a.fz + rz * a.fx) < 1.7) target = Math.min(target, along < 6 ? 0 : Math.max(0, (along - 6) * 0.8));
      }
      if (a.hold > 0) { a.hold -= dt; target = 0; }
      a.v += Math.max(-8 * dt, Math.min(3 * dt, target - a.v));
      a.s += a.dir * a.v * dt;
      if (a.s < 0 || a.s > a.way.len) {
        if (!this.turn(a)) {
          if (a.way.ow === 0) { a.dir = (a.dir * -1) as 1 | -1; a.s = Math.max(0.1, Math.min(a.way.len - 0.1, a.s)); a.lane = this.laneFor(a.way); }
          else continue;
        }
      }
      this.place(a);
      keep.push(a);
    }
    this.agents = keep;
    let n = 0;
    for (const a of this.agents) {
      this.pose(this.tmpM, a.x, a.z, a.fx, a.fz, a.kind);
      this.mesh.set(n, this.tmpM, this.tmpC.setHex(PAINT[a.col]));
      n++;
    }
    this.mesh.count = n;
    this.mesh.flush();
    void playerSpeed;
  }

  /** Choque del coche del jugador con los que circulan: lo empuja fuera, le quita velocidad y frena al otro. Devuelve el impacto [0..1]. */
  collide(state: CarState): number {
    if (!this.enabled || !this.agents.length) return 0;
    const l = toLocal(state.lat, state.lng);
    const h = (state.headingDeg * Math.PI) / 180;
    const pfx = Math.sin(h), pfz = -Math.cos(h);
    let cx = l.x, cz = l.z, impact = 0;
    for (const a of this.agents) {
      if (Math.abs(a.x - cx) > 6 || Math.abs(a.z - cz) > 6) continue;
      for (const po of [-1.7, 0, 1.7]) for (const ao of [-1.3, 0, 1.3]) {
        const ax = cx + pfx * po, az = cz + pfz * po;
        const bx = a.x + a.fx * ao, bz = a.z + a.fz * ao;
        const dx = ax - bx, dz = az - bz, d = Math.hypot(dx, dz), min = 1.9;
        if (d < min && d > 1e-4) {
          const push = (min - d) * 0.6;
          cx += (dx / d) * push; cz += (dz / d) * push;
          impact = Math.max(impact, Math.min(1, Math.abs(state.speedMps - a.v) / 18));
          a.v *= 0.4; a.hold = Math.max(a.hold, 0.8);
        }
      }
    }
    if (cx !== l.x || cz !== l.z) {
      const ll = toLatLng(cx, cz);
      state.lat = ll.lat; state.lng = ll.lng;
      if (impact > 0.05) state.speedMps *= 1 - Math.min(0.7, impact * 0.8);
    }
    return impact;
  }

  stats() { return { ways: this.ways.size, usable: this.wayList.length, agents: this.agents.length, parkedTiles: this.parked.size, parked: [...this.parked.values()].reduce((n, m) => n + m.count, 0), sample: this.agents.slice(0, 3).map((q) => [Math.round(q.x), Math.round(q.z), +q.v.toFixed(1)]) }; }

  dispose() {
    this.mesh.removeFrom(this.scene);
    for (const im of this.parked.values()) { im.removeFrom(this.scene); im.dispose(); }
    this.parked.clear();
    this.mesh.dispose();
    this.geo.paint.dispose(); this.geo.trim.dispose();
    this.mats.paint.dispose(); this.mats.trim.dispose();
  }
}
