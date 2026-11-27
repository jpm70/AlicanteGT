import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type VariantId = 'sedan' | 'hatch' | 'suv' | 'van' | 'taxi' | 'bus';
export const VARIANT_IDS: VariantId[] = ['sedan', 'hatch', 'suv', 'van', 'taxi', 'bus'];
/** Largo aproximado (m) de cada variante: separaciones al seguir y colisiones. */
export const VARIANT_LEN: Record<VariantId, number> = { sedan: 4.3, hatch: 4.0, suv: 4.55, van: 5.1, taxi: 4.3, bus: 11.8 };

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

interface Spec {
  /** estaciones de la carrocería: [z, semiancho, suelo, línea de cintura / capó] */
  st: [number, number, number, number][];
  /** cabina: [y, z trasero, z delantero, semiancho] */
  cab: [number, number, number, number][];
  wheelZ: [number, number]; wheelR: number; track: number;
  hwMid: number;                       // semiancho de la carrocería a media altura (para pegar detalles)
  doors: number[];                     // z de las juntas de las puertas
  front: number; rear: number;         // z de morro y cola
  headY: number; tailY: number; plateY: number;
  mirrorZ: number; mirrorY: number;
  roofSign?: boolean; bus?: boolean; van?: boolean;
}

const SPECS: Record<VariantId, Spec> = {
  sedan: {
    st: [[-2.15, 0.62, 0.42, 0.8], [-2.05, 0.78, 0.34, 0.93], [-1.75, 0.87, 0.3, 0.99], [-1.0, 0.9, 0.27, 0.99], [0.0, 0.91, 0.27, 0.96], [0.9, 0.9, 0.27, 0.94], [1.5, 0.87, 0.28, 0.88], [1.95, 0.8, 0.32, 0.77], [2.15, 0.66, 0.4, 0.64]],
    cab: [[0.94, -1.78, 0.98, 0.79], [1.1, -1.62, 0.66, 0.75], [1.28, -1.3, 0.28, 0.68], [1.42, -0.98, -0.02, 0.6]],
    wheelZ: [-1.38, 1.36], wheelR: 0.33, track: 0.84, hwMid: 0.91, doors: [0.35, -0.55], front: 2.15, rear: -2.15, headY: 0.72, tailY: 0.84, plateY: 0.62, mirrorZ: 0.82, mirrorY: 1.0,
  },
  hatch: {
    st: [[-1.95, 0.6, 0.42, 0.82], [-1.88, 0.76, 0.34, 0.95], [-1.6, 0.86, 0.3, 1.0], [-0.8, 0.9, 0.27, 0.99], [0.1, 0.91, 0.27, 0.96], [0.9, 0.9, 0.27, 0.93], [1.45, 0.87, 0.28, 0.86], [1.85, 0.8, 0.32, 0.76], [2.05, 0.66, 0.4, 0.64]],
    cab: [[0.94, -1.78, 0.92, 0.79], [1.1, -1.72, 0.62, 0.76], [1.3, -1.55, 0.25, 0.69], [1.44, -1.25, -0.05, 0.6]],
    wheelZ: [-1.25, 1.28], wheelR: 0.31, track: 0.84, hwMid: 0.91, doors: [0.3, -0.6], front: 2.05, rear: -1.95, headY: 0.7, tailY: 0.86, plateY: 0.6, mirrorZ: 0.78, mirrorY: 1.0,
  },
  suv: {
    st: [[-2.3, 0.72, 0.5, 1.05], [-2.2, 0.88, 0.4, 1.2], [-1.8, 0.95, 0.36, 1.26], [-0.8, 0.97, 0.34, 1.24], [0.4, 0.97, 0.34, 1.2], [1.3, 0.95, 0.35, 1.14], [1.9, 0.9, 0.38, 1.02], [2.25, 0.8, 0.45, 0.9]],
    cab: [[1.2, -2.12, 0.95, 0.88], [1.38, -2.05, 0.7, 0.84], [1.56, -1.9, 0.4, 0.78], [1.68, -1.65, 0.1, 0.7]],
    wheelZ: [-1.45, 1.5], wheelR: 0.38, track: 0.92, hwMid: 0.97, doors: [0.55, -0.45], front: 2.25, rear: -2.3, headY: 0.92, tailY: 1.0, plateY: 0.7, mirrorZ: 0.9, mirrorY: 1.2,
  },
  van: {
    st: [[-2.65, 0.8, 0.5, 1.45], [-2.55, 0.93, 0.4, 1.75], [-2.0, 0.97, 0.36, 1.82], [0.8, 0.97, 0.36, 1.78], [1.35, 0.95, 0.38, 1.6], [1.85, 0.88, 0.42, 1.12], [2.2, 0.78, 0.46, 0.9]],
    cab: [[1.15, 0.5, 1.75, 0.87], [1.55, 0.62, 1.5, 0.82], [1.85, 0.78, 1.3, 0.74]],
    wheelZ: [-1.55, 1.6], wheelR: 0.35, track: 0.9, hwMid: 0.97, doors: [0.55], front: 2.2, rear: -2.65, headY: 0.95, tailY: 1.0, plateY: 0.75, mirrorZ: 1.5, mirrorY: 1.35, van: true,
  },
  taxi: {
    st: [[-2.15, 0.62, 0.42, 0.8], [-2.05, 0.78, 0.34, 0.93], [-1.75, 0.87, 0.3, 0.99], [-1.0, 0.9, 0.27, 0.99], [0.0, 0.91, 0.27, 0.96], [0.9, 0.9, 0.27, 0.94], [1.5, 0.87, 0.28, 0.88], [1.95, 0.8, 0.32, 0.77], [2.15, 0.66, 0.4, 0.64]],
    cab: [[0.94, -1.78, 0.98, 0.79], [1.1, -1.62, 0.66, 0.75], [1.28, -1.3, 0.28, 0.68], [1.42, -0.98, -0.02, 0.6]],
    wheelZ: [-1.38, 1.36], wheelR: 0.33, track: 0.84, hwMid: 0.91, doors: [0.35, -0.55], front: 2.15, rear: -2.15, headY: 0.72, tailY: 0.84, plateY: 0.62, mirrorZ: 0.82, mirrorY: 1.0, roofSign: true,
  },
  bus: {
    st: [[-5.9, 1.2, 0.5, 2.6], [-5.7, 1.28, 0.4, 3.0], [-4.0, 1.28, 0.36, 3.05], [4.0, 1.28, 0.36, 3.05], [5.6, 1.2, 0.4, 2.7], [5.9, 1.0, 0.5, 2.2]],
    cab: [[1.05, -5.6, 5.5, 1.3], [1.6, -5.6, 5.5, 1.3], [2.4, -5.55, 5.4, 1.3]],
    wheelZ: [-3.8, 3.5], wheelR: 0.5, track: 1.12, hwMid: 1.28, doors: [3.0, 0.2], front: 5.9, rear: -5.9, headY: 0.85, tailY: 1.0, plateY: 0.7, mirrorZ: 5.4, mirrorY: 2.0, bus: true,
  },
};

interface VariantGeo { paint: THREE.BufferGeometry; trim: THREE.BufferGeometry; glass: THREE.BufferGeometry; lights: THREE.BufferGeometry }

/**
 * Vehículo modelado por secciones (eje largo +Z): carrocería redondeada, cabina inclinada con cristal reflectante, techo,
 * ruedas con llanta y pasos de rueda, juntas de puertas, pilar B, parachoques, faros, pilotos, retrovisores y matrículas.
 * Devuelve cuatro mallas: pintura (se tiñe), accesorios, cristal y luces.
 */
function buildVariant(id: VariantId): VariantGeo {
  const sp = SPECS[id];
  const paint: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], lights: THREE.BufferGeometry[] = [];
  const NB = 18;
  const rings = sp.st.map(([z, hw, yb, yt]) => squircle(NB, hw, (yt - yb) / 2, sp.bus || sp.van ? 4.2 : 3.2).map(([x, y]) => [x, (yt + yb) / 2 + y, z]));
  paint.push(loft(rings, true, true));
  const cr = sp.cab.map(([y, zr, zf, hw]) => squircle(NB, (zf - zr) / 2, hw, sp.bus ? 5 : 3).map(([a, b]) => [b, y, (zf + zr) / 2 + a]));
  glass.push(loft(cr, false, false));
  const roofR = cr[cr.length - 1];
  paint.push(loft([roofR, roofR.map(([x, y, z]) => [x * (sp.bus ? 0.98 : 0.96), y + 0.045, z])], false, true));
  const dark = [0.045, 0.045, 0.05];
  const x0 = sp.hwMid + 0.004;
  // parachoques y parrilla
  trim.push(colorVerts(flatBox(sp.hwMid * 1.5, 0.16, 0.12, 0, 0.42, sp.front - 0.04), dark));
  trim.push(colorVerts(flatBox(sp.hwMid * 1.5, 0.14, 0.12, 0, 0.42, sp.rear + 0.04), dark));
  trim.push(colorVerts(flatBox(sp.hwMid * 1.0, sp.bus ? 0.3 : 0.1, 0.05, 0, sp.bus ? 1.0 : sp.headY - 0.2, sp.front + 0.015), [0.03, 0.03, 0.03]));
  for (const sx of [-1, 1]) {
    lights.push(colorVerts(flatBox(sp.bus ? 0.5 : 0.38, 0.14, 0.09, sx * sp.hwMid * 0.68, sp.headY, sp.front - 0.08), [0.95, 0.95, 0.85]));
    lights.push(colorVerts(flatBox(sp.bus ? 0.4 : 0.38, 0.12, 0.09, sx * sp.hwMid * 0.7, sp.tailY, sp.rear + 0.08), [0.85, 0.06, 0.06]));
    paint.push(flatBox(0.12, 0.09, 0.2, sx * (sp.hwMid + 0.07), sp.mirrorY, sp.mirrorZ));
    for (const sz of sp.wheelZ) {
      trim.push(colorVerts(cyl(sp.wheelR, 0.24, sx * sp.track, sp.wheelR, sz, 16), [0.03, 0.03, 0.035]));
      trim.push(colorVerts(cyl(sp.wheelR * 0.62, 0.26, sx * (sp.track + 0.005), sp.wheelR, sz, 10), [0.66, 0.68, 0.7]));
      trim.push(colorVerts(cyl(sp.wheelR * 0.2, 0.28, sx * (sp.track + 0.01), sp.wheelR, sz, 6), [0.25, 0.25, 0.27]));
      trim.push(colorVerts(cyl(sp.wheelR * 1.28, 0.03, sx * (x0 - 0.012), sp.wheelR * 1.05, sz, 14), [0.015, 0.015, 0.02]));      // paso de rueda
    }
    for (const dz of sp.doors) trim.push(colorVerts(flatBox(0.02, sp.bus ? 1.6 : 0.6, 0.025, sx * x0, sp.bus ? 1.3 : 0.64, dz), [0.07, 0.07, 0.08]));   // junta de puerta
    if (!sp.bus) trim.push(colorVerts(flatBox(0.03, 0.44, 0.08, sx * (sp.cab[1][3] + 0.01), sp.cab[1][0] + 0.02, (sp.cab[1][1] + sp.cab[1][2]) / 2 - 0.1), dark));       // pilar B
  }
  trim.push(colorVerts(flatBox(0.46, 0.11, 0.03, 0, sp.plateY, sp.rear - 0.005), [0.93, 0.93, 0.9]));         // matrícula trasera
  trim.push(colorVerts(flatBox(0.46, 0.11, 0.03, 0, sp.bus ? 0.55 : 0.46, sp.front + 0.02), [0.93, 0.93, 0.9])); // matrícula delantera
  if (sp.roofSign) trim.push(colorVerts(flatBox(0.55, 0.15, 0.24, 0, roofR[0][1] + 0.14, (sp.cab[3][1] + sp.cab[3][2]) / 2), [0.98, 0.92, 0.55]));
  if (sp.bus) {
    trim.push(colorVerts(flatBox(0.03, 1.9, 1.15, 1.295, 1.55, 3.3), [0.03, 0.04, 0.05]));                   // puertas de viajeros
    lights.push(colorVerts(flatBox(1.5, 0.22, 0.04, 0, 2.62, sp.front - 0.02), [1.0, 0.7, 0.15]));             // rótulo de destino
    trim.push(colorVerts(flatBox(0.9, 0.12, 0.7, 0, roofR[0][1] + 0.18, -1.5), [0.7, 0.7, 0.72]));            // aire acondicionado en el techo
  } else if (!sp.van) {
    trim.push(colorVerts(flatBox(0.025, 0.2, 0.025, 0.4, roofR[0][1] + 0.14, sp.cab[3][1] + 0.1), dark));   // antena
  }
  return {
    paint: mergeGeometries(paint, false)!, trim: mergeGeometries(trim, false)!,
    glass: mergeGeometries(glass, false)!, lights: mergeGeometries(lights, false)!,
  };
}

/** Mallas instanciadas de un vehículo (pintura teñida, accesorios, cristal y luces) que comparten matrices. */
export class CarSet {
  readonly paint: THREE.InstancedMesh;
  readonly trim: THREE.InstancedMesh;
  readonly glass: THREE.InstancedMesh;
  readonly lights: THREE.InstancedMesh;
  constructor(g: VariantGeo, mats: { paint: THREE.Material; trim: THREE.Material; glass: THREE.Material; lights: THREE.Material }, count: number) {
    this.paint = new THREE.InstancedMesh(g.paint, mats.paint, count);
    this.trim = new THREE.InstancedMesh(g.trim, mats.trim, count);
    this.glass = new THREE.InstancedMesh(g.glass, mats.glass, count);
    this.lights = new THREE.InstancedMesh(g.lights, mats.lights, count);
    for (const m of this.all()) { m.frustumCulled = false; m.castShadow = m !== this.lights; }
  }
  private all() { return [this.paint, this.trim, this.glass, this.lights]; }
  set(i: number, m: THREE.Matrix4, color: THREE.Color) { for (const x of this.all()) x.setMatrixAt(i, m); this.paint.setColorAt(i, color); }
  get count() { return this.paint.count; }
  set count(n: number) { for (const x of this.all()) x.count = n; }
  flush() {
    for (const m of this.all()) m.instanceMatrix.needsUpdate = true;
    if (this.paint.instanceColor) this.paint.instanceColor.needsUpdate = true;
  }
  addTo(scene: THREE.Scene) { scene.add(...this.all()); }
  removeFrom(scene: THREE.Scene) { scene.remove(...this.all()); }
  dispose() { for (const m of this.all()) m.dispose(); }
}

/** Geometrías y materiales compartidos de todos los vehículos. */
export class VehicleLib {
  private geos = new Map<VariantId, VariantGeo>();
  readonly mats = {
    paint: new THREE.MeshPhysicalMaterial({ roughness: 0.32, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0a1016, roughness: 0.05, metalness: 0.9, envMapIntensity: 1.5 }),
    lights: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  /** Luces de los coches aparcados (se apagan de noche). */
  readonly parkedLights = new THREE.MeshBasicMaterial({ vertexColors: true });

  geo(v: VariantId): VariantGeo {
    let g = this.geos.get(v);
    if (!g) { g = buildVariant(v); this.geos.set(v, g); }
    return g;
  }

  makeSet(v: VariantId, count: number, parked: boolean): CarSet {
    return new CarSet(this.geo(v), parked ? { ...this.mats, lights: this.parkedLights } : this.mats, count);
  }

  setLightLevel(lv: number) {
    this.mats.lights.color.setScalar(1 + 1.8 * lv);
    this.parkedLights.color.setScalar(1 - 0.85 * lv);
  }

  dispose() {
    for (const g of this.geos.values()) { g.paint.dispose(); g.trim.dispose(); g.glass.dispose(); g.lights.dispose(); }
    for (const m of Object.values(this.mats)) m.dispose();
    this.parkedLights.dispose();
  }
}
