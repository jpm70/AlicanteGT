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
      accel = 17.5 * (1 - 0.58 * speedRatio * speedRatio);
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

  // Rolling resistance & aerodynamic drag
  const drag =
    -state.speedMps * 0.24 -
    state.speedMps * absSpeed * 0.0042;
  accel += drag;

  state.speedMps += accel * dt;

  // Stop creeping at very low speed when idle
  if (!input.throttle && !input.brake && Math.abs(state.speedMps) < 0.18) {
    state.speedMps = 0;
  }

  state.speedMps = Math.max(MAX_REVERSE_MPS, Math.min(MAX_FORWARD_MPS, state.speedMps));

  // 2. Steering input & front wheel visual angle
  const steerInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const maxVisualSteer = 0.56; // ~32 deg at low speed
  const speedSteerScale = 1 - Math.min(absSpeed / MAX_FORWARD_MPS, 1) * 0.52;
  const targetVisualSteer = steerInput * maxVisualSteer * speedSteerScale;
  state.steerAngleRad = damp(state.steerAngleRad, targetVisualSteer, 12.5, dt);

  // 3. Drift dynamics (Space + steering at speed)
  const canDrift = input.handbrake && state.speedMps > 7.5;
  const isActivelyDrifting = canDrift && (Math.abs(steerInput) > 0 || Math.abs(state.driftSlipRad) > 0.08);
  const targetSlip = canDrift
    ? steerInput * Math.min(0.46, 0.24 + (state.speedMps / MAX_FORWARD_MPS) * 0.24)
    : 0;
  state.driftSlipRad = damp(
    state.driftSlipRad,
    targetSlip,
    canDrift ? 5.2 : 7.5,
    dt
  );

  // 4. Yaw rate (heading change)
  if (absSpeed > 0.15) {
    const directionSign = state.speedMps >= 0 ? 1 : -1;
    const lowSpeedFactor = Math.min(absSpeed / 6.5, 1.0);
    const highSpeedStability = 1.0 - Math.min(absSpeed / (MAX_FORWARD_MPS * 1.15), 0.58);
    const driftTurnBoost = canDrift ? 1.52 : 1.0;

    // Max ~125 deg/s in tight urban turns, smooth at highway speeds
    const yawRateDegPerSec =
      steerInput * 128 * lowSpeedFactor * highSpeedStability * driftTurnBoost * directionSign;

    state.headingDeg = (state.headingDeg + yawRateDegPerSec * dt + 360) % 360;
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
  const targetPitch = Math.max(-0.042, Math.min(0.036, -longAccel * 0.0014));
  const lateralG = steerInput * Math.min(absSpeed / 22, 1.3) * (canDrift ? 1.35 : 1.0);
  const targetRoll = Math.max(-0.055, Math.min(0.055, lateralG * 0.038));

  state.bodyPitchRad = damp(state.bodyPitchRad, targetPitch, 9.5, dt);
  state.bodyRollRad = damp(state.bodyRollRad, targetRoll, 9.5, dt);

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
