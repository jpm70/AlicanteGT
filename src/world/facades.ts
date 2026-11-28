import * as THREE from 'three';

/**
 * Atlas procedimental de fachadas mediterráneas.
 * 4 estilos (columnas) x 2 filas: planta baja (abajo) y planta tipo (arriba).
 * Cada celda = 1 tramo de 3,2 m x 1 planta de 3,1 m.
 *  - map : color casi blanco (se multiplica por el color del edificio).
 *  - mask: ventanas (blanco) para el brillo nocturno.
 * Estilos: 0 ensanche clásico · 1 moderno · 2 casco antiguo · 3 bloque residencial.
 */
export const FACADE_STYLES = 4;
const CELL = 256;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

type Ctx = CanvasRenderingContext2D;

function plaster(c: Ctx, x: number, y: number, r: () => number) {
  c.fillStyle = '#f2efe9';
  c.fillRect(x, y, CELL, CELL);
  for (let i = 0; i < 700; i++) {
    const v = 222 + Math.floor(r() * 26);
    c.fillStyle = `rgba(${v},${v - 2},${v - 8},0.35)`;
    c.fillRect(x + r() * CELL, y + r() * CELL, 1 + r() * 2, 1 + r() * 2);
  }
}

function glass(c: Ctx, m: Ctx, x: number, y: number, w: number, h: number) {
  const g = c.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#5a6b82');
  g.addColorStop(1, '#27313f');
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  m.fillStyle = '#fff';
  m.fillRect(x, y, w, h);
}

function frame(c: Ctx, x: number, y: number, w: number, h: number, t: number, col: string) {
  c.strokeStyle = col;
  c.lineWidth = t;
  c.strokeRect(x, y, w, h);
}

function drawCell(style: number, ground: boolean, c: Ctx, m: Ctx, ox: number, oy: number, r: () => number) {
  c.save();
  m.save();
  c.translate(ox, oy);
  m.translate(ox, oy);
  plaster(c, 0, 0, r);
  m.fillStyle = '#000';
  m.fillRect(0, 0, CELL, CELL);

  if (style === 0) {
    // ensanche clásico: ventana alta con persiana y balcón de hierro
    if (!ground) {
      const wx = 82, wy = 36, ww = 92, wh = 170;
      c.fillStyle = '#d8d2c6';
      c.fillRect(wx - 10, wy - 12, ww + 20, wh + 24); // moldura
      glass(c, m, wx, wy, ww, wh);
      c.fillStyle = '#4f7a52'; // persiana verde recogida
      c.fillRect(wx, wy, ww, 26);
      for (let i = 0; i < 5; i++) c.fillRect(wx, wy + 30 + i * 5, ww, 1);
      frame(c, wx, wy, ww, wh, 5, '#f3f1ea');
      c.fillStyle = '#f3f1ea';
      c.fillRect(wx + ww / 2 - 2, wy, 4, wh);
      // balcón
      c.fillStyle = '#c9c3b6';
      c.fillRect(wx - 26, 212, ww + 52, 12);
      c.fillStyle = '#2b2b30';
      for (let i = 0; i <= 12; i++) c.fillRect(wx - 24 + i * ((ww + 48) / 12), 178, 3, 34);
      c.fillRect(wx - 26, 176, ww + 52, 4);
      // cornisa
      c.fillStyle = '#ddd7ca';
      c.fillRect(0, 244, CELL, 12);
    } else {
      // planta baja: portal / escaparate
      c.fillStyle = '#cfc8b8';
      c.fillRect(0, 226, CELL, 30); // zócalo
      glass(c, m, 40, 60, 176, 160);
      frame(c, 40, 60, 176, 160, 7, '#3a3a40');
      c.fillStyle = '#b84a3a';
      c.fillRect(24, 28, 208, 30); // toldo
      for (let i = 0; i < 9; i++) {
        c.fillStyle = i % 2 ? '#f1e7d4' : '#b84a3a';
        c.fillRect(24 + i * 23, 28, 23, 30);
      }
    }
  } else if (style === 1) {
    // moderno: ventanal corrido de aluminio y antepecho
    if (!ground) {
      c.fillStyle = '#dedcd6';
      c.fillRect(0, 214, CELL, 42);
      c.fillRect(0, 0, CELL, 22);
      glass(c, m, 14, 44, 228, 140);
      c.fillStyle = '#b9bcc0';
      c.fillRect(14, 44, 228, 5);
      for (let i = 0; i < 3; i++) c.fillRect(14 + i * 76 + 74, 44, 4, 140);
      c.fillRect(14, 180, 228, 4);
      c.fillStyle = 'rgba(190,225,235,0.35)'; // barandilla de cristal
      c.fillRect(8, 186, 240, 34);
    } else {
      glass(c, m, 10, 40, 236, 176);
      for (let i = 0; i < 4; i++) {
        c.fillStyle = '#1f2125';
        c.fillRect(10 + i * 59, 40, 5, 176);
      }
      c.fillStyle = '#26272b';
      c.fillRect(0, 12, CELL, 26);
    }
  } else if (style === 2) {
    // casco antiguo: ventana pequeña con contraventanas de madera
    if (!ground) {
      const wx = 100, wy = 70, ww = 56, wh = 100;
      c.fillStyle = '#e9e3d3';
      c.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
      glass(c, m, wx, wy, ww, wh);
      c.fillStyle = '#6a4a2e';
      c.fillRect(wx - 28, wy - 4, 26, wh + 8);
      c.fillRect(wx + ww + 2, wy - 4, 26, wh + 8);
      for (let i = 0; i < 9; i++) {
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(wx - 28, wy + i * 11, 26, 1);
        c.fillRect(wx + ww + 2, wy + i * 11, 26, 1);
      }
      c.fillStyle = '#9a9488';
      c.fillRect(wx - 12, wy + wh + 8, ww + 24, 6);
      c.fillStyle = '#5b4a3a'; // maceta
      c.fillRect(wx + 8, wy + wh - 10, ww - 16, 8);
      c.fillStyle = '#4f8a3f';
      for (let i = 0; i < 7; i++) c.fillRect(wx + 8 + i * 7, wy + wh - 18, 5, 9);
    } else {
      // portal con arco
      c.fillStyle = '#6a4a2e';
      c.beginPath();
      c.moveTo(84, 256);
      c.lineTo(84, 110);
      c.arc(128, 110, 44, Math.PI, 0);
      c.lineTo(172, 256);
      c.closePath();
      c.fill();
      c.fillStyle = '#e0d9c5';
      c.fillRect(0, 232, CELL, 24);
      glass(c, m, 196, 90, 40, 70);
    }
  } else {
    // bloque residencial: balcón corrido y ventana
    if (!ground) {
      c.fillStyle = '#e5e2da';
      c.fillRect(0, 204, CELL, 24);
      c.fillStyle = '#cfcbc0';
      c.fillRect(0, 160, CELL, 44);
      for (let i = 0; i < 16; i++) {
        c.fillStyle = '#9d9a90';
        c.fillRect(i * 16 + 6, 160, 3, 44);
      }
      glass(c, m, 52, 40, 152, 114);
      frame(c, 52, 40, 152, 114, 5, '#ecebe6');
      c.fillStyle = '#ecebe6';
      c.fillRect(126, 40, 4, 114);
    } else {
      glass(c, m, 30, 70, 196, 150);
      frame(c, 30, 70, 196, 150, 6, '#55585e');
      c.fillStyle = '#d6d3cb';
      c.fillRect(0, 232, CELL, 24);
    }
  }
  // sombra suave inferior para dar relieve entre plantas
  const sh = c.createLinearGradient(0, CELL - 18, 0, CELL);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.12)');
  c.fillStyle = sh;
  c.fillRect(0, CELL - 18, CELL, 18);
  c.restore();
  m.restore();
}

/** Elementos en relieve de cada celda (x, y, ancho, alto, altura 0..255; 128 = plano): balcones, cornisas, antepechos, zócalos, contraventanas. */
const RAISED: Record<string, [number, number, number, number, number][]> = {
  '0u': [[62, 20, 132, 12, 190], [56, 208, 144, 18, 235], [0, 244, 256, 12, 215], [66, 206, 124, 4, 160]],
  '0g': [[0, 226, 256, 30, 195], [24, 26, 208, 34, 205], [34, 54, 188, 10, 180]],
  '1u': [[0, 214, 256, 42, 200], [0, 0, 256, 22, 190], [8, 186, 240, 34, 175]],
  '1g': [[0, 12, 256, 26, 205], [8, 38, 240, 6, 185]],
  '2u': [[72, 62, 24, 116, 190], [160, 62, 24, 116, 190], [88, 170, 80, 8, 230], [88, 58, 80, 6, 200]],
  '2g': [[0, 232, 256, 24, 195], [78, 100, 100, 10, 200]],
  '3u': [[0, 160, 256, 68, 215], [40, 30, 176, 10, 190], [40, 154, 176, 6, 195]],
  '3g': [[0, 232, 256, 24, 195], [22, 62, 212, 10, 195]],
};

/** Mapa de alturas (blanco = sobresale, negro = hundido): ventanas rehundidas, marcos y molduras en relieve. Se usa para inclinar la normal en el shader. */
function buildHeightMap(mc: HTMLCanvasElement): THREE.CanvasTexture {
  const W = mc.width, H = mc.height;
  const src = mc.getContext('2d')!.getImageData(0, 0, W, H).data;
  const glassMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) glassMask[i] = src[i * 4] > 128 ? 1 : 0;
  const dil = (inp: Uint8Array, r: number) => {                       // dilatación separable (máximo en ventana)
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0; for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < W && inp[y * W + xx]) v = 1; }
      tmp[y * W + x] = v;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0; for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) v = 1; }
      out[y * W + x] = v;
    }
    return out;
  };
  const frame = dil(glassMask, 7);
  const hc = document.createElement('canvas');
  hc.width = W; hc.height = H;
  const c = hc.getContext('2d')!;
  const img = c.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = glassMask[i] ? 18 : frame[i] ? 196 : 128;                // ventana hundida · marco que sobresale · muro
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  for (let s = 0; s < FACADE_STYLES; s++) {
    for (const [row, tag] of [[0, 'u'], [1, 'g']] as [number, string][]) {
      for (const [x, y, w, h, v] of RAISED[`${s}${tag}`] ?? []) { c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(s * CELL + x, row * CELL + y, w, h); }
    }
  }
  const soft = document.createElement('canvas');                       // suavizado: bordes con pendiente, no escalones
  soft.width = W; soft.height = H;
  const sc = soft.getContext('2d')!;
  sc.filter = 'blur(1.4px)';
  sc.drawImage(hc, 0, 0);
  const t = new THREE.CanvasTexture(soft);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function createFacadeAtlas(): { map: THREE.CanvasTexture; mask: THREE.CanvasTexture; height: THREE.CanvasTexture } {
  const W = CELL * FACADE_STYLES, H = CELL * 2;
  const cc = document.createElement('canvas');
  cc.width = W; cc.height = H;
  const mc = document.createElement('canvas');
  mc.width = W; mc.height = H;
  const c = cc.getContext('2d')!, m = mc.getContext('2d')!;
  const r = rng(20251125);
  for (let s = 0; s < FACADE_STYLES; s++) {
    drawCell(s, false, c, m, s * CELL, 0, r); // fila superior del canvas = planta tipo
    drawCell(s, true, c, m, s * CELL, CELL, r); // fila inferior = planta baja
  }
  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: mk(cc, true), mask: mk(mc, false), height: buildHeightMap(mc) };
}

/** Mosaico ondulado de la Explanada (rojo, negro y crema). UV: u = a lo largo del paseo, v = a lo ancho (9 m por tile). */
export function createMosaicTexture(): THREE.CanvasTexture {
  const W = 512, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d')!;
  const cols = ['#efe7d3', '#26396a', '#b0604a', '#efe7d3', '#26396a', '#b0604a'];   // crema, azul marino y terracota, como la Explanada real (fotos de referencia)
  const bands = cols.length, bh = H / bands;
  c.fillStyle = cols[0];
  c.fillRect(0, 0, W, H);
  for (let b = 0; b < bands; b++) {
    c.fillStyle = cols[b];
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const y = b * bh + Math.sin((x / W) * Math.PI * 2) * bh * 0.55;
      c.lineTo(x, y);
    }
    c.lineTo(W, H);
    c.closePath();
    c.fill();
  }
  c.strokeStyle = 'rgba(0,0,0,0.10)';
  c.lineWidth = 1;
  for (let i = 0; i <= W; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, H); c.stroke(); }
  for (let j = 0; j <= H; j += 16) { c.beginPath(); c.moveTo(0, j); c.lineTo(W, j); c.stroke(); }
  const t = new THREE.CanvasTexture(c.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
