import * as THREE from 'three';

/**
 * Geometría procedimental de un GT: carrocería moldeada por secciones transversales (loft),
 * con pasos de rueda reales, capó con "power dome", tumblehome y cola truncada.
 * Ejes: morro hacia -Z, cola +Z, derecha +X, arriba +Y, suelo en Y = 0. Unidades: metros (~4,54 m de largo).
 */

/** Curva Catmull-Rom 2D (centrípeta) muestreada: devuelve puntos [x, y]. */
function spline2D(pts: [number, number][], samplesPerSeg: number): [number, number][] {
  const out: [number, number][] = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Interpolación lineal por tramos de una tabla [z, valor]. */
function lerpTable(tbl: [number, number][], z: number): number {
  if (z <= tbl[0][0]) return tbl[0][1];
  for (let i = 1; i < tbl.length; i++) {
    if (z <= tbl[i][0]) {
      const [z0, v0] = tbl[i - 1], [z1, v1] = tbl[i];
      const t = (z - z0) / (z1 - z0);
      const s = t * t * (3 - 2 * t);   // suavizado
      return v0 + (v1 - v0) * s;
    }
  }
  return tbl[tbl.length - 1][1];
}

/** Construye una malla cerrada a partir de anillos (cada anillo = lista de puntos 3D con el mismo nº de puntos). */
function ringsToGeometry(rings: THREE.Vector3[][], capFirst: boolean, capLast: boolean): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
      idx.push(a, b, c, b, d, c);
    }
  }
  const cap = (ringIdx: number, flip: boolean) => {
    const cen = new THREE.Vector3();
    for (const p of rings[ringIdx]) cen.add(p);
    cen.multiplyScalar(1 / n);
    const ci = pos.length / 3;
    pos.push(cen.x, cen.y, cen.z);
    for (let j = 0; j < n; j++) {
      const a = ringIdx * n + j, b = ringIdx * n + ((j + 1) % n);
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  if (capFirst) cap(0, true);
  if (capLast) cap(rings.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Posición de los ejes y radio de rueda (compartidos con createSportsCar). */
export const CAR = {
  wheelR: 0.36,
  wheelW: 0.28,
  frontZ: -1.36,
  rearZ: 1.3,
  frontX: 0.8,
  rearX: 0.82,
  archR: 0.47,
};

/** Estaciones: z → [altura de cubierta en el crestón del aleta, ancho medio máximo, caída del capó respecto al crestón]. */
const DECK: [number, number][] = [
  [-2.27, 0.42], [-2.12, 0.54], [-1.8, 0.70], [-1.5, 0.86], [-1.36, 0.93], [-1.15, 0.90], [-0.7, 0.82], [-0.2, 0.82],
  [0.5, 0.85], [1.0, 0.89], [1.3, 0.92], [1.55, 0.88], [2.0, 0.78], [2.27, 0.64],
];
const WIDTH: [number, number][] = [
  [-2.27, 0.50], [-2.12, 0.68], [-1.8, 0.82], [-1.4, 0.92], [-0.9, 0.90], [-0.2, 0.88],
  [0.6, 0.90], [1.1, 0.96], [1.5, 0.97], [2.0, 0.90], [2.27, 0.80],
];
const DIP: [number, number][] = [   // hundimiento del eje central respecto a las aletas (power dome)
  [-2.27, 0.02], [-1.8, 0.07], [-1.3, 0.09], [-0.7, 0.07], [-0.2, 0.02], [1.0, 0.04], [2.27, 0.02],
];

/** Altura inferior: faldón a 0,2 m con medio punto de arco circular sobre cada rueda. */
function underside(z: number): number {
  let yb = 0.2;
  for (const wz of [CAR.frontZ, CAR.rearZ]) {
    const dz = Math.abs(z - wz);
    if (dz < CAR.archR) yb = Math.max(yb, CAR.wheelR + Math.sqrt(CAR.archR * CAR.archR - dz * dz) * 0.86);
  }
  return yb;
}

function bodySection(z: number): THREE.Vector3[] {
  const yd = lerpTable(DECK, z), ws = lerpTable(WIDTH, z), dip = lerpTable(DIP, z);
  const yb = Math.min(underside(z), yd - 0.12);
  const wt = ws * 0.80;                         // ancho en la cubierta (tumblehome)
  // medio perfil de abajo-centro hacia arriba-centro
  const half: [number, number][] = [
    [0, yb], [ws * 0.78, yb], [ws * 0.97, yb + 0.05], [ws, yb + 0.16], [ws, yd - 0.24],
    [ws * 0.97, yd - 0.12], [(ws + wt) / 2, yd - 0.035], [wt, yd], [wt * 0.55, yd - dip * 0.55], [0, yd - dip],
  ];
  const sm = spline2D(half, 6);
  const full: THREE.Vector3[] = [];
  for (const [x, y] of sm) full.push(new THREE.Vector3(x, y, z));
  for (let i = sm.length - 2; i >= 1; i--) full.push(new THREE.Vector3(-sm[i][0], sm[i][1], z));
  return full;
}

export function createBodyGeometry(): THREE.BufferGeometry {
  const zs: number[] = [];
  for (let z = -2.27; z <= 2.27001; z += 0.05) zs.push(+z.toFixed(3));
  // más estaciones dentro de los arcos de rueda para que el contorno salga redondo
  for (const wz of [CAR.frontZ, CAR.rearZ]) for (let d = -CAR.archR; d <= CAR.archR + 1e-6; d += 0.045) zs.push(+(wz + d).toFixed(3));
  zs.sort((a, b) => a - b);
  const uniq = zs.filter((v, i) => i === 0 || v - zs[i - 1] > 0.012);
  return ringsToGeometry(uniq.map(bodySection), true, true);
}

/** Habitáculo: cristales (caras laterales/frontales) y techo pintado (caras superiores). Devuelve ambos grupos en una geometría con groups [cristal, techo]. */
export function createCabinGeometry(): THREE.BufferGeometry {
  const ROOF: [number, number][] = [[-0.92, 0.80], [-0.62, 0.99], [-0.2, 1.15], [0.35, 1.21], [0.85, 1.15], [1.2, 1.05], [1.42, 0.95], [1.55, 0.83], [1.6, 0.72]];
  const HW: [number, number][] = [[-0.92, 0.74], [-0.6, 0.66], [-0.1, 0.60], [0.5, 0.60], [1.0, 0.63], [1.4, 0.66], [1.6, 0.68]];
  const stations: number[] = [];
  for (let z = -0.92; z <= 1.60001; z += 0.04) stations.push(+z.toFixed(3));
  const base = 0.74;
  const rings = stations.map((z) => {
    const yr = lerpTable(ROOF, z), hw = lerpTable(HW, z);
    const half: [number, number][] = [[0, base], [hw, base], [hw * 0.96, base + (yr - base) * 0.45], [hw * 0.78, yr - 0.07], [hw * 0.4, yr - 0.012], [0, yr]];
    const sm = spline2D(half, 6);
    const full: THREE.Vector3[] = [];
    for (const [x, y] of sm) full.push(new THREE.Vector3(x, y, z));
    for (let i = sm.length - 2; i >= 1; i--) full.push(new THREE.Vector3(-sm[i][0], sm[i][1], z));
    return full;
  });
  const g = ringsToGeometry(rings, true, true);
  // reparte las caras: normal.y > 0.78 → techo pintado (grupo 1); resto → cristal (grupo 0)
  const idx = g.getIndex()!;
  const pos = g.getAttribute('position');
  const glass: number[] = [], roof: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    const ia = idx.getX(i), ib = idx.getX(i + 1), ic = idx.getX(i + 2);
    a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
    n.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    const cy = (a.y + b.y + c.y) / 3;
    (n.y > 0.8 && cy > 1.0 ? roof : glass).push(ia, ib, ic);
  }
  g.setIndex([...glass, ...roof]);
  g.clearGroups();
  g.addGroup(0, glass.length, 0);
  g.addGroup(glass.length, roof.length, 1);
  return g;
}

/** Neumático con flanco redondeado (revolución alrededor del eje X). */
export function createTireGeometry(): THREE.BufferGeometry {
  const R = CAR.wheelR, W = CAR.wheelW, rr = 0.245;      // rr = radio interior de la llanta
  const prof: THREE.Vector2[] = [];
  const bead = 0.04;
  prof.push(new THREE.Vector2(rr, -W / 2 + 0.01));
  prof.push(new THREE.Vector2(rr + bead, -W / 2));
  for (let i = 0; i <= 8; i++) {                      // hombro redondeado
    const t = (i / 8) * Math.PI / 2;
    prof.push(new THREE.Vector2(R - 0.07 + Math.sin(t) * 0.07, -W / 2 + 0.03 + (1 - Math.cos(t)) * 0.03 - 0.0 + 0.0));
  }
  prof.push(new THREE.Vector2(R, -W / 2 + 0.07));
  prof.push(new THREE.Vector2(R, W / 2 - 0.07));
  for (let i = 8; i >= 0; i--) {
    const t = (i / 8) * Math.PI / 2;
    prof.push(new THREE.Vector2(R - 0.07 + Math.sin(t) * 0.07, W / 2 - 0.03 - (1 - Math.cos(t)) * 0.03));
  }
  prof.push(new THREE.Vector2(rr + bead, W / 2));
  prof.push(new THREE.Vector2(rr, W / 2 - 0.01));
  const g = new THREE.LatheGeometry(prof, 32);
  g.rotateZ(Math.PI / 2);   // eje del lathe (Y) → X
  g.computeVertexNormals();
  return g;
}

/** Llanta de 10 radios en forma de Y: una geometría única, orientada con el eje en X. */
export function createRimGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const W = CAR.wheelW;
  const barrel = new THREE.CylinderGeometry(0.245, 0.245, W - 0.04, 28, 1, true); barrel.rotateZ(Math.PI / 2); parts.push(barrel);
  const lip = new THREE.TorusGeometry(0.245, 0.018, 8, 28); lip.rotateY(Math.PI / 2); lip.translate(W / 2 - 0.018, 0, 0); parts.push(lip);
  const lip2 = lip.clone(); lip2.translate(-(W - 0.036), 0, 0); parts.push(lip2);
  const hub = new THREE.CylinderGeometry(0.06, 0.06, W - 0.02, 14); hub.rotateZ(Math.PI / 2); parts.push(hub);
  for (let s = 0; s < 10; s++) {
    const spoke = new THREE.BoxGeometry(0.03, 0.2, 0.034);
    spoke.translate(W / 2 - 0.045, 0.145, 0);       // radio exterior, cerca de la cara
    spoke.rotateX((s / 10) * Math.PI * 2);
    parts.push(spoke);
  }
  const g = mergeAll(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  const prepared = geos.map((g) => {
    const gg = g.index ? g : (() => { const c = g.clone(); const n = c.getAttribute('position').count; c.setIndex(Array.from({ length: n }, (_, i) => i)); return c; })();
    nv += gg.getAttribute('position').count; ni += gg.index!.count;
    return gg;
  });
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of prepared) {
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    pos.set(p.array as ArrayLike<number>, ov * 3);
    if (n) nor.set(n.array as ArrayLike<number>, ov * 3);
    for (let i = 0; i < g.index!.count; i++) idx[oi + i] = g.index!.getX(i) + ov;
    ov += p.count; oi += g.index!.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
