import * as THREE from 'three';
import {
  loadFlamethrowerDroneAsset,
  type FlamethrowerDroneAsset,
  type FlamethrowerDronePart,
} from '../assets/FlamethrowerDroneAsset';

export type FlamethrowerDroneMotionState =
  | 'patrol'
  | 'stalk'
  | 'attack-windup'
  | 'attack-recover'
  | 'jump-anticipation'
  | 'airborne'
  | 'landing'
  | 'destroyed';

type LegRig = {
  side: -1 | 1;
  row: 0 | 1;
  hip: THREE.Group;
  knee: THREE.Group;
  phase: number;
};

const ROWS = ['front', 'rear'] as const;
const SIDES = ['left', 'right'] as const;

export class FlamethrowerDroneVisual {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;
  readonly muzzle = new THREE.Object3D();
  isReady = false;
  loadError: Error | null = null;
  rigNodeCount = 0;
  partCount = 0;
  sourceTriangles = 0;
  sourceAnimationCount = 0;
  sourceSkinCount = 0;

  private readonly modelRoot = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly legs: LegRig[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private fallback: THREE.Object3D | null = null;
  private gaitPhase = 0;
  private motionBlend = 0;
  private landingBlend = 0;
  private recoil = 0;
  private hitFlash = 0;
  private readonly hitShell: THREE.Mesh;

  constructor(readonly id: string) {
    this.root.name = `${id}-flamethrower-spider-drone`;
    this.root.userData.flamethrowerDroneId = id;
    this.modelRoot.name = `${id}-runtime-rigid-rig`;
    this.body.name = `${id}-body-pivot`;
    this.root.add(this.modelRoot);
    this.modelRoot.add(this.body);
    this.muzzle.name = `${id}-grenade-launcher-muzzle`;
    this.muzzle.position.set(0, 2.72, -2.18);
    this.body.add(this.muzzle);
    this.installFallback();

    const shellGeometry = new THREE.SphereGeometry(2.45, 18, 12);
    const shellMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4b31,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.hitShell = new THREE.Mesh(shellGeometry, shellMaterial);
    this.hitShell.name = `${id}-damage-flash`;
    this.hitShell.position.y = 2;
    this.root.add(this.hitShell);
    this.ownedGeometries.push(shellGeometry);
    this.ownedMaterials.push(shellMaterial);
    this.ready = this.installAsset();
  }

  private installFallback(): void {
    const fallback = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x4a5545, metalness: 0.72, roughness: 0.42 });
    const chassisGeometry = new THREE.BoxGeometry(2.8, 1.3, 3.6);
    const legGeometry = new THREE.CapsuleGeometry(0.11, 1.8, 4, 7);
    const chassis = new THREE.Mesh(chassisGeometry, material);
    chassis.position.y = 1.7;
    fallback.add(chassis);
    for (const side of [-1, 1]) {
      for (let row = 0; row < 2; row += 1) {
        const leg = new THREE.Mesh(legGeometry, material);
        leg.position.set(side * 1.8, 0.75, (row - 0.5) * 2.2);
        leg.rotation.z = side * 0.8;
        fallback.add(leg);
      }
    }
    this.modelRoot.add(fallback);
    this.fallback = fallback;
    this.ownedGeometries.push(chassisGeometry, legGeometry);
    this.ownedMaterials.push(material);
  }

  private async installAsset(): Promise<void> {
    try {
      const asset = await loadFlamethrowerDroneAsset();
      this.buildRig(asset);
      this.fallback?.removeFromParent();
      this.fallback = null;
      this.isReady = true;
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private buildRig(asset: FlamethrowerDroneAsset): void {
    this.sourceTriangles = asset.triangles;
    this.sourceAnimationCount = asset.sourceAnimationCount;
    this.sourceSkinCount = asset.sourceSkinCount;
    const regionBounds = new Map<FlamethrowerDronePart, THREE.Box3>();
    for (const part of asset.parts) {
      const bounds = regionBounds.get(part.region) ?? new THREE.Box3();
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      bounds.union(part.geometry.boundingBox!);
      regionBounds.set(part.region, bounds);
    }

    const rigGroups = new Map<string, { hip: THREE.Group; knee: THREE.Group; hipPivot: THREE.Vector3; kneePivot: THREE.Vector3 }>();
    ROWS.forEach((row, rowIndex) => {
      SIDES.forEach((sideName) => {
        const side = sideName === 'left' ? -1 : 1;
        const upperRegion: FlamethrowerDronePart = `${row}-${sideName}-upper`;
        const lowerRegion: FlamethrowerDronePart = `${row}-${sideName}-lower`;
        const bounds = new THREE.Box3();
        const upperBounds = regionBounds.get(upperRegion);
        const lowerBounds = regionBounds.get(lowerRegion);
        if (upperBounds) bounds.union(upperBounds);
        if (lowerBounds) bounds.union(lowerBounds);
        if (bounds.isEmpty()) {
          const z = (rowIndex - 0.5) * 2.2;
          bounds.set(new THREE.Vector3(side * 2, 0, z - 0.4), new THREE.Vector3(side * 1.2, 1.55, z + 0.4));
        }
        const center = bounds.getCenter(new THREE.Vector3());
        const hipPivot = new THREE.Vector3(center.x * 0.62, bounds.max.y * 0.9, center.z);
        const kneePivot = new THREE.Vector3(center.x, THREE.MathUtils.lerp(bounds.min.y, bounds.max.y, 0.43), center.z);
        const hip = new THREE.Group();
        const knee = new THREE.Group();
        hip.name = `${this.id}-${row}-${sideName}-hip`;
        knee.name = `${this.id}-${row}-${sideName}-knee`;
        hip.position.copy(hipPivot);
        knee.position.copy(kneePivot).sub(hipPivot);
        hip.add(knee);
        this.modelRoot.add(hip);
        rigGroups.set(`${row}-${sideName}`, { hip, knee, hipPivot, kneePivot });
        this.legs.push({
          side,
          row: rowIndex as 0 | 1,
          hip,
          knee,
          phase: ((rowIndex + (side > 0 ? 1 : 0)) % 2) * Math.PI,
        });
      });
    });

    for (const part of asset.parts) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.name = `${this.id}-${part.region}-armor`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      this.partCount += 1;
      if (part.region === 'body') {
        this.body.add(mesh);
        continue;
      }
      const [row, sideName, segment] = part.region.split('-') as [typeof ROWS[number], typeof SIDES[number], 'upper' | 'lower'];
      const rig = rigGroups.get(`${row}-${sideName}`)!;
      if (segment === 'upper') {
        mesh.position.copy(rig.hipPivot).multiplyScalar(-1);
        rig.hip.add(mesh);
      } else {
        mesh.position.copy(rig.kneePivot).multiplyScalar(-1);
        rig.knee.add(mesh);
      }
    }
    this.rigNodeCount = 2 + this.legs.length * 2;
  }

  update(
    delta: number,
    elapsed: number,
    state: FlamethrowerDroneMotionState,
    horizontalSpeed: number,
    aimDirection?: THREE.Vector3,
  ): void {
    const moving = state === 'patrol' || state === 'stalk';
    const targetMotion = moving ? THREE.MathUtils.clamp(horizontalSpeed / 8.5, 0, 1) : 0;
    this.motionBlend = THREE.MathUtils.damp(this.motionBlend, targetMotion, 9, delta);
    this.landingBlend = THREE.MathUtils.damp(this.landingBlend, state === 'landing' ? 1 : 0, 14, delta);
    const strideRate = THREE.MathUtils.lerp(2.2, 6.8, this.motionBlend);
    this.gaitPhase += delta * strideRate;
    const anticipation = state === 'jump-anticipation' ? THREE.MathUtils.smoothstep((elapsed % 1) + 0.1, 0, 1) : 0;
    const tuck = state === 'airborne' ? 1 : 0;
    const recovery = state === 'attack-recover' ? 1 : 0;
    this.recoil = THREE.MathUtils.damp(this.recoil, recovery, 13, delta);

    for (const leg of this.legs) {
      const wave = Math.sin(this.gaitPhase + leg.phase);
      const planted = Math.max(0, -wave);
      const swing = wave * 0.34 * this.motionBlend;
      const lift = Math.max(0, wave) * 0.22 * this.motionBlend;
      const rowBias = leg.row === 0 ? -0.08 : 0.08;
      leg.hip.rotation.x = swing + rowBias - tuck * (leg.row - 0.5) * 0.22;
      leg.hip.rotation.z = leg.side * (lift + anticipation * 0.18 - tuck * 0.32 - this.landingBlend * 0.08);
      leg.knee.rotation.z = leg.side * (-planted * 0.17 - anticipation * 0.28 + tuck * 0.55 + this.landingBlend * 0.38);
    }

    const bob = Math.sin(this.gaitPhase * 2) * 0.055 * this.motionBlend;
    const landingCompression = this.landingBlend * 0.22;
    const crouch = state === 'jump-anticipation' ? 0.33 : 0;
    this.body.position.y = bob - crouch - landingCompression;
    this.body.rotation.z = Math.sin(this.gaitPhase) * 0.025 * this.motionBlend;
    this.body.rotation.x = -this.recoil * 0.075;
    if (aimDirection && aimDirection.lengthSq() > 1e-5) {
      const localYaw = Math.atan2(-aimDirection.x, -aimDirection.z);
      this.body.rotation.y = THREE.MathUtils.damp(this.body.rotation.y, THREE.MathUtils.clamp(localYaw, -0.22, 0.22), 5, delta);
    } else {
      this.body.rotation.y = THREE.MathUtils.damp(this.body.rotation.y, 0, 5, delta);
    }
    this.hitFlash = Math.max(0, this.hitFlash - delta * 5.5);
    (this.hitShell.material as THREE.MeshBasicMaterial).opacity = this.hitFlash * 0.42;
  }

  face(direction: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() < 1e-5) return;
    const desiredYaw = Math.atan2(direction.x, direction.z) + Math.PI;
    const desired = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, desiredYaw);
    this.root.quaternion.slerp(desired, 1 - Math.exp(-delta * 7.5));
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.muzzle.updateWorldMatrix(true, false);
    return this.muzzle.getWorldPosition(out);
  }

  flashDamage(): void {
    this.hitFlash = 1;
  }

  dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.root.removeFromParent();
  }
}
