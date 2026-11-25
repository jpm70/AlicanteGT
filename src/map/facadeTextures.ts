import type * as maplibregl from 'maplibre-gl';
import type { AtmosphereMode } from '../types/game';

interface FacadeSpec {
  id: string;
  wallTop: string;
  wallBottom: string;
  corniceColor: string;
  corniceShadow: string;
  frameColor: string;
  glassDark: string;
  glassReflect: string;
  balconyRail: string;
  balconyShadow: string;
  isNight: boolean;
  litRatio: number;
  litPalette: string[];
  cols: number;
  rows: number;
  seed: number;
  curtainWall?: boolean;
}

/** Deterministic PRNG so facade window illumination patterns stay crisp and stable */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawFacadeTexture(spec: FacadeSpec): { width: number; height: number; data: Uint8Array } {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(spec.seed);

  // 1. Base architectural wall material with subtle vertical tone
  const wallGrad = ctx.createLinearGradient(0, 0, 0, size);
  wallGrad.addColorStop(0, spec.wallTop);
  wallGrad.addColorStop(1, spec.wallBottom);
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, size, size);

  // Subtle Mediterranean stucco / limestone micro-grain
  for (let i = 0; i < 420; i++) {
    const gx = Math.floor(rand() * size);
    const gy = Math.floor(rand() * size);
    const bright = rand() > 0.5;
    ctx.fillStyle = bright
      ? spec.isNight
        ? 'rgba(255,255,255,0.03)'
        : 'rgba(255,255,255,0.08)'
      : 'rgba(0,0,0,0.06)';
    ctx.fillRect(gx, gy, 2, 2);
  }

  const cellW = size / spec.cols;
  const cellH = size / spec.rows;

  // 2. Floor slabs, recessed windows, glass reflections, frames & Mediterranean balconies
  for (let r = 0; r < spec.rows; r++) {
    const y0 = Math.round(r * cellH);

    // Architectural cornice / horizontal floor ledge
    ctx.fillStyle = spec.corniceColor;
    ctx.fillRect(0, y0, size, 2);
    ctx.fillStyle = spec.corniceShadow;
    ctx.fillRect(0, y0 + 2, size, 2);

    for (let c = 0; c < spec.cols; c++) {
      const x0 = Math.round(c * cellW);
      const padX = spec.curtainWall ? 2 : 5;
      const padTop = 5;
      const winW = Math.round(cellW - padX * 2);
      const winH = Math.round(cellH - padTop - 6);
      const wx = x0 + padX;
      const wy = y0 + padTop;

      // Subtle architectural recess drop shadow behind window
      ctx.fillStyle = spec.balconyShadow;
      ctx.fillRect(wx - 1, wy - 1, winW + 2, winH + 2);

      // Outer window frame / stone trim
      ctx.fillStyle = spec.frameColor;
      ctx.fillRect(wx, wy, winW, winH);

      const innerX = wx + 1;
      const innerY = wy + 1;
      const innerW = Math.max(2, winW - 2);
      const innerH = Math.max(2, winH - 2);

      const isLit = rand() < spec.litRatio;

      if (isLit && spec.litPalette.length > 0) {
        const litColor = spec.litPalette[Math.floor(rand() * spec.litPalette.length)];
        const glowGrad = ctx.createLinearGradient(innerX, innerY, innerX, innerY + innerH);
        glowGrad.addColorStop(0, litColor);
        glowGrad.addColorStop(1, spec.isNight ? '#ffdf9e' : litColor);
        ctx.fillStyle = glowGrad;
        ctx.fillRect(innerX, innerY, innerW, innerH);

        // Subtle interior ceiling/blind shadow at top of lit window for depth
        ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
        ctx.fillRect(innerX, innerY, innerW, Math.max(2, Math.floor(innerH * 0.24)));
      } else {
        // Dark architectural glass pane with sky/horizon diagonal reflection
        const glassGrad = ctx.createLinearGradient(innerX, innerY, innerX + innerW, innerY + innerH);
        glassGrad.addColorStop(0, spec.glassDark);
        glassGrad.addColorStop(0.55, spec.glassReflect);
        glassGrad.addColorStop(1, spec.glassDark);
        ctx.fillStyle = glassGrad;
        ctx.fillRect(innerX, innerY, innerW, innerH);

        // Crisp upper reflection streak
        ctx.fillStyle = spec.isNight ? 'rgba(130, 175, 255, 0.14)' : 'rgba(255, 255, 255, 0.18)';
        ctx.fillRect(innerX + 1, innerY + 1, Math.max(2, innerW - 4), 2);
      }

      // Vertical center mullion bar inside window
      ctx.fillStyle = spec.frameColor;
      ctx.fillRect(Math.round(innerX + innerW / 2), innerY, 1, innerH);

      // Mediterranean balcony railing & sill slab on lower third of window
      const sillY = wy + winH;
      ctx.fillStyle = spec.corniceColor;
      ctx.fillRect(wx - 2, sillY, winW + 4, 2);
      ctx.fillStyle = spec.balconyShadow;
      ctx.fillRect(wx - 2, sillY + 2, winW + 4, 2);

      if (!spec.curtainWall) {
        // Wrought-iron balcony horizontal bar & slim vertical balusters
        const railY = wy + Math.round(winH * 0.64);
        ctx.fillStyle = spec.balconyRail;
        ctx.fillRect(wx - 1, railY, winW + 2, 1);
        for (let bx = wx; bx <= wx + winW; bx += 4) {
          ctx.fillRect(bx, railY, 1, winH - Math.round(winH * 0.64));
        }
      }
    }
  }

  const imgData = ctx.getImageData(0, 0, size, size);
  return {
    width: size,
    height: size,
    data: new Uint8Array(imgData.data.buffer),
  };
}

const FACADE_SPECS: FacadeSpec[] = [
  // --- DÍA (Mediterranean limestone, ivory stucco, travertine, glazed towers) ---
  {
    id: 'facade-day',
    wallTop: '#ebe3d5',
    wallBottom: '#dcd2c2',
    corniceColor: '#f7f2e8',
    corniceShadow: 'rgba(65, 56, 46, 0.28)',
    frameColor: '#a69b8d',
    glassDark: '#263447',
    glassReflect: '#4d6c8a',
    balconyRail: 'rgba(38, 44, 54, 0.72)',
    balconyShadow: 'rgba(42, 36, 30, 0.34)',
    isNight: false,
    litRatio: 0,
    litPalette: [],
    cols: 4,
    rows: 4,
    seed: 101,
  },
  {
    id: 'facade-day-mid',
    wallTop: '#e3d5c3',
    wallBottom: '#d2c2ae',
    corniceColor: '#f0e6d8',
    corniceShadow: 'rgba(72, 58, 44, 0.3)',
    frameColor: '#8f8171',
    glassDark: '#222f40',
    glassReflect: '#45617d',
    balconyRail: 'rgba(34, 40, 48, 0.75)',
    balconyShadow: 'rgba(48, 38, 30, 0.36)',
    isNight: false,
    litRatio: 0,
    litPalette: [],
    cols: 4,
    rows: 4,
    seed: 202,
  },
  {
    id: 'facade-day-tall',
    wallTop: '#dfe4ea',
    wallBottom: '#cdd5de',
    corniceColor: '#f2f5f9',
    corniceShadow: 'rgba(42, 54, 70, 0.28)',
    frameColor: '#7d8a99',
    glassDark: '#1c3148',
    glassReflect: '#5c8cb5',
    balconyRail: 'rgba(55, 68, 84, 0.65)',
    balconyShadow: 'rgba(28, 38, 52, 0.32)',
    isNight: false,
    litRatio: 0,
    litPalette: [],
    cols: 4,
    rows: 4,
    seed: 303,
    curtainWall: true,
  },

  // --- ATARDECER MEDITERRÁNEO (Warm sandstone & golden-hour reflections + early lit rooms) ---
  {
    id: 'facade-sunset',
    wallTop: '#d9bca3',
    wallBottom: '#bf9d83',
    corniceColor: '#edd4bc',
    corniceShadow: 'rgba(54, 34, 34, 0.38)',
    frameColor: '#7d6355',
    glassDark: '#22283d',
    glassReflect: '#665b73',
    balconyRail: 'rgba(30, 26, 36, 0.8)',
    balconyShadow: 'rgba(40, 24, 28, 0.42)',
    isNight: false,
    litRatio: 0.16,
    litPalette: ['#ffcf7d', '#ffb45c'],
    cols: 4,
    rows: 4,
    seed: 404,
  },
  {
    id: 'facade-sunset-mid',
    wallTop: '#cdb09c',
    wallBottom: '#b0917e',
    corniceColor: '#e3c7b2',
    corniceShadow: 'rgba(50, 32, 38, 0.4)',
    frameColor: '#6f5a52',
    glassDark: '#1d2438',
    glassReflect: '#705868',
    balconyRail: 'rgba(26, 24, 36, 0.82)',
    balconyShadow: 'rgba(38, 22, 30, 0.44)',
    isNight: false,
    litRatio: 0.22,
    litPalette: ['#ffd488', '#ffa952', '#ffe6b3'],
    cols: 4,
    rows: 4,
    seed: 505,
  },
  {
    id: 'facade-sunset-tall',
    wallTop: '#b7a9b4',
    wallBottom: '#938796',
    corniceColor: '#d4c3c9',
    corniceShadow: 'rgba(38, 28, 44, 0.42)',
    frameColor: '#5c5568',
    glassDark: '#1c243b',
    glassReflect: '#8f635c',
    balconyRail: 'rgba(30, 28, 42, 0.78)',
    balconyShadow: 'rgba(32, 22, 36, 0.42)',
    isNight: false,
    litRatio: 0.28,
    litPalette: ['#ffd791', '#ffb766', '#9ad4ff'],
    cols: 4,
    rows: 4,
    seed: 606,
    curtainWall: true,
  },

  // --- NOCHE NEÓN (Dark obsidian architectural facades with warm gold & cyan lit windows) ---
  {
    id: 'facade-night',
    wallTop: '#192238',
    wallBottom: '#111829',
    corniceColor: '#253352',
    corniceShadow: 'rgba(3, 6, 14, 0.75)',
    frameColor: '#273554',
    glassDark: '#0b101e',
    glassReflect: '#162442',
    balconyRail: 'rgba(8, 12, 22, 0.9)',
    balconyShadow: 'rgba(2, 4, 10, 0.72)',
    isNight: true,
    litRatio: 0.34,
    litPalette: ['#ffbe5c', '#ffd98e', '#ff9b42', '#64c8ff', '#a5e3ff'],
    cols: 4,
    rows: 4,
    seed: 707,
  },
  {
    id: 'facade-night-mid',
    wallTop: '#1f2b45',
    wallBottom: '#151e33',
    corniceColor: '#2c3d61',
    corniceShadow: 'rgba(3, 6, 14, 0.78)',
    frameColor: '#2f4166',
    glassDark: '#0c1222',
    glassReflect: '#1b2c4f',
    balconyRail: 'rgba(8, 12, 22, 0.9)',
    balconyShadow: 'rgba(2, 4, 10, 0.75)',
    isNight: true,
    litRatio: 0.4,
    litPalette: ['#ffc76b', '#ffe2a3', '#38bdf8', '#7dd3fc', '#ffa64d'],
    cols: 4,
    rows: 4,
    seed: 808,
  },
  {
    id: 'facade-night-tall',
    wallTop: '#243354',
    wallBottom: '#18243d',
    corniceColor: '#364d7a',
    corniceShadow: 'rgba(2, 5, 12, 0.8)',
    frameColor: '#374c78',
    glassDark: '#0c1426',
    glassReflect: '#223a66',
    balconyRail: 'rgba(10, 16, 30, 0.9)',
    balconyShadow: 'rgba(2, 4, 10, 0.76)',
    isNight: true,
    litRatio: 0.48,
    litPalette: ['#38bdf8', '#7dd3fc', '#ffd27d', '#ffba59', '#e0f2fe'],
    cols: 4,
    rows: 4,
    seed: 909,
    curtainWall: true,
  },
];

/**
 * Generates and registers all procedural architectural building facade textures
 * ('facade-day', 'facade-night', 'facade-sunset' + mid/tall height variations)
 * into the MapLibre style sprite atlas.
 */
export function registerFacadeTextures(map: maplibregl.Map): void {
  for (const spec of FACADE_SPECS) {
    if (map.hasImage(spec.id)) continue;
    try {
      const img = drawFacadeTexture(spec);
      map.addImage(spec.id, img, { pixelRatio: 2 });
    } catch {
      // Ignore duplicate registration race
    }
  }
}

export function getFacadePatternExpression(mode: AtmosphereMode): unknown[] {
  const heightExpr = ['coalesce', ['get', 'render_height'], ['get', 'height'], 15];
  if (mode === 'night') {
    return ['step', heightExpr, 'facade-night', 14, 'facade-night-mid', 26, 'facade-night-tall'];
  }
  if (mode === 'day') {
    return ['step', heightExpr, 'facade-day', 14, 'facade-day-mid', 26, 'facade-day-tall'];
  }
  return ['step', heightExpr, 'facade-sunset', 14, 'facade-sunset-mid', 26, 'facade-sunset-tall'];
}
