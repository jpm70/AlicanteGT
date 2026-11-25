import * as THREE from 'three';
import type { AtmosphereMode, CarPaintPreset, CarState } from '../types/game';
import { ATMOSPHERE_SPECS } from '../game/constants';
import { CAR, createBodyGeometry, createCabinGeometry, createRimGeometry, createTireGeometry } from './carBody';

export interface SportsCarRig {
  root: THREE.Group;
  chassisGroup: THREE.Group;
  updateFromState: (state: CarState, dt: number) => void;
  setPaint: (paint: CarPaintPreset) => void;
  setAtmosphere: (mode: AtmosphereMode) => void;
  setBodyVisible: (visible: boolean) => void;
  dispose: () => void;
}

interface DriftParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  vx: number;
  vy: number;
  vz: number;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 256, 512);
  // Soft outer ambient shadow
  const gradOuter = ctx.createRadialGradient(128, 256, 20, 128, 256, 122);
  gradOuter.addColorStop(0, 'rgba(0, 0, 0, 0.82)');
  gradOuter.addColorStop(0.55, 'rgba(0, 0, 0, 0.45)');
  gradOuter.addColorStop(0.82, 'rgba(0, 0, 0, 0.14)');
  gradOuter.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.save();
  ctx.translate(128, 256);
  ctx.scale(0.92, 1.88);
  ctx.translate(-128, -256);
  ctx.fillStyle = gradOuter;
  ctx.fillRect(0, 0, 256, 512);
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createHeadlightPoolTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 256, 512);
  // Dual overlapping forward headlight cones projected onto asphalt
  const drawBeam = (cx: number) => {
    const grad = ctx.createRadialGradient(cx, 480, 6, cx, 240, 245);
    grad.addColorStop(0, 'rgba(255, 250, 232, 0.92)');
    grad.addColorStop(0.22, 'rgba(235, 246, 255, 0.56)');
    grad.addColorStop(0.58, 'rgba(186, 224, 255, 0.22)');
    grad.addColorStop(1, 'rgba(150, 205, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - 12, 495);
    ctx.lineTo(cx - 108, 20);
    ctx.lineTo(cx + 108, 20);
    ctx.lineTo(cx + 12, 495);
    ctx.closePath();
    ctx.fill();
  };

  drawBeam(92);
  drawBeam(164);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createRadialGlowTexture(innerRgba: string, midRgba: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  grad.addColorStop(0, innerRgba);
  grad.addColorStop(0.45, midRgba);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createSmokeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(230, 236, 245, 0.65)');
  grad.addColorStop(0.55, 'rgba(200, 210, 224, 0.28)');
  grad.addColorStop(1, 'rgba(180, 190, 205, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Procedurally constructs a detailed, sculpted 3D GT sports car in metric space:
 *  - Nose faces -Z, Rear faces +Z, Right is +X, Up is +Y, Ground contact is Y = 0.
 *  - Uses ExtrudeGeometry with bevels for the aerodynamic coupe silhouette,
 *    PBR metallic clearcoat paint, tinted wraparound glass, carbon rear spoiler,
 *    4 independent wheels with steering front knuckles and brake calipers,
 *    headlight beams + asphalt projection, dynamic brake lights, and soft contact shadow.
 */
export function createSportsCar(
  initialPaint: CarPaintPreset,
  initialAtmosphere: AtmosphereMode
): SportsCarRig {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const root = new THREE.Group();
  // Base chassis length is ~4.54m; 1.22x gives ~5.54m for crisp visibility in chase perspective
  root.scale.setScalar(1.22);

  const chassisGroup = new THREE.Group();
  root.add(chassisGroup);

  // --- Shared PBR Materials (calibrated roughness/metalness contrast >= 0.25) ---
  const bodyPaintMat = track(
    new THREE.MeshPhysicalMaterial({
      color: initialPaint.hex,
      metalness: 0.86,
      roughness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.35,
    })
  );

  const carbonMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x161922,
      metalness: 0.25,
      roughness: 0.56,
      envMapIntensity: 0.8,
    })
  );

  const glassMat = track(
    new THREE.MeshPhysicalMaterial({
      color: 0x0a111f,
      metalness: 0.92,
      roughness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.6,
    })
  );

  const chromeMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xe6ecf5,
      metalness: 0.96,
      roughness: 0.12,
      envMapIntensity: 1.5,
    })
  );

  const tireMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x15171c,
      metalness: 0.04,
      roughness: 0.86,
    })
  );

  const rimMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xd4dde8,
      metalness: 0.94,
      roughness: 0.16,
      envMapIntensity: 1.4,
    })
  );

  const rotorMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x8b95a5,
      metalness: 0.85,
      roughness: 0.32,
    })
  );

  const caliperMat = track(
    new THREE.MeshStandardMaterial({
      color: initialPaint.caliperHex,
      metalness: 0.45,
      roughness: 0.3,
    })
  );

  const headlightLensMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xfff4d6,
      emissiveIntensity: 2.2,
      roughness: 0.1,
      metalness: 0.1,
    })
  );

  const brakeLightMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x8f0912,
      emissive: 0xff1624,
      emissiveIntensity: 1.5,
      roughness: 0.14,
      metalness: 0.1,
    })
  );

  // --- 1. Carrocería moldeada por secciones (pasos de rueda reales, capó con power dome) + habitáculo ---
  const bodyGeo = track(createBodyGeometry());
  chassisGroup.add(new THREE.Mesh(bodyGeo, bodyPaintMat));
  const cabinGeo = track(createCabinGeometry());
  chassisGroup.add(new THREE.Mesh(cabinGeo, [glassMat, bodyPaintMat]));   // grupo 0 cristal, grupo 1 techo pintado

  const darkMat = track(new THREE.MeshStandardMaterial({ color: 0x07090d, metalness: 0.3, roughness: 0.7 }));
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(track(geo), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    chassisGroup.add(m);
    return m;
  };

  // pasos de rueda: forro oscuro semicircular
  for (const wz of [CAR.frontZ, CAR.rearZ]) {
    for (const sx of [-1, 1]) {
      const wx = sx * (wz < 0 ? CAR.frontX : CAR.rearX);
      const liner = new THREE.Mesh(track(new THREE.CylinderGeometry(0.44, 0.44, 0.34, 22, 1, true, 0, Math.PI)), darkMat);
      liner.material.side = THREE.DoubleSide;
      liner.rotation.set(0, 0, Math.PI / 2);
      liner.rotation.order = 'ZYX';
      liner.position.set(wx, CAR.wheelR, wz);
      chassisGroup.add(liner);
    }
  }

  // morro: labio delantero, parrilla con lamas y entradas de aire
  add(new THREE.BoxGeometry(1.72, 0.05, 0.46), carbonMat, 0, 0.17, -2.09);
  add(new THREE.BoxGeometry(1.04, 0.15, 0.05), darkMat, 0, 0.33, -2.255);
  for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(1.0, 0.012, 0.06), carbonMat, 0, 0.285 + i * 0.045, -2.262);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.3, 0.09, 0.05), darkMat, sx * 0.62, 0.3, -2.17, 0, sx * 0.3, 0);

  // capó: tomas de aire de fibra de carbono
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.26, 0.02, 0.5), carbonMat, sx * 0.3, 0.805, -1.05, 0.12, 0, 0);

  // laterales: líneas de puerta, branquias traseras y faldones
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.012, 0.3, 0.012), darkMat, sx * 0.905, 0.6, -0.55);
    add(new THREE.BoxGeometry(0.012, 0.3, 0.012), darkMat, sx * 0.905, 0.6, 0.62);
    add(new THREE.BoxGeometry(0.012, 0.012, 1.17), darkMat, sx * 0.905, 0.76, 0.035);
    add(new THREE.BoxGeometry(0.03, 0.2, 0.5), darkMat, sx * 0.93, 0.56, 0.95);
    add(new THREE.BoxGeometry(0.06, 0.07, 1.8), carbonMat, sx * 0.9, 0.19, 0.0);
    // retrovisores
    add(new THREE.BoxGeometry(0.2, 0.035, 0.06), carbonMat, sx * 0.8, 0.9, -0.66);
    add(new THREE.BoxGeometry(0.17, 0.1, 0.13), bodyPaintMat, sx * 0.92, 0.93, -0.6, 0, sx * -0.18, 0);
    // tiradores
    add(new THREE.BoxGeometry(0.016, 0.02, 0.17), chromeMat, sx * 0.915, 0.74, 0.34);
  }

  // cola: difusor con aletas, escapes cuádruples, matrícula, ducktail y alerón GT
  add(new THREE.BoxGeometry(1.1, 0.14, 0.12), carbonMat, 0, 0.255, 2.21);
  for (const fx of [-0.36, 0, 0.36]) add(new THREE.BoxGeometry(0.025, 0.12, 0.16), carbonMat, fx, 0.25, 2.26);
  const exhaustGeo = track(new THREE.CylinderGeometry(0.055, 0.055, 0.2, 14));
  exhaustGeo.rotateX(Math.PI / 2);
  for (const ex of [-0.4, -0.26, 0.26, 0.4]) {
    const tip = new THREE.Mesh(exhaustGeo, chromeMat);
    tip.position.set(ex, 0.31, 2.27);
    chassisGroup.add(tip);
  }
  add(new THREE.BoxGeometry(0.46, 0.12, 0.02), track(new THREE.MeshStandardMaterial({ color: 0xf1f1ea, roughness: 0.5 })), 0, 0.46, 2.285);
  add(new THREE.BoxGeometry(1.5, 0.03, 0.2), bodyPaintMat, 0, 0.8, 2.04, -0.2, 0, 0);
  const spoilerGroup = new THREE.Group();
  for (const sx of [-0.5, 0.5]) {
    const strut = new THREE.Mesh(track(new THREE.BoxGeometry(0.05, 0.3, 0.14)), carbonMat);
    strut.position.set(sx, 0.95, 2.0);
    strut.rotation.x = 0.18;
    spoilerGroup.add(strut);
  }
  const wingBlade = new THREE.Mesh(track(new THREE.BoxGeometry(1.62, 0.045, 0.3)), carbonMat);
  wingBlade.position.set(0, 1.1, 2.07);
  wingBlade.rotation.x = 0.1;
  spoilerGroup.add(wingBlade);
  for (const ex of [-0.82, 0.82]) {
    const endplate = new THREE.Mesh(track(new THREE.BoxGeometry(0.03, 0.2, 0.36)), bodyPaintMat);
    endplate.position.set(ex, 1.09, 2.07);
    spoilerGroup.add(endplate);
  }
  chassisGroup.add(spoilerGroup);

  // --- 5. Sharp LED Headlights + Volumetric Beams + Asphalt Light Pool ---
  const hlHousingGeo = track(new THREE.BoxGeometry(0.4, 0.055, 0.14));
  const hlRingGeo = track(new THREE.BoxGeometry(0.44, 0.085, 0.1));
  for (const side of [-1, 1]) {
    const bezel = new THREE.Mesh(hlRingGeo, carbonMat);
    bezel.position.set(side * 0.57, 0.465, -2.1);
    bezel.rotation.set(0.1, side * -0.34, side * 0.05);
    chassisGroup.add(bezel);
    const hl = new THREE.Mesh(hlHousingGeo, headlightLensMat);
    hl.position.set(side * 0.57, 0.47, -2.15);
    hl.rotation.set(0.1, side * -0.34, side * 0.05);
    chassisGroup.add(hl);
    const drl = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.012, 0.03)), headlightLensMat);
    drl.position.set(side * 0.56, 0.43, -2.16);
    drl.rotation.set(0.1, side * -0.34, 0);
    chassisGroup.add(drl);
  }

  // Volumetric translucent headlight cones extending along -Z
  const beamConeGeo = track(new THREE.ConeGeometry(1.65, 11.5, 16, 1, true));
  beamConeGeo.translate(0, -5.75, 0);
  beamConeGeo.rotateX(Math.PI / 2); // Tip at origin, flares toward -Z
  const beamConeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xe8f3ff,
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  const leftBeam = new THREE.Mesh(beamConeGeo, beamConeMat);
  leftBeam.position.set(-0.57, 0.47, -2.2);
  leftBeam.rotation.x = -0.045;
  chassisGroup.add(leftBeam);

  const rightBeam = new THREE.Mesh(beamConeGeo, beamConeMat);
  rightBeam.position.set(0.57, 0.47, -2.2);
  rightBeam.rotation.x = -0.045;
  chassisGroup.add(rightBeam);

  // Projected headlight asphalt pool (illuminates the real street ahead!)
  const poolTex = track(createHeadlightPoolTexture());
  const poolGeo = track(new THREE.PlaneGeometry(8.6, 20.0));
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = track(
    new THREE.MeshBasicMaterial({
      map: poolTex,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  const headlightPool = new THREE.Mesh(poolGeo, poolMat);
  headlightPool.position.set(0, 0.04, -12.1);
  root.add(headlightPool);

  // --- 6. Rear Full-Width LED Tail-Light Bar + Intense Brake Flare ---
  const tailBarGeo = track(new THREE.BoxGeometry(1.42, 0.06, 0.05));
  const tailBar = new THREE.Mesh(tailBarGeo, brakeLightMat);
  tailBar.position.set(0, 0.63, 2.27);
  chassisGroup.add(tailBar);

  const tailPodGeo = track(new THREE.BoxGeometry(0.36, 0.1, 0.06));
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(tailPodGeo, brakeLightMat);
    pod.position.set(side * 0.55, 0.6, 2.26);
    pod.rotation.y = side * 0.25;
    chassisGroup.add(pod);
  }

  // Additive rear brake glow halo & asphalt red reflection
  const redGlowTex = track(
    createRadialGlowTexture('rgba(255, 45, 55, 0.95)', 'rgba(255, 16, 30, 0.35)')
  );
  const brakeHaloGeo = track(new THREE.PlaneGeometry(1.25, 0.52));
  const brakeHaloMat = track(
    new THREE.MeshBasicMaterial({
      map: redGlowTex,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  const brakeHaloLeft = new THREE.Mesh(brakeHaloGeo, brakeHaloMat);
  brakeHaloLeft.position.set(-0.55, 0.62, 2.33);
  chassisGroup.add(brakeHaloLeft);

  const brakeHaloRight = new THREE.Mesh(brakeHaloGeo, brakeHaloMat);
  brakeHaloRight.position.set(0.55, 0.62, 2.33);
  chassisGroup.add(brakeHaloRight);

  const rearRoadGlowGeo = track(new THREE.PlaneGeometry(3.4, 4.2));
  rearRoadGlowGeo.rotateX(-Math.PI / 2);
  const rearRoadGlowMat = track(
    new THREE.MeshBasicMaterial({
      map: redGlowTex,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
  );
  const rearRoadGlow = new THREE.Mesh(rearRoadGlowGeo, rearRoadGlowMat);
  rearRoadGlow.position.set(0, 0.04, 3.35);
  root.add(rearRoadGlow);

  // Subtle Neon Underglow plane (prominent in Noche Neón)
  const underglowTex = track(
    createRadialGlowTexture('rgba(255, 255, 255, 0.88)', 'rgba(255, 255, 255, 0.28)')
  );
  const underglowGeo = track(new THREE.PlaneGeometry(3.15, 5.4));
  underglowGeo.rotateX(-Math.PI / 2);
  const underglowMat = track(
    new THREE.MeshBasicMaterial({
      map: underglowTex,
      color: initialPaint.underglowHex,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  );
  const underglowMesh = new THREE.Mesh(underglowGeo, underglowMat);
  underglowMesh.position.set(0, 0.03, 0);
  root.add(underglowMesh);

  // --- 7. Soft Grounded Contact Shadow ---
  const shadowTex = track(createContactShadowTexture());
  const shadowGeo = track(new THREE.PlaneGeometry(2.75, 5.3));
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = track(
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: ATMOSPHERE_SPECS[initialAtmosphere].shadowOpacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  );
  const contactShadow = new THREE.Mesh(shadowGeo, shadowMat);
  contactShadow.position.set(0, 0.02, 0.02);
  root.add(contactShadow);

  // --- 8. Four Independent Detailed Wheels (Steering Front + Spinning All 4) ---
  const wheelRadius = CAR.wheelR;
  const tireGeo = track(createTireGeometry());
  const rimGeo = track(createRimGeometry());
  const rotorGeo = track(new THREE.CylinderGeometry(0.2, 0.2, 0.035, 22));
  rotorGeo.rotateZ(Math.PI / 2);
  const caliperGeo = track(new THREE.BoxGeometry(0.07, 0.17, 0.12));

  const frontSteerPivots: THREE.Group[] = [];
  const allWheelPivots: THREE.Group[] = [];
  const wheelSpinGroups: THREE.Group[] = [];

  const wheelSpecs: Array<{ x: number; z: number; isFront: boolean }> = [
    { x: -CAR.frontX, z: CAR.frontZ, isFront: true },
    { x: CAR.frontX, z: CAR.frontZ, isFront: true },
    { x: -CAR.rearX, z: CAR.rearZ, isFront: false },
    { x: CAR.rearX, z: CAR.rearZ, isFront: false },
  ];

  for (const spec of wheelSpecs) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(spec.x, wheelRadius, spec.z);
    root.add(steerPivot);
    allWheelPivots.push(steerPivot);

    if (spec.isFront) {
      frontSteerPivots.push(steerPivot);
    }

    // Stationary brake caliper mounted inside the steering knuckle
    const caliper = new THREE.Mesh(caliperGeo, caliperMat);
    const caliperX = spec.x < 0 ? 0.03 : -0.03;
    caliper.position.set(caliperX, 0.04, spec.isFront ? 0.12 : -0.12);
    steerPivot.add(caliper);

    // Spinning tire + alloy rim + 5 spokes + rotor
    const spinGroup = new THREE.Group();
    steerPivot.add(spinGroup);
    wheelSpinGroups.push(spinGroup);

    const tire = new THREE.Mesh(tireGeo, tireMat);
    spinGroup.add(tire);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    if (spec.x < 0) rim.rotation.y = Math.PI;      // la cara bonita siempre hacia fuera
    spinGroup.add(rim);

    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.position.x = spec.x < 0 ? 0.05 : -0.05;
    spinGroup.add(rotor);
  }

  // --- 9. Lightweight Procedural Drift Tire-Smoke Particle Pool ---
  const smokeTex = track(createSmokeTexture());
  const smokeGeo = track(new THREE.PlaneGeometry(0.95, 0.95));
  smokeGeo.rotateX(-Math.PI / 2);
  const particles: DriftParticle[] = [];
  for (let i = 0; i < 16; i++) {
    const mat = track(
      new THREE.MeshBasicMaterial({
        map: smokeTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    const mesh = new THREE.Mesh(smokeGeo, mat);
    mesh.visible = false;
    root.add(mesh);
    particles.push({ mesh, mat, age: 1, life: 0.5, vx: 0, vy: 0, vz: 0 });
  }
  let nextParticleIdx = 0;
  let smokeSpawnTimer = 0;

  let currentAtmosphere: AtmosphereMode = initialAtmosphere;

  const applyAtmosphereEffects = (mode: AtmosphereMode) => {
    currentAtmosphere = mode;
    const spec = ATMOSPHERE_SPECS[mode];
    bodyPaintMat.envMapIntensity = spec.envIntensity;
    glassMat.envMapIntensity = spec.envIntensity * 1.15;
    shadowMat.opacity = spec.shadowOpacity;

    const hl = spec.headlightStrength;
    headlightLensMat.emissiveIntensity = 1.4 + hl * 2.8;
    beamConeMat.opacity = hl * 0.24;
    beamConeMat.color.setHex(mode === 'sunset' ? 0xffe4b8 : 0xe4f3ff);
    poolMat.opacity = hl * 0.85;
    poolMat.color.setHex(mode === 'sunset' ? 0xffdfb0 : 0xdbf0ff);
    headlightPool.visible = hl > 0.05;
    leftBeam.visible = hl > 0.05;
    rightBeam.visible = hl > 0.05;

    underglowMat.opacity = spec.underglowStrength * 0.42;
    underglowMesh.visible = spec.underglowStrength > 0.02;
  };

  applyAtmosphereEffects(initialAtmosphere);

  const updateFromState = (state: CarState, dt: number) => {
    // 1. Visual front wheel steering (right turn = negative rotation.y)
    for (let i = 0; i < frontSteerPivots.length; i++) {
      frontSteerPivots[i].rotation.y = -state.steerAngleRad;
    }

    // 2. Wheel rolling spin around X (forward = negative rotation.x)
    for (let i = 0; i < wheelSpinGroups.length; i++) {
      wheelSpinGroups[i].rotation.x = -state.wheelSpinRad;
    }

    // 3. Suspension chassis pitch (accel squat / brake dive) & roll (cornering lean)
    chassisGroup.rotation.x = state.bodyPitchRad;
    chassisGroup.rotation.z = state.bodyRollRad;

    // 4. Dynamic rear brake lights flare brightly when braking or handbrake drifting
    const b = state.brakeIntensity;
    const nightBoost = currentAtmosphere === 'night' ? 1.35 : 1.0;
    brakeLightMat.emissiveIntensity = (1.35 + b * 4.4) * nightBoost;
    brakeHaloMat.opacity = (0.18 + b * 0.68) * nightBoost;
    const haloScale = 0.85 + b * 0.55;
    brakeHaloLeft.scale.set(haloScale, haloScale, 1);
    brakeHaloRight.scale.set(haloScale, haloScale, 1);
    rearRoadGlowMat.opacity = (0.08 + b * 0.46) * (currentAtmosphere === 'day' ? 0.45 : nightBoost);

    // 5. Drift tire smoke puffs from rear tires (disabled in cockpit view)
    if (bodyVisible && state.driftIntensity > 0.25) {
      smokeSpawnTimer += dt;
      if (smokeSpawnTimer > 0.035) {
        smokeSpawnTimer = 0;
        for (const side of [-CAR.rearX, CAR.rearX]) {
          const p = particles[nextParticleIdx];
          nextParticleIdx = (nextParticleIdx + 1) % particles.length;
          p.age = 0;
          p.life = 0.42 + Math.random() * 0.2;
          p.mesh.position.set(side + (Math.random() - 0.5) * 0.14, 0.14, CAR.rearZ + 0.2);
          p.mesh.scale.setScalar(0.55);
          p.mesh.visible = true;
          p.vx = -state.driftSlipRad * 2.2 + (Math.random() - 0.5) * 0.8;
          p.vy = 0.45 + Math.random() * 0.35;
          p.vz = 2.6 + Math.random() * 1.4;
        }
      }
    }

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.mesh.visible) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.visible = false;
        continue;
      }
      const t = p.age / p.life;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const s = 0.55 + t * 1.75;
      p.mesh.scale.setScalar(s);
      p.mat.opacity = (1 - t) * (1 - t) * (currentAtmosphere === 'night' ? 0.34 : 0.44);
    }
  };

  const setPaint = (paint: CarPaintPreset) => {
    bodyPaintMat.color.setHex(paint.hex);
    caliperMat.color.setHex(paint.caliperHex);
    underglowMat.color.setHex(paint.underglowHex);
  };

  let bodyVisible = true;

  const setBodyVisible = (visible: boolean) => {
    bodyVisible = visible;
    chassisGroup.visible = visible;
    contactShadow.visible = visible;
    rearRoadGlow.visible = visible;
    for (let i = 0; i < allWheelPivots.length; i++) {
      allWheelPivots[i].visible = visible;
    }
    const spec = ATMOSPHERE_SPECS[currentAtmosphere];
    underglowMesh.visible = visible && spec.underglowStrength > 0.02;
    if (!visible) {
      for (let i = 0; i < particles.length; i++) {
        particles[i].mesh.visible = false;
      }
    }
  };

  const dispose = () => {
    for (const d of disposables) {
      d.dispose();
    }
  };

  return {
    root,
    chassisGroup,
    updateFromState,
    setPaint,
    setAtmosphere: (mode: AtmosphereMode) => {
      applyAtmosphereEffects(mode);
      if (!bodyVisible) {
        underglowMesh.visible = false;
      }
    },
    setBodyVisible,
    dispose,
  };
}
