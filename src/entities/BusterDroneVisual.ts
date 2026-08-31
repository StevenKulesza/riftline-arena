import * as THREE from 'three';
import {
  BUSTER_DRONE_DIAGNOSTICS,
  cloneBusterDroneScene,
  loadBusterDroneAsset,
} from '../assets/BusterDroneAsset';

const MODEL_FORWARD = new THREE.Vector3(0, 0, 1);
const TARGET_DIAMETER = 5.4;
const TAKEOFF_CLIP_START_SECONDS = 3.6;

export type BusterVisualFlightState =
  | 'spool'
  | 'takeoff'
  | 'survey'
  | 'attack-run'
  | 'breakaway'
  | 'jink'
  | 'landing-approach'
  | 'landed'
  | 'destroyed';

/**
 * Presentation wrapper for the supplied Buster Drone GLB. The asset uses an
 * authored transform hierarchy rather than a skin, so AnimationMixer must own
 * the cloned hierarchy intact. Gameplay movement remains on `root` and the
 * embedded clip supplies turbines, legs, panels, eye and lift-off articulation.
 */
export class BusterDroneVisual {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;
  isReady = false;
  loadError: Error | null = null;
  modelMeshCount = 0;
  modelWidth = 0;
  modelHeight = 0;
  modelDepth = 0;
  rigNodeCount = 0;
  animationClipName = '';
  animationClipDuration = 0;
  animationTime = 0;
  animationPlaying = false;

  private readonly modelMount = new THREE.Group();
  private readonly shardEmitter = new THREE.Object3D();
  private readonly fallbackGeometry = new THREE.IcosahedronGeometry(1.6, 1);
  private readonly fallbackMaterial = new THREE.MeshStandardMaterial({
    color: 0x3b2632,
    metalness: 0.78,
    roughness: 0.32,
    emissive: 0xff173f,
    emissiveIntensity: 0.34,
  });
  private readonly ownedMaterials: THREE.Material[] = [];
  private fallback: THREE.Mesh | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private takeoffAction: THREE.AnimationAction | null = null;
  private turbineLeft: THREE.Object3D | null = null;
  private turbineRight: THREE.Object3D | null = null;
  private eyeController: THREE.Object3D | null = null;
  private clipCompleted = false;
  private turbinePhase = 0;

  constructor(readonly id: string) {
    this.root.name = `${id}-buster-drone`;
    this.root.userData.combatDroneId = id;
    this.root.userData.combatDroneKind = 'buster';
    this.modelMount.name = `${id}-authored-buster-mount`;
    this.root.add(this.modelMount);
    this.installFallback();
    this.ready = this.installAuthoredModel();
  }

  face(direction: THREE.Vector3, delta: number, response = 2.7): void {
    if (direction.lengthSq() <= 1e-5) return;
    const desired = new THREE.Quaternion().setFromUnitVectors(MODEL_FORWARD, direction.clone().normalize());
    this.root.quaternion.slerp(desired, 1 - Math.exp(-delta * response));
  }

  forwardWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(MODEL_FORWARD).applyQuaternion(this.root.quaternion).normalize();
  }

  shardOriginWorld(target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.shardEmitter.updateWorldMatrix(true, false);
    this.shardEmitter.getWorldPosition(out);
    const towardTarget = target.clone().sub(out);
    if (towardTarget.lengthSq() > 1e-6) out.addScaledVector(towardTarget.normalize(), 0.2);
    return out;
  }

  resetTakeoffAnimation(): void {
    if (!this.takeoffAction) return;
    this.takeoffAction.reset();
    this.takeoffAction.setLoop(THREE.LoopOnce, 1);
    this.takeoffAction.clampWhenFinished = true;
    this.takeoffAction.time = TAKEOFF_CLIP_START_SECONDS;
    this.takeoffAction.timeScale = 1.25;
    this.takeoffAction.play();
    this.animationTime = TAKEOFF_CLIP_START_SECONDS;
    this.animationPlaying = true;
    this.clipCompleted = false;
  }

  startLandingAnimation(): void {
    if (!this.takeoffAction) return;
    this.takeoffAction.reset();
    this.takeoffAction.setLoop(THREE.LoopOnce, 1);
    this.takeoffAction.clampWhenFinished = true;
    // Reverse the authored deployment section so the same real panel, leg and
    // turbine rig folds into a convincing touchdown pose.
    this.takeoffAction.time = 11.76;
    this.takeoffAction.timeScale = -1.1;
    this.takeoffAction.play();
    this.animationTime = 11.76;
    this.animationPlaying = true;
    this.clipCompleted = false;
  }

  updateAnimation(delta: number, state: BusterVisualFlightState, targetDirection?: THREE.Vector3): void {
    if (this.mixer && this.takeoffAction && !this.clipCompleted) {
      this.mixer.update(delta);
      this.animationTime = this.takeoffAction.time;
      this.animationPlaying = this.takeoffAction.isRunning();
      if (!this.animationPlaying || this.animationTime >= this.animationClipDuration - 1e-3) {
        this.clipCompleted = true;
      }
    }

    // The authored clip is one-shot. Keep the actual rig's turbine nodes alive
    // after it clamps rather than replaying the full take-off sequence in air.
    if (this.clipCompleted && state !== 'landed' && state !== 'spool') {
      this.turbinePhase += delta * (state === 'attack-run' || state === 'breakaway' ? 18 : 12);
      if (this.turbineLeft) this.turbineLeft.rotation.y += delta * 18;
      if (this.turbineRight) this.turbineRight.rotation.y -= delta * 18;
    }
    if (this.eyeController && targetDirection && targetDirection.lengthSq() > 1e-6) {
      const localTarget = targetDirection.clone().applyQuaternion(this.root.quaternion.clone().invert()).normalize();
      const targetYaw = THREE.MathUtils.clamp(Math.atan2(localTarget.x, localTarget.z), -0.42, 0.42);
      const targetPitch = THREE.MathUtils.clamp(-Math.asin(localTarget.y), -0.28, 0.28);
      this.eyeController.rotation.y = THREE.MathUtils.lerp(
        this.eyeController.rotation.y,
        targetYaw,
        1 - Math.exp(-delta * 5.5),
      );
      this.eyeController.rotation.x = THREE.MathUtils.lerp(
        this.eyeController.rotation.x,
        targetPitch,
        1 - Math.exp(-delta * 5.5),
      );
    }
  }

  stopContinuousBeam(): void {
    // Shared combat-drone interface: Busters use physical shard projectiles.
  }

  get continuousBeamVisible(): boolean { return false; }
  get continuousBeamLayerCount(): number { return 0; }
  get continuousBeamHaloCount(): number { return 0; }
  get continuousBeamParticleCount(): number { return 0; }

  dispose(): void {
    this.mixer?.stopAllAction();
    if (this.mixer) this.mixer.uncacheRoot(this.modelMount);
    for (const material of this.ownedMaterials) material.dispose();
    this.fallbackGeometry.dispose();
    this.fallbackMaterial.dispose();
    this.root.removeFromParent();
  }

  private installFallback(): void {
    const mesh = new THREE.Mesh(this.fallbackGeometry, this.fallbackMaterial);
    mesh.name = `${this.id}-buster-loading-fallback`;
    mesh.castShadow = true;
    mesh.scale.set(1, 0.62, 1.18);
    this.modelMount.add(mesh);
    this.fallback = mesh;
  }

  private async installAuthoredModel(): Promise<void> {
    try {
      const asset = await loadBusterDroneAsset();
      const model = cloneBusterDroneScene(asset);
      model.name = `${this.id}-authored-buster-drone`;

      // Sketchfab packaged a presentation floor and sky under Env. They are
      // not part of the vehicle and would corrupt scale, shadows and collision.
      model.getObjectByName('Env')?.removeFromParent();
      model.updateMatrixWorld(true);
      const sourceBounds = new THREE.Box3().setFromObject(model);
      const sourceSize = sourceBounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
      if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
        throw new Error('Buster drone GLB has no renderable vehicle bounds.');
      }
      const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
      const modelScale = TARGET_DIAMETER / maxDimension;
      model.scale.setScalar(modelScale);
      model.position.copy(sourceCenter).multiplyScalar(-modelScale);

      model.traverse((object) => {
        if (object.name === 'Drone_Turb_Blade_L') this.turbineLeft = object;
        if (object.name === 'Drone_Turb_Blade_R') this.turbineRight = object;
        if (object.name === 'Drone_IEye' || object.name === 'Eye_Controller') this.eyeController ??= object;
        if (!(object instanceof THREE.Mesh)) return;
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const materials = sourceMaterials.map((source) => {
          const material = source.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            material.envMapIntensity = Math.max(1.1, material.envMapIntensity);
            if (object.name.toLowerCase().includes('lens') || object.name === '1') {
              material.emissive.set(0xff123d);
              material.emissiveIntensity = 2.35;
            }
          }
          this.ownedMaterials.push(material);
          return material;
        });
        object.material = Array.isArray(object.material) ? materials : materials[0];
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
        this.modelMeshCount += 1;
      });

      this.modelMount.add(model);
      const authoredEye = model.getObjectByName('Drone_ILens_body_0');
      if (authoredEye instanceof THREE.Mesh) {
        const eyeMesh = authoredEye;
        eyeMesh.geometry.computeBoundingBox();
        eyeMesh.geometry.boundingBox?.getCenter(this.shardEmitter.position);
        this.shardEmitter.position.z += 0.045;
        eyeMesh.add(this.shardEmitter);
      } else {
        this.shardEmitter.position.set(0, 0.15, TARGET_DIAMETER * 0.42);
        this.root.add(this.shardEmitter);
      }

      const clip = asset.animations.find((candidate) => candidate.name === 'Start_Liftoff')
        ?? asset.animations[0];
      if (!clip) throw new Error('Buster drone GLB is missing its authored Start_Liftoff animation.');
      this.mixer = new THREE.AnimationMixer(model);
      this.takeoffAction = this.mixer.clipAction(clip);
      this.animationClipName = clip.name;
      this.animationClipDuration = clip.duration;
      const rigNames = new Set<string>();
      for (const track of clip.tracks) rigNames.add(track.name.split('.')[0]);
      this.rigNodeCount = rigNames.size;
      this.resetTakeoffAnimation();

      this.fallback?.removeFromParent();
      this.fallback = null;
      this.root.updateMatrixWorld(true);
      const installed = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      this.modelWidth = installed.x;
      this.modelHeight = installed.y;
      this.modelDepth = installed.z;
      this.isReady = true;
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
      this.isReady = false;
    }
  }
}

export const BUSTER_VISUAL_DIAGNOSTICS = Object.freeze({
  targetDiameter: TARGET_DIAMETER,
  takeoffClipStartSeconds: TAKEOFF_CLIP_START_SECONDS,
  source: BUSTER_DRONE_DIAGNOSTICS,
});
