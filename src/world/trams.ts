import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from './geo';

/** Datos del TRAM de Alicante (public/world/tram.json, tools/pbf_tram.py): cadenas de vía, con el tramo en túnel marcado, y paradas. */
export interface TramData { chains: { p: [number, number][]; t: number[] }[]; stops: [number, number, string][] }

interface Chain { p: [number, number][]; t: number[]; cum: number[]; len: number; stops: number[] }
interface Tram { chain: Chain; s: number; dir: 1 | -1; v: number; hold: number; lastStop: number }

const CAR_LEN = 12.4, GAP = 0.5, CARS = 3, MAX_TRAMS = 5;
const VMAX = 13;                                   // ~47 km/h en superficie
const SPAWN_MIN = 90, SPAWN_MAX = 300, DESPAWN = 480;

function colorize(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const c = new THREE.Color(hex), n = ng.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return ng;
}

/** Un coche del TRAM (mira a +Z): caja blanca con franja azul, banda de ventanillas, testeros con parabrisas y pantógrafo. */
function buildCarGeometry(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, l: number, x: number, y: number, z: number, hex: number) => P.push(colorize(new THREE.BoxGeometry(w, h, l).translate(x, y, z), hex));
  box(2.65, 0.55, CAR_LEN, 0, 0.62, 0, 0x1f4e9a);                    // faldón azul
  box(2.65, 1.75, CAR_LEN, 0, 1.77, 0, 0xf1f2f0);                    // caja blanca
  box(2.69, 0.78, CAR_LEN - 0.9, 0, 2.05, 0, 0x1b2a3a);              // ventanillas
  box(2.4, 0.3, CAR_LEN - 0.4, 0, 2.77, 0, 0xc9ccd0);                // techo
  box(2.68, 0.12, CAR_LEN, 0, 1.2, 0, 0x2fa05a);                     // línea verde
  for (const s of [1, -1]) {
    box(2.1, 0.95, 0.05, 0, 2.0, s * (CAR_LEN / 2 + 0.01), 0x1b2a3a);  // parabrisas / testero
    box(2.5, 0.35, 0.08, 0, 0.6, s * (CAR_LEN / 2 + 0.01), 0x33383c);
  }
  box(1.5, 0.08, 1.2, 0, 3.0, 2.2, 0x44484c);                         // pantógrafo
  box(0.08, 0.3, 0.08, 0.5, 2.92, 2.2, 0x44484c);
  box(0.08, 0.3, 0.08, -0.5, 2.92, 2.2, 0x44484c);
  return mergeGeometries(P, false)!;
}

/** TRAM de Alicante: vías (balasto y raíles), andenes en las paradas y tranvías de tres coches que circulan, paran y entran en los túneles. */
export class Trams {
  private chains: Chain[] = [];
  private stops: [number, number, string][] = [];
  private trams: Tram[] = [];
  private mesh: THREE.InstancedMesh;
  private track: THREE.Mesh | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private timer = 0;
  enabled = true;

  constructor(private scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.25 });
    this.mesh = new THREE.InstancedMesh(buildCarGeometry(), mat, MAX_TRAMS * CARS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
  }

  setData(d: TramData) {
    this.chains = d.chains.map((c) => {
      const cum = [0];
      for (let i = 1; i < c.p.length; i++) cum.push(cum[i - 1] + Math.hypot(c.p[i][0] - c.p[i - 1][0], c.p[i][1] - c.p[i - 1][1]));
      return { p: c.p, t: c.t, cum, len: cum[cum.length - 1], stops: [] };
    });
    this.stops = d.stops;
    for (const [sx, sz] of d.stops) {                                     // cada parada, en la cadena que pasa a menos de 12 m
      let best: { c: Chain; s: number; d: number } | null = null;
      for (const c of this.chains) {
        for (let i = 0; i < c.p.length - 1; i++) {
          const [ax, az] = c.p[i], [bx, bz] = c.p[i + 1];
          const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((sx - ax) * ex + (sz - az) * ez) / l2)) : 0;
          const dd = Math.hypot(sx - (ax + ex * t), sz - (az + ez * t));
          if (dd < 12 && (!best || dd < best.d) && !c.t[i]) best = { c, s: c.cum[i] + t * Math.sqrt(l2), d: dd };
        }
      }
      if (best) best.c.stops.push(best.s);
    }
    this.buildTrack();
  }

  /** Raíles y balasto de toda la red en superficie, y andenes (con marquesina) en las paradas, como una sola malla. */
  private buildTrack() {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const strip = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number, w: number, y0: number, y1: number, hex: number, off = 0) => {
      const c = new THREE.Color(hex), base = pos.length / 3;
      for (const [x, z, y] of [[ax, az, y0], [bx, bz, y1]] as [number, number, number][]) {
        pos.push(x + nx * (off - w / 2), y, z + nz * (off - w / 2), x + nx * (off + w / 2), y, z + nz * (off + w / 2));
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    };
    const STEP = 3;
    for (const c of this.chains) {
      let prev: { x: number; z: number; nx: number; nz: number; y: number } | null = null, prevTun = true;
      for (let s = 0; s <= c.len + 1e-6; s += STEP) {
        const { x, z, tx, tz, tun } = this.sample(c, Math.min(s, c.len));
        const nx = -tz, nz = tx, y = heightAt(x, z) + 0.09;
        if (prev && !tun && !prevTun) {
          strip(prev.x, prev.z, x, z, nx, nz, 2.9, prev.y, y, 0x58544f);
          strip(prev.x, prev.z, x, z, nx, nz, 0.13, prev.y + 0.02, y + 0.02, 0xb4b8bd, -0.72);
          strip(prev.x, prev.z, x, z, nx, nz, 0.13, prev.y + 0.02, y + 0.02, 0xb4b8bd, 0.72);
        }
        prev = { x, z, nx, nz, y }; prevTun = tun;
      }
    }
    for (const [sx, sz] of this.stops) {                                    // andén: losa con borde amarillo y una marquesina
      const c0 = this.nearestChain(sx, sz);
      if (!c0) continue;
      const { x, z, tx, tz, tun } = this.sample(c0.c, c0.s);
      if (tun) continue;
      const nx = -tz, nz = tx, y = heightAt(x, z) + 0.2;
      for (const side of [-1, 1]) {
        const cx = x + nx * side * 3.1, cz = z + nz * side * 3.1;
        strip(cx - tx * 14, cz - tz * 14, cx + tx * 14, cz + tz * 14, nx, nz, 2.4, y, y, 0xa9a69d);
        strip(cx - tx * 14 - nx * side * 1.15, cz - tz * 14 - nz * side * 1.15, cx + tx * 14 - nx * side * 1.15, cz + tz * 14 - nz * side * 1.15, nx, nz, 0.25, y + 0.01, y + 0.01, 0xe0b72a);
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.track = new THREE.Mesh(g, m);
    this.track.frustumCulled = false;
    this.track.receiveShadow = true;
    this.scene.add(this.track);
  }

  private nearestChain(x: number, z: number): { c: Chain; s: number } | null {
    let best: { c: Chain; s: number; d: number } | null = null;
    for (const c of this.chains) {
      for (let i = 0; i < c.p.length - 1; i++) {
        const [ax, az] = c.p[i], [bx, bz] = c.p[i + 1];
        const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
        const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
        if (d < 14 && (!best || d < best.d)) best = { c, s: c.cum[i] + t * Math.sqrt(l2), d };
      }
    }
    return best;
  }

  /** Posición, rumbo y bandera de túnel de la cadena a distancia s. */
  private sample(c: Chain, s: number): { x: number; z: number; tx: number; tz: number; tun: boolean } {
    let i = 0;
    while (i < c.cum.length - 2 && c.cum[i + 1] < s) i++;
    const [ax, az] = c.p[i], [bx, bz] = c.p[i + 1];
    const sl = c.cum[i + 1] - c.cum[i] || 1, t = Math.max(0, Math.min(1, (s - c.cum[i]) / sl));
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / sl, tz: (bz - az) / sl, tun: !!c.t[i] };
  }

  private spawn(px: number, pz: number) {
    for (let tries = 0; tries < 40; tries++) {
      const c = this.chains[Math.floor(Math.random() * this.chains.length)];
      if (!c || c.len < 120) continue;
      const s = 30 + Math.random() * (c.len - 60);
      const q = this.sample(c, s);
      if (q.tun) continue;
      const d = Math.hypot(q.x - px, q.z - pz);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (this.trams.some((o) => Math.hypot(this.sample(o.chain, o.s).x - q.x, this.sample(o.chain, o.s).z - q.z) < 80)) continue;
      this.trams.push({ chain: c, s, dir: Math.random() < 0.5 ? 1 : -1, v: VMAX * 0.7, hold: 0, lastStop: -1 });
      return;
    }
  }

  update(dt: number, px: number, pz: number) {
    if (!this.enabled || !this.chains.length) { this.mesh.count = 0; if (this.track) this.track.visible = !!this.chains.length; return; }
    if (this.track) this.track.visible = true;
    this.timer += dt;
    if (this.timer > 3 && this.trams.length < MAX_TRAMS) { this.timer = 0; this.spawn(px, pz); }
    const keep: Tram[] = [];
    for (const t of this.trams) {
      const head = this.sample(t.chain, t.s);
      if (Math.hypot(head.x - px, head.z - pz) > DESPAWN) continue;
      // frena y para en la próxima parada de su sentido; en los extremos de la cadena da la vuelta tras una espera
      let target = VMAX;
      let nextStop = -1, dStop = 1e9;
      for (let k = 0; k < t.chain.stops.length; k++) {
        const ds = (t.chain.stops[k] - t.s) * t.dir;
        if (ds > 1 && ds < dStop && k !== t.lastStop) { dStop = ds; nextStop = k; }
      }
      if (nextStop >= 0 && dStop < 60) target = Math.max(0, Math.min(VMAX, (dStop - 3) * 0.55));
      if (nextStop >= 0 && dStop < 4 && t.v < 0.8) { t.hold = 12; t.lastStop = nextStop; }
      const toEnd = t.dir > 0 ? t.chain.len - t.s : t.s;
      if (toEnd < 40) target = Math.min(target, Math.max(0, toEnd - 4) * 0.5);
      if (t.hold > 0) { t.hold -= dt; target = 0; }
      if (toEnd < 4.5 && t.v < 0.8) { t.dir = (t.dir * -1) as 1 | -1; t.hold = 10; t.lastStop = -1; }
      t.v += Math.max(-1.3 * dt, Math.min(0.9 * dt, target - t.v));
      t.s = Math.max(0, Math.min(t.chain.len, t.s + t.dir * t.v * dt));
      keep.push(t);
    }
    this.trams = keep;
    let n = 0;
    for (const t of this.trams) {
      for (let k = 0; k < CARS; k++) {
        const s = t.s - t.dir * (k * (CAR_LEN + GAP) + CAR_LEN / 2);
        const out = s < 0 || s > t.chain.len;
        const q = this.sample(t.chain, Math.max(0, Math.min(t.chain.len, s)));
        if (out || q.tun) { this.mesh.setMatrixAt(n++, this.zero); continue; }   // bajo tierra: no se ve
        const fx = q.tx * t.dir, fz = q.tz * t.dir;
        const yf = heightAt(q.x + fx * 4, q.z + fz * 4), yb = heightAt(q.x - fx * 4, q.z - fz * 4);
        this.tmpE.set(-Math.atan2(yf - yb, 8), Math.atan2(fx, fz), 0);
        this.tmpQ.setFromEuler(this.tmpE);
        this.tmpM.compose(this.tmpV.set(q.x, heightAt(q.x, q.z) + 0.12, q.z), this.tmpQ, new THREE.Vector3(1, 1, 1));
        this.mesh.setMatrixAt(n++, this.tmpM);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose();
    if (this.track) { this.scene.remove(this.track); this.track.geometry.dispose(); (this.track.material as THREE.Material).dispose(); }
  }
}
