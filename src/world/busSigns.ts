import * as THREE from 'three';
import type { BusRoute } from './traffic';

const COLS = 2, CELL_W = 512, CELL_H = 64;
const DOT_W = 192, DOT_H = 16;                 // resolución de la matriz de puntos de cada rótulo

/** Destino a mostrar: el de OSM (`to`) o, si falta, el último tramo del nombre de la ruta («03: Ciudad de Asís ⇄ Colonia Requena»). */
export function destinationOf(r: BusRoute): string {
  if (r.to) return r.to;
  const body = r.name.replace(/^[^:]*:\s*/, '');
  const parts = body.split(/\s*(?:=>|<=>|[⇄⇆⇒⇐⇔↔→⟷–—]|\s-\s)\s*/).filter(Boolean);
  return (parts[parts.length - 1] ?? body).replace(/\([^)]*\)/g, '').trim();
}

/** Rótulo de la línea: «03 COLONIA REQUENA». */
export function signTextOf(r: BusRoute): string {
  const ref = r.ref.replace(/^Línea\s*/i, '').trim();
  return `${ref} ${destinationOf(r)}`.trim().toUpperCase();
}

/** Textos de los rótulos y la celda de cada ruta: 0 = fuera de servicio, 1 = sin línea, el resto = una por texto distinto. */
export function buildSignTexts(routes: BusRoute[]): { texts: string[]; cellOf: number[] } {
  const texts = ['FUERA DE SERVICIO', 'ALICANTE'];
  const idx = new Map<string, number>();
  const cellOf = routes.map((r) => {
    const t = signTextOf(r);
    let c = idx.get(t);
    if (c === undefined) { c = texts.length; texts.push(t); idx.set(t, c); }
    return c;
  });
  return { texts, cellOf };
}

/** Atlas de rótulos LED ámbar (matriz de puntos): cada celda es un texto; COLS columnas. */
export function createSignAtlas(texts: string[]): { texture: THREE.CanvasTexture; rows: number } {
  const rows = Math.ceil(texts.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = CELL_W * COLS; cv.height = CELL_H * rows;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#0a0703'; c.fillRect(0, 0, cv.width, cv.height);
  const mini = document.createElement('canvas');
  mini.width = DOT_W; mini.height = DOT_H;
  const m = mini.getContext('2d', { willReadFrequently: true })!;
  const px = CELL_W / DOT_W, py = CELL_H / DOT_H;
  texts.forEach((txt, i) => {
    const ox = (i % COLS) * CELL_W, oy = Math.floor(i / COLS) * CELL_H;
    m.clearRect(0, 0, DOT_W, DOT_H);
    m.fillStyle = '#fff'; m.textBaseline = 'middle';
    m.font = 'bold 13px "Arial Narrow", Arial, sans-serif';
    const w = m.measureText(txt).width;
    m.save();
    const sx = Math.min(1, (DOT_W - 6) / Math.max(w, 1));            // se comprime en horizontal si no cabe
    m.translate((DOT_W - w * sx) / 2, DOT_H / 2 + 0.5); m.scale(sx, 1);
    m.fillText(txt, 0, 0);
    m.restore();
    const data = m.getImageData(0, 0, DOT_W, DOT_H).data;
    for (let y = 0; y < DOT_H; y++) for (let x = 0; x < DOT_W; x++) {
      const a = data[(y * DOT_W + x) * 4 + 3] / 255;
      c.fillStyle = a > 0.45 ? '#ffb21a' : '#2a1b05';                   // punto encendido / apagado
      c.beginPath();
      c.arc(ox + (x + 0.5) * px, oy + (y + 0.5) * py, Math.min(px, py) * 0.38, 0, Math.PI * 2);
      c.fill();
    }
  });
  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return { texture, rows };
}

export const SIGN_COLS = COLS;
