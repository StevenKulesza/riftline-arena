import * as THREE from 'three';

export const CTF_FLAG_MODEL_ID = 'riftline-ctf-standard-v2';
export const CTF_FLAG_GEOMETRY_SIGNATURE = 'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2';

const CLOTH_COLUMNS = 11;
const CLOTH_ROWS = 7;
const CLOTH_VERTEX_COUNT = CLOTH_COLUMNS * CLOTH_ROWS;
const CLOTH_STEP = 1 / 60;
const OBJECT_STEP = 1 / 120;
const MAX_CLOTH_STEPS = 4;
const FLAG_ATTACH_X = 0.065;
const FLAG_WIDTH = 1.34;
const FLAG_NOTCH = 0.24;
const FLAG_HEIGHT = 0.76;
const FLAG_CENTER_Y = 2.49;

type ClothConstraint = {
  a: number;
  b: number;
  restLength: number;
};

export type CtfFlagPhysicsDiagnostics = {
  engine: 'custom-verlet-cloth';
  modelId: typeof CTF_FLAG_MODEL_ID;
  geometrySignature: typeof CTF_FLAG_GEOMETRY_SIGNATURE;
  objectTimestep: number;
  clothTimestep: number;
  bodyCount: 1;
  colliderCount: 1;
  clothVertices: number;
  clothConstraints: number;
  mode: 'base' | 'carried' | 'dropped';
  grounded: boolean;
  bounces: number;
  maxClothDeflection: number;
  velocity: { x: number; y: number; z: number };
};

export type CtfFlagFloorSampler = (x: number, z: number, fromY: number) => number | null;

/**
 * One authored CTF flag used by both factions and every map. Faction identity
 * is a material colorway only; silhouette, topology, dimensions, and physics
 * stay identical so neither team receives a readability advantage.
 */
export class CtfFlagVisual {
  readonly root = new THREE.Group();
  readonly baseRoot = new THREE.Group();
  readonly modelId = CTF_FLAG_MODEL_ID;
  readonly geometrySignature = CTF_FLAG_GEOMETRY_SIGNATURE;

  private readonly velocity = new THREE.Vector3();
  private readonly carryTarget = new THREE.Vector3();
  private readonly carryError = new THREE.Vector3();
  private readonly carryAcceleration = new THREE.Vector3();
  private readonly carrierVelocity = new THREE.Vector3();
  private readonly clothGeometry = new THREE.BufferGeometry();
  private readonly clothPositions = new Float32Array(CLOTH_VERTEX_COUNT * 3);
  private readonly clothPrevious = new Float32Array(CLOTH_VERTEX_COUNT * 3);
  private readonly clothRest = new Float32Array(CLOTH_VERTEX_COUNT * 3);
  private readonly clothConstraints: ClothConstraint[] = [];
  private readonly seamGeometry = new THREE.BufferGeometry();
  private readonly seamPositions: Float32Array;
  private readonly crest = new THREE.Mesh();
  private readonly crestBasis = new THREE.Matrix4();
  private readonly crestXAxis = new THREE.Vector3();
  private readonly crestYAxis = new THREE.Vector3();
  private readonly crestZAxis = new THREE.Vector3();
  private readonly crestCenter = new THREE.Vector3();
  private readonly crestRight = new THREE.Vector3();
  private readonly crestUp = new THREE.Vector3();
  private readonly signal: THREE.Group;
  private readonly signalCore: THREE.Object3D;
  private readonly flagRing: THREE.Object3D;
  private readonly beaconRing: THREE.Object3D;
  private readonly baseRing: THREE.Object3D;

  private mode: CtfFlagPhysicsDiagnostics['mode'] = 'base';
  private grounded = true;
  private bounces = 0;
  private clothAccumulator = 0;
  private clothTime = 0;
  private maxClothDeflection = 0;
  private leanX = 0;
  private leanZ = 0;

  constructor(teamName: string, color: number) {
    this.root.name = `ctf-${teamName}-flag`;
    this.baseRoot.name = `ctf-${teamName}-flag-base`;
    this.root.userData.modelId = CTF_FLAG_MODEL_ID;
    this.root.userData.geometrySignature = CTF_FLAG_GEOMETRY_SIGNATURE;
    this.baseRoot.userData.modelId = CTF_FLAG_MODEL_ID;
    this.baseRoot.userData.geometrySignature = CTF_FLAG_GEOMETRY_SIGNATURE;

    const teamColor = new THREE.Color(color);
    const seamColor = teamColor.clone().lerp(new THREE.Color(0xffffff), 0.48);
    const poleMaterial = new THREE.MeshStandardMaterial({
      name: 'ctf-standard-pole',
      color: 0x334861,
      metalness: 0.78,
      roughness: 0.27,
    });
    const clothMaterial = new THREE.MeshPhysicalMaterial({
      name: 'ctf-standard-cloth',
      color,
      emissive: color,
      emissiveIntensity: 0.16,
      metalness: 0,
      roughness: 0.86,
      sheen: 0.82,
      sheenRoughness: 0.58,
      sheenColor: seamColor,
      envMapIntensity: 0.54,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    const signalMaterial = new THREE.MeshStandardMaterial({
      name: 'ctf-standard-signal',
      color,
      emissive: color,
      emissiveIntensity: 0.72,
      metalness: 0.34,
      roughness: 0.24,
      side: THREE.DoubleSide,
    });
    const baseMaterial = new THREE.MeshStandardMaterial({
      name: 'ctf-standard-plinth',
      color: 0x111c2c,
      metalness: 0.82,
      roughness: 0.29,
    });
    const seamMaterial = new THREE.LineBasicMaterial({
      name: 'ctf-standard-stitching',
      color: seamColor,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });

    const basePlate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.94, 1.08, 0.14, 12),
      baseMaterial,
    );
    basePlate.name = 'ctf-base-plate';
    basePlate.position.y = 0.07;
    basePlate.receiveShadow = true;
    const baseInset = new THREE.Mesh(
      new THREE.CylinderGeometry(0.58, 0.7, 0.05, 12),
      baseMaterial,
    );
    baseInset.name = 'ctf-base-inset';
    baseInset.position.y = 0.165;
    baseInset.receiveShadow = true;
    this.baseRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.047, 8, 28),
      signalMaterial,
    );
    this.baseRing.name = 'ctf-base-ring';
    this.baseRing.rotation.x = Math.PI * 0.5;
    this.baseRing.position.y = 0.17;
    this.baseRoot.add(basePlate, baseInset, this.baseRing);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.064, 3.04, 10),
      poleMaterial,
    );
    pole.name = 'ctf-standard-pole';
    pole.position.y = 1.52;
    pole.castShadow = true;
    const poleCap = new THREE.Mesh(new THREE.OctahedronGeometry(0.105, 0), signalMaterial);
    poleCap.name = 'ctf-standard-finial';
    poleCap.position.y = 3.09;
    poleCap.rotation.y = Math.PI * 0.25;
    poleCap.castShadow = true;

    this.buildClothGeometry();
    const cloth = new THREE.Mesh(this.clothGeometry, clothMaterial);
    cloth.name = 'ctf-faction-pennant';
    cloth.castShadow = true;
    cloth.frustumCulled = false;
    const seamSegmentCount = (CLOTH_COLUMNS - 1) * 2 + (CLOTH_ROWS - 1) * 2;
    this.seamPositions = new Float32Array(seamSegmentCount * 2 * 3);
    this.seamGeometry.setAttribute('position', new THREE.BufferAttribute(this.seamPositions, 3));
    const seams = new THREE.LineSegments(this.seamGeometry, seamMaterial);
    seams.name = 'ctf-pennant-reinforced-seams';
    seams.frustumCulled = false;

    this.crest.geometry = new THREE.RingGeometry(0.065, 0.125, 6, 1);
    this.crest.material = signalMaterial;
    this.crest.name = 'ctf-faction-crest';
    this.crest.castShadow = true;
    this.crest.frustumCulled = false;

    for (const y of [FLAG_CENTER_Y - FLAG_HEIGHT * 0.44, FLAG_CENTER_Y + FLAG_HEIGHT * 0.44]) {
      const tie = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.015, 5, 14), signalMaterial);
      tie.name = 'ctf-pennant-pole-tie';
      tie.position.y = y;
      tie.rotation.x = Math.PI * 0.5;
      this.root.add(tie);
    }

    this.signal = new THREE.Group();
    this.signal.name = 'ctf-signal-beacon';
    this.signal.position.set(0, 0.72, 0);
    const signalCage = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 1), baseMaterial);
    signalCage.name = 'ctf-signal-cage';
    signalCage.scale.set(1, 1.14, 1);
    this.signalCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), signalMaterial);
    this.signalCore.name = 'ctf-signal-core';
    this.signalCore.userData.ctfSignal = true;
    this.beaconRing = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.024, 6, 20), signalMaterial);
    this.beaconRing.name = 'ctf-beacon-ring';
    this.beaconRing.rotation.x = Math.PI * 0.5;
    this.signal.add(signalCage, this.signalCore, this.beaconRing);

    this.flagRing = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.034, 7, 24), signalMaterial);
    this.flagRing.name = 'ctf-flag-ring';
    this.flagRing.rotation.x = Math.PI * 0.5;
    this.flagRing.position.y = 0.055;

    this.root.add(pole, poleCap, cloth, seams, this.crest, this.signal, this.flagRing);
    this.writeClothGeometry();
  }

  resetAt(position: THREE.Vector3): void {
    this.mode = 'base';
    this.root.position.copy(position);
    this.root.rotation.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.leanX = 0;
    this.leanZ = 0;
    this.grounded = true;
    this.bounces = 0;
    this.clothAccumulator = 0;
    this.clothTime = 0;
    this.signal.position.y = 0.72;
    this.signal.rotation.set(0, 0, 0);
    this.signalCore.scale.setScalar(1);
    this.flagRing.rotation.set(Math.PI * 0.5, 0, 0);
    this.beaconRing.rotation.set(Math.PI * 0.5, 0, 0);
    this.baseRing.rotation.set(Math.PI * 0.5, 0, 0);
    this.resetCloth();
  }

  beginCarry(target: THREE.Vector3, inheritedVelocity: THREE.Vector3): void {
    this.mode = 'carried';
    this.root.position.copy(target);
    this.velocity.copy(inheritedVelocity).multiplyScalar(0.62);
    this.grounded = false;
  }

  stepCarried(delta: number, target: THREE.Vector3, inheritedVelocity: THREE.Vector3): void {
    this.mode = 'carried';
    this.carryTarget.copy(target);
    this.carrierVelocity.copy(inheritedVelocity);
    const horizontalSpeed = Math.hypot(inheritedVelocity.x, inheritedVelocity.z);
    if (horizontalSpeed > 0.001) {
      this.carryTarget.x -= inheritedVelocity.x / horizontalSpeed * 0.18;
      this.carryTarget.z -= inheritedVelocity.z / horizontalSpeed * 0.18;
    }

    const step = Math.min(Math.max(delta, 0), OBJECT_STEP * 2);
    this.carryError.subVectors(this.carryTarget, this.root.position);
    this.carryAcceleration.copy(this.carryError).multiplyScalar(165)
      .addScaledVector(this.carrierVelocity, 20)
      .addScaledVector(this.velocity, -20);
    this.velocity.addScaledVector(this.carryAcceleration, step);
    if (this.velocity.lengthSq() > 165 * 165) this.velocity.setLength(165);
    this.root.position.addScaledVector(this.velocity, step);

    const lag = this.root.position.distanceTo(this.carryTarget);
    if (lag > 1.05) {
      this.root.position.lerp(this.carryTarget, 1 - 1.05 / lag);
    }
    const targetLeanX = THREE.MathUtils.clamp(inheritedVelocity.z * 0.008, -0.16, 0.16);
    const targetLeanZ = THREE.MathUtils.clamp(-inheritedVelocity.x * 0.008, -0.16, 0.16);
    const leanBlend = 1 - Math.exp(-step * 8.5);
    this.leanX = THREE.MathUtils.lerp(this.leanX, targetLeanX, leanBlend);
    this.leanZ = THREE.MathUtils.lerp(this.leanZ, targetLeanZ, leanBlend);
    this.root.rotation.x = this.leanX;
    this.root.rotation.z = this.leanZ;
    this.grounded = false;
  }

  dropAt(position: THREE.Vector3, inheritedVelocity: THREE.Vector3): void {
    this.mode = 'dropped';
    this.root.position.copy(position);
    this.velocity.copy(inheritedVelocity).multiplyScalar(0.68);
    this.velocity.y = Math.max(this.velocity.y, 2.35);
    this.grounded = false;
    this.bounces = 0;
  }

  stepDropped(delta: number, sampleFloor: CtfFlagFloorSampler): void {
    this.mode = 'dropped';
    const step = Math.min(Math.max(delta, 0), OBJECT_STEP * 2);
    if (!this.grounded) {
      this.velocity.y -= 18.5 * step;
      this.root.position.addScaledVector(this.velocity, step);
    } else {
      const groundDamping = Math.exp(-7.5 * step);
      this.velocity.x *= groundDamping;
      this.velocity.z *= groundDamping;
      this.root.position.addScaledVector(this.velocity, step);
    }

    const floor = sampleFloor(
      this.root.position.x,
      this.root.position.z,
      this.root.position.y + 3.25,
    );
    if (floor !== null && this.root.position.y <= floor) {
      this.root.position.y = floor;
      const impactSpeed = Math.abs(this.velocity.y);
      if (impactSpeed > 1.25 && this.bounces < 3) {
        this.velocity.y = impactSpeed * 0.24;
        this.velocity.x *= 0.74;
        this.velocity.z *= 0.74;
        this.bounces += 1;
        this.grounded = false;
      } else {
        this.velocity.y = 0;
        this.grounded = true;
      }
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const rock = Math.min(speed * 0.012, 0.11) * Math.exp(-this.bounces * 0.25);
    const leanBlend = 1 - Math.exp(-step * (this.grounded ? 7 : 3.5));
    this.leanX = THREE.MathUtils.lerp(this.leanX, this.velocity.z >= 0 ? rock : -rock, leanBlend);
    this.leanZ = THREE.MathUtils.lerp(this.leanZ, this.velocity.x >= 0 ? -rock : rock, leanBlend);
    this.root.rotation.x = this.leanX;
    this.root.rotation.z = this.leanZ;
  }

  updatePresentation(
    delta: number,
    windDirection: Readonly<{ x: number; z: number }>,
    windStrength: number,
    reducedMotion: boolean,
  ): void {
    const presentationDelta = Math.min(Math.max(delta, 0), 0.067);
    if (!reducedMotion) {
      this.flagRing.rotation.z += presentationDelta * 2.2;
      this.beaconRing.rotation.z -= presentationDelta * 1.45;
      this.baseRing.rotation.z += presentationDelta * 0.35;
      this.signal.position.y = 0.72 + Math.sin(this.clothTime * 2.4) * 0.035;
      this.signal.rotation.y += presentationDelta * 0.9;
      const pulse = 1 + Math.sin(this.clothTime * 3.1) * 0.11;
      this.signalCore.scale.setScalar(pulse);
    }

    this.clothAccumulator = Math.min(
      this.clothAccumulator + presentationDelta,
      CLOTH_STEP * MAX_CLOTH_STEPS,
    );
    while (this.clothAccumulator >= CLOTH_STEP) {
      this.stepCloth(CLOTH_STEP, windDirection, windStrength, reducedMotion);
      this.clothAccumulator -= CLOTH_STEP;
    }
  }

  diagnostics(): CtfFlagPhysicsDiagnostics {
    return {
      engine: 'custom-verlet-cloth',
      modelId: CTF_FLAG_MODEL_ID,
      geometrySignature: CTF_FLAG_GEOMETRY_SIGNATURE,
      objectTimestep: OBJECT_STEP,
      clothTimestep: CLOTH_STEP,
      bodyCount: 1,
      colliderCount: 1,
      clothVertices: CLOTH_VERTEX_COUNT,
      clothConstraints: this.clothConstraints.length,
      mode: this.mode,
      grounded: this.grounded,
      bounces: this.bounces,
      maxClothDeflection: this.maxClothDeflection,
      velocity: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
    };
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const root of [this.root, this.baseRoot]) {
      root.removeFromParent();
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh && !(object as THREE.LineSegments).isLineSegments) return;
        if (mesh.geometry) geometries.add(mesh.geometry);
        const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of meshMaterials) if (material) materials.add(material);
      });
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  private buildClothGeometry(): void {
    const colors = new Float32Array(CLOTH_VERTEX_COUNT * 3);
    const uvs = new Float32Array(CLOTH_VERTEX_COUNT * 2);
    const indices: number[] = [];
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      const v = row / (CLOTH_ROWS - 1);
      const rowLength = FLAG_WIDTH - FLAG_NOTCH * (1 - Math.abs(v * 2 - 1));
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        const u = column / (CLOTH_COLUMNS - 1);
        const index = row * CLOTH_COLUMNS + column;
        const offset = index * 3;
        const x = FLAG_ATTACH_X + rowLength * u;
        const y = FLAG_CENTER_Y + FLAG_HEIGHT * (0.5 - v);
        const z = Math.sin(u * Math.PI * 2) * 0.025 * u;
        this.clothPositions[offset] = x;
        this.clothPositions[offset + 1] = y;
        this.clothPositions[offset + 2] = z;
        this.clothPrevious[offset] = x;
        this.clothPrevious[offset + 1] = y;
        this.clothPrevious[offset + 2] = z;
        this.clothRest[offset] = x;
        this.clothRest[offset + 1] = y;
        this.clothRest[offset + 2] = 0;
        uvs[index * 2] = u;
        uvs[index * 2 + 1] = 1 - v;
        // Vertex colors act as a lightness multiplier over the faction
        // material. Keeping them neutral avoids squaring/darkening the team
        // hue while still adding a subtle woven gradient.
        const shade = 0.83 + (1 - v) * 0.11 + (1 - u) * 0.06;
        colors[offset] = shade;
        colors[offset + 1] = shade;
        colors[offset + 2] = shade;
      }
    }
    for (let row = 0; row < CLOTH_ROWS - 1; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS - 1; column += 1) {
        const a = row * CLOTH_COLUMNS + column;
        const b = a + 1;
        const c = a + CLOTH_COLUMNS;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    this.clothGeometry.setAttribute('position', new THREE.BufferAttribute(this.clothPositions, 3));
    this.clothGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.clothGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.clothGeometry.setIndex(indices);
    this.clothGeometry.computeVertexNormals();

    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 0; column < CLOTH_COLUMNS; column += 1) {
        const point = row * CLOTH_COLUMNS + column;
        if (column + 1 < CLOTH_COLUMNS) this.addConstraint(point, point + 1);
        if (row + 1 < CLOTH_ROWS) this.addConstraint(point, point + CLOTH_COLUMNS);
        if (column + 1 < CLOTH_COLUMNS && row + 1 < CLOTH_ROWS) {
          this.addConstraint(point, point + CLOTH_COLUMNS + 1);
          this.addConstraint(point + 1, point + CLOTH_COLUMNS);
        }
        if (column + 2 < CLOTH_COLUMNS) this.addConstraint(point, point + 2);
      }
    }
  }

  private addConstraint(a: number, b: number): void {
    const aOffset = a * 3;
    const bOffset = b * 3;
    const dx = this.clothRest[bOffset] - this.clothRest[aOffset];
    const dy = this.clothRest[bOffset + 1] - this.clothRest[aOffset + 1];
    const dz = this.clothRest[bOffset + 2] - this.clothRest[aOffset + 2];
    this.clothConstraints.push({ a, b, restLength: Math.hypot(dx, dy, dz) });
  }

  private resetCloth(): void {
    for (let index = 0; index < CLOTH_VERTEX_COUNT; index += 1) {
      const offset = index * 3;
      const u = (index % CLOTH_COLUMNS) / (CLOTH_COLUMNS - 1);
      const z = Math.sin(u * Math.PI * 2) * 0.025 * u;
      this.clothPositions[offset] = this.clothRest[offset];
      this.clothPositions[offset + 1] = this.clothRest[offset + 1];
      this.clothPositions[offset + 2] = z;
      this.clothPrevious[offset] = this.clothPositions[offset];
      this.clothPrevious[offset + 1] = this.clothPositions[offset + 1];
      this.clothPrevious[offset + 2] = z;
    }
    this.maxClothDeflection = 0;
    this.writeClothGeometry();
  }

  private stepCloth(
    delta: number,
    windDirection: Readonly<{ x: number; z: number }>,
    windStrength: number,
    reducedMotion: boolean,
  ): void {
    this.clothTime += delta;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const motionPressure = Math.min(speed, 70) * 0.5;
    const weatherPressure = THREE.MathUtils.clamp(windStrength, 0, 1) * 24;
    const crosswind = windDirection.z * weatherPressure - windDirection.x * weatherPressure * 0.35;
    const damping = reducedMotion ? 0.9 : 0.985;
    const gravity = reducedMotion ? -0.45 : -4.8;

    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      for (let column = 1; column < CLOTH_COLUMNS; column += 1) {
        const index = row * CLOTH_COLUMNS + column;
        const offset = index * 3;
        const u = column / (CLOTH_COLUMNS - 1);
        const v = row / (CLOTH_ROWS - 1);
        const x = this.clothPositions[offset];
        const y = this.clothPositions[offset + 1];
        const z = this.clothPositions[offset + 2];
        const previousX = this.clothPrevious[offset];
        const previousY = this.clothPrevious[offset + 1];
        const previousZ = this.clothPrevious[offset + 2];
        this.clothPrevious[offset] = x;
        this.clothPrevious[offset + 1] = y;
        this.clothPrevious[offset + 2] = z;
        const gust = reducedMotion
          ? 0
          : Math.sin(this.clothTime * 3.1 + u * 7.2 + v * 2.4) * (8 + u * 11);
        const pressure = (12 + motionPressure + crosswind + gust) * (0.34 + u * 0.9);
        this.clothPositions[offset] = x + (x - previousX) * damping;
        this.clothPositions[offset + 1] = y + (y - previousY) * damping + gravity * delta * delta;
        // A soft torsional tether keeps the banner readable from combat
        // distance while still allowing strong wind and carrier speed to fold
        // it well out of plane. Without this, the entire lattice can rotate
        // edge-on around its pinned hem like an unconstrained curtain.
        const readabilityTether = -z * 110;
        this.clothPositions[offset + 2] = z + (z - previousZ) * damping
          + (pressure + readabilityTether) * delta * delta;
      }
    }

    for (let iteration = 0; iteration < 5; iteration += 1) {
      this.pinClothEdge();
      for (const constraint of this.clothConstraints) this.solveConstraint(constraint);
    }
    this.pinClothEdge();
    this.writeClothGeometry();
  }

  private solveConstraint(constraint: ClothConstraint): void {
    const aOffset = constraint.a * 3;
    const bOffset = constraint.b * 3;
    const dx = this.clothPositions[bOffset] - this.clothPositions[aOffset];
    const dy = this.clothPositions[bOffset + 1] - this.clothPositions[aOffset + 1];
    const dz = this.clothPositions[bOffset + 2] - this.clothPositions[aOffset + 2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-7) return;
    const aPinned = constraint.a % CLOTH_COLUMNS === 0;
    const bPinned = constraint.b % CLOTH_COLUMNS === 0;
    const inverseMassA = aPinned ? 0 : 1;
    const inverseMassB = bPinned ? 0 : 1;
    const inverseMassTotal = inverseMassA + inverseMassB;
    if (inverseMassTotal === 0) return;
    const correction = (distance - constraint.restLength) / distance;
    const aWeight = inverseMassA / inverseMassTotal;
    const bWeight = inverseMassB / inverseMassTotal;
    this.clothPositions[aOffset] += dx * correction * aWeight;
    this.clothPositions[aOffset + 1] += dy * correction * aWeight;
    this.clothPositions[aOffset + 2] += dz * correction * aWeight;
    this.clothPositions[bOffset] -= dx * correction * bWeight;
    this.clothPositions[bOffset + 1] -= dy * correction * bWeight;
    this.clothPositions[bOffset + 2] -= dz * correction * bWeight;
  }

  private pinClothEdge(): void {
    for (let row = 0; row < CLOTH_ROWS; row += 1) {
      const offset = row * CLOTH_COLUMNS * 3;
      this.clothPositions[offset] = this.clothRest[offset];
      this.clothPositions[offset + 1] = this.clothRest[offset + 1];
      this.clothPositions[offset + 2] = 0;
    }
  }

  private writeClothGeometry(): void {
    const positionAttribute = this.clothGeometry.getAttribute('position') as THREE.BufferAttribute;
    positionAttribute.needsUpdate = true;
    this.clothGeometry.computeVertexNormals();
    const normalAttribute = this.clothGeometry.getAttribute('normal') as THREE.BufferAttribute;
    normalAttribute.needsUpdate = true;
    this.writeSeams();
    this.updateCrest();
    let largestDeflection = 0;
    for (let index = 2; index < this.clothPositions.length; index += 3) {
      largestDeflection = Math.max(largestDeflection, Math.abs(this.clothPositions[index]));
    }
    this.maxClothDeflection = largestDeflection;
  }

  private writeSeams(): void {
    if (!this.seamPositions) return;
    let target = 0;
    const appendSegment = (a: number, b: number): void => {
      const aOffset = a * 3;
      const bOffset = b * 3;
      this.seamPositions[target++] = this.clothPositions[aOffset];
      this.seamPositions[target++] = this.clothPositions[aOffset + 1];
      this.seamPositions[target++] = this.clothPositions[aOffset + 2] + 0.006;
      this.seamPositions[target++] = this.clothPositions[bOffset];
      this.seamPositions[target++] = this.clothPositions[bOffset + 1];
      this.seamPositions[target++] = this.clothPositions[bOffset + 2] + 0.006;
    };
    for (let column = 0; column < CLOTH_COLUMNS - 1; column += 1) {
      appendSegment(column, column + 1);
      const bottom = (CLOTH_ROWS - 1) * CLOTH_COLUMNS + column;
      appendSegment(bottom, bottom + 1);
    }
    for (let row = 0; row < CLOTH_ROWS - 1; row += 1) {
      appendSegment(row * CLOTH_COLUMNS, (row + 1) * CLOTH_COLUMNS);
      appendSegment(row * CLOTH_COLUMNS + CLOTH_COLUMNS - 1, (row + 2) * CLOTH_COLUMNS - 1);
    }
    const seamAttribute = this.seamGeometry.getAttribute('position') as THREE.BufferAttribute;
    seamAttribute.needsUpdate = true;
  }

  private updateCrest(): void {
    const row = Math.floor(CLOTH_ROWS / 2);
    const column = 3;
    const centerIndex = row * CLOTH_COLUMNS + column;
    const rightIndex = centerIndex + 1;
    const upIndex = (row - 1) * CLOTH_COLUMNS + column;
    this.readClothPoint(centerIndex, this.crestCenter);
    this.readClothPoint(rightIndex, this.crestRight);
    this.readClothPoint(upIndex, this.crestUp);
    this.crestXAxis.subVectors(this.crestRight, this.crestCenter).normalize();
    this.crestYAxis.subVectors(this.crestUp, this.crestCenter).normalize();
    this.crestZAxis.crossVectors(this.crestXAxis, this.crestYAxis).normalize();
    this.crestYAxis.crossVectors(this.crestZAxis, this.crestXAxis).normalize();
    this.crestBasis.makeBasis(this.crestXAxis, this.crestYAxis, this.crestZAxis);
    this.crest.position.copy(this.crestCenter).addScaledVector(this.crestZAxis, 0.012);
    this.crest.quaternion.setFromRotationMatrix(this.crestBasis);
  }

  private readClothPoint(index: number, target: THREE.Vector3): void {
    const offset = index * 3;
    target.set(
      this.clothPositions[offset],
      this.clothPositions[offset + 1],
      this.clothPositions[offset + 2],
    );
  }
}
