import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from './geo';
import { nodeKey, type Traffic, type Way } from './traffic';

interface Ped {
  way: Way; dir: 1 | -1; s: number; side: 1 | -1; off: number;
  v: number; vwalk: number; x: number; z: number; fx: number; fz: number;
  phase: number; shirt: number; pants: number; pause: number; flee: number; bad: number; h: number; test?: boolean;
}

const SHIRTS = [0xd9d9d6, 0x2f4f8a, 0xb23a3a, 0x3f7a4f, 0xe0b23c, 0x1f1f24, 0x8a5a9c, 0xe8e2d0, 0x4aa0b8, 0xc96a2a, 0x6b6f75];
const PANTS = [0x23324a, 0x1c1c20, 0x4a5a78, 0x6d5a45, 0x8a8f96, 0x2a3b2f, 0x3a3a40];
const MAX_PEDS = 90;

function tint(g: THREE.BufferGeometry, c: number, part: number, limb: number, pivot: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3), pa = new Float32Array(n), li = new Float32Array(n), pv = new Float32Array(n);
  const k = new THREE.Color(c);
  for (let i = 0; i < n; i++) { col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b; pa[i] = part; li[i] = limb; pv[i] = pivot; }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aPart', new THREE.BufferAttribute(pa, 1));
  ng.setAttribute('aLimb', new THREE.BufferAttribute(li, 1));
  ng.setAttribute('aPivot', new THREE.BufferAttribute(pv, 1));
  return ng;
}

/** Figura humana de ~1,72 m (eje +Z de frente): piernas y brazos con pivote para el paso; camiseta/pantalón se tiñen por instancia. */
function buildPedGeometry(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const leg = (x: number, limb: number) => {
    const l = new THREE.CylinderGeometry(0.075, 0.062, 0.8, 7).translate(x, 0.5, 0);
    P.push(tint(l, 0x000000, 2, limb, 0.9));
    const shoe = new THREE.BoxGeometry(0.11, 0.07, 0.24).translate(x, 0.04, 0.05);
    P.push(tint(shoe, 0x1b1b1d, 0, limb, 0.9));
  };
  leg(-0.1, 1); leg(0.1, -1);
  P.push(tint(new THREE.CylinderGeometry(0.2, 0.17, 0.62, 8).scale(1, 1, 0.62).translate(0, 1.2, 0), 0x000000, 1, 0, 0));      // torso
  const arm = (x: number, limb: number) => {
    P.push(tint(new THREE.CylinderGeometry(0.05, 0.045, 0.52, 6).translate(x, 1.2, 0), 0x000000, 1, limb * 0.8, 1.46));
    P.push(tint(new THREE.SphereGeometry(0.055, 6, 5).translate(x, 0.92, 0), 0xf0c8a0, 0, limb * 0.8, 1.46));                      // mano
  };
  arm(-0.27, -1); arm(0.27, 1);
  P.push(tint(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 6).translate(0, 1.56, 0), 0xe0ac84, 0, 0, 0));                           // cuello
  P.push(tint(new THREE.SphereGeometry(0.115, 9, 7).scale(1, 1.15, 1.05).translate(0, 1.67, 0), 0xe0ac84, 0, 0, 0));                // cabeza
  P.push(tint(new THREE.SphereGeometry(0.122, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.1, 1.08).translate(0, 1.69, -0.005), 0x2b2118, 0, 0, 0));   // pelo
  return mergeGeometries(P, false)!;
}

/** Peatones por las aceras: siguen las calles de OSM por el lado de la acera, se paran un rato y se apartan del coche. */
export class Pedestrians {
  private geo = buildPedGeometry();
  private timeU = { value: 0 };
  private mat: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private aShirt: THREE.InstancedBufferAttribute;
  private aPants: THREE.InstancedBufferAttribute;
  private aPhase: THREE.InstancedBufferAttribute;
  private aSpd: THREE.InstancedBufferAttribute;
  private peds: Ped[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private ay = new THREE.Vector3(0, 1, 0);
  enabled = true;

  constructor(private scene: THREE.Scene, private traffic: Traffic, private walkable: (x: number, z: number) => boolean) {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.timeU;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPart; attribute float aLimb; attribute float aPivot; attribute vec3 aShirt; attribute vec3 aPants; attribute float aPhase; attribute float aSpd; uniform float uTime;')
        .replace('#include <color_vertex>', '#include <color_vertex>\n if (aPart > 1.5) vColor.xyz = aPants; else if (aPart > 0.5) vColor.xyz = aShirt;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float sw = sin(uTime * 7.0 * aSpd + aPhase) * 0.6 * aLimb * min(aSpd, 1.0);
          float cs = cos(sw), sn = sin(sw);
          float yy = transformed.y - aPivot;
          float nz = transformed.z * cs + yy * sn;
          transformed.y = aPivot + yy * cs - transformed.z * sn;
          transformed.z = nz;`);
    };
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_PEDS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.aShirt = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEDS * 3), 3);
    this.aPants = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEDS * 3), 3);
    this.aPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEDS), 1);
    this.aSpd = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PEDS), 1);
    this.geo.setAttribute('aShirt', this.aShirt);
    this.geo.setAttribute('aPants', this.aPants);
    this.geo.setAttribute('aPhase', this.aPhase);
    this.geo.setAttribute('aSpd', this.aSpd);
    scene.add(this.mesh);
  }

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
      const p: Ped = {
        way: w, dir: Math.random() < 0.5 ? 1 : -1, s: 2 + Math.random() * (w.len - 4), side: Math.random() < 0.5 ? 1 : -1, off: 0,
        v: 0, vwalk: 1.0 + Math.random() * 0.7, x: 0, z: 0, fx: 0, fz: 1, phase: Math.random() * 6.28,
        shirt: SHIRTS[Math.floor(Math.random() * SHIRTS.length)], pants: PANTS[Math.floor(Math.random() * PANTS.length)],
        pause: Math.random() < 0.2 ? 2 + Math.random() * 8 : 0, flee: 0, bad: 0, h: 0.93 + Math.random() * 0.14,
      };
      if (!this.pickOffset(p)) continue;
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < 20 || d > 120) continue;
      p.v = p.vwalk;
      this.peds.push(p);
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
    if (!this.enabled) { this.mesh.count = 0; return; }
    this.timeU.value += dt;
    const { ways } = this.traffic.graph();
    const target = Math.round(60 * density);
    if (this.peds.length < target && ways.length) { this.spawn(px, pz, ways); this.spawn(px, pz, ways); }
    const hx = Math.sin(headingRad), hz = -Math.cos(headingRad);
    const keep: Ped[] = [];
    for (const p of this.peds) {
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
      p.s += p.dir * p.v * dt;
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
      const p = this.peds[i];
      const yaw = Math.atan2(p.fx, p.fz);
      this.tmpQ.setFromAxisAngle(this.ay, yaw);
      this.tmpM.compose(this.tmpV.set(p.x, heightAt(p.x, p.z) + 0.02, p.z), this.tmpQ, this.tmpS.set(p.h, p.h, p.h));
      this.mesh.setMatrixAt(i, this.tmpM);
      this.tmpC.setHex(p.shirt); this.aShirt.setXYZ(i, this.tmpC.r, this.tmpC.g, this.tmpC.b);
      this.tmpC.setHex(p.pants); this.aPants.setXYZ(i, this.tmpC.r, this.tmpC.g, this.tmpC.b);
      this.aPhase.setX(i, p.phase);
      this.aSpd.setX(i, p.v / 1.2);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aShirt.needsUpdate = true; this.aPants.needsUpdate = true; this.aPhase.needsUpdate = true; this.aSpd.needsUpdate = true;
  }

  /** Solo para depuración (?pedtest=1): 6 peatones andando en línea recta delante del coche. */
  debugAhead(px: number, pz: number, hx: number, hz: number) {
    const way: Way = { id: -1, cls: 'test', ow: 0, w: 0, pts: [[px + hx * 6, pz + hz * 6], [px + hx * 80, pz + hz * 80]], cum: [0, 74], len: 74, tiles: new Set() };
    for (let i = 0; i < 6; i++) {
      this.peds.push({ way, dir: 1, s: 2 + i * 5, side: i % 2 ? 1 : -1, off: 1.2 + (i % 3) * 0.7, v: 1.3, vwalk: 1.3, x: 0, z: 0, fx: 0, fz: 1, phase: i * 1.3,
        shirt: SHIRTS[i % SHIRTS.length], pants: PANTS[i % PANTS.length], pause: 0, flee: 0, bad: 0, h: 1, test: true });
    }
  }

  stats() { return { peds: this.peds.length, sample: this.peds.slice(0, 3).map((q) => [Math.round(q.x), Math.round(q.z), +q.v.toFixed(2)]) }; }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}
