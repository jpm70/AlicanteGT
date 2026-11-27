import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from './geo';
import { nodeKey, type Traffic, type Way } from './traffic';
import type { Signals } from './signals';
import { PALETTE, PAL_OFF, randomLook } from './pedlook';

const MAX_CYC = 24;

interface Cyc {
  way: Way; dir: 1 | -1; s: number; v: number; vmax: number; lane: number; laneT: number;
  x: number; z: number; fx: number; fz: number;
  shirt: number; pants: number; skin: number; hasHelmet: boolean; phase: number; wheelAng: number; test?: boolean;
}

// aMeta = (parte, tipo, signo) · aMeta2 = (pivote y, pivote z, 0)
// parte: 0 fijo · 1 camiseta · 2 pantalón · 3 color de la bici · 4 piel · 5 casco
// tipo : 0 estático · 1 rueda (gira) · 2 muslo · 3 pantorrilla y pie (pedalean)
function part(g: THREE.BufferGeometry, c: number, o: { part?: number; kind?: number; limb?: number; py?: number; pz?: number }): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3), m1 = new Float32Array(n * 3), m2 = new Float32Array(n * 3);
  const k = new THREE.Color(c);
  for (let i = 0; i < n; i++) {
    col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b;
    m1[i * 3] = o.part ?? 0; m1[i * 3 + 1] = o.kind ?? 0; m1[i * 3 + 2] = o.limb ?? 0;
    m2[i * 3] = o.py ?? 0; m2[i * 3 + 1] = o.pz ?? 0;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aMeta', new THREE.BufferAttribute(m1, 3));
  ng.setAttribute('aMeta2', new THREE.BufferAttribute(m2, 3));
  return ng;
}

/** Cilindro entre dos puntos. */
function seg(a: [number, number, number], b: [number, number, number], r: number): THREE.BufferGeometry {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  g.applyQuaternion(q);
  const m = A.clone().add(B).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

function buildCyclistGeometry(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const R = 0.33, RY = 0.35, ZR = -0.55, ZF = 0.55;
  for (const z of [ZR, ZF]) {
    P.push(part(new THREE.TorusGeometry(R, 0.026, 6, 22).rotateY(Math.PI / 2).translate(0, RY, z), 0x16161a, { kind: 1, py: RY, pz: z }));           // neumático
    for (const ang of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const sp = new THREE.BoxGeometry(0.012, R * 2 - 0.04, 0.012).rotateX(ang).translate(0, RY, z);
      P.push(part(sp, 0xa8a8ae, { kind: 1, py: RY, pz: z }));                                                                                      // radios
    }
  }
  // cuadro, horquilla, manillar y sillín
  const bike = (a: [number, number, number], b: [number, number, number], r = 0.016) => P.push(part(seg(a, b, r), 0, { part: 3 }));
  bike([0, 0.93, -0.3], [0, 0.95, 0.38], 0.018);        // tubo superior
  bike([0, 0.95, 0.38], [0, 0.5, 0.05], 0.02);          // tubo diagonal
  bike([0, 0.93, -0.3], [0, 0.5, 0.05], 0.018);         // tubo del sillín
  bike([0, 0.5, 0.05], [0, RY, ZR], 0.015);             // vaina
  bike([0, 0.93, -0.3], [0, RY, ZR], 0.014);
  bike([0, 0.95, 0.38], [0, RY, ZF], 0.016);            // horquilla
  P.push(part(seg([-0.22, 1.02, 0.4], [0.22, 1.02, 0.4], 0.013), 0x1b1b1f, {}));          // manillar
  P.push(part(new THREE.BoxGeometry(0.1, 0.04, 0.2).translate(0, 0.97, -0.32), 0x1b1b1f, {}));  // sillín
  // ciclista: torso inclinado, cabeza, casco y brazos al manillar
  const HIP: [number, number, number] = [0, 1.0, -0.3], SH: [number, number, number] = [0, 1.42, 0.12];
  P.push(part(seg(HIP, SH, 0.125), 0, { part: 1 }));
  P.push(part(new THREE.SphereGeometry(0.105, 10, 8).translate(0, 1.58, 0.22), 0, { part: 4 }));
  P.push(part(new THREE.SphereGeometry(0.118, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.05, 1.15).translate(0, 1.6, 0.21), 0, { part: 5 }));
  for (const sx of [-1, 1]) {
    P.push(part(seg([sx * 0.19, 1.38, 0.1], [sx * 0.22, 1.02, 0.4], 0.04), 0, { part: 1 }));
    P.push(part(new THREE.SphereGeometry(0.04, 6, 5).translate(sx * 0.22, 1.02, 0.4), 0, { part: 4 }));
    // piernas: muslo (pivote en la cadera) y pantorrilla con pie (siguen al muslo y giran en la rodilla)
    const knee: [number, number, number] = [sx * 0.11, 0.74, 0.0], foot: [number, number, number] = [sx * 0.11, 0.36, 0.02];
    P.push(part(seg([sx * 0.11, 1.0, -0.3], knee, 0.07), 0, { part: 2, kind: 2, limb: sx, py: 1.0, pz: -0.3 }));
    P.push(part(seg(knee, foot, 0.055), 0, { part: 2, kind: 3, limb: sx, py: 0.74, pz: 0.0 }));
    P.push(part(new THREE.BoxGeometry(0.1, 0.06, 0.22).translate(sx * 0.11, 0.33, 0.07), 0x1a1a1d, { kind: 3, limb: sx, py: 0.74, pz: 0.0 }));
  }
  return mergeGeometries(P, false)!;
}

/** Ciclistas por la calzada, pegados al bordillo: respetan los semáforos, giran en los cruces y se arriman si un coche rápido viene detrás. */
export class Cyclists {
  private geo = buildCyclistGeometry();
  private timeU = { value: 0 };
  private mat: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private aLook: THREE.InstancedBufferAttribute;
  private aMisc: THREE.InstancedBufferAttribute;
  private cyc: Cyc[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private ay = new THREE.Vector3(0, 1, 0);
  private posList: { x: number; z: number }[] = [];
  enabled = true;

  constructor(private scene: THREE.Scene, private traffic: Traffic, private signals: Signals | null) {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
    const pal = PALETTE.map((h) => new THREE.Color(h));
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.timeU;
      sh.uniforms.uPal = { value: pal };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aMeta; attribute vec3 aMeta2; attribute vec4 aLook; attribute vec4 aMisc;
          uniform float uTime; uniform vec3 uPal[${PALETTE.length}];
          void rotX(inout vec3 p, float py, float pz, float a) { float c = cos(a), s = sin(a); float yy = p.y - py, zz = p.z - pz; p.y = py + yy * c - zz * s; p.z = pz + yy * s + zz * c; }`)
        .replace('#include <color_vertex>', `#include <color_vertex>
          if (aMeta.x > 4.5) vColor.xyz = uPal[int(aMisc.x)];
          else if (aMeta.x > 3.5) vColor.xyz = uPal[int(aLook.z)];
          else if (aMeta.x > 2.5) vColor.xyz = uPal[int(aLook.w)];
          else if (aMeta.x > 1.5) vColor.xyz = uPal[int(aLook.y)];
          else if (aMeta.x > 0.5) vColor.xyz = uPal[int(aLook.x)];`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = aMisc.z;                                   // fase del pedaleo
          float wa = aMisc.y;                                   // ángulo acumulado de las ruedas
          if (aMeta.y > 0.5 && aMeta.y < 1.5) rotX(transformed, aMeta2.x, aMeta2.y, wa);
          float thigh = sin(ph + (aMeta.z > 0.0 ? 0.0 : 3.14159)) * 0.42;
          float calf = -0.55 - 0.5 * sin(ph + (aMeta.z > 0.0 ? 0.0 : 3.14159) + 1.1);
          if (aMeta.y > 2.5) rotX(transformed, aMeta2.x, aMeta2.y, calf);                 // rodilla
          if (aMeta.y > 1.5) rotX(transformed, 1.0, -0.3, thigh);                         // cadera`);
    };
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_CYC);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.aLook = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CYC * 4), 4);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CYC * 4), 4);
    this.geo.setAttribute('aLook', this.aLook);
    this.geo.setAttribute('aMisc', this.aMisc);
    scene.add(this.mesh);
  }

  /** Posiciones de los ciclistas (los coches les ceden el paso). */
  positions(): { x: number; z: number }[] { return this.posList; }

  private place(c: Cyc) {
    const w = c.way, cum = w.cum;
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < c.s) i++;
    const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
    const sl = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (c.s - cum[i]) / sl));
    const dx = (bx - ax) / sl * c.dir, dz = (bz - az) / sl * c.dir;
    c.fx = dx; c.fz = dz;
    c.x = ax + (bx - ax) * t - dz * c.lane;
    c.z = az + (bz - az) * t + dx * c.lane;
  }

  private edge(w: Way) { return Math.max(1.0, w.w / 2 - 0.95); }

  private spawn(px: number, pz: number, hx: number, hz: number, ways: Way[]) {
    for (let tries = 0; tries < 12; tries++) {
      const w = ways[Math.floor(Math.random() * ways.length)];
      if (!w || w.len < 30 || w.w < 5.5 || !['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street'].includes(w.cls)) continue;
      const dir: 1 | -1 = w.ow === 1 ? 1 : w.ow === 2 ? -1 : Math.random() < 0.5 ? 1 : -1;
      const lk = randomLook();
      const c: Cyc = {
        way: w, dir, s: 4 + Math.random() * (w.len - 8), v: 0, vmax: 3.6 + Math.random() * 2.6, lane: this.edge(w), laneT: this.edge(w),
        x: 0, z: 0, fx: 0, fz: 1, shirt: lk.shirt, pants: lk.pants, skin: lk.skin, hasHelmet: Math.random() < 0.75, phase: Math.random() * 6.28, wheelAng: 0,
      };
      this.place(c);
      const dx = c.x - px, dz = c.z - pz, d = Math.hypot(dx, dz);
      if (d < 30 || d > 160) continue;
      if (d < 100 && (dx * hx + dz * hz) / d > 0.4) continue;
      if (this.cyc.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 12)) continue;
      c.v = c.vmax * 0.8;
      this.cyc.push(c);
      return;
    }
  }

  private turn(c: Cyc): boolean {
    const w = c.way;
    const end = c.dir > 0 ? w.pts[w.pts.length - 1] : w.pts[0];
    const { ends } = this.traffic.graph();
    const cands = (ends.get(nodeKey(end[0], end[1])) ?? []).filter((k) => k.way !== w && k.way.w >= 5 && (k.atStart ? k.way.ow !== 2 : k.way.ow !== 1));
    if (!cands.length) return false;
    let tot = 0;
    const wts = cands.map((k) => {
      const q = k.atStart ? k.way.pts[1] : k.way.pts[k.way.pts.length - 2];
      let dx = q[0] - end[0], dz = q[1] - end[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const wt = Math.exp(1.8 * (dx * c.fx + dz * c.fz)); tot += wt; return wt;
    });
    let r = Math.random() * tot, k = 0;
    while (k < cands.length - 1 && r > wts[k]) { r -= wts[k]; k++; }
    const n = cands[k];
    c.way = n.way; c.dir = n.atStart ? 1 : -1; c.s = n.atStart ? 0.05 : n.way.len - 0.05; c.lane = c.laneT = this.edge(n.way);
    return true;
  }

  update(dt: number, px: number, pz: number, headingRad: number, carSpeed: number, density: number) {
    if (!this.enabled) { this.mesh.count = 0; this.posList = []; return; }
    this.timeU.value += dt;
    const { ways } = this.traffic.graph();
    const hx = Math.sin(headingRad), hz = -Math.cos(headingRad);
    const target = Math.round(7 * density);
    if (this.cyc.length < target && ways.length) this.spawn(px, pz, hx, hz, ways);
    const keep: Cyc[] = [];
    for (const c of this.cyc) {
      if (!c.test && (Math.hypot(c.x - px, c.z - pz) > 200 || !this.traffic.hasWay(c.way.id))) continue;
      if (c.test) { c.v = 5; c.wheelAng += (c.v * dt) / 0.33; c.phase += c.v * dt * 2.6; this.place(c); keep.push(c); continue; }
      const toEnd = c.dir > 0 ? c.way.len - c.s : c.s;
      let tv = c.vmax * (toEnd < 12 ? 0.5 + 0.5 * toEnd / 12 : 1);
      if (this.signals && toEnd < 22) {
        const end = c.dir > 0 ? c.way.pts[c.way.pts.length - 1] : c.way.pts[0];
        const st = this.signals.stateAt(end[0], end[1], c.fx, c.fz);
        if (st && (st.state === 'r' || (st.state === 'a' && toEnd > 4 + c.v * 0.5))) tv = Math.min(tv, Math.max(0, toEnd - 3.0) * 0.9);
      }
      // se arrima al bordillo si un coche rápido viene detrás
      const rx = c.x - px, rz = c.z - pz, behind = rx * hx + rz * hz;
      c.laneT = this.edge(c.way);
      if (carSpeed > 7 && behind > 0 && behind < 22 && Math.abs(rx * -hz + rz * hx) < 4) c.laneT = c.way.w / 2 - 0.35;
      c.lane += (c.laneT - c.lane) * Math.min(1, dt * 2.5);
      c.v += Math.max(-3.5 * dt, Math.min(1.4 * dt, tv - c.v));
      c.s += c.dir * c.v * dt;
      if (c.s < 0 || c.s > c.way.len) {
        if (!this.turn(c)) {
          if (c.way.ow === 0) { c.dir = (c.dir * -1) as 1 | -1; c.s = Math.max(0.1, Math.min(c.way.len - 0.1, c.s)); } else continue;
        }
      }
      this.place(c);
      c.wheelAng += (c.v * dt) / 0.33;
      c.phase += c.v * dt * 2.6;
      keep.push(c);
    }
    this.cyc = keep;
    const n = Math.min(this.cyc.length, MAX_CYC);
    this.posList = [];
    for (let i = 0; i < n; i++) {
      const c = this.cyc[i];
      const yaw = Math.atan2(c.fx, c.fz);
      const y0 = heightAt(c.x, c.z);
      const pitch = -Math.atan2(heightAt(c.x + c.fx, c.z + c.fz) - heightAt(c.x - c.fx, c.z - c.fz), 2);
      this.tmpQ.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      this.tmpM.compose(this.tmpV.set(c.x, y0 + 0.02, c.z), this.tmpQ, this.tmpS);
      this.mesh.setMatrixAt(i, this.tmpM);
      this.aLook.setXYZW(i, c.shirt, c.pants, c.skin, PAL_OFF.acc + (i % 7));
      this.aMisc.setXYZW(i, c.hasHelmet ? PAL_OFF.acc + ((i * 3) % 7) : PAL_OFF.hair + (i % 8), c.wheelAng % (Math.PI * 2), c.phase % (Math.PI * 2), 0);
      this.posList.push({ x: c.x, z: c.z });
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aLook.needsUpdate = true; this.aMisc.needsUpdate = true;
  }

  /** Solo pruebas (?cyctest=1): cuatro ciclistas pedaleando en el sitio, delante del coche. */
  debugAhead(px: number, pz: number, hx: number, hz: number) {
    const way: Way = { id: -3, cls: 'test', ow: 0, w: 8, pts: [[px + hx * 5, pz + hz * 5], [px + hx * 80, pz + hz * 80]], cum: [0, 75], len: 75, tiles: new Set() };
    for (let i = 0; i < 4; i++) {
      const lk = randomLook();
      const c: Cyc = { way, dir: 1, s: 6 + i * 3.4, v: 5, vmax: 5, lane: (i % 2 ? 1 : -1) * (0.9 + (i % 3) * 0.9), laneT: 0, x: 0, z: 0, fx: 0, fz: 1,
        shirt: lk.shirt, pants: lk.pants, skin: lk.skin, hasHelmet: i % 3 !== 2, phase: i * 1.7, wheelAng: 0, test: true };
      this.place(c); this.cyc.push(c);
    }
  }

  stats() { return { cyclists: this.cyc.length, sample: this.cyc.slice(0, 3).map((c) => [Math.round(c.x), Math.round(c.z), +c.v.toFixed(1)]) }; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose(); this.geo.dispose(); this.mat.dispose();
  }
}
