import * as THREE from 'three';
import type { BusRoute } from './traffic';

const COLS = 3, CELL_W = 512, CELL_H = 64;
const DOT_W = 192, DOT_H = 16;                 // resolución de la matriz de puntos de cada rótulo

/** Celdas fijas del atlas (los planos del autobús las usan por índice): 0/1 fuera de servicio (rótulo y referencia vacía), 2/3 «ALICANTE», 4 logotipo, 5 accesibilidad, 6 estrella. */
export const CELL_OUT = 0, CELL_CITY = 2, CELL_LOGO = 4, CELL_WHEEL = 5, CELL_STAR = 6;
/** 32 matrículas distintas a continuación; después, dos celdas por línea (rótulo completo + solo el número). */
export const PLATE0 = 7, PLATES = 32, ROUTES0 = PLATE0 + PLATES;
export const SIGN_COLS = COLS;

/** Destino a mostrar: el de OSM (`to`) o, si falta, el último tramo del nombre de la ruta («03: Ciudad de Asís ⇄ Colonia Requena»). */
export function destinationOf(r: BusRoute): string {
  if (r.to) return r.to;
  const body = r.name.replace(/^[^:]*:\s*/, '');
  const parts = body.split(/\s*(?:=>|<=>|[⇄⇆⇒⇐⇔↔→⟷–—]|\s-\s)\s*/).filter(Boolean);
  return (parts[parts.length - 1] ?? body).replace(/\([^)]*\)/g, '').trim();
}

export function refOf(r: BusRoute): string { return r.ref.replace(/^Línea\s*/i, '').trim(); }

/** Rótulo de la línea: «03 COLONIA REQUENA». */
export function signTextOf(r: BusRoute): string {
  return `${refOf(r)} ${destinationOf(r)}`.trim().toUpperCase();
}

export type CellSpec = { k: 'led'; t: string } | { k: 'plate'; t: string } | { k: 'logo' } | { k: 'wheel' } | { k: 'star' };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Matrícula española aleatoria («1234 KBC»; sin vocales ni Ñ/Q, como las reales). */
function plateText(r: () => number): string {
  const L = 'BCDFGHJKLMNPRSTVWXYZ';
  return `${String(Math.floor(r() * 10000)).padStart(4, '0')} ${L[Math.floor(r() * L.length)]}${L[Math.floor(r() * L.length)]}${L[Math.floor(r() * L.length)]}`;
}

/** Celdas del atlas y la celda de cada ruta (la del rótulo completo; el número solo está en la siguiente). */
export function buildSignCells(routes: BusRoute[]): { cells: CellSpec[]; cellOf: number[] } {
  const cells: CellSpec[] = [{ k: 'led', t: 'FUERA DE SERVICIO' }, { k: 'led', t: '' }, { k: 'led', t: 'ALICANTE' }, { k: 'led', t: '' }, { k: 'logo' }, { k: 'wheel' }, { k: 'star' }];
  const r = rng(99);
  for (let i = 0; i < PLATES; i++) cells.push({ k: 'plate', t: plateText(r) });
  const idx = new Map<string, number>();
  const cellOf = routes.map((rt) => {
    const t = signTextOf(rt);
    let c = idx.get(t);
    if (c === undefined) { c = cells.length; cells.push({ k: 'led', t }, { k: 'led', t: refOf(rt).toUpperCase() }); idx.set(t, c); }
    return c;
  });
  return { cells, cellOf };
}

/** Atlas: rótulos LED ámbar (matriz de puntos), matrículas, logotipo SubÚs, símbolo de accesibilidad y estrella; COLS columnas.
 *  Lo que no es LED se dibuja en la franja central de la celda (u de 0,25 a 0,75 o, los cuadrados, de 0,4375 a 0,5625). */
export function createSignAtlas(cells: CellSpec[]): { texture: THREE.CanvasTexture; rows: number } {
  const rows = Math.ceil(cells.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = CELL_W * COLS; cv.height = CELL_H * rows;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#0a0703'; c.fillRect(0, 0, cv.width, cv.height);
  const mini = document.createElement('canvas');
  mini.width = DOT_W; mini.height = DOT_H;
  const m = mini.getContext('2d', { willReadFrequently: true })!;
  const px = CELL_W / DOT_W, py = CELL_H / DOT_H;

  const led = (txt: string, ox: number, oy: number) => {
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
  };
  const roundRect = (x: number, y: number, w: number, h: number, r: number) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };

  cells.forEach((cell, i) => {
    const ox = (i % COLS) * CELL_W, oy = Math.floor(i / COLS) * CELL_H;
    const cx = ox + CELL_W / 2;
    if (cell.k === 'led') { led(cell.t, ox, oy); return; }
    c.fillStyle = '#ffffff'; c.fillRect(ox, oy, CELL_W, CELL_H);
    if (cell.k === 'plate') {                                           // matrícula blanca con banda azul europea
      const x = cx - 128, w = 256;
      c.fillStyle = '#1a1a1a'; roundRect(x, oy + 2, w, CELL_H - 4, 7); c.fill();
      c.fillStyle = '#f4f4f0'; roundRect(x + 3, oy + 5, w - 6, CELL_H - 10, 5); c.fill();
      c.fillStyle = '#1b4aa8'; roundRect(x + 3, oy + 5, 34, CELL_H - 10, 5); c.fill();
      c.fillStyle = '#ffd400';
      for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; c.beginPath(); c.arc(x + 20 + Math.cos(a) * 11, oy + 22 + Math.sin(a) * 11, 1.8, 0, Math.PI * 2); c.fill(); }
      c.fillStyle = '#fff'; c.font = 'bold 15px Arial, sans-serif'; c.textAlign = 'center'; c.fillText('E', x + 20, oy + 52);
      c.fillStyle = '#111'; c.font = 'bold 40px "Arial Narrow", Arial, sans-serif'; c.textBaseline = 'middle';
      c.fillText(cell.t, x + 37 + (w - 43) / 2, oy + CELL_H / 2 + 2);
      c.textAlign = 'start';
    } else if (cell.k === 'logo') {                                     // SubÚs: texto rojo sobre el cuerpo blanco
      c.fillStyle = '#d8101c'; c.font = 'italic bold 40px "Arial Narrow", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('SubÚs', cx, oy + 24);
      c.fillStyle = '#666'; c.font = 'bold 15px Arial, sans-serif';
      c.fillText('ALICANTE · TRANSPORTE URBANO', cx, oy + 52);
      c.textAlign = 'start';
    } else if (cell.k === 'wheel') {                                    // símbolo de accesibilidad: cuadrado azul con silla de ruedas
      const s = 56, x = cx - s / 2, y = oy + 4;
      c.fillStyle = '#1a56a8'; roundRect(x, y, s, s, 6); c.fill();
      c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 3.4; c.lineCap = 'round';
      c.beginPath(); c.arc(x + 24, y + 12, 4, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.moveTo(x + 24, y + 19); c.lineTo(x + 24, y + 33); c.lineTo(x + 36, y + 33); c.lineTo(x + 40, y + 45); c.stroke();
      c.beginPath(); c.moveTo(x + 24, y + 25); c.lineTo(x + 35, y + 25); c.stroke();
      c.beginPath(); c.arc(x + 25, y + 38, 11, Math.PI * 0.75, Math.PI * 2.1); c.stroke();
    } else {                                                            // estrella de tres puntas dentro de un círculo plateado (marca del vehículo)
      const x = cx, y = oy + 32, R = 27;
      c.fillStyle = '#b9bdc2'; c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#2a2d31'; c.lineWidth = 3;
      c.beginPath(); c.arc(x, y, R - 3, 0, Math.PI * 2); c.stroke();
      c.lineWidth = 4.2; c.lineCap = 'round';
      for (let k = 0; k < 3; k++) { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 3; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * (R - 5), y + Math.sin(a) * (R - 5)); c.stroke(); }
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
