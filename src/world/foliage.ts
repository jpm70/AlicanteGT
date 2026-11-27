import * as THREE from 'three';

/** Pequeño generador pseudoaleatorio determinista (la copa es igual en todos los árboles; la variedad la da la escala, el giro y el tinte de cada uno). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = 128;

/** Atlas de follaje: 4 ramitas con hojas de formas y verdes distintos (fondo transparente) y dos texeles sólidos (verde oscuro del interior y marrón de las ramas). */
export function createFoliageTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = CELL * 2;
  const c = cv.getContext('2d')!;
  const r = mulberry(7);
  const leaf = (x: number, y: number, ang: number, len: number, wid: number, shade: number) => {
    c.save();
    c.translate(x, y); c.rotate(ang);
    const g = c.createLinearGradient(0, -wid, 0, wid);
    const a = 62 + shade * 40, b = 120 + shade * 50, d = 36 + shade * 22;
    g.addColorStop(0, `rgb(${a + 28},${b + 36},${d + 12})`);
    g.addColorStop(0.55, `rgb(${a},${b},${d})`);
    g.addColorStop(1, `rgb(${a - 18},${b - 30},${d - 8})`);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, 0);
    c.bezierCurveTo(len * 0.25, -wid * 1.1, len * 0.75, -wid * 0.9, len, 0);        // hoja lanceolada con punta
    c.bezierCurveTo(len * 0.75, wid * 0.9, len * 0.25, wid * 1.1, 0, 0);
    c.fill();
    c.strokeStyle = `rgba(${a + 50},${b + 62},${d + 30},0.7)`;                          // nervio central
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(len * 0.92, 0); c.stroke();
    c.restore();
  };
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * CELL, oy = Math.floor(k / 2) * CELL;
    c.save();
    c.beginPath(); c.rect(ox, oy, CELL, CELL); c.clip();
    c.translate(ox, oy);
    // tres ramitas que salen del centro, con 6-8 hojas cada una
    for (let t = 0; t < 3; t++) {
      const base = (t / 3) * Math.PI * 2 + r() * 0.8;
      c.strokeStyle = 'rgba(92,70,44,0.9)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(CELL / 2, CELL / 2); c.lineTo(CELL / 2 + Math.cos(base) * 46, CELL / 2 + Math.sin(base) * 46); c.stroke();
      for (let i = 0; i < 7; i++) {
        const s = 0.18 + i * 0.12;
        const px = CELL / 2 + Math.cos(base) * 46 * s, py = CELL / 2 + Math.sin(base) * 46 * s;
        for (const side of [-1, 1]) leaf(px, py, base + side * (0.7 + r() * 0.5), 26 + r() * 14, 7 + r() * 3.5, r());
      }
      leaf(CELL / 2 + Math.cos(base) * 46, CELL / 2 + Math.sin(base) * 46, base, 28, 8, r());
    }
    c.restore();
  }
  c.fillStyle = '#2c5426'; c.fillRect(CELL * 2 - 14, CELL * 2 - 14, 14, 14);       // verde oscuro sólido (interior de la copa)
  c.fillStyle = '#5a4430'; c.fillRect(0, CELL * 2 - 14, 14, 14);                    // marrón sólido (ramas)
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * Copa de árbol de hoja ancha (origen en el centro de la copa, radio ~1,9 m): ~72 tarjetas de follaje con textura de hojas repartidas en capas
 * (más densas y oscuras hacia dentro), un núcleo verde oscuro para que no se vea a través, y varias ramas desde el tronco.
 * Las normales se suavizan hacia fuera de la esfera: la copa se ilumina como una masa de hojas y no como láminas planas.
 */
export function createFoliageGeometry(): THREE.BufferGeometry {
  const r = mulberry(1234);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const R = 1.9;
  const solid = (u: number, v: number): [number, number] => [u, v];
  const DARK_UV = solid(1 - 6 / (CELL * 2), 6 / (CELL * 2)), BROWN_UV = solid(6 / (CELL * 2), 6 / (CELL * 2));
  const push = (p: [number, number, number], n: [number, number, number], u: number, v: number, c: [number, number, number]) => {
    pos.push(...p); nor.push(...n); uv.push(u, v); col.push(...c);
  };
  const v3 = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), nn = new THREE.Vector3(), out = new THREE.Vector3();

  // núcleo oscuro
  const core = new THREE.IcosahedronGeometry(R * 0.66, 1);
  const cp = core.attributes.position, cn = core.attributes.normal;
  const base0 = pos.length / 3;
  for (let i = 0; i < cp.count; i++) push([cp.getX(i), cp.getY(i) * 0.9, cp.getZ(i)], [cn.getX(i), cn.getY(i), cn.getZ(i)], DARK_UV[0], DARK_UV[1], [0.55, 0.6, 0.5]);
  for (let i = 0; i < cp.count; i += 3) idx.push(base0 + i, base0 + i + 1, base0 + i + 2);

  // tarjetas de hojas
  const N = 72;
  for (let i = 0; i < N; i++) {
    const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    out.set(s * Math.cos(a), z * 0.88, s * Math.sin(a)).normalize();
    const rad = R * (0.42 + 0.58 * Math.pow(r(), 0.55));
    v3.copy(out).multiplyScalar(rad);
    nn.copy(out).multiplyScalar(0.75).add(t1.set(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.7)).normalize();
    t1.set(r() - 0.5, r() - 0.5, r() - 0.5).cross(nn).normalize();
    t2.copy(nn).cross(t1).normalize();
    const size = (1.05 + r() * 0.7) * (0.8 + 0.4 * (rad / R));
    const variant = Math.floor(r() * 4), u0 = (variant % 2) * 0.5, vv0 = Math.floor(variant / 2) * 0.5;
    const depth = rad / R;
    const shade = 0.62 + 0.5 * depth * (0.85 + r() * 0.3);
    const c: [number, number, number] = [shade * (0.92 + r() * 0.16), shade * (0.95 + r() * 0.1), shade * (0.85 + r() * 0.15)];
    const sn: [number, number, number] = [(nn.x * 0.35 + out.x * 0.65), (nn.y * 0.35 + out.y * 0.65), (nn.z * 0.35 + out.z * 0.65)];
    const base = pos.length / 3;
    for (const [sx, sy, uu, vv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]] as [number, number, number, number][]) {
      push([v3.x + (t1.x * sx + t2.x * sy) * size * 0.5, v3.y + (t1.y * sx + t2.y * sy) * size * 0.5, v3.z + (t1.z * sx + t2.z * sy) * size * 0.5], sn, u0 + uu * 0.5 * 0.98 + 0.005, vv0 + vv * 0.5 * 0.98 + 0.005, c);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // ramas desde la parte baja del centro hacia fuera
  for (let b = 0; b < 5; b++) {
    const ang = (b / 5) * Math.PI * 2 + 0.4, len = 1.5 + r() * 0.5;
    const top = new THREE.Vector3(Math.cos(ang) * len * 0.75, -0.2 + r() * 0.8, Math.sin(ang) * len * 0.75);
    const bot = new THREE.Vector3(0, -1.5, 0);
    const dir = top.clone().sub(bot), length = dir.length();
    const cyl = new THREE.CylinderGeometry(0.045, 0.085, length, 5, 1, true);
    cyl.translate(0, length / 2, 0);
    cyl.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    cyl.translate(bot.x, bot.y, bot.z);
    const p = cyl.attributes.position, n = cyl.attributes.normal, ix = cyl.index!;
    const base = pos.length / 3;
    for (let i = 0; i < p.count; i++) push([p.getX(i), p.getY(i), p.getZ(i)], [n.getX(i), n.getY(i), n.getZ(i)], BROWN_UV[0], BROWN_UV[1], [1, 1, 1]);
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export function createFoliageMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: createFoliageTexture(), vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.92, metalness: 0 });
}
