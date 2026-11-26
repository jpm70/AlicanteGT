import type { AtmosphereMode, CarPaintPreset, LandmarkPreset } from '../types/game';

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const INITIAL_VIEW = {
  lng: -0.48303,
  lat: 38.34325,
  zoom: 19.6,
  pitch: 74,
  bearing: 63,
};

export const ALICANTE_LANDMARKS: LandmarkPreset[] = [
  {
    id: 'explanada',
    name: 'Explanada',
    zone: 'Explanada de España · Mosaico ondulado',
    lat: 38.34325,
    lng: -0.48303,
    bearing: 63,
  },
  {
    id: 'castillo',
    name: 'Castillo Sta. Bárbara',
    zone: 'Monte Benacantil · Castillo de Santa Bárbara',
    lat: 38.34945,
    lng: -0.47819,
    bearing: 228,
  },
  {
    id: 'ayuntamiento',
    name: 'Ayuntamiento',
    zone: 'Plaza del Ayuntamiento · Casa Consistorial',
    lat: 38.34517,
    lng: -0.48105,
    bearing: 313,
  },
  {
    id: 'mercado',
    name: 'Mercado Central',
    zone: 'Av. Alfonso X El Sabio · Mercado Central',
    lat: 38.34758,
    lng: -0.48655,
    bearing: 26,
  },
  {
    id: 'santacruz',
    name: 'Barrio Santa Cruz',
    zone: 'Barrio de Santa Cruz · Casco Antiguo',
    lat: 38.34753,
    lng: -0.48327,
    bearing: 110,
  },
  {
    id: 'luceros',
    name: 'Plaza de Luceros',
    zone: 'Plaza de los Luceros · Fuente y estatua',
    lat: 38.34625,
    lng: -0.49104,
    bearing: 130,
  },
  {
    id: 'concatedral',
    name: 'Concatedral',
    zone: 'Concatedral de San Nicolás de Bari',
    lat: 38.34537,
    lng: -0.48285,
    bearing: 56,
    camera: 'aerial',
  },
  {
    id: 'santamaria',
    name: 'Santa María',
    zone: 'Basílica de Santa María · Casco Antiguo',
    lat: 38.34599,
    lng: -0.47859,
    bearing: 296,
  },
  {
    id: 'estacion',
    name: 'Estación Terminal',
    zone: 'Estación de Alicante-Terminal',
    lat: 38.34521,
    lng: -0.49547,
    bearing: 169,
  },
  {
    id: 'adda',
    name: 'Auditorio ADDA',
    zone: 'Auditorio de la Diputación · ADDA',
    lat: 38.35501,
    lng: -0.4864,
    bearing: 156,
  },
  {
    id: 'tunel',
    name: 'Túnel de Dénia',
    zone: 'Avinguda de Dénia · Túnel',
    lat: 38.35173,
    lng: -0.47266,
    bearing: 357,
  },
  {
    id: 'puente',
    name: 'Puente Dr. Jiménez',
    zone: 'Avinguda del Doctor Jiménez · Puente',
    lat: 38.3471,
    lng: -0.50699,
    bearing: 8,
  },
  {
    id: 'puerto',
    name: 'Puerto Deportivo',
    zone: 'Muelle de Levante · Marina de Alicante',
    lat: 38.3414,
    lng: -0.4828,
    bearing: 28,
  },
  {
    id: 'postiguet',
    name: 'Playa del Postiguet',
    zone: 'Paseo de Gómiz · Playa del Postiguet',
    lat: 38.3458,
    lng: -0.4766,
    bearing: 58,
  },
  {
    id: 'alfonso',
    name: 'Av. Alfonso X El Sabio',
    zone: 'Centro · Av. Alfonso X El Sabio',
    lat: 38.3474,
    lng: -0.4868,
    bearing: 74,
  },
];

export const CAR_PAINT_PRESETS: CarPaintPreset[] = [
  {
    id: 'rosso',
    label: 'Rojo Levante',
    hex: 0xd9232e,
    css: '#d9232e',
    caliperHex: 0xf5b700,
    underglowHex: 0xff3b30,
  },
  {
    id: 'mediterraneo',
    label: 'Azul Mediterráneo',
    hex: 0x0e63b8,
    css: '#0e63b8',
    caliperHex: 0xff6b2b,
    underglowHex: 0x22d3ee,
  },
  {
    id: 'titanio',
    label: 'Plata Titanio',
    hex: 0xc9d2de,
    css: '#c9d2de',
    caliperHex: 0xef4444,
    underglowHex: 0x38bdf8,
  },
  {
    id: 'sol',
    label: 'Amarillo Sol',
    hex: 0xe6a100,
    css: '#e6a100',
    caliperHex: 0xd9232e,
    underglowHex: 0xf59e0b,
  },
  {
    id: 'obsidiana',
    label: 'Negro Obsidiana',
    hex: 0x181c26,
    css: '#181c26',
    caliperHex: 0x22d3ee,
    underglowHex: 0x38bdf8,
  },
];

export interface AtmosphereLightingSpec {
  id: AtmosphereMode;
  label: string;
  shortLabel: string;
  /** Three.js directional key light */
  keyColor: number;
  keyIntensity: number;
  keyPosition: [number, number, number];
  /** Three.js hemisphere light */
  hemiSkyColor: number;
  hemiGroundColor: number;
  hemiIntensity: number;
  /** Three.js rim light */
  rimColor: number;
  rimIntensity: number;
  /** Environment reflection multiplier */
  envIntensity: number;
  /** Car headlight beam & ground light pool strength [0..1] */
  headlightStrength: number;
  /** Neon underglow visibility [0..1] */
  underglowStrength: number;
  /** Contact shadow darkness */
  shadowOpacity: number;
}

export const ATMOSPHERE_SPECS: Record<AtmosphereMode, AtmosphereLightingSpec> = {
  sunset: {
    id: 'sunset',
    label: 'Atardecer Mediterráneo',
    shortLabel: 'Atardecer',
    keyColor: 0xffb36b,
    keyIntensity: 2.6,
    keyPosition: [-18, 12, 14],
    hemiSkyColor: 0x6b7fd7,
    hemiGroundColor: 0x3d2a24,
    hemiIntensity: 1.05,
    rimColor: 0xff8a4c,
    rimIntensity: 1.15,
    envIntensity: 1.15,
    headlightStrength: 0.42,
    underglowStrength: 0.12,
    shadowOpacity: 0.56,
  },
  night: {
    id: 'night',
    label: 'Noche Neón',
    shortLabel: 'Noche Neón',
    keyColor: 0x6e9eff,
    keyIntensity: 1.15,
    keyPosition: [12, 16, -12],
    hemiSkyColor: 0x1e3566,
    hemiGroundColor: 0x0b1020,
    hemiIntensity: 0.65,
    rimColor: 0x38bdf8,
    rimIntensity: 1.5,
    envIntensity: 0.72,
    headlightStrength: 1.0,
    underglowStrength: 0.75,
    shadowOpacity: 0.68,
  },
  day: {
    id: 'day',
    label: 'Día',
    shortLabel: 'Día',
    keyColor: 0xfff8eb,
    keyIntensity: 2.85,
    keyPosition: [16, 28, 12],
    hemiSkyColor: 0x9bd0ff,
    hemiGroundColor: 0x5c5752,
    hemiIntensity: 1.25,
    rimColor: 0xdbeafe,
    rimIntensity: 0.7,
    envIntensity: 1.35,
    headlightStrength: 0.08,
    underglowStrength: 0.0,
    shadowOpacity: 0.52,
  },
};

export interface ZoneAnchor {
  name: string;
  lat: number;
  lng: number;
}

export const ALICANTE_ZONES: ZoneAnchor[] = [
  { name: 'Paseo Mártires de la Libertad · Puerto', lat: 38.3432, lng: -0.4820 },
  { name: 'Explanada de España', lat: 38.34325, lng: -0.48303 },
  { name: 'Puerto Deportivo de Alicante', lat: 38.3408, lng: -0.4832 },
  { name: 'Playa del Postiguet', lat: 38.3462, lng: -0.4758 },
  { name: 'Casco Antiguo · Santa Cruz', lat: 38.3474, lng: -0.4824 },
  { name: 'Plaza del Ayuntamiento', lat: 38.34495, lng: -0.48106 },
  { name: 'Basílica de Santa María', lat: 38.34623, lng: -0.47955 },
  { name: 'Concatedral de San Nicolás', lat: 38.34556, lng: -0.48325 },
  { name: 'Estación Alicante-Terminal', lat: 38.34463, lng: -0.49533 },
  { name: 'Benalúa', lat: 38.3372, lng: -0.4975 },
  { name: 'Carolinas Bajas', lat: 38.3538, lng: -0.4975 },
  { name: 'Carolinas Altas', lat: 38.3585, lng: -0.4955 },
  { name: 'San Blas', lat: 38.3512, lng: -0.4915 },
  { name: 'Plaza de América', lat: 38.35905, lng: -0.4849 },
  { name: 'Auditorio ADDA · Diputación', lat: 38.3543, lng: -0.48598 },
  { name: 'Hospital General Universitario', lat: 38.36377, lng: -0.48758 },
  { name: 'Parque Lo Morant', lat: 38.36738, lng: -0.48598 },
  { name: 'Vistahermosa', lat: 38.36302, lng: -0.46386 },
  { name: 'Palacio de Congresos', lat: 38.35728, lng: -0.47145 },
  { name: 'Florida · Babel', lat: 38.33925, lng: -0.5148 },
  { name: 'Av. de Dénia · Túnel', lat: 38.3525, lng: -0.4735 },
  { name: 'Mercado Central', lat: 38.34774, lng: -0.48611 },
  { name: 'Castillo de Santa Bárbara', lat: 38.3490, lng: -0.4781 },
  { name: 'Rambla de Méndez Núñez', lat: 38.3466, lng: -0.4852 },
  { name: 'Av. Alfonso X El Sabio', lat: 38.3478, lng: -0.4882 },
  { name: 'Plaza de los Luceros', lat: 38.346, lng: -0.49067 },
  { name: 'Av. de Maisonnave', lat: 38.3435, lng: -0.4910 },
  { name: 'Paseo de la Canalejas', lat: 38.3422, lng: -0.4865 },
];
