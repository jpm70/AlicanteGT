export type AtmosphereMode = 'sunset' | 'night' | 'day';

export type CameraPreset = 'chase' | 'driver' | 'aerial';

export interface CarPaintPreset {
  id: string;
  label: string;
  hex: number;
  css: string;
  caliperHex: number;
  underglowHex: number;
}

export interface LandmarkPreset {
  id: string;
  name: string;
  zone: string;
  lat: number;
  lng: number;
  bearing: number;
  /** Cámara con la que se llega al punto (por defecto, la actual). */
  camera?: CameraPreset;
}

export interface ControlInput {
  throttle: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
  handbrake: boolean;
}

export interface CarState {
  lat: number;
  lng: number;
  /** Compass heading in degrees (0 = North, 90 = East, clockwise) */
  headingDeg: number;
  /** Forward speed in meters per second (negative when reversing) */
  speedMps: number;
  /** Absolute speed in km/h for HUD */
  speedKmh: number;
  /** Normalized RPM [0.12 .. 1.0] */
  rpm: number;
  /** Current gear string ('R', 'N', '1'..'6') */
  gear: string;
  /** Front wheel visual steering angle in radians */
  steerAngleRad: number;
  /** Accumulated wheel spin rotation in radians */
  wheelSpinRad: number;
  /** Dynamic lateral drift slip angle in radians */
  driftSlipRad: number;
  /** Suspension pitch (nose up/down) in radians */
  bodyPitchRad: number;
  /** Suspension roll (chassis lean) in radians */
  bodyRollRad: number;
  /** True when braking or handbraking */
  isBraking: boolean;
  /** True when actively sliding in a drift */
  isDrifting: boolean;
  /** Smoothly interpolated intensity [0..1] for brake lights */
  brakeIntensity: number;
  /** Smoothly interpolated intensity [0..1] for drift smoke */
  driftIntensity: number;
  /** Dirección analógica [-1..1]: sube y baja progresivamente con las teclas */
  steerCmd: number;
  /** Velocidad de guiñada (rad/s, + = giro a la derecha) */
  yawRate: number;
  /** Aceleración lateral (m/s², + = hacia la derecha) */
  latAccel: number;
  /** Sacudida de cámara por impactos [0..1] */
  shake: number;
  /** Daños acumulados por choques [0..1] (0 = como nuevo) */
  damage: number;
}

export interface HudTelemetry {
  speedKmh: number;
  gear: string;
  rpm: number;
  isBraking: boolean;
  isDrifting: boolean;
  zoneName: string;
  headingDeg: number;
  lat: number;
  lng: number;
  tilesStatus: 'loading' | 'ready' | 'error';
  tileStatusText: string;
  damage: number;
}

/** Un sitio elegible como salida o meta. `b` = rumbo por defecto de salida (si lo tiene). */
/** `ax`: `b` es el eje de una calle (vale en cualquiera de sus dos sentidos). */
export interface PlaceRef { n: string; la: number; lo: number; b?: number; ax?: boolean; c?: string }

/** Lo que se elige en la pantalla de inicio. */
export interface RaceConfig {
  start: PlaceRef;
  /** Rumbo de salida en grados, o 'auto' (hacia la meta; sin meta, el del lugar). */
  bearing: number | 'auto';
  dest: PlaceRef | null;
  camera: CameraPreset;
  paintId: string;
  atmosphere: AtmosphereMode;
  traffic: boolean;
  audio: boolean;
}
