import { ALICANTE_ZONES, INITIAL_VIEW } from './constants';
import type { CarState, ControlInput } from '../types/game';

const METERS_PER_DEG_LAT = 111320;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Max speeds in meters/sec (58 m/s ≈ 209 km/h) */
const MAX_FORWARD_MPS = 58.0;
const MAX_REVERSE_MPS = -14.0;
const WHEEL_RADIUS_M = 0.36;

// Gear upper speed thresholds in km/h
const GEAR_THRESHOLDS_KMH = [42, 76, 114, 152, 186, 220];

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function createInitialCarState(
  lat = INITIAL_VIEW.lat,
  lng = INITIAL_VIEW.lng,
  headingDeg = INITIAL_VIEW.bearing
): CarState {
  return {
    lat,
    lng,
    headingDeg,
    speedMps: 0,
    speedKmh: 0,
    rpm: 0.16,
    gear: 'N',
    steerAngleRad: 0,
    wheelSpinRad: 0,
    driftSlipRad: 0,
    bodyPitchRad: 0,
    bodyRollRad: 0,
    isBraking: false,
    isDrifting: false,
    brakeIntensity: 0,
    driftIntensity: 0,
    steerCmd: 0,
    yawRate: 0,
    latAccel: 0,
    shake: 0,
  };
}

export function stepCarPhysics(
  state: CarState,
  input: ControlInput,
  dtRaw: number
): void {
  // Clamp dt to keep physics rock-solid across tab switches or software WebGL pauses
  const dt = Math.min(Math.max(dtRaw, 0.001), 0.05);

  const prevSpeed = state.speedMps;
  const absSpeed = Math.abs(state.speedMps);

  // 1. Longitudinal acceleration / braking / aerodynamic drag
  let accel = 0;
  let brakingNow = false;

  if (input.throttle) {
    if (state.speedMps < -0.5) {
      // Braking out of reverse
      accel = 28.0;
      brakingNow = true;
    } else {
      // Torque curve: punchy off the line, smooth taper near top speed
      const speedRatio = Math.min(absSpeed / MAX_FORWARD_MPS, 1);
      accel = 11.5 * (1 - 0.58 * speedRatio * speedRatio);
    }
  } else if (input.brake) {
    if (state.speedMps > 0.6) {
      // Strong carbon-ceramic brakes
      accel = -31.0;
      brakingNow = true;
    } else {
      // Smooth reverse gear
      const revRatio = Math.min(Math.abs(state.speedMps) / Math.abs(MAX_REVERSE_MPS), 1);
      accel = -9.5 * (1 - 0.5 * revRatio);
    }
  }

  // Handbrake deceleration + drift initiation
  if (input.handbrake) {
    brakingNow = true;
    if (absSpeed > 0.4) {
      const sign = Math.sign(state.speedMps);
      accel -= sign * (input.throttle ? 6.5 : 18.5);
    }
  }

  // Freno motor al soltar el acelerador
  if (!input.throttle && !input.brake && absSpeed > 1) accel -= Math.sign(state.speedMps) * 1.6;

  // Rolling resistance & aerodynamic drag
  const drag =
    -state.speedMps * 0.035 -
    state.speedMps * absSpeed * 0.0013;
  accel += drag;

  state.speedMps += accel * dt;

  // Stop creeping at very low speed when idle
  if (!input.throttle && !input.brake && Math.abs(state.speedMps) < 0.18) {
    state.speedMps = 0;
  }

  state.speedMps = Math.max(MAX_REVERSE_MPS, Math.min(MAX_FORWARD_MPS, state.speedMps));

  // 2. Dirección progresiva: el volante tarda en girar y vuelve solo al centro (más lento a velocidad alta)
  const steerInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const speedRatio01 = Math.min(absSpeed / MAX_FORWARD_MPS, 1);
  const rate = steerInput === 0 ? 9 : (Math.sign(steerInput) !== Math.sign(state.steerCmd) && state.steerCmd !== 0 ? 12 : 7.0 - 2.5 * speedRatio01);
  const cmdTarget = steerInput;
  const stepCmd = rate * dt;
  state.steerCmd += Math.max(-stepCmd, Math.min(stepCmd, cmdTarget - state.steerCmd));
  const steerCmd = state.steerCmd;
  const maxVisualSteer = 0.56; // ~32 deg at low speed
  const speedSteerScale = 1 - speedRatio01 * 0.62;
  const targetVisualSteer = steerCmd * maxVisualSteer * speedSteerScale;
  state.steerAngleRad = damp(state.steerAngleRad, targetVisualSteer, 14, dt);

  // 3. Drift dynamics (Space + steering at speed)
  const canDrift = input.handbrake && state.speedMps > 7.5;
  const isActivelyDrifting = canDrift && (Math.abs(steerInput) > 0 || Math.abs(state.driftSlipRad) > 0.08);
  const targetSlip = canDrift
    ? steerCmd * Math.min(0.46, 0.24 + (state.speedMps / MAX_FORWARD_MPS) * 0.24)
    : 0;
  state.driftSlipRad = damp(
    state.driftSlipRad,
    targetSlip,
    canDrift ? 5.2 : 7.5,
    dt
  );

  // 4. Guiñada: modelo de bicicleta limitado por el agarre (subviraje en curvas rápidas)
  let yawRateRad = 0;
  if (absSpeed > 0.15) {
    const directionSign = state.speedMps >= 0 ? 1 : -1;
    const WHEELBASE = 2.7;
    const delta = state.steerAngleRad * (canDrift ? 1.5 : 1);
    const lowSpeedFactor = Math.min(absSpeed / 3.0, 1.0);
    const wanted = (absSpeed * Math.tan(delta)) / WHEELBASE;
    const gripLat = canDrift ? 24 : 18;                       // m/s² de agarre lateral (~1,1 g)
    const maxYaw = gripLat / Math.max(absSpeed, 4);
    yawRateRad = Math.max(-maxYaw, Math.min(maxYaw, wanted)) * lowSpeedFactor * directionSign;
    state.headingDeg = (state.headingDeg + yawRateRad * RAD_TO_DEG * dt + 360) % 360;
  }
  state.yawRate = damp(state.yawRate, yawRateRad, 14, dt);
  state.latAccel = state.yawRate * state.speedMps;
  // Deslizamiento natural al pedir más de lo que da el agarre
  if (!canDrift) {
    const slipNat = Math.max(-0.07, Math.min(0.07, state.latAccel * 0.004));
    state.driftSlipRad = damp(state.driftSlipRad, slipNat, 6, dt);
  }

  // 5. Move along velocity heading (heading + drift slip offset so car visibly slides sideways!)
  const travelHeadingRad = (state.headingDeg - state.driftSlipRad * RAD_TO_DEG * 0.65) * DEG_TO_RAD;
  const distMeters = state.speedMps * dt;
  const northMeters = Math.cos(travelHeadingRad) * distMeters;
  const eastMeters = Math.sin(travelHeadingRad) * distMeters;

  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos(state.lat * DEG_TO_RAD);
  state.lat += northMeters / METERS_PER_DEG_LAT;
  state.lng += eastMeters / metersPerDegLng;

  // 6. Wheel rotation, suspension pitch & roll
  state.wheelSpinRad = (state.wheelSpinRad + (state.speedMps * dt) / WHEEL_RADIUS_M) % (Math.PI * 200);

  const longAccel = (state.speedMps - prevSpeed) / dt;
  const targetPitch = Math.max(-0.042, Math.min(0.036, -longAccel * 0.0016));
  const targetRoll = Math.max(-0.075, Math.min(0.075, state.latAccel * 0.0042));

  state.bodyPitchRad = damp(state.bodyPitchRad, targetPitch, 6.5, dt);
  state.bodyRollRad = damp(state.bodyRollRad, targetRoll, 6.5, dt);

  // 7. Derived telemetry: km/h, gear, RPM, brake/drift intensities
  state.speedKmh = Math.abs(state.speedMps) * 3.6;
  state.isBraking = brakingNow;
  state.isDrifting = isActivelyDrifting || Math.abs(state.driftSlipRad) > 0.14;

  state.brakeIntensity = damp(state.brakeIntensity, brakingNow ? 1 : 0, 14, dt);
  state.driftIntensity = damp(
    state.driftIntensity,
    state.isDrifting && state.speedMps > 6.5 ? 1 : 0,
    8,
    dt
  );

  if (state.speedMps < -0.5) {
    state.gear = 'R';
    state.rpm = Math.min(0.85, 0.24 + (state.speedKmh / 55) * 0.6);
  } else if (state.speedKmh < 1.2 && !input.throttle) {
    state.gear = 'N';
    state.rpm = damp(state.rpm, 0.15, 6, dt);
  } else {
    let gearIdx = 0;
    for (let i = 0; i < GEAR_THRESHOLDS_KMH.length; i++) {
      if (state.speedKmh <= GEAR_THRESHOLDS_KMH[i]) {
        gearIdx = i;
        break;
      }
      gearIdx = GEAR_THRESHOLDS_KMH.length - 1;
    }
    state.gear = String(gearIdx + 1);
    const gearMin = gearIdx === 0 ? 0 : GEAR_THRESHOLDS_KMH[gearIdx - 1] * 0.72;
    const gearMax = GEAR_THRESHOLDS_KMH[gearIdx];
    const gearRatio = Math.max(0, Math.min(1, (state.speedKmh - gearMin) / Math.max(1, gearMax - gearMin)));
    const targetRpm = Math.min(0.98, 0.24 + gearRatio * 0.72 + (input.throttle ? 0.05 : 0));
    state.rpm = damp(state.rpm, targetRpm, 10, dt);
  }
}

export function getNearestAlicanteZone(lat: number, lng: number): string {
  let nearest = ALICANTE_ZONES[0].name;
  let bestDistSq = Infinity;
  for (let i = 0; i < ALICANTE_ZONES.length; i++) {
    const z = ALICANTE_ZONES[i];
    const dLat = z.lat - lat;
    const dLng = (z.lng - lng) * 0.78;
    const dSq = dLat * dLat + dLng * dLng;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      nearest = z.name;
    }
  }
  if (bestDistSq > 0.0005) {
    return 'Alicante · Costa Blanca';
  }
  return nearest;
}
