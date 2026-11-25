import * as THREE from 'three';
import type { AtmosphereMode, CarPaintPreset, CarState } from '../types/game';
import { ATMOSPHERE_SPECS } from '../game/constants';

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

  // --- 1. Sculpted Aerodynamic Coupe Body (ExtrudeGeometry side profile) ---
  // Profile drawn in (x = -z along length, y = height), extruded along width
  const bodyShape = new THREE.Shape();
  // Start at low front splitter tip (z = -2.26 -> x = -2.26 in shape space)
  bodyShape.moveTo(-2.26, 0.24);
  bodyShape.lineTo(-2.22, 0.42);
  // Swept nose & hood
  bodyShape.quadraticCurveTo(-1.92, 0.64, -1.25, 0.72);
  // Hood cowl to windshield base
  bodyShape.lineTo(-0.78, 0.76);
  // Sleek fastback beltline over cabin shoulders
  bodyShape.quadraticCurveTo(-0.05, 0.84, 0.86, 0.86);
  // Muscular rear haunch & engine deck
  bodyShape.quadraticCurveTo(1.58, 0.87, 2.12, 0.78);
  // Sharp Kammback tail
  bodyShape.lineTo(2.22, 0.56);
  bodyShape.lineTo(2.14, 0.26);
  // Flat aerodynamic undertray
  bodyShape.lineTo(-2.26, 0.24);

  const bodyWidth = 1.72;
  const bodyGeo = track(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: bodyWidth,
      bevelEnabled: true,
      bevelThickness: 0.12,
      bevelSize: 0.08,
      bevelSegments: 4,
      curveSegments: 16,
    })
  );
  // Center extrusion and orient so shape +X -> +Z (rear), shape +Y -> +Y (up)
  bodyGeo.translate(0, 0, -bodyWidth / 2);
  bodyGeo.rotateY(-Math.PI / 2);
  bodyGeo.computeVertexNormals();

  const mainBodyMesh = new THREE.Mesh(bodyGeo, bodyPaintMat);
  chassisGroup.add(mainBodyMesh);

  // --- 2. Sculpted Fastback Cabin Greenhouse (Roof + Tinted Wraparound Glass) ---
  const cabinShape = new THREE.Shape();
  cabinShape.moveTo(-0.88, 0.74);
  // Raked windshield
  cabinShape.quadraticCurveTo(-0.46, 1.12, -0.02, 1.19);
  // Curved aerodynamic roofline
  cabinShape.quadraticCurveTo(0.46, 1.22, 0.96, 1.06);
  // Fastback rear window slope
  cabinShape.lineTo(1.52, 0.82);
  cabinShape.lineTo(-0.88, 0.74);

  const cabinWidth = 1.26;
  const cabinGeo = track(
    new THREE.ExtrudeGeometry(cabinShape, {
      depth: cabinWidth,
      bevelEnabled: true,
      bevelThickness: 0.09,
      bevelSize: 0.06,
      bevelSegments: 3,
      curveSegments: 14,
    })
  );
  cabinGeo.translate(0, 0, -cabinWidth / 2);
  cabinGeo.rotateY(-Math.PI / 2);
  cabinGeo.computeVertexNormals();

  const cabinGlassMesh = new THREE.Mesh(cabinGeo, glassMat);
  chassisGroup.add(cabinGlassMesh);

  // Painted Roof Cap panel sitting cleanly atop the tinted greenhouse
  const roofGeo = track(new THREE.BoxGeometry(1.12, 0.06, 1.12));
  const roofMesh = new THREE.Mesh(roofGeo, bodyPaintMat);
  roofMesh.position.set(0, 1.21, 0.22);
  roofMesh.rotation.x = 0.04;
  chassisGroup.add(roofMesh);

  // Sculpted Hood Center Ridge & Hood Vent Accent
  const hoodVentGeo = track(new THREE.BoxGeometry(0.68, 0.05, 0.56));
  const hoodVent = new THREE.Mesh(hoodVentGeo, carbonMat);
  hoodVent.position.set(0, 0.70, -1.36);
  hoodVent.rotation.x = 0.14;
  chassisGroup.add(hoodVent);

  // --- 3. Widebody Fender Flares, Side Intakes, Front Splitter & Rear Diffuser ---
  const fenderGeo = track(new THREE.BoxGeometry(0.18, 0.34, 1.06));
  const fenderPositions: Array<[number, number, number]> = [
    [-0.95, 0.48, -1.34],
    [0.95, 0.48, -1.34],
    [-0.99, 0.52, 1.28],
    [0.99, 0.52, 1.28],
  ];
  for (const [fx, fy, fz] of fenderPositions) {
    const fender = new THREE.Mesh(fenderGeo, bodyPaintMat);
    fender.position.set(fx, fy, fz);
    chassisGroup.add(fender);
  }

  // Front carbon splitter lip
  const splitterGeo = track(new THREE.BoxGeometry(2.04, 0.07, 0.42));
  const splitterMesh = new THREE.Mesh(splitterGeo, carbonMat);
  splitterMesh.position.set(0, 0.19, -2.14);
  chassisGroup.add(splitterMesh);

  // Front grille air intake recess
  const grilleGeo = track(new THREE.BoxGeometry(1.36, 0.2, 0.12));
  const grilleMesh = new THREE.Mesh(grilleGeo, carbonMat);
  grilleMesh.position.set(0, 0.34, -2.26);
  chassisGroup.add(grilleMesh);

  // Side skirts & sculpted side air scoops
  const skirtGeo = track(new THREE.BoxGeometry(0.12, 0.12, 2.32));
  const scoopGeo = track(new THREE.BoxGeometry(0.08, 0.32, 0.62));
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(skirtGeo, carbonMat);
    skirt.position.set(side * 0.99, 0.21, 0.0);
    chassisGroup.add(skirt);

    const scoop = new THREE.Mesh(scoopGeo, carbonMat);
    scoop.position.set(side * 0.96, 0.54, 0.42);
    chassisGroup.add(scoop);
  }

  // Aerodynamic side mirrors
  const mirrorArmGeo = track(new THREE.BoxGeometry(0.18, 0.04, 0.07));
  const mirrorCapGeo = track(new THREE.BoxGeometry(0.22, 0.11, 0.16));
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(mirrorArmGeo, carbonMat);
    arm.position.set(side * 0.88, 0.86, -0.56);
    chassisGroup.add(arm);

    const cap = new THREE.Mesh(mirrorCapGeo, bodyPaintMat);
    cap.position.set(side * 1.0, 0.89, -0.54);
    chassisGroup.add(cap);
  }

  // Rear carbon diffuser with vertical aero fins
  const diffuserGeo = track(new THREE.BoxGeometry(1.88, 0.24, 0.28));
  const diffuserMesh = new THREE.Mesh(diffuserGeo, carbonMat);
  diffuserMesh.position.set(0, 0.28, 2.16);
  chassisGroup.add(diffuserMesh);

  const finGeo = track(new THREE.BoxGeometry(0.04, 0.22, 0.34));
  for (const fx of [-0.52, -0.2, 0.2, 0.52]) {
    const fin = new THREE.Mesh(finGeo, carbonMat);
    fin.position.set(fx, 0.25, 2.22);
    chassisGroup.add(fin);
  }

  // Quad chrome exhaust tips
  const exhaustGeo = track(new THREE.CylinderGeometry(0.058, 0.058, 0.22, 12));
  exhaustGeo.rotateX(Math.PI / 2);
  for (const ex of [-0.42, -0.28, 0.28, 0.42]) {
    const tip = new THREE.Mesh(exhaustGeo, chromeMat);
    tip.position.set(ex, 0.28, 2.28);
    chassisGroup.add(tip);
  }

  // Rear engine bay louvered deck
  const louverGeo = track(new THREE.BoxGeometry(0.92, 0.04, 0.11));
  for (let i = 0; i < 4; i++) {
    const louver = new THREE.Mesh(louverGeo, carbonMat);
    louver.position.set(0, 0.86 - i * 0.012, 1.15 + i * 0.2);
    louver.rotation.x = -0.18;
    chassisGroup.add(louver);
  }

  // --- 4. Carbon-Fiber GT Rear Wing / Spoiler ---
  const spoilerGroup = new THREE.Group();
  const strutGeo = track(new THREE.BoxGeometry(0.06, 0.36, 0.22));
  for (const sx of [-0.54, 0.54]) {
    const strut = new THREE.Mesh(strutGeo, carbonMat);
    strut.position.set(sx, 1.0, 2.04);
    strut.rotation.x = 0.22;
    spoilerGroup.add(strut);
  }
  const wingBladeGeo = track(new THREE.BoxGeometry(1.94, 0.06, 0.34));
  const wingBlade = new THREE.Mesh(wingBladeGeo, carbonMat);
  wingBlade.position.set(0, 1.18, 2.12);
  wingBlade.rotation.x = 0.1;
  spoilerGroup.add(wingBlade);

  const endplateGeo = track(new THREE.BoxGeometry(0.04, 0.24, 0.42));
  for (const ex of [-0.98, 0.98]) {
    const endplate = new THREE.Mesh(endplateGeo, bodyPaintMat);
    endplate.position.set(ex, 1.16, 2.12);
    spoilerGroup.add(endplate);
  }
  chassisGroup.add(spoilerGroup);

  // --- 5. Sharp LED Headlights + Volumetric Beams + Asphalt Light Pool ---
  const hlHousingGeo = track(new THREE.BoxGeometry(0.46, 0.11, 0.22));
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(hlHousingGeo, headlightLensMat);
    hl.position.set(side * 0.66, 0.53, -2.18);
    hl.rotation.y = side * -0.22;
    hl.rotation.x = 0.14;
    chassisGroup.add(hl);
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
  leftBeam.position.set(-0.64, 0.52, -2.24);
  leftBeam.rotation.x = -0.045;
  chassisGroup.add(leftBeam);

  const rightBeam = new THREE.Mesh(beamConeGeo, beamConeMat);
  rightBeam.position.set(0.64, 0.52, -2.24);
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
  const tailBarGeo = track(new THREE.BoxGeometry(1.74, 0.085, 0.08));
  const tailBar = new THREE.Mesh(tailBarGeo, brakeLightMat);
  tailBar.position.set(0, 0.68, 2.24);
  chassisGroup.add(tailBar);

  const tailPodGeo = track(new THREE.BoxGeometry(0.42, 0.14, 0.1));
  for (const side of [-1, 1]) {
    const pod = new THREE.Mesh(tailPodGeo, brakeLightMat);
    pod.position.set(side * 0.68, 0.67, 2.23);
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
  brakeHaloLeft.position.set(-0.65, 0.67, 2.31);
  chassisGroup.add(brakeHaloLeft);

  const brakeHaloRight = new THREE.Mesh(brakeHaloGeo, brakeHaloMat);
  brakeHaloRight.position.set(0.65, 0.67, 2.31);
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
  const wheelRadius = 0.36;
  const wheelWidth = 0.3;

  const tireGeo = track(new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 24));
  tireGeo.rotateZ(Math.PI / 2);

  const rimBarrelGeo = track(new THREE.CylinderGeometry(0.245, 0.245, wheelWidth + 0.012, 18));
  rimBarrelGeo.rotateZ(Math.PI / 2);

  const hubGeo = track(new THREE.CylinderGeometry(0.07, 0.07, wheelWidth + 0.03, 12));
  hubGeo.rotateZ(Math.PI / 2);

  const spokeGeo = track(new THREE.BoxGeometry(wheelWidth + 0.02, 0.43, 0.045));
  const rotorGeo = track(new THREE.CylinderGeometry(0.20, 0.20, 0.05, 16));
  rotorGeo.rotateZ(Math.PI / 2);
  const caliperGeo = track(new THREE.BoxGeometry(0.08, 0.16, 0.11));

  const frontSteerPivots: THREE.Group[] = [];
  const allWheelPivots: THREE.Group[] = [];
  const wheelSpinGroups: THREE.Group[] = [];

  const wheelSpecs: Array<{ x: number; z: number; isFront: boolean }> = [
    { x: -0.94, z: -1.34, isFront: true },
    { x: 0.94, z: -1.34, isFront: true },
    { x: -0.97, z: 1.28, isFront: false },
    { x: 0.97, z: 1.28, isFront: false },
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

    const rimBarrel = new THREE.Mesh(rimBarrelGeo, carbonMat);
    spinGroup.add(rimBarrel);

    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.position.x = spec.x < 0 ? 0.05 : -0.05;
    spinGroup.add(rotor);

    const hub = new THREE.Mesh(hubGeo, rimMat);
    spinGroup.add(hub);

    // 5-spoke metallic alloy star pattern
    for (let s = 0; s < 5; s++) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.rotation.x = (s * Math.PI) / 5;
      spinGroup.add(spoke);
    }
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
        for (const side of [-0.95, 0.95]) {
          const p = particles[nextParticleIdx];
          nextParticleIdx = (nextParticleIdx + 1) % particles.length;
          p.age = 0;
          p.life = 0.42 + Math.random() * 0.2;
          p.mesh.position.set(side + (Math.random() - 0.5) * 0.14, 0.14, 1.48);
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
