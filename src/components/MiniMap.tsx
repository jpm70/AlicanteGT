import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Compass, Maximize2, Minus, Plus, X } from 'lucide-react';
import type { CarState } from '../types/game';
import { toLocal } from '../world/geo';
import { CATS, type Place } from './PlacesPanel';

interface MapData {
  b: [number, number, number, number]; tile: number; land: [number, number][];
  roads: Record<'m' | 'p' | 's' | 't' | 'r', number[][]>; coast: number[][]; parks: number[][]; water: number[][];
}
interface Poly { pts: number[]; x0: number; z0: number; x1: number; z1: number }

const bbox = (pts: number[]): Poly => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
  return { pts, x0, z0, x1, z1 };
};

const ROAD_STYLE: Record<string, { color: string; w: number; wBig: number }> = {
  r: { color: '#56657a', w: 1.1, wBig: 1.3 },
  t: { color: '#8fa0b8', w: 1.5, wBig: 2.0 },
  s: { color: '#e6c36a', w: 2.0, wBig: 3.0 },
  p: { color: '#f0a050', w: 2.6, wBig: 3.8 },
  m: { color: '#e8704a', w: 3.2, wBig: 4.6 },
};
const SEA = '#0c2540', LAND = '#1a2634', PARK = '#1d4a36', WATER = '#14406a';

interface Props {
  carStateRef: MutableRefObject<CarState>;
  places: Place[] | null;
  expanded: boolean;
  onToggle: () => void;
  onGo: (p: Place) => void;
}

/** Minimapa que sigue al coche (arriba = delante o norte) y mapa grande de todo el circuito con zoom, arrastre y lugares clicables. */
export function MiniMap({ carStateRef, places, expanded, onToggle, onGo }: Props) {
  const miniRef = useRef<HTMLCanvasElement>(null);
  const bigRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<MapData | null>(null);
  const [headingUp, setHeadingUp] = useState(() => { try { return localStorage.getItem('gt-map-north') !== '1'; } catch { return true; } });
  const miniScale = useRef(0.3);
  const view = useRef({ cx: 0, cz: 0, s: 0.1, init: false, drag: null as null | { x: number; y: number; cx: number; cz: number; moved: boolean } });
  const hover = useRef<Place | null>(null);
  const [cat, setCat] = useState('all');
  const catRef = useRef('all');
  catRef.current = cat;
  const headingUpRef = useRef(headingUp);
  headingUpRef.current = headingUp;

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}world/map.json`).then((r) => r.json()).then((d: MapData) => setData(d)).catch(() => setData(null));
  }, []);

  // geometría con cajas para recortar; lugares ya en metros locales
  const geo = useMemo(() => {
    if (!data) return null;
    const mk = (a: number[][]) => a.map(bbox);
    return { roads: Object.fromEntries(Object.entries(data.roads).map(([k, v]) => [k, mk(v)])) as Record<string, Poly[]>, coast: mk(data.coast), parks: mk(data.parks), water: mk(data.water) };
  }, [data]);
  const pl = useMemo(() => (places ?? []).map((p) => ({ p, ...toLocal(p.la, p.lo) })), [places]);

  useEffect(() => {
    if (!geo || !data) return;
    let raf = 0, last = 0;
    const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);

    const draw = (cv: HTMLCanvasElement, big: boolean, now: number) => {
      const dpr = dprOf();
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = carStateRef.current;
      const me = toLocal(st.lat, st.lng);
      const hd = (st.headingDeg * Math.PI) / 180;
      const rot = !big && headingUpRef.current;
      const v = view.current;
      let cx: number, cz: number, s: number;
      if (big) {
        if (!v.init) {
          s = Math.min(w / (data.b[2] - data.b[0]), h / (data.b[3] - data.b[1])) * 0.98;
          v.cx = (data.b[0] + data.b[2]) / 2; v.cz = (data.b[1] + data.b[3]) / 2; v.s = s; v.init = true;
        }
        cx = v.cx; cz = v.cz; s = v.s;
      } else { cx = me.x; cz = me.z; s = miniScale.current; }
      const cosH = Math.cos(hd), sinH = Math.sin(hd);
      const sx = (x: number, z: number) => { const dx = x - cx, dz = z - cz; return w / 2 + s * (rot ? dx * cosH + dz * sinH : dx); };
      const sy = (x: number, z: number) => { const dx = x - cx, dz = z - cz; return h / 2 + s * (rot ? -dx * sinH + dz * cosH : dz); };
      // zona visible en el mundo (con holgura por la rotación)
      const rad = (rot ? Math.hypot(w, h) / 2 : 0) / s;
      const vx0 = cx - (rot ? rad : w / 2 / s), vx1 = cx + (rot ? rad : w / 2 / s), vz0 = cz - (rot ? rad : h / 2 / s), vz1 = cz + (rot ? rad : h / 2 / s);
      const inView = (q: Poly) => !(q.x1 < vx0 || q.x0 > vx1 || q.z1 < vz0 || q.z0 > vz1);
      ctx.fillStyle = SEA; ctx.fillRect(0, 0, w, h);
      // tierra por teselas
      ctx.fillStyle = LAND;
      for (const [tx, tz] of data.land) {
        const x0 = tx * data.tile, z0 = tz * data.tile;
        if (x0 > vx1 || x0 + data.tile < vx0 || z0 > vz1 || z0 + data.tile < vz0) continue;
        ctx.beginPath();
        const c = [[x0, z0], [x0 + data.tile, z0], [x0 + data.tile, z0 + data.tile], [x0, z0 + data.tile]];
        c.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x, z), sy(x, z)) : ctx.moveTo(sx(x, z), sy(x, z))));
        ctx.closePath(); ctx.fill();
      }
      const poly = (arr: Poly[], fill: string) => {
        ctx.fillStyle = fill;
        for (const q of arr) {
          if (!inView(q)) continue;
          ctx.beginPath();
          for (let i = 0; i < q.pts.length; i += 2) (i ? ctx.lineTo(sx(q.pts[i], q.pts[i + 1]), sy(q.pts[i], q.pts[i + 1])) : ctx.moveTo(sx(q.pts[i], q.pts[i + 1]), sy(q.pts[i], q.pts[i + 1])));
          ctx.closePath(); ctx.fill();
        }
      };
      poly(geo.parks, PARK); poly(geo.water, WATER);
      const line = (arr: Poly[], color: string, lw: number) => {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
        for (const q of arr) {
          if (!inView(q)) continue;
          for (let i = 0; i < q.pts.length; i += 2) (i ? ctx.lineTo(sx(q.pts[i], q.pts[i + 1]), sy(q.pts[i], q.pts[i + 1])) : ctx.moveTo(sx(q.pts[i], q.pts[i + 1]), sy(q.pts[i], q.pts[i + 1])));
        }
        ctx.stroke();
      };
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      line(geo.coast, '#4aa3d6', 1.5);
      const zoomK = big ? Math.max(0.5, Math.min(1.7, s * 11)) : 1;
      for (const k of ['r', 't', 's', 'p', 'm']) {
        if (big && s < 0.05 && k === 'r') continue;                 // a escala de ciudad se omiten las calles pequeñas
        const rs = ROAD_STYLE[k];
        line(geo.roads[k], rs.color, (big ? rs.wBig : rs.w) * (big ? zoomK : 1));
      }
      // lugares
      const ct = catRef.current;
      hover.current = big ? hover.current : null;
      for (const { p, x, z } of pl) {
        if (ct !== 'all' && p.c !== ct) continue;
        if (x < vx0 || x > vx1 || z < vz0 || z > vz1) continue;
        const X = sx(x, z), Y = sy(x, z);
        const col = CATS[p.c]?.color ?? '#ffffff';
        const r = big ? 5.5 : 4;
        ctx.fillStyle = col; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (big && hover.current) {
        const hp = pl.find((q) => q.p === hover.current);
        if (hp) {
          const X = sx(hp.x, hp.z), Y = sy(hp.x, hp.z);
          ctx.font = '600 12px system-ui, sans-serif';
          const tw = ctx.measureText(hp.p.n).width + 12;
          ctx.fillStyle = 'rgba(11,18,32,0.92)'; ctx.fillRect(X + 8, Y - 24, tw, 20);
          ctx.fillStyle = '#fff'; ctx.fillText(hp.p.n, X + 14, Y - 10);
        }
      }
      // el coche (flecha)
      const mx = sx(me.x, me.z), my = sy(me.x, me.z);
      const ang = rot ? 0 : hd;
      ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
      const k = big ? 1.15 : 1;
      ctx.fillStyle = '#ffd34a'; ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -9 * k); ctx.lineTo(6.5 * k, 8 * k); ctx.lineTo(0, 4 * k); ctx.lineTo(-6.5 * k, 8 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      if (!big) {                                                  // norte
        const nx = w / 2 + (w / 2 - 14) * (rot ? -sinH : 0), ny = h / 2 - (h / 2 - 14) * (rot ? cosH : 1);
        ctx.fillStyle = '#ff6b5a'; ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', rot ? nx : w / 2, rot ? ny + 4 : 12); ctx.textAlign = 'left';
      }
      void now;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 66) return;
      last = now;
      if (miniRef.current && !expanded) draw(miniRef.current, false, now);
      if (bigRef.current && expanded) draw(bigRef.current, true, now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [geo, data, pl, expanded, carStateRef]);

  // interacción del mapa grande: arrastrar, zoom con la rueda, pasar el ratón y pulsar un lugar
  const toWorld = (cv: HTMLCanvasElement, ex: number, ey: number) => {
    const r = cv.getBoundingClientRect(); const v = view.current;
    return { x: v.cx + (ex - r.left - r.width / 2) / v.s, z: v.cz + (ey - r.top - r.height / 2) / v.s };
  };
  const nearest = (cv: HTMLCanvasElement, ex: number, ey: number) => {
    const w = toWorld(cv, ex, ey); const v = view.current; let best: Place | null = null, bd = 14 / v.s;
    for (const q of pl) {
      if (cat !== 'all' && q.p.c !== cat) continue;
      const d = Math.hypot(q.x - w.x, q.z - w.z);
      if (d < bd) { bd = d; best = q.p; }
    }
    return best;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = view.current; v.drag = { x: e.clientX, y: e.clientY, cx: v.cx, cz: v.cz, moved: false };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = view.current;
    if (v.drag) {
      const dx = e.clientX - v.drag.x, dy = e.clientY - v.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) v.drag.moved = true;
      v.cx = v.drag.cx - dx / v.s; v.cz = v.drag.cz - dy / v.s;
    } else hover.current = nearest(e.currentTarget, e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = view.current; const d = v.drag; v.drag = null;
    if (d && !d.moved) { const p = nearest(e.currentTarget, e.clientX, e.clientY); if (p) onGo(p); }
  };
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const v = view.current; const w0 = toWorld(e.currentTarget, e.clientX, e.clientY);
    const k = Math.exp(-e.deltaY * 0.0015); v.s = Math.max(0.03, Math.min(1.6, v.s * k));
    const w1 = toWorld(e.currentTarget, e.clientX, e.clientY);
    v.cx += w0.x - w1.x; v.cz += w0.z - w1.z;
  };
  const zoomMini = (f: number) => { miniScale.current = Math.max(0.12, Math.min(1.2, miniScale.current * f)); };
  const toggleNorth = () => setHeadingUp((u) => { const n = !u; try { localStorage.setItem('gt-map-north', n ? '0' : '1'); } catch { /* sin almacenamiento */ } return n; });

  const counts = useMemo(() => { const m: Record<string, number> = {}; for (const p of places ?? []) m[p.c] = (m[p.c] ?? 0) + 1; return m; }, [places]);

  return (
    <>
      {!expanded && (
        <div className="fixed left-3 top-[7.4rem] z-20 h-[150px] w-[150px] overflow-hidden rounded-2xl border border-white/20 bg-[#0b1220] shadow-xl sm:h-[184px] sm:w-[184px]" aria-label="Minimapa">
          <canvas ref={miniRef} className="h-full w-full" />
          <div className="absolute right-1 top-1 flex flex-col gap-1">
            <button type="button" onClick={onToggle} title="Mapa grande (M)" className="rounded-md bg-black/55 p-1 text-slate-100 hover:bg-black/75"><Maximize2 className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={toggleNorth} title={headingUp ? 'Mapa con el norte arriba' : 'Mapa girando con el coche'} className="rounded-md bg-black/55 p-1 text-slate-100 hover:bg-black/75"><Compass className="h-3.5 w-3.5" /></button>
          </div>
          <div className="absolute bottom-1 right-1 flex gap-1">
            <button type="button" onClick={() => zoomMini(0.8)} title="Alejar" className="rounded-md bg-black/55 p-1 text-slate-100 hover:bg-black/75"><Minus className="h-3 w-3" /></button>
            <button type="button" onClick={() => zoomMini(1.25)} title="Acercar" className="rounded-md bg-black/55 p-1 text-slate-100 hover:bg-black/75"><Plus className="h-3 w-3" /></button>
          </div>
        </div>
      )}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm" onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
          <div className="flex h-[min(86vh,820px)] w-[min(96vw,1180px)] flex-col overflow-hidden rounded-2xl border border-white/20 bg-[#0b1220] shadow-2xl">
            <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2">
              <h2 className="mr-2 text-sm font-semibold text-white">Mapa de Alicante</h2>
              <button type="button" onClick={() => setCat('all')} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${cat === 'all' ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-white/15 text-slate-300 hover:bg-white/10'}`}>Todos</button>
              {Object.entries(CATS).filter(([k]) => counts[k]).map(([k, c]) => (
                <button key={k} type="button" onClick={() => setCat(k)} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${cat === k ? 'border-amber-400/60 bg-amber-500/20 text-amber-200' : 'border-white/15 text-slate-300 hover:bg-white/10'}`}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />{c.label}
                </button>
              ))}
              <span className="ml-auto hidden text-[11px] text-slate-400 sm:inline">Arrastra · rueda = zoom · pulsa un lugar para ir</span>
              <button type="button" onClick={onToggle} className="rounded-md p-1 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Cerrar el mapa"><X className="h-4 w-4" /></button>
            </div>
            <canvas
              ref={bigRef}
              className="min-h-0 flex-1 cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}
            />
          </div>
        </div>
      )}
    </>
  );
}
