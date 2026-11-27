import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from './geo';

const MAX_DOGS = 40;
/** Capas de pelaje: dorado, marrón, negro, blanco, gris, canela, manchado (algo más oscuro). */
const COATS = [0xc79a4a, 0x7a4a2a, 0x1c1a1a, 0xeeeae0, 0x8a8a8e, 0xb06a3a, 0xd9c9a4, 0x4a3a2c];

export interface DogItem { x: number; z: number; fx: number; fz: number; v: number; seed: number }

/** Geometría de un perro (mira a +Z): aMeta = (parte de color, tipo de miembro, signo de la pata); aMeta2 = (pivote y, pivote z, 0). */
function part(g: THREE.BufferGeometry, c: number, o: { part?: number; kind?: number; limb?: number; py?: number; pz?: number }): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3), m1 = new Float32Array(n * 3), m2 = new Float32Array(n * 3);
  const k = new THREE.Color(c);
  for (let i = 0; i < n; i++) {
    col[i * 3] = k.r; col[i * 3 + 1] = k.g; col[i * 3 + 2] = k.b;
    m1[i * 3] = o.part ?? 0; m1[i * 3 + 1] = o.kind ?? 0; m1[i * 3 + 2] = o.limb ?? 0;
    m2[i * 3] = o.py ?? 0; m2[i * 3 + 1] = o.pz ?? 0;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.setAttribute('aMeta', new THREE.BufferAttribute(m1, 3));
  ng.setAttribute('aMeta2', new THREE.BufferAttribute(m2, 3));
  return ng;
}

// aPart: 0 color fijo · 1 pelaje · 2 pelaje oscuro (orejas, patas) ; aKind: 0 cuerpo · 1 pata · 2 cola · 3 cabeza
function buildDogGeometry(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  P.push(part(new THREE.CapsuleGeometry(0.115, 0.46, 4, 10).rotateX(Math.PI / 2).translate(0, 0.38, 0), 0, { part: 1 }));                       // cuerpo
  P.push(part(new THREE.SphereGeometry(0.1, 9, 7).scale(1, 1.05, 1.1).translate(0, 0.5, 0.42), 0, { part: 1, kind: 3, py: 0.46, pz: 0.3 }));  // cabeza
  P.push(part(new THREE.BoxGeometry(0.075, 0.065, 0.13).translate(0, 0.465, 0.54), 0, { part: 1, kind: 3, py: 0.46, pz: 0.3 }));              // hocico
  P.push(part(new THREE.BoxGeometry(0.03, 0.025, 0.025).translate(0, 0.485, 0.61), 0x0b0b0b, { kind: 3, py: 0.46, pz: 0.3 }));                 // nariz
  for (const sx of [-1, 1]) P.push(part(new THREE.BoxGeometry(0.03, 0.09, 0.07).translate(sx * 0.075, 0.57, 0.39), 0, { part: 2, kind: 3, py: 0.46, pz: 0.3 })); // orejas
  P.push(part(new THREE.CylinderGeometry(0.014, 0.02, 0.26, 5).rotateX(-0.9).translate(0, 0.52, -0.47), 0, { part: 2, kind: 2, py: 0.46, pz: -0.38 })); // cola
  for (const [x, z, limb] of [[-0.07, 0.25, 1], [0.07, 0.25, -1], [-0.07, -0.25, -1], [0.07, -0.25, 1]] as [number, number, number][]) {
    P.push(part(new THREE.CylinderGeometry(0.032, 0.024, 0.3, 6).translate(x, 0.15, z), 0, { part: 2, kind: 1, limb, py: 0.32, pz: z }));   // pata
  }
  return mergeGeometries(P, false)!;
}

/** Perros que pasean con algunos peatones: trotan al lado, se desvían un poco y menean la cola. */
export class Dogs {
  private geo = buildDogGeometry();
  private mat: THREE.MeshStandardMaterial;
  private mesh: THREE.InstancedMesh;
  private aCol: THREE.InstancedBufferAttribute;
  private aMisc: THREE.InstancedBufferAttribute;
  private timeU = { value: 0 };
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private ay = new THREE.Vector3(0, 1, 0);
  enabled = true;

  constructor(private scene: THREE.Scene) {
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    this.mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.timeU;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec3 aMeta; attribute vec3 aMeta2; attribute vec4 aCol; attribute vec4 aMisc; uniform float uTime;
          void rotX(inout vec3 p, float py, float pz, float a) { float c = cos(a), s = sin(a); float yy = p.y - py, zz = p.z - pz; p.y = py + yy * c - zz * s; p.z = pz + yy * s + zz * c; }`)
        .replace('#include <color_vertex>', `#include <color_vertex>
          if (aMeta.x > 1.5) vColor.xyz = aCol.xyz * 0.62; else if (aMeta.x > 0.5) vColor.xyz = aCol.xyz;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = uTime * 11.0 * aMisc.x + aCol.w;
          float amp = min(aMisc.x, 1.0);
          if (aMeta.y > 0.5 && aMeta.y < 1.5) rotX(transformed, aMeta2.x, aMeta2.y, sin(ph) * 0.7 * aMeta.z * amp);          // patas al trote (en diagonal)
          if (aMeta.y > 1.5 && aMeta.y < 2.5) { float w = sin(uTime * 9.0 + aCol.w * 3.0) * 0.5; float c = cos(w), s = sin(w); float xx = transformed.x; transformed.x = xx * c - (transformed.z + 0.38) * s; transformed.z = xx * s + (transformed.z + 0.38) * c - 0.38; }   // cola que se menea
          if (aMeta.y > 2.5) rotX(transformed, aMeta2.x, aMeta2.y, sin(ph * 0.5) * 0.06 * amp - 0.04);                          // cabeza que cabecea
          transformed.y += abs(sin(ph)) * 0.015 * amp;`);
    };
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, MAX_DOGS);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DOGS * 4), 4);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DOGS * 4), 4);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aMisc', this.aMisc);
    scene.add(this.mesh);
  }

  /** Coloca los perros de este fotograma (la lista la da el que los pasea). */
  sync(items: DogItem[], dt: number) {
    if (!this.enabled) { this.mesh.count = 0; return; }
    this.timeU.value += dt;
    const n = Math.min(items.length, MAX_DOGS);
    for (let i = 0; i < n; i++) {
      const d = items[i];
      const yaw = Math.atan2(d.fx, d.fz);
      const size = 0.7 + (Math.abs(Math.sin(d.seed * 7.7)) * 0.7);
      this.tmpQ.setFromAxisAngle(this.ay, yaw);
      this.tmpM.compose(this.tmpV.set(d.x, heightAt(d.x, d.z) + 0.02, d.z), this.tmpQ, this.tmpS.set(size, size, size));
      this.mesh.setMatrixAt(i, this.tmpM);
      this.tmpC.setHex(COATS[Math.floor(Math.abs(Math.sin(d.seed * 12.9898)) * COATS.length) % COATS.length]);
      this.aCol.setXYZW(i, this.tmpC.r, this.tmpC.g, this.tmpC.b, d.seed * 6.28);
      this.aMisc.setXYZW(i, Math.max(0.25, d.v / 1.1), 0, 0, 0);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aCol.needsUpdate = true; this.aMisc.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose(); this.geo.dispose(); this.mat.dispose();
  }
}
