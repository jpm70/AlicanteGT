import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Hoja de palmera pinnada: raquis arqueado con foliolos en V que cuelgan hacia fuera. Eje +Z hacia delante, +Y arriba. */
function makeFrond(len: number, pairs: number, leafLen: number, droop: number, rise: number, base: THREE.Color, tip: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3, ca: THREE.Color, cb: THREE.Color, cd: THREE.Color) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
    col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cd.r, cd.g, cd.b);
  };
  const at = (t: number) => new THREE.Vector3(0, rise * t - droop * t * t * len, len * t);
  const tangent = (t: number) => at(Math.min(t + 0.01, 1)).sub(at(Math.max(t - 0.01, 0))).normalize();
  const dark = base.clone().multiplyScalar(0.8);
  // raquis
  const seg = 8;
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg, t1 = (i + 1) / seg;
    const w0 = 0.05 * (1 - t0 * 0.8), w1 = 0.05 * (1 - t1 * 0.8);
    const p0 = at(t0), p1 = at(t1);
    const a = new THREE.Vector3(p0.x - w0, p0.y, p0.z), b = new THREE.Vector3(p0.x + w0, p0.y, p0.z);
    const d = new THREE.Vector3(p1.x - w1, p1.y, p1.z), e = new THREE.Vector3(p1.x + w1, p1.y, p1.z);
    tri(a, b, d, dark, dark, dark);
    tri(b, e, d, dark, dark, dark);
  }
  // foliolos
  for (let k = 0; k < pairs; k++) {
    const t = 0.12 + (k / (pairs - 1)) * 0.86;
    const p = at(t);
    const tan = tangent(t);
    const L = leafLen * Math.pow(Math.sin(Math.PI * Math.min(t * 0.92 + 0.04, 1)), 0.55);
    const w = 0.11;
    c.copy(base).lerp(tip, t);
    for (const side of [-1, 1]) {
      const v = 0.55 - 0.25 * t;                           // apertura en V (más cerrada hacia la punta)
      const out = new THREE.Vector3(side * Math.cos(v) * L, Math.sin(v) * L * 0.55 - L * 0.5, 0.35 * L);
      const tipP = p.clone().add(out);
      const a = p.clone().addScaledVector(tan, -w), b = p.clone().addScaledVector(tan, w);
      tri(a, b, tipP, c, c, c.clone().lerp(tip, 0.5));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Corona: varias hojas repartidas en espiral; las bajas cuelgan y las altas se yerguen. */
function makeCrown(n: number, len: number, pairs: number, leafLen: number, riseBase: number, droopBase: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.Color(0x2f6a2c);
  const tip = new THREE.Color(0x78b04e);
  for (let k = 0; k < n; k++) {
    const u = k / n;
    const f = makeFrond(len * (0.85 + ((k * 37) % 10) / 40), pairs, leafLen, droopBase + (1 - u) * 0.35, riseBase + u * 1.6, base, tip);
    f.rotateX(-(0.3 + (1 - u) * 0.55) + u * 0.5);            // inclinación: las primeras cuelgan, las últimas suben
    f.rotateY(k * 2.399963);                                 // ángulo áureo
    f.translate(0, 0.05 * u, 0);
    parts.push(f);
  }
  const g = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return g;
}

function trunkTexture(kind: 'phoenix' | 'wash'): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 256;
  const c = cv.getContext('2d')!;
  c.fillStyle = kind === 'phoenix' ? '#7c6044' : '#8a735a';
  c.fillRect(0, 0, 128, 256);
  if (kind === 'phoenix') {
    // cicatrices romboidales de las hojas caídas
    for (let y = -10; y < 270; y += 22) {
      for (let x = (Math.floor(y / 22) % 2) * 16; x < 140; x += 32) {
        c.fillStyle = 'rgba(40,28,18,0.55)';
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + 14, y + 11); c.lineTo(x, y + 22); c.lineTo(x - 14, y + 11); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(210,180,140,0.28)'; c.lineWidth = 1.5; c.stroke();
      }
    }
  } else {
    // anillos horizontales y fibras
    for (let y = 0; y < 256; y += 9) {
      c.fillStyle = `rgba(50,38,28,${0.18 + ((y * 7) % 10) / 60})`;
      c.fillRect(0, y, 128, 2.2);
    }
    for (let i = 0; i < 160; i++) {
      c.fillStyle = 'rgba(30,22,16,0.14)';
      c.fillRect(Math.random() * 128, Math.random() * 256, 1.2, 10 + Math.random() * 18);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export interface PalmAssets {
  phoenix: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; trunkMat: THREE.Material; crownMat: THREE.Material };
  wash: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; skirt: THREE.BufferGeometry; trunkMat: THREE.Material; crownMat: THREE.Material; skirtMat: THREE.Material };
  bulbGeo: THREE.BufferGeometry;
}

/** Geometrías y materiales de las dos palmeras típicas de Alicante: Phoenix canariensis (gruesa, copa densa) y Washingtonia (esbelta, con falda). */
export function createPalmAssets(): PalmAssets {
  const trunkP = new THREE.CylinderGeometry(0.3, 0.4, 1, 10, 4);
  const trunkW = new THREE.CylinderGeometry(0.14, 0.21, 1, 8, 4);
  const mapP = trunkTexture('phoenix'); mapP.repeat.set(2, 5);
  const mapW = trunkTexture('wash'); mapW.repeat.set(2, 9);
  const leafMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.62, metalness: 0.02 });
  const skirt = new THREE.CylinderGeometry(0.46, 0.8, 1.5, 10, 1, true);
  return {
    phoenix: {
      trunk: trunkP, crown: makeCrown(22, 3.9, 13, 1.35, 1.1, 0.07),
      trunkMat: new THREE.MeshStandardMaterial({ map: mapP, roughness: 0.95 }), crownMat: leafMat(),
    },
    wash: {
      trunk: trunkW, crown: makeCrown(15, 2.6, 9, 1.05, 0.9, 0.09), skirt,
      trunkMat: new THREE.MeshStandardMaterial({ map: mapW, roughness: 0.95 }), crownMat: leafMat(),
      skirtMat: new THREE.MeshStandardMaterial({ color: 0x8d7a4e, roughness: 1, side: THREE.DoubleSide }),
    },
    bulbGeo: new THREE.SphereGeometry(0.5, 10, 8),
  };
}
