import type * as maplibregl from 'maplibre-gl';
import type { AtmosphereMode } from '../types/game';
import { getFacadePatternExpression, registerFacadeTextures } from './facadeTextures';

export interface StyleAuditReport {
  buildingLayerId: string;
  roadLayersVisible: number;
  waterLayerVisible: boolean;
}

interface MapPalette {
  background: string;
  water: string;
  waterLine: string;
  park: string;
  landcover: string;
  landuse: string;
  roadMotorway: string;
  roadPrimary: string;
  roadSecondary: string;
  roadMinor: string;
  roadCasing: string;
  roadHighlight: string;
  labelText: string;
  labelHalo: string;
  buildingFallbackLow: string;
  buildingFallbackMid: string;
  buildingFallbackHigh: string;
  buildingOpacity: number;
  light: {
    anchor: 'map' | 'viewport';
    color: string;
    intensity: number;
    position: [number, number, number];
  };
  sky: {
    'sky-color': string;
    'sky-horizon-blend': number;
    'horizon-color': string;
    'horizon-fog-blend': number;
    'fog-color': string;
    'fog-ground-blend': number;
  };
}

const PALETTES: Record<AtmosphereMode, MapPalette> = {
  sunset: {
    background: '#272329',
    water: '#1a426b',
    waterLine: '#2d6394',
    park: '#2b4737',
    landcover: '#332f35',
    landuse: '#373035',
    roadMotorway: '#1a1d24',
    roadPrimary: '#1e2129',
    roadSecondary: '#242730',
    roadMinor: '#2b2e38',
    roadCasing: '#5e4c4f',
    roadHighlight: '#e88b4f',
    labelText: '#f8ebdc',
    labelHalo: '#1a151c',
    buildingFallbackLow: '#c9a68b',
    buildingFallbackMid: '#dfbf9f',
    buildingFallbackHigh: '#edd1b5',
    buildingOpacity: 0.98,
    light: {
      anchor: 'map',
      color: '#ffae66',
      intensity: 0.85,
      position: [1.6, 245, 18],
    },
    // Smooth atmospheric Mediterranean sunset sky with soft distant horizon blend (foreground stays crisp)
    sky: {
      'sky-color': '#232e5e',
      'sky-horizon-blend': 0.52,
      'horizon-color': '#f09459',
      'horizon-fog-blend': 0.62,
      'fog-color': '#d88c65',
      'fog-ground-blend': 0.14,
    },
  },
  night: {
    background: '#080c16',
    water: '#071429',
    waterLine: '#122c54',
    park: '#0c1f22',
    landcover: '#0d1322',
    landuse: '#101627',
    roadMotorway: '#0d1322',
    roadPrimary: '#0f1626',
    roadSecondary: '#121a2c',
    roadMinor: '#151e31',
    roadCasing: '#294970',
    roadHighlight: '#22d3ee',
    labelText: '#cbd5e1',
    labelHalo: '#050811',
    buildingFallbackLow: '#1a253d',
    buildingFallbackMid: '#243456',
    buildingFallbackHigh: '#324875',
    buildingOpacity: 0.98,
    light: {
      anchor: 'map',
      color: '#7aaeff',
      intensity: 0.72,
      position: [1.4, 200, 38],
    },
    sky: {
      'sky-color': '#040712',
      'sky-horizon-blend': 0.48,
      'horizon-color': '#13244a',
      'horizon-fog-blend': 0.68,
      'fog-color': '#0b1530',
      'fog-ground-blend': 0.16,
    },
  },
  day: {
    background: '#d6d2c9',
    water: '#238bc4',
    waterLine: '#47a9de',
    park: '#8fc08b',
    landcover: '#cbc9c0',
    landuse: '#d2cec4',
    roadMotorway: '#2c313a',
    roadPrimary: '#333944',
    roadSecondary: '#3d4450',
    roadMinor: '#4b525f',
    roadCasing: '#a8a49c',
    roadHighlight: '#e8b34a',
    labelText: '#0f172a',
    labelHalo: '#f8fafc',
    buildingFallbackLow: '#ded4c7',
    buildingFallbackMid: '#ebe3d8',
    buildingFallbackHigh: '#f5efe6',
    buildingOpacity: 0.98,
    light: {
      anchor: 'map',
      color: '#fffbf0',
      intensity: 0.78,
      position: [1.3, 140, 52],
    },
    sky: {
      'sky-color': '#449ae3',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#d7ecfa',
      'horizon-fog-blend': 0.58,
      'fog-color': '#cde5f5',
      'fog-ground-blend': 0.12,
    },
  },
};

function safeSetPaint(
  map: maplibregl.Map,
  layerId: string,
  prop: string,
  value: unknown
): void {
  try {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(
        layerId,
        prop as Parameters<maplibregl.Map['setPaintProperty']>[1],
        value as never
      );
    }
  } catch {
    // Ignore incompatible paint props across style variants
  }
}

function safeSetVisibility(
  map: maplibregl.Map,
  layerId: string,
  visibility: 'visible' | 'none'
): void {
  try {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', visibility);
    }
  } catch {
    // ignore
  }
}

function findBuildingSource(map: maplibregl.Map): { source: string; sourceLayer: string } {
  const style = map.getStyle();
  if (style?.layers) {
    for (const layer of style.layers) {
      const l = layer as { source?: string; 'source-layer'?: string };
      if (l.source && l['source-layer'] === 'building') {
        return { source: l.source, sourceLayer: 'building' };
      }
    }
  }
  return { source: 'openmaptiles', sourceLayer: 'building' };
}

function findFirstSymbolLayerId(map: maplibregl.Map): string | undefined {
  const style = map.getStyle();
  if (!style?.layers) return undefined;
  for (const layer of style.layers) {
    if (layer.type === 'symbol') {
      return layer.id;
    }
  }
  return undefined;
}

/**
 * Enhances OpenFreeMap Liberty with realistic procedural Mediterranean / Neon-Night
 * windowed building facade patterns (`fill-extrusion-pattern`), vertical shading gradient,
 * strong directional lighting, clean dark racing asphalt, hidden POI clutter, and smooth horizon sky.
 */
export function applyMapAtmosphere(
  map: maplibregl.Map,
  mode: AtmosphereMode,
  carLayerId?: string
): StyleAuditReport {
  const style = map.getStyle();
  if (!style?.layers) {
    return { buildingLayerId: 'none', roadLayersVisible: 0, waterLayerVisible: false };
  }

  // Register procedural canvas building facade textures ('facade-day', 'facade-night', etc.)
  registerFacadeTextures(map);

  const palette = PALETTES[mode];
  let roadLayersVisible = 0;
  let waterLayerVisible = false;
  let existing3dBuildingId: string | null = null;

  // 1. Style existing vector layers cleanly while guaranteeing roads and water remain visible
  for (const layer of style.layers) {
    const id = layer.id.toLowerCase();
    const type = layer.type;

    if (layer.id === carLayerId) continue;

    if (type === 'fill-extrusion' && id.includes('building')) {
      existing3dBuildingId = layer.id;
      safeSetVisibility(map, layer.id, 'visible');
      continue;
    }

    if (type === 'fill' && id === 'building') {
      safeSetPaint(map, layer.id, 'fill-color', palette.buildingFallbackLow);
      continue;
    }

    if (type === 'background') {
      safeSetPaint(map, layer.id, 'background-color', palette.background);
    } else if (type === 'fill') {
      const paintObj = (layer as { paint?: Record<string, unknown> }).paint;
      if (paintObj && 'fill-pattern' in paintObj) {
        continue;
      }

      if (id === 'water' || id.includes('water')) {
        safeSetVisibility(map, layer.id, 'visible');
        safeSetPaint(map, layer.id, 'fill-color', palette.water);
        waterLayerVisible = true;
      } else if (
        id.includes('park') ||
        id.includes('grass') ||
        id.includes('wood') ||
        id.includes('forest') ||
        id.includes('garden') ||
        id.includes('pitch') ||
        id.includes('cemetery')
      ) {
        safeSetPaint(map, layer.id, 'fill-color', palette.park);
      } else if (id.includes('sand') || id.includes('beach')) {
        safeSetPaint(
          map,
          layer.id,
          'fill-color',
          mode === 'night' ? '#171d2e' : mode === 'sunset' ? '#6d5746' : '#ebdcb9'
        );
      } else if (id.includes('landuse') || id.includes('aeroway')) {
        safeSetPaint(map, layer.id, 'fill-color', palette.landuse);
      } else if (id.includes('landcover')) {
        safeSetPaint(map, layer.id, 'fill-color', palette.landcover);
      }
    } else if (type === 'line') {
      if (id.includes('water')) {
        safeSetVisibility(map, layer.id, 'visible');
        safeSetPaint(map, layer.id, 'line-color', palette.waterLine);
      } else if (
        id.includes('road') ||
        id.includes('highway') ||
        id.includes('street') ||
        id.includes('bridge') ||
        id.includes('tunnel')
      ) {
        safeSetVisibility(map, layer.id, 'visible');
        roadLayersVisible++;
        if (id.includes('casing')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadCasing);
        } else if (id.includes('motorway') || id.includes('trunk')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadMotorway);
        } else if (id.includes('primary') || id.includes('secondary') || id.includes('tertiary')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadPrimary);
        } else if (id.includes('minor') || id.includes('street') || id.includes('link')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadSecondary);
        } else if (id.includes('path') || id.includes('pedestrian') || id.includes('service') || id.includes('track')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadMinor);
        } else if (id.includes('rail') || id.includes('transit')) {
          safeSetPaint(map, layer.id, 'line-color', palette.roadHighlight);
        }
      }
    } else if (type === 'symbol') {
      const keepMajorAvenueLabel = id === 'highway-name-major';
      if (!keepMajorAvenueLabel) {
        safeSetVisibility(map, layer.id, 'none');
      } else {
        safeSetVisibility(map, layer.id, 'visible');
        safeSetPaint(map, layer.id, 'text-color', palette.labelText);
        safeSetPaint(map, layer.id, 'text-halo-color', palette.labelHalo);
        safeSetPaint(map, layer.id, 'text-halo-width', 1.4);
        safeSetPaint(map, layer.id, 'text-opacity', mode === 'night' ? 0.68 : 0.8);
      }
    }
  }

  // 2. Apply realistic windowed facade patterns + height tonal variation + vertical shading to 3D buildings
  const heightExpr: unknown[] = [
    'coalesce',
    ['get', 'render_height'],
    ['get', 'height'],
    15,
  ];
  const baseExpr: unknown[] = [
    'coalesce',
    ['get', 'render_min_height'],
    ['get', 'min_height'],
    0,
  ];
  const fallbackColorExpr: unknown[] = [
    'interpolate',
    ['linear'],
    heightExpr,
    0,
    palette.buildingFallbackLow,
    14,
    palette.buildingFallbackMid,
    28,
    palette.buildingFallbackHigh,
  ];
  const patternExpr = getFacadePatternExpression(mode);

  const targetBuildingLayerId = existing3dBuildingId ?? 'alicante-buildings-3d';

  if (existing3dBuildingId) {
    safeSetVisibility(map, existing3dBuildingId, 'visible');
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-color', fallbackColorExpr);
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-pattern', patternExpr);
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-height', heightExpr);
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-base', baseExpr);
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-opacity', palette.buildingOpacity);
    safeSetPaint(map, existing3dBuildingId, 'fill-extrusion-vertical-gradient', true);
  } else if (!map.getLayer(targetBuildingLayerId)) {
    const { source, sourceLayer } = findBuildingSource(map);
    const beforeId =
      (carLayerId && map.getLayer(carLayerId) ? carLayerId : undefined) ??
      findFirstSymbolLayerId(map);

    map.addLayer(
      {
        id: targetBuildingLayerId,
        type: 'fill-extrusion',
        source,
        'source-layer': sourceLayer,
        minzoom: 14,
        paint: {
          'fill-extrusion-color': fallbackColorExpr as never,
          'fill-extrusion-pattern': patternExpr as never,
          'fill-extrusion-height': heightExpr as never,
          'fill-extrusion-base': baseExpr as never,
          'fill-extrusion-opacity': palette.buildingOpacity,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      beforeId
    );
  }

  // 3. Intense directional lighting tailored to each atmosphere for strong 3D facade relief
  try {
    map.setLight(palette.light);
  } catch {
    // Graceful fallback
  }

  // 4. Atmospheric sky & soft distant horizon gradient (prevents harsh horizon cutoff at low pitch / cockpit view)
  try {
    map.setSky(palette.sky);
  } catch {
    // Graceful fallback
  }

  return {
    buildingLayerId: targetBuildingLayerId,
    roadLayersVisible,
    waterLayerVisible,
  };
}

export function getSkyBackdropCss(mode: AtmosphereMode): string {
  switch (mode) {
    case 'sunset':
      return 'linear-gradient(180deg, #232e5e 0%, #804a62 50%, #f09459 100%)';
    case 'night':
      return 'linear-gradient(180deg, #040712 0%, #0b1633 56%, #13244a 100%)';
    case 'day':
      return 'linear-gradient(180deg, #449ae3 0%, #9acdf2 56%, #d7ecfa 100%)';
  }
}
