import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { buildSignCells, CELL_LOGO, CELL_STAR, CELL_WHEEL, createSignAtlas, SIGN_COLS, type CellSpec } from './busSigns';
export type VariantId = 'sedan' | 'hatch' | 'suv' | 'van' | 'taxi' | 'bus' | 'police' | 'ambulance' | 'fire';
export const VARIANT_IDS: VariantId[] = ['sedan', 'hatch', 'suv', 'van', 'taxi', 'bus', 'police', 'ambulance', 'fire'];
/** Variantes que circulan (las de emergencia solo se aparcan junto a sus edificios). */
export const MOVING_IDS: VariantId[] = ['sedan', 'hatch', 'suv', 'van', 'taxi', 'bus'];
/** Largo aproximado (m) de cada variante: separaciones al seguir y colisiones. */
export const VARIANT_LEN: Record<VariantId, number> = { sedan: 4.3, hatch: 4.0, suv: 4.55, van: 5.1, taxi: 4.3, bus: 17.8, police: 4.3, ambulance: 5.1, fire: 9.2 };

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
  wheelZ: number[]; wheelR: number; track: number;
  hwMid: number;                       // semiancho de la carrocería a media altura (para pegar detalles)
  doors: number[];                     // z de las juntas de las puertas
  front: number; rear: number;         // z de morro y cola
  headY: number; tailY: number; plateY: number;
  mirrorZ: number; mirrorY: number;
  roofSign?: boolean; bus?: boolean; van?: boolean;
  /** barra de luces en el techo, franja lateral de color y escalera (emergencias) */
  lightBar?: boolean; stripe?: number[]; ladder?: boolean;
}

const SPECS: Record<VariantId, Spec> = {
  police: null as unknown as Spec, ambulance: null as unknown as Spec, fire: null as unknown as Spec,
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
  // autobús urbano articulado (Mercedes Citaro G de Masatusa/SubÚs): 17,8 m, tres ejes, fuelle entre los dos cuerpos
  bus: {
    st: [[-8.9, 1.2, 0.5, 2.6], [-8.7, 1.28, 0.4, 3.0], [-7.0, 1.28, 0.36, 3.05], [7.0, 1.28, 0.36, 3.05], [8.6, 1.2, 0.4, 2.7], [8.9, 1.0, 0.5, 2.2]],
    cab: [[1.05, -8.6, 8.5, 1.3], [1.6, -8.6, 8.5, 1.3], [2.4, -8.55, 8.4, 1.3]],
    wheelZ: [-6.3, -1.6, 5.6], wheelR: 0.5, track: 1.12, hwMid: 1.28, doors: [4.6, 1.2, -3.6], front: 8.9, rear: -8.9, headY: 0.85, tailY: 1.0, plateY: 0.7, mirrorZ: 8.3, mirrorY: 2.0, bus: true,
  },
};

SPECS.police = { ...SPECS.sedan, lightBar: true, stripe: [0.08, 0.2, 0.62] };
SPECS.ambulance = { ...SPECS.van, lightBar: true, stripe: [0.85, 0.12, 0.1] };
SPECS.fire = {
  st: [[-4.6, 1.2, 0.5, 2.9], [-4.4, 1.25, 0.4, 3.1], [-3.0, 1.25, 0.4, 3.15], [3.0, 1.25, 0.4, 3.15], [3.8, 1.2, 0.45, 2.9], [4.5, 1.0, 0.5, 2.3]],
  cab: [[1.6, 2.9, 4.3, 1.2], [2.2, 3.0, 4.2, 1.15], [2.75, 3.15, 4.0, 1.05]],
  wheelZ: [-2.8, 2.9], wheelR: 0.55, track: 1.1, hwMid: 1.25, doors: [2.6], front: 4.6, rear: -4.6, headY: 0.9, tailY: 1.2, plateY: 0.8, mirrorZ: 3.9, mirrorY: 2.0,
  van: true, lightBar: true, stripe: [0.95, 0.95, 0.9], ladder: true,
};

interface VariantGeo {
  paint: THREE.BufferGeometry; trim: THREE.BufferGeometry; glass: THREE.BufferGeometry;
  /** faros (y rótulo del autobús) */ lights: THREE.BufferGeometry;
  /** pilotos traseros */ tail: THREE.BufferGeometry;
  /** intermitentes izquierdos / derechos (esquina delantera y trasera) */ sigL: THREE.BufferGeometry; sigR: THREE.BufferGeometry;
  /** faros + pilotos juntos (coches aparcados) */ lightsAll: THREE.BufferGeometry;
  /** rótulo LED de destino (solo autobús) */ sign: THREE.BufferGeometry | null;
}

/**
 * Vehículo modelado por secciones (eje largo +Z): carrocería redondeada, cabina inclinada con cristal reflectante, techo,
 * ruedas con llanta y pasos de rueda, juntas de puertas, pilar B, parachoques, faros, pilotos, retrovisores y matrículas.
 * Devuelve cuatro mallas: pintura (se tiñe), accesorios, cristal y luces.
 */
/** Plano con textura de una celda del atlas: `sel` = celda fija (>= 0) o -1 rótulo de línea, -2 número de línea, -3 matrícula; u0..u1 = franja de la celda. */
function atlasPlane(w: number, h: number, u0: number, u1: number, sel: number, place: (g: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
  g.setAttribute('aSel', new THREE.BufferAttribute(new Float32Array(4).fill(sel), 1));
  place(g);
  return g;
}

/** Planos con texto del autobús: rótulo de destino y número (frontal, lateral y trasero), matrículas, logotipos SubÚs, accesibilidad y estrella. */
function buildBusPlanes(sp: Spec): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const hw = sp.hwMid + 0.034, F = sp.front, R = sp.rear;
  P.push(atlasPlane(1.52, 0.24, 0, 1, -1, (g) => g.translate(0, 2.62, F + 0.062)));                                   // rótulo de destino
  P.push(atlasPlane(0.46, 0.105, 0.25, 0.75, -3, (g) => g.translate(0, 0.62, F + 0.075)));                           // matrícula delantera
  P.push(atlasPlane(0.3, 0.3, 0.4375, 0.5625, CELL_STAR, (g) => g.translate(0, 1.22, F + 0.078)));                   // estrella
  P.push(atlasPlane(0.9, 0.2, 0.3, 0.7, -2, (g) => g.rotateY(Math.PI).translate(0, 2.52, R - 0.045)));                // número trasero
  P.push(atlasPlane(0.46, 0.105, 0.25, 0.75, -3, (g) => g.rotateY(Math.PI).translate(0, 0.72, R - 0.082)));           // matrícula trasera
  for (const sx of [1, -1]) {
    const ry = sx * Math.PI / 2;
    P.push(atlasPlane(0.95, 0.22, 0.3, 0.7, -2, (g) => g.rotateY(ry).translate(sx * hw, 2.28, F - 1.0)));             // número en el lateral (junto al parabrisas)
    P.push(atlasPlane(1.9, 0.38, 0.25, 0.75, CELL_LOGO, (g) => g.rotateY(ry).translate(sx * hw, 0.84, -2.4)));        // logotipo SubÚs en el cuerpo
  }
  P.push(atlasPlane(0.3, 0.3, 0.4375, 0.5625, CELL_WHEEL, (g) => g.rotateY(Math.PI / 2).translate(hw, 1.1, 5.9)));    // accesibilidad junto a la puerta delantera
  return mergeGeometries(P, false)!;
}

function buildVariant(id: VariantId): VariantGeo {
  const sp = SPECS[id];
  const paint: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], lights: THREE.BufferGeometry[] = [], tail: THREE.BufferGeometry[] = [], sigL: THREE.BufferGeometry[] = [], sigR: THREE.BufferGeometry[] = [];
  const NB = 12;
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
    tail.push(colorVerts(flatBox(sp.bus ? 0.4 : 0.38, 0.12, 0.09, sx * sp.hwMid * 0.7, sp.tailY, sp.rear + 0.08), [0.85, 0.06, 0.06]));
    const sg = sx < 0 ? sigL : sigR;                                                                               // intermitentes ámbar en las cuatro esquinas
    sg.push(colorVerts(flatBox(0.16, 0.08, 0.07, sx * sp.hwMid * 0.9, sp.headY - 0.1, sp.front - 0.05), [1, 0.62, 0.08]));
    sg.push(colorVerts(flatBox(0.16, 0.08, 0.07, sx * sp.hwMid * 0.9, sp.tailY + 0.12, sp.rear + 0.05), [1, 0.62, 0.08]));
    paint.push(flatBox(0.12, 0.09, 0.2, sx * (sp.hwMid + 0.07), sp.mirrorY, sp.mirrorZ));
    for (const sz of sp.wheelZ) {
      trim.push(colorVerts(cyl(sp.wheelR, 0.24, sx * sp.track, sp.wheelR, sz, 10), [0.03, 0.03, 0.035]));
      trim.push(colorVerts(cyl(sp.wheelR * 0.62, 0.26, sx * (sp.track + 0.005), sp.wheelR, sz, 8), [0.66, 0.68, 0.7]));
      trim.push(colorVerts(cyl(sp.wheelR * 1.28, 0.03, sx * (x0 - 0.012), sp.wheelR * 1.05, sz, 8), [0.015, 0.015, 0.02]));      // paso de rueda
    }
    for (const dz of sp.doors) trim.push(colorVerts(flatBox(0.02, sp.bus ? 1.6 : 0.6, 0.025, sx * x0, sp.bus ? 1.3 : 0.64, dz), [0.07, 0.07, 0.08]));   // junta de puerta
    if (!sp.bus) trim.push(colorVerts(flatBox(0.03, 0.44, 0.08, sx * (sp.cab[1][3] + 0.01), sp.cab[1][0] + 0.02, (sp.cab[1][1] + sp.cab[1][2]) / 2 - 0.1), dark));       // pilar B
  }
  if (!sp.bus) {
    trim.push(colorVerts(flatBox(0.46, 0.11, 0.03, 0, sp.plateY, sp.rear - 0.005), [0.93, 0.93, 0.9]));         // matrícula trasera
    trim.push(colorVerts(flatBox(0.46, 0.11, 0.03, 0, 0.46, sp.front + 0.02), [0.93, 0.93, 0.9])); // matrícula delantera
  }
  if (sp.roofSign) trim.push(colorVerts(flatBox(0.55, 0.15, 0.24, 0, roofR[0][1] + 0.14, (sp.cab[3][1] + sp.cab[3][2]) / 2), [0.98, 0.92, 0.55]));
  if (sp.bus) {
    // librea de Alicante (rojo intenso: los colores de vértice son lineales, por eso el valor es tan bajo): cuerpo blanco (la «pintura» se tiñe de blanco) con frontal, zaga, zócalo y bandas de puertas en rojo
    const RED = [0.72, 0.005, 0.012], GREYB = [0.18, 0.19, 0.21];
    const hw = sp.hwMid + 0.012;
    for (const sx of [-1, 1]) {
      for (const [z0, z1] of [[3.4, 8.8], [-8.8, -5.6]]) trim.push(colorVerts(flatBox(0.03, 0.62, z1 - z0, sx * hw, 0.74, (z0 + z1) / 2), RED));      // zócalo rojo delante y detrás
      trim.push(colorVerts(flatBox(0.03, 0.16, 17.0, sx * hw, 0.5, 0), [0.62, 0.62, 0.64]));                                                        // faldón gris
    }
    for (const dz of [4.6, 1.2, -3.6]) {                                                                                                          // puertas de viajeros (lado derecho) con bandas rojas verticales
      trim.push(colorVerts(flatBox(0.03, 1.9, 1.15, 1.295, 1.55, dz), [0.03, 0.04, 0.05]));
      for (const e of [-0.66, 0.66]) trim.push(colorVerts(flatBox(0.035, 2.2, 0.16, 1.3, 1.5, dz + e), RED));
    }
    trim.push(colorVerts(flatBox(sp.hwMid * 2.0, 1.15, 0.07, 0, 0.9, sp.front + 0.012), RED));                                                      // frontal rojo
    trim.push(colorVerts(flatBox(sp.hwMid * 2.0, 0.6, 0.07, 0, 2.62, sp.front + 0.008), RED));                                                      // cenefa roja sobre el parabrisas
    trim.push(colorVerts(flatBox(sp.hwMid * 2.0, 1.95, 0.07, 0, 1.5, sp.rear - 0.012), RED));                                                       // zaga roja
    trim.push(colorVerts(flatBox(2.0, 2.2, 1.3, 0, 1.55, -0.2), GREYB));                                                                            // fuelle de la articulación
    trim.push(colorVerts(flatBox(2.4, 0.08, 1.3, 0, 2.7, -0.2), [0.3, 0.3, 0.33]));
    trim.push(colorVerts(flatBox(1.6, 0.3, 0.05, 0, 2.62, sp.front + 0.03), [0.02, 0.02, 0.02]));                                                  // marco del rótulo de destino (el texto LED es una malla aparte)
    trim.push(colorVerts(flatBox(0.9, 0.12, 0.7, 0, roofR[0][1] + 0.18, -3.0), [0.7, 0.7, 0.72]));                                                // aire acondicionado en el techo
    trim.push(colorVerts(flatBox(0.9, 0.12, 0.7, 0, roofR[0][1] + 0.18, 3.5), [0.7, 0.7, 0.72]));
  } else if (!sp.van) {
    trim.push(colorVerts(flatBox(0.025, 0.2, 0.025, 0.4, roofR[0][1] + 0.14, sp.cab[3][1] + 0.1), dark));   // antena
  }
  if (sp.stripe) {                                                                                      // franja lateral
    const zc = sp.van ? 0.4 : -0.1, ln = id === 'fire' ? 6.4 : sp.van ? 3.8 : 2.4;
    for (const sx of [-1, 1]) trim.push(colorVerts(flatBox(0.02, 0.2, ln, sx * (sp.hwMid + 0.01), id === 'fire' ? 1.3 : 0.7, id === 'fire' ? 0 : zc), sp.stripe));
  }
  if (sp.lightBar) {                                                                                     // barra de luces: azul y rojo
    const ry = roofR[0][1] + 0.12, rz = id === 'fire' ? 3.5 : sp.van ? 1.5 : (sp.cab[3][1] + sp.cab[3][2]) / 2;
    trim.push(colorVerts(flatBox(0.9, 0.07, 0.3, 0, ry, rz), [0.12, 0.12, 0.14]));
    lights.push(colorVerts(flatBox(0.42, 0.11, 0.26, -0.22, ry + 0.08, rz), [0.1, 0.25, 1.0]));
    lights.push(colorVerts(flatBox(0.42, 0.11, 0.26, 0.22, ry + 0.08, rz), [1.0, 0.1, 0.1]));
  }
  if (sp.ladder) {                                                                                       // escalera y cuerpo de bomba
    trim.push(colorVerts(flatBox(0.5, 0.18, 6.4, 0, 3.3, -0.9), [0.72, 0.72, 0.75]));
    trim.push(colorVerts(flatBox(1.6, 0.9, 5.0, 0, 3.35, -1.5), [0.8, 0.12, 0.1]));
  }
  return {
    paint: mergeGeometries(paint, false)!, trim: mergeGeometries(trim, false)!,
    glass: mergeGeometries(glass, false)!, lights: mergeGeometries(lights, false)!, tail: mergeGeometries(tail, false)!,
    sigL: mergeGeometries(sigL, false)!, sigR: mergeGeometries(sigR, false)!, lightsAll: mergeGeometries([...lights, ...tail], false)!,
    sign: sp.bus ? buildBusPlanes(sp) : null,
  };
}

/** Mallas instanciadas de un vehículo (pintura teñida, accesorios, cristal y luces) que comparten matrices.
 *  Los coches en marcha llevan además pilotos (más brillo al frenar) e intermitentes que parpadean; los aparcados, las luces fijas. */
export class CarSet {
  readonly paint: THREE.InstancedMesh;
  readonly trim: THREE.InstancedMesh;
  readonly glass: THREE.InstancedMesh;
  readonly lights: THREE.InstancedMesh;
  readonly tail: THREE.InstancedMesh | null;
  readonly sigL: THREE.InstancedMesh | null;
  readonly sigR: THREE.InstancedMesh | null;
  /** rótulo LED de destino del autobús (celda del atlas por instancia) */
  readonly sign: THREE.InstancedMesh | null;
  private signCells: THREE.InstancedBufferAttribute | null = null;
  private plateCells: THREE.InstancedBufferAttribute | null = null;
  private tmpC = new THREE.Color();
  constructor(g: VariantGeo, mats: { paint: THREE.Material; trim: THREE.Material; glass: THREE.Material; lights: THREE.Material; sign?: THREE.Material }, count: number, moving: boolean, shadow = true) {
    this.paint = new THREE.InstancedMesh(g.paint, mats.paint, count);
    this.trim = new THREE.InstancedMesh(g.trim, mats.trim, count);
    this.glass = new THREE.InstancedMesh(g.glass, mats.glass, count);
    this.lights = new THREE.InstancedMesh(moving ? g.lights : g.lightsAll, mats.lights, count);
    this.tail = moving ? new THREE.InstancedMesh(g.tail, mats.lights, count) : null;
    this.sigL = moving ? new THREE.InstancedMesh(g.sigL, mats.lights, count) : null;
    this.sigR = moving ? new THREE.InstancedMesh(g.sigR, mats.lights, count) : null;
    if (g.sign && mats.sign) {
      const geo = g.sign.clone();
      this.signCells = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      this.plateCells = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
      geo.setAttribute('aCell', this.signCells);
      geo.setAttribute('aPlate', this.plateCells);
      this.sign = new THREE.InstancedMesh(geo, mats.sign, count);
    } else this.sign = null;
    for (const m of this.all()) { m.frustumCulled = false; m.castShadow = shadow && !(m === this.lights || m === this.tail || m === this.sigL || m === this.sigR || m === this.sign); }
  }
  private all(): THREE.InstancedMesh[] { return [this.paint, this.trim, this.glass, this.lights, ...(this.tail ? [this.tail, this.sigL!, this.sigR!] : []), ...(this.sign ? [this.sign] : [])]; }
  /** Celda del atlas de rótulos que muestra la instancia i (0 = fuera de servicio, 1 = ALICANTE, …). */
  setSign(i: number, cell: number) { if (this.signCells) this.signCells.setX(i, cell); }
  /** Celda del atlas con la matrícula de la instancia i. */
  setPlate(i: number, cell: number) { if (this.plateCells) this.plateCells.setX(i, cell); }
  /** tailK: brillo de los pilotos (1 normal, más al frenar); sigL/sigR: 1 = intermitente encendido. */
  set(i: number, m: THREE.Matrix4, color: THREE.Color, tailK = 1, sigL = 0, sigR = 0) {
    for (const x of this.all()) x.setMatrixAt(i, m);
    this.paint.setColorAt(i, color);
    if (this.tail) {
      this.tail.setColorAt(i, this.tmpC.setScalar(tailK));
      this.sigL!.setColorAt(i, this.tmpC.setScalar(sigL * 2.4));
      this.sigR!.setColorAt(i, this.tmpC.setScalar(sigR * 2.4));
    }
  }
  get count() { return this.paint.count; }
  set count(n: number) { for (const x of this.all()) x.count = n; }
  flush() {
    for (const m of this.all()) m.instanceMatrix.needsUpdate = true;
    for (const m of [this.paint, this.tail, this.sigL, this.sigR]) if (m?.instanceColor) m.instanceColor.needsUpdate = true;
    if (this.signCells) this.signCells.needsUpdate = true;
    if (this.plateCells) this.plateCells.needsUpdate = true;
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
    /** rótulo LED: sin iluminación, con la celda del atlas elegida por instancia (atributo aCell) */
    sign: new THREE.MeshBasicMaterial({ toneMapped: false }),
  };
  private signUniforms = { uRows: { value: 1 }, uCols: { value: SIGN_COLS } };

  constructor() {
    const mat = this.mats.sign;
    mat.customProgramCacheKey = () => 'bus-sign';
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uRows = this.signUniforms.uRows;
      sh.uniforms.uCols = this.signUniforms.uCols;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCell; attribute float aPlate; attribute float aSel; varying float vCell;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCell = aSel >= -0.5 ? aSel : (aSel > -1.5 ? aCell : (aSel > -2.5 ? aCell + 1.0 : aPlate));');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCell; uniform float uRows; uniform float uCols;')
        .replace('#include <map_fragment>', `
          float sRow = floor((vCell + 0.5) / uCols);
          float sCol = vCell - sRow * uCols;
          vec2 suv = vec2((sCol + vMapUv.x) / uCols, 1.0 - (sRow + (1.0 - vMapUv.y)) / uRows);
          diffuseColor *= texture2D(map, suv);`);
    };
    this.setBusSigns([]);
  }

  /** (Re)genera el atlas de rótulos con los textos dados (celda 0 = fuera de servicio, 1 = sin línea). */
  setBusSigns(cells: CellSpec[]) {
    const { texture, rows } = createSignAtlas(cells);
    this.mats.sign.map?.dispose();
    this.mats.sign.map = texture;
    this.mats.sign.needsUpdate = true;
    this.signUniforms.uRows.value = rows;
  }
  /** Luces de los coches aparcados (se apagan de noche). */
  readonly parkedLights = new THREE.MeshBasicMaterial({ vertexColors: true });

  geo(v: VariantId): VariantGeo {
    let g = this.geos.get(v);
    if (!g) { g = buildVariant(v); this.geos.set(v, g); }
    return g;
  }

  makeSet(v: VariantId, count: number, parked: boolean, shadow = true): CarSet {
    return new CarSet(this.geo(v), parked ? { ...this.mats, lights: this.parkedLights } : this.mats, count, !parked, shadow);
  }

  setLightLevel(lv: number) {
    this.mats.lights.color.setScalar(1 + 1.8 * lv);
    this.mats.sign.color.setScalar(1 + 1.2 * lv);
    this.parkedLights.color.setScalar(1 - 0.85 * lv);
  }

  dispose() {
    for (const g of this.geos.values()) { g.paint.dispose(); g.trim.dispose(); g.glass.dispose(); g.lights.dispose(); g.tail.dispose(); g.sigL.dispose(); g.sigR.dispose(); g.lightsAll.dispose(); g.sign?.dispose(); }
    for (const m of Object.values(this.mats)) m.dispose();
    this.parkedLights.dispose();
  }
}
