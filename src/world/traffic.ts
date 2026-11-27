import * as THREE from 'three';
import { heightAt, toLatLng, toLocal } from './geo';
import type { CarState } from '../types/game';
import type { Signals } from './signals';
import { CarSet, VARIANT_IDS, VARIANT_LEN, VehicleLib, type VariantId } from './vehicles';

/** Vía conducible de OSM: [id, clase, sentido (0 doble, 1 único, 2 único inverso), ancho, puntos]. */
export type RoadRec = [number, string, number, number, number[][]];
/** Coche aparcado: [x, z, yaw, color, tipo (0 turismo, 1 furgoneta, 2 pequeño)]. */
export type ParkedRec = number[];

export interface Way { id: number; cls: string; ow: number; w: number; pts: number[][]; cum: number[]; len: number; tiles: Set<string> }
interface Agent {
  way: Way; dir: 1 | -1; s: number; v: number; vmax: number; lane: number;
  x: number; z: number; fx: number; fz: number; col: number; variant: VariantId; len: number; hold: number;
}

/** Colores de carrocería: mucho blanco, gris, plata y negro, como en la calle. */
const PAINT = [0xf2f2f0, 0xf2f2f0, 0xe4e6e8, 0xb9bec3, 0xb9bec3, 0x6d7278, 0x2a2c30, 0x2a2c30, 0x9c2b2b, 0x2d4f8c, 0x5b6b4f, 0xc8b79a];
const TAXI_PAINT = 0xf4f4f0;
const BUS_PAINT = 0x1f4e9a;
/** Variante de los coches aparcados según el tipo guardado en la tesela (0 turismo, 1 furgoneta, 2 pequeño) y el color. */
const PARKED_CAR: VariantId[] = ['sedan', 'hatch', 'suv', 'hatch', 'sedan', 'suv', 'hatch', 'sedan', 'suv', 'hatch', 'sedan', 'hatch'];
const SPEED: Record<string, number> = { trunk: 15, primary: 13, secondary: 11.5, tertiary: 10, residential: 7.5, unclassified: 7.5, living_street: 4.5, primary_link: 8, secondary_link: 8, tertiary_link: 7 };
const MAX_AGENTS = 56;
const TARGET_AGENTS = 16;
/** Capacidad de cada variante en circulación. */
const CAP: Record<VariantId, number> = { sedan: 40, hatch: 40, suv: 40, van: 16, taxi: 16, bus: 8 };

const NODE = 1.5;
export const nodeKey = (x: number, z: number) => `${Math.round(x / NODE)},${Math.round(z / NODE)}`;

/** Tráfico: coches aparcados fijos (instanciados por tesela) y vehículos que circulan por la red de OSM. */
export class Traffic {
  private ways = new Map<number, Way>();
  private wayList: Way[] = [];
  private ends = new Map<string, { way: Way; atStart: boolean }[]>();
  private dirty = true;
  private agents: Agent[] = [];
  private parked = new Map<string, CarSet[]>();
  private lib = new VehicleLib();
  private sets = new Map<VariantId, CarSet>();
  private beams: THREE.InstancedMesh;
  private beamMat: THREE.MeshBasicMaterial;
  private lightLevel = 0;
  private signals: Signals | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private tmpC = new THREE.Color();
  private rnd = Math.random;
  enabled = true;

  constructor(private scene: THREE.Scene) {
    for (const v of VARIANT_IDS) {
      const s = this.lib.makeSet(v, CAP[v], false);
      s.count = 0;
      s.addTo(scene);
      this.sets.set(v, s);
    }
    // haces de los faros sobre el asfalto (aditivos, solo de noche y al atardecer)
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 128;
    const c2 = cv.getContext('2d')!;
    const g = c2.createLinearGradient(0, 128, 0, 0);
    g.addColorStop(0, 'rgba(255,240,200,0.9)'); g.addColorStop(0.5, 'rgba(255,235,190,0.35)'); g.addColorStop(1, 'rgba(255,230,180,0)');
    c2.fillStyle = g; c2.fillRect(0, 0, 64, 128);
    const mask = c2.createLinearGradient(0, 0, 64, 0);
    mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(0.5, 'rgba(0,0,0,0)'); mask.addColorStop(1, 'rgba(0,0,0,1)');
    c2.globalCompositeOperation = 'destination-out';
    c2.fillStyle = mask; c2.globalAlpha = 0.85; c2.fillRect(0, 0, 64, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.beamMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.beams = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.6, 12).rotateX(-Math.PI / 2).translate(0, 0, 8.5), this.beamMat, MAX_AGENTS);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.renderOrder = 6;
    scene.add(this.beams);
  }

  setSignals(s: Signals) { this.signals = s; }

  /** ¿Hay algún coche en marcha a menos de r metros de (x, z)? */
  carWithin(x: number, z: number, r: number): boolean {
    return this.agents.some((a) => Math.hypot(a.x - x, a.z - z) < r);
  }

  /** Nivel de luz artificial (0 día, 0,35 atardecer, 1 noche): faros y pilotos de los coches en marcha, haces sobre el asfalto. */
  setLightLevel(lv: number) {
    this.lightLevel = lv;
    this.lib.setLightLevel(lv);
    this.beamMat.opacity = 0.55 * lv;
    this.beams.visible = lv > 0;
  }

  /** Coloca un vehículo: sigue la pendiente del terreno (cabeceo según la distancia entre ejes). */
  private pose(m: THREE.Matrix4, x: number, z: number, fx: number, fz: number, half = 1.8) {
    const yaw = Math.atan2(fx, fz);
    const y0 = heightAt(x, z);
    const yf = heightAt(x + fx * half, z + fz * half), yb = heightAt(x - fx * half, z - fz * half);
    this.tmpE.set(-Math.atan2(yf - yb, half * 2), yaw, 0);
    this.tmpQ.setFromEuler(this.tmpE);
    m.compose(this.tmpV.set(x, y0 + 0.03, z), this.tmpQ, this.tmpS);
  }

  /** Pequeña variación de tono por coche (no hay dos iguales). */
  private tone(hex: number, key: number): THREE.Color {
    this.tmpC.setHex(hex);
    const k = 0.9 + 0.14 * (((Math.sin(key * 12.9898) * 43758.5453) % 1 + 1) % 1);
    return this.tmpC.multiplyScalar(k);
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
      const groups = new Map<VariantId, { i: number; rec: number[] }[]>();
      parked.forEach((rec, i) => {
        const [, , , col, kind] = rec;
        const v: VariantId = kind === 1 ? 'van' : kind === 2 ? 'hatch' : PARKED_CAR[(col + i) % PARKED_CAR.length];
        const arr = groups.get(v);
        if (arr) arr.push({ i, rec }); else groups.set(v, [{ i, rec }]);
      });
      const sets: CarSet[] = [];
      for (const [v, list] of groups) {
        const set = this.lib.makeSet(v, list.length, true);
        list.forEach(({ i, rec }, j) => {
          const [x, z, yaw, col] = rec;
          this.pose(this.tmpM, x, z, Math.sin(yaw), Math.cos(yaw), v === 'van' ? 2 : 1.8);
          set.set(j, this.tmpM, this.tone(PAINT[col % PAINT.length], i + col));
        });
        set.flush();
        set.addTo(this.scene);
        sets.push(set);
      }
      this.parked.set(key, sets);
    }
  }

  removeTile(key: string) {
    const sets = this.parked.get(key);
    if (sets) { for (const s of sets) { s.removeFrom(this.scene); s.dispose(); } this.parked.delete(key); }
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

  /** Variante al azar con pesos realistas; el autobús solo en vías principales y largas. */
  private pickVariant(w: Way): VariantId {
    const r = this.rnd();
    const main = (w.cls === 'primary' || w.cls === 'secondary' || w.cls === 'tertiary') && w.len > 60;
    if (main && r < 0.1) return 'bus';
    if (r < 0.1) return 'taxi';
    if (r < 0.38) return 'hatch';
    if (r < 0.62) return 'sedan';
    if (r < 0.86) return 'suv';
    return 'van';
  }

  private spawn(px: number, pz: number, hx: number, hz: number) {
    for (let tries = 0; tries < 10; tries++) {
      const w = this.wayList[Math.floor(this.rnd() * this.wayList.length)];
      if (!w) return;
      const dir: 1 | -1 = w.ow === 1 ? 1 : w.ow === 2 ? -1 : this.rnd() < 0.5 ? 1 : -1;
      const variant = this.pickVariant(w);
      if (this.agents.filter((q) => q.variant === variant).length >= CAP[variant]) continue;
      const a: Agent = {
        way: w, dir, s: 4 + this.rnd() * (w.len - 8), v: 0, vmax: (SPEED[w.cls] ?? 7) * (0.8 + this.rnd() * 0.3) * (variant === 'bus' ? 0.85 : 1), lane: this.laneFor(w),
        x: 0, z: 0, fx: 0, fz: 1, col: Math.floor(this.rnd() * PAINT.length), variant, len: VARIANT_LEN[variant], hold: 0,
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
    a.way = c.way; a.dir = c.atStart ? 1 : -1; a.s = c.atStart ? 0.05 : c.way.len - 0.05; a.lane = this.laneFor(c.way);
    a.vmax = (SPEED[c.way.cls] ?? 7) * (0.8 + this.rnd() * 0.3) * (a.variant === 'bus' ? 0.85 : 1);
    return true;
  }

  /** Red de vías cargada (para los peatones): vías y extremos por nodo. */
  graph(): { ways: Way[]; ends: Map<string, { way: Way; atStart: boolean }[]> } {
    if (this.dirty) this.rebuild();
    return { ways: this.wayList, ends: this.ends };
  }

  update(dt: number, px: number, pz: number, headingRad: number, playerSpeed: number, density = 1, obstacles: { x: number; z: number }[] = []) {
    if (!this.enabled) { for (const s of this.sets.values()) s.count = 0; return; }
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
      const reach = 6 + a.len * 0.5 + a.v * 0.9;
      for (const o of this.agents) {
        if (o === a) continue;
        const rx = o.x - a.x, rz = o.z - a.z, along = rx * a.fx + rz * a.fz;
        if (along <= 0 || along > reach + o.len * 0.5) continue;
        const lat = Math.abs(rx * -a.fz + rz * a.fx);
        const gap = (a.len + o.len) / 2 + 1.0;
        if (lat < 1.15 && o.fx * a.fx + o.fz * a.fz > 0.3) target = Math.min(target, along < gap ? 0 : Math.max(0, o.v + (along - gap) * 0.7));
      }
      {
        const rx = px - a.x, rz = pz - a.z, along = rx * a.fx + rz * a.fz;
        const stop = a.len / 2 + 2.2;
        if (along > 0 && along < reach + 3 && Math.abs(rx * -a.fz + rz * a.fx) < 1.7) target = Math.min(target, along < stop ? 0 : Math.max(0, (along - stop) * 0.8));
      }
      // semáforo del cruce al que llega: rojo = para antes de la línea; ámbar = para si le da tiempo
      if (this.signals && toEnd < 26) {
        const end = a.dir > 0 ? a.way.pts[a.way.pts.length - 1] : a.way.pts[0];
        const st = this.signals.stateAt(end[0], end[1], a.fx, a.fz);
        if (st && (st.state === 'r' || (st.state === 'a' && toEnd > 5 + a.v * 0.6))) target = Math.min(target, Math.max(0, toEnd - 4.0 - a.len * 0.3) * 0.9);
      }
      // peatones cruzando por la calzada
      for (const o of obstacles) {
        const rx = o.x - a.x, rz = o.z - a.z, along = rx * a.fx + rz * a.fz;
        const stop = a.len / 2 + 1.6;
        if (along > 0 && along < reach + 4 && Math.abs(rx * -a.fz + rz * a.fx) < 2.4) target = Math.min(target, along < stop ? 0 : Math.max(0, (along - stop) * 0.7));
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
    const counts = new Map<VariantId, number>();
    for (const a of this.agents) {
      const set = this.sets.get(a.variant)!;
      const n = counts.get(a.variant) ?? 0;
      if (n >= CAP[a.variant]) continue;
      this.pose(this.tmpM, a.x, a.z, a.fx, a.fz, a.variant === 'bus' ? 4 : 1.8);
      const hex = a.variant === 'taxi' ? TAXI_PAINT : a.variant === 'bus' ? BUS_PAINT : PAINT[a.col];
      set.set(n, this.tmpM, a.variant === 'taxi' || a.variant === 'bus' ? this.tmpC.setHex(hex) : this.tone(hex, a.col + a.way.id));
      counts.set(a.variant, n + 1);
    }
    for (const v of VARIANT_IDS) { const s = this.sets.get(v)!; s.count = counts.get(v) ?? 0; s.flush(); }
    if (this.lightLevel > 0) {
      const n = Math.min(this.agents.length, MAX_AGENTS);
      for (let i = 0; i < n; i++) {
        const a = this.agents[i];
        const yaw = Math.atan2(a.fx, a.fz);
        this.tmpQ.setFromAxisAngle(this.tmpV.set(0, 1, 0), yaw);
        this.tmpM.compose(this.tmpV.set(a.x + a.fx * (a.len / 2 - 2.1), heightAt(a.x, a.z) + 0.12, a.z + a.fz * (a.len / 2 - 2.1)), this.tmpQ, this.tmpS);
        this.beams.setMatrixAt(i, this.tmpM);
      }
      this.beams.count = n;
      this.beams.instanceMatrix.needsUpdate = true;
    }
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
      if (Math.abs(a.x - cx) > 9 || Math.abs(a.z - cz) > 9) continue;
      const bus = a.variant === 'bus';
      const offs = bus ? [-4.4, -1.5, 1.5, 4.4] : [-a.len * 0.3, 0, a.len * 0.3];
      const min = bus ? 2.35 : 1.9;
      for (const po of [-1.7, 0, 1.7]) for (const ao of offs) {
        const ax = cx + pfx * po, az = cz + pfz * po;
        const bx = a.x + a.fx * ao, bz = a.z + a.fz * ao;
        const dx = ax - bx, dz = az - bz, d = Math.hypot(dx, dz);
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

  /** Solo pruebas (?cartest=1): una fila con un vehículo de cada variante delante del coche, para verlos de cerca. */
  debugShowroom(px: number, pz: number, hx: number, hz: number) {
    const rx = -hz, rz = hx;
    VARIANT_IDS.forEach((v, i) => {
      const set = this.lib.makeSet(v, 1, false);
      const side = (i - 2.5) * 6.2;
      const dist = 16 + (v === 'bus' ? 4 : 0);
      this.pose(this.tmpM, px + hx * dist + rx * side, pz + hz * dist + rz * side, -hx, -hz, 1.8);
      set.set(0, this.tmpM, this.tmpC.setHex(v === 'taxi' ? TAXI_PAINT : v === 'bus' ? BUS_PAINT : PAINT[(i * 3) % PAINT.length]));
      set.flush(); set.addTo(this.scene);
    });
  }

  stats() {
    return {
      ways: this.ways.size, usable: this.wayList.length, agents: this.agents.length, parkedTiles: this.parked.size,
      parked: [...this.parked.values()].reduce((n, sets) => n + sets.reduce((m, s) => m + s.count, 0), 0),
      variants: Object.fromEntries(VARIANT_IDS.map((v) => [v, this.agents.filter((q) => q.variant === v).length])),
      sample: this.agents.slice(0, 3).map((q) => [Math.round(q.x), Math.round(q.z), +q.v.toFixed(1)]),
    };
  }

  dispose() {
    for (const s of this.sets.values()) { s.removeFrom(this.scene); s.dispose(); }
    this.scene.remove(this.beams); this.beams.geometry.dispose(); this.beamMat.dispose();
    for (const sets of this.parked.values()) for (const s of sets) { s.removeFrom(this.scene); s.dispose(); }
    this.parked.clear();
    this.lib.dispose();
  }
}
