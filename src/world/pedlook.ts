import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Bits de `flags` de cada peatón (se decodifican en el shader de vértices). */
export const F = {
  LONG_SLEEVE: 0, SHORTS: 1, SKIRT: 2, BACKPACK: 3, BAG: 4, CAP: 5, LONG_HAIR: 6, GLASSES: 7, CHILD: 8, PHONE: 9, JACKET: 10, BEARD: 11,
} as const;

const SHIRTS = [0xd9d9d6, 0x2f4f8a, 0xb23a3a, 0x3f7a4f, 0xe0b23c, 0x1f1f24, 0x8a5a9c, 0xe8e2d0, 0x4aa0b8, 0xc96a2a, 0x6b6f75, 0xf1c8d0, 0x2a2f3a, 0x7a8a5a];
const PANTS = [0x23324a, 0x1c1c20, 0x4a5a78, 0x6d5a45, 0x8a8f96, 0x2a3b2f, 0x3a3a40, 0x9a8a6a, 0x30343c];
const SKIN = [0xf1c9a5, 0xe3b48c, 0xc99068, 0x8c5a3d, 0x5e3b27, 0xf5d7bd, 0xdcae88];
const HAIR = [0x2b2118, 0x4a3220, 0x1a1a1a, 0x8a6a3a, 0xb59a6a, 0x6a3a22, 0x2b2118, 0x1a1a1a, 0xc4c4c4];
const ACC = [0x2b2b30, 0x8a2b2b, 0x2d4f8c, 0x5b4a3a, 0x3b6b4a, 0xc8b79a, 0x1f1f24];

/** Paleta única que recibe el shader: camisetas, pantalones, piel, pelo y complementos, uno detrás de otro. */
export const PALETTE = [...SHIRTS, ...PANTS, ...SKIN, ...HAIR, ...ACC];
export const PAL_OFF = { shirt: 0, pants: SHIRTS.length, skin: SHIRTS.length + PANTS.length, hair: SHIRTS.length + PANTS.length + SKIN.length, acc: SHIRTS.length + PANTS.length + SKIN.length + HAIR.length };

/** Índices en PALETTE de cada color del peatón. */
export interface Look {
  shirt: number; pants: number; skin: number; hair: number; acc: number;
  flags: number;
  /** escala del cuerpo: ancho, alto, fondo */
  scale: [number, number, number];
  /** multiplicador de la velocidad de paseo */
  speed: number;
  child: boolean;
}

const pickI = (n: number): number => Math.floor(Math.random() * n);

/** Un aspecto al azar: adulto, niño o mayor, con ropa, pelo y complementos distintos. */
export function randomLook(): Look {
  const r = Math.random();
  const child = r < 0.09, elder = !child && r < 0.22;
  let flags = 0;
  const set = (bit: number, p: number) => { if (Math.random() < p) flags |= 1 << bit; };
  set(F.LONG_SLEEVE, 0.45); set(F.SHORTS, child ? 0.5 : 0.22); set(F.LONG_HAIR, child ? 0.3 : 0.28); set(F.GLASSES, 0.12);
  set(F.CAP, child ? 0.25 : 0.1); set(F.JACKET, 0.25); set(F.BEARD, child ? 0 : 0.14);
  if (!(flags & (1 << F.SHORTS))) set(F.SKIRT, child ? 0.1 : 0.09);
  if (flags & (1 << F.SKIRT)) flags &= ~(1 << F.BEARD);
  const bag = Math.random();
  if (bag < (child ? 0.45 : 0.14)) flags |= 1 << F.BACKPACK; else if (bag < 0.28) flags |= 1 << F.BAG;
  if (!child && !elder && Math.random() < 0.14) flags |= 1 << F.PHONE;
  if (child) flags |= 1 << F.CHILD;
  const hair = PAL_OFF.hair + (elder && Math.random() < 0.8 ? HAIR.length - 1 : pickI(HAIR.length - 1));
  const h = child ? 0.62 + Math.random() * 0.16 : elder ? 0.93 + Math.random() * 0.07 : 0.94 + Math.random() * 0.14;
  const w = child ? 0.86 : 0.88 + Math.random() * 0.3;
  return {
    shirt: PAL_OFF.shirt + pickI(SHIRTS.length), pants: PAL_OFF.pants + pickI(PANTS.length), skin: PAL_OFF.skin + pickI(SKIN.length), hair, acc: PAL_OFF.acc + pickI(ACC.length), flags,
    scale: [w * (child ? h / 0.9 : 1), h, 0.94 + Math.random() * 0.18], speed: child ? 1.05 : elder ? 0.68 : 0.9 + Math.random() * 0.3, child,
  };
}

/** Atributos por vértice (empaquetados en dos vec3 para no pasar de los 16 que admite el hardware):
 *  aMeta = (parte de color, puerta del complemento, tipo de miembro) · aMeta2 = (lado del miembro, pivote, cabeza). */
function part(g: THREE.BufferGeometry, c: number, o: { part?: number; gate?: number; kind?: number; limb?: number; pivot?: number; head?: number }): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3), m1 = new Float32Array(n * 3), m2 = new Float32Array(n * 3);
  const k = new THREE.Color(c);
  for (let i = 0; i < n; i++) {
    col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b;
    m1[i * 3] = o.part ?? 0; m1[i * 3 + 1] = o.gate ?? 0; m1[i * 3 + 2] = o.kind ?? 0;
    m2[i * 3] = o.limb ?? 0; m2[i * 3 + 1] = o.pivot ?? 0; m2[i * 3 + 2] = o.head ?? 0;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aMeta', new THREE.BufferAttribute(m1, 3));
  ng.setAttribute('aMeta2', new THREE.BufferAttribute(m2, 3));
  return ng;
}

// aPart: 0 color fijo · 1 camiseta · 2 pantalón · 3 pierna baja (pantalón o piel si lleva shorts) · 4 pelo · 5 piel · 6 complemento · 7 antebrazo (manga o piel)
// aKind: 0 cuerpo · 1 brazo · 2 pierna · 3 pierna baja · 4 antebrazo        aGate: 0 siempre, n = solo si el bit (n-1) del peatón está activo
export function buildPedGeometry(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const HIP = 0.9, KNEE = 0.5, SHOULDER = 1.46, ELBOW = 1.2;
  for (const [x, limb] of [[-0.1, 1], [0.1, -1]] as [number, number][]) {
    P.push(part(new THREE.CylinderGeometry(0.083, 0.068, 0.42, 8).translate(x, 0.71, 0), 0, { part: 2, kind: 2, limb, pivot: HIP }));                    // muslo
    P.push(part(new THREE.CylinderGeometry(0.064, 0.05, 0.42, 8).translate(x, 0.29, 0), 0, { part: 3, kind: 3, limb, pivot: HIP }));                    // pantorrilla
    P.push(part(new THREE.BoxGeometry(0.11, 0.07, 0.25).translate(x, 0.035, 0.05), 0x1b1b1d, { kind: 3, limb, pivot: HIP }));                           // zapato
  }
  P.push(part(new THREE.CylinderGeometry(0.2, 0.17, 0.6, 10).scale(1, 1, 0.62).translate(0, 1.2, 0), 0, { part: 1 }));                                   // torso
  P.push(part(new THREE.CylinderGeometry(0.18, 0.19, 0.22, 10).scale(1, 1, 0.64).translate(0, 0.96, 0), 0, { part: 2 }));                                // cadera
  P.push(part(new THREE.CylinderGeometry(0.205, 0.215, 0.24, 10).scale(1, 1, 0.66).translate(0, 1.0, 0), 0x2a2a30, { part: 1, gate: F.JACKET + 1 }));   // bajo de la chaqueta
  for (const [x, limb] of [[-0.265, -1], [0.265, 1]] as [number, number][]) {
    P.push(part(new THREE.CylinderGeometry(0.052, 0.046, 0.3, 7).translate(x, 1.31, 0), 0, { part: 1, kind: 1, limb, pivot: SHOULDER }));                 // brazo
    P.push(part(new THREE.CylinderGeometry(0.046, 0.04, 0.27, 7).translate(x, 1.06, 0), 0, { part: 7, kind: 4, limb, pivot: SHOULDER }));               // antebrazo
    P.push(part(new THREE.SphereGeometry(0.052, 7, 6).translate(x, 0.9, 0), 0, { part: 5, kind: 4, limb, pivot: SHOULDER }));                           // mano
  }
  P.push(part(new THREE.BoxGeometry(0.06, 0.12, 0.02).translate(0.265, 0.95, 0.07), 0x15171b, { kind: 4, limb: 1, pivot: SHOULDER, gate: F.PHONE + 1 }));  // móvil
  // faldas
  P.push(part(new THREE.CylinderGeometry(0.19, 0.27, 0.36, 12).translate(0, 0.72, 0), 0, { part: 2, gate: F.SKIRT + 1 }));
  // cabeza y cuello
  P.push(part(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 7).translate(0, 1.56, 0), 0, { part: 5, head: 1 }));
  P.push(part(new THREE.SphereGeometry(0.112, 12, 9).scale(0.95, 1.18, 1.05).translate(0, 1.67, 0), 0, { part: 5, head: 1 }));
  P.push(part(new THREE.SphereGeometry(0.02, 5, 4).translate(0, 1.66, 0.12), 0, { part: 5, head: 1 }));                                                   // nariz
  P.push(part(new THREE.SphereGeometry(0.119, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.56).scale(1, 1.12, 1.12).translate(0, 1.69, -0.012), 0, { part: 4, head: 1 })); // pelo corto
  P.push(part(new THREE.BoxGeometry(0.2, 0.26, 0.09).translate(0, 1.6, -0.1), 0, { part: 4, head: 1, gate: F.LONG_HAIR + 1 }));                          // pelo largo
  P.push(part(new THREE.BoxGeometry(0.2, 0.05, 0.03).translate(0, 1.685, 0.1), 0x0d0d10, { head: 1, gate: F.GLASSES + 1 }));                            // gafas de sol
  P.push(part(new THREE.SphereGeometry(0.09, 8, 6, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45).scale(1.2, 1, 1).translate(0, 1.6, 0.06), 0, { part: 4, head: 1, gate: F.BEARD + 1 }));   // barba
  P.push(part(new THREE.SphereGeometry(0.125, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(1, 0.9, 1.1).translate(0, 1.71, -0.005), 0, { part: 6, head: 1, gate: F.CAP + 1 }));   // gorra
  P.push(part(new THREE.BoxGeometry(0.17, 0.014, 0.1).translate(0, 1.72, 0.13), 0, { part: 6, head: 1, gate: F.CAP + 1 }));
  // complementos
  P.push(part(new THREE.BoxGeometry(0.28, 0.36, 0.13).translate(0, 1.22, -0.17), 0, { part: 6, gate: F.BACKPACK + 1 }));
  P.push(part(new THREE.BoxGeometry(0.22, 0.17, 0.08).translate(0.3, 0.98, 0.0), 0, { part: 6, gate: F.BAG + 1 }));
  P.push(part(new THREE.BoxGeometry(0.02, 0.5, 0.02).translate(0.2, 1.22, 0.0).rotateZ(-0.35), 0x1b1b1d, { gate: F.BAG + 1 }));
  return mergeGeometries(P, false)!;
}

/** Shader de vértices: colores por paleta, complementos con puerta, animación de paso (brazos, rodillas, cadera, cabeza) y escala de la cabeza en niños. */
export function patchPedMaterial(mat: THREE.MeshStandardMaterial, timeU: { value: number }) {
  const pal = PALETTE.map((h) => new THREE.Color(h));
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.uniforms.uPal = { value: pal };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aMeta; attribute vec3 aMeta2; attribute vec4 aLook; attribute vec4 aMisc;
        uniform float uTime; uniform vec3 uPal[${PALETTE.length}];
        float fbit(float f, float b) { return mod(floor(f / exp2(b)), 2.0); }
        void rotX(inout vec3 p, float piv, float a) { float c = cos(a), s = sin(a); float yy = p.y - piv; float nz = p.z * c + yy * s; p.y = piv + yy * c - p.z * s; p.z = nz; }`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        float aPart = aMeta.x, aGate = aMeta.y, aKind = aMeta.z, aLimb = aMeta2.x, aPivot = aMeta2.y, aHead = aMeta2.z;
        float aFlags = aMisc.y, aPhase = aMisc.z, aSpd = aMisc.w;
        vec3 cShirt = uPal[int(aLook.x)], cPants = uPal[int(aLook.y)], cSkin = uPal[int(aLook.z)], cHair = uPal[int(aLook.w)], cAcc = uPal[int(aMisc.x)];
        if (aPart > 6.5) vColor.xyz = fbit(aFlags, 0.0) > 0.5 ? cShirt : cSkin;
        else if (aPart > 5.5) vColor.xyz = cAcc;
        else if (aPart > 4.5) vColor.xyz = cSkin;
        else if (aPart > 3.5) vColor.xyz = cHair;
        else if (aPart > 2.5) vColor.xyz = fbit(aFlags, 1.0) > 0.5 ? cSkin : cPants;
        else if (aPart > 1.5) vColor.xyz = cPants;
        else if (aPart > 0.5) vColor.xyz = cShirt;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aGate > 0.5 && fbit(aFlags, aGate - 1.0) < 0.5) transformed = vec3(0.0);
        float ph = uTime * 7.0 * aSpd + aPhase;
        float amp = min(aSpd, 1.0);
        float sw = sin(ph) * 0.62 * aLimb * amp;
        float bob = abs(sin(ph)) * 0.022 * amp;
        bool phone = fbit(aFlags, 9.0) > 0.5 && aLimb > 0.5;
        if (aHead > 0.5 && fbit(aFlags, 8.0) > 0.5) transformed = vec3(0.0, 1.55, 0.0) + (transformed - vec3(0.0, 1.55, 0.0)) * 1.28;
        if (aKind > 2.5 && aKind < 3.5) rotX(transformed, 0.5, max(0.0, -sw) * 1.25);               // rodilla: se dobla al adelantar la pierna
        if (aKind > 3.5) rotX(transformed, 1.18, phone ? -1.25 : -max(0.0, -sw) * 0.8 - 0.12 * amp);   // codo
        if (aKind > 0.5 && aKind < 1.5 || aKind > 3.5) rotX(transformed, aPivot, phone ? -0.5 : sw);  // hombro
        else if (aKind > 1.5) rotX(transformed, aPivot, sw);                                             // cadera
        transformed.y += bob;`);
  };
}
