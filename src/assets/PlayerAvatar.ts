import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCharacterAsset } from './CharacterAsset';
import { JetpackRig } from './JetpackRig';

const PLAYER_MODEL_HEIGHT = 1.78;
const SOURCE_MODEL_HEIGHT = 1.85245;

/**
 * Third-person presentation for the local player. Gameplay owns position and
 * aim; this class owns the imported character, its animation state, and the
 * authored hardware that makes the avatar readable from behind.
 */
export class PlayerAvatar {
  readonly root = new THREE.Group();
  readonly jetpack = new JetpackRig({ color: 0x43e8ff, thirdPersonPlayer: true });
  readonly ready: Promise<void>;
  modelReady = false;
  modelMeshCount = 0;
  modelHeight = 0;
  modelWidth = 0;
  modelDepth = 0;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private mixer?: THREE.AnimationMixer;
  private activeAnimation = '';
  private disposed = false;

  constructor() {
    this.root.name = 'rift-player-avatar';
    this.root.visible = false;
    this.root.add(this.jetpack.root);
    this.ready = this.installAuthoredModel();
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  setPose(yaw: number, strafe: number): void {
    // The SWAT asset faces +Z. The gameplay view faces -Z at yaw 0, hence the
    // half-turn. A restrained roll gives lateral movement a readable silhouette
    // without making the player look permanently tilted at high speed.
    this.root.rotation.y = yaw + Math.PI;
    this.root.rotation.z = THREE.MathUtils.clamp(-strafe * 0.045, -0.055, 0.055);
  }

  update(
    delta: number,
    elapsed: number,
    grounded: boolean,
    speed: number,
    firing: boolean,
    jetpacking: boolean,
    reducedMotion: boolean,
  ): void {
    this.jetpack.update(jetpacking, delta, elapsed, reducedMotion);
    if (!this.mixer) return;

    const animation = firing
      ? 'shoot'
      : jetpacking
        ? 'idle_gun_pointing'
      : !grounded
        ? 'jump'
        : speed > 6
          ? 'run_shoot'
          : speed > 0.8
            ? 'walk'
            : 'idle_gun_pointing';
    this.playAnimation(animation, 0.13);
    this.mixer.update(delta);
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.jetpack.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private async installAuthoredModel(): Promise<void> {
    try {
      const asset = await loadCharacterAsset();
      if (this.disposed) return;

      const model = cloneSkeleton(asset.scene) as THREE.Group;
      const teamColor = new THREE.Color(0x43e8ff);
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;

        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const authoredMaterials = sourceMaterials.map((source) => {
          const material = source.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            const role = material.name.toLowerCase();
            if (role.includes('visor')) {
              material.color.set(0x9ff5ff).lerp(teamColor, 0.2);
              material.emissive.copy(material.color).multiplyScalar(0.38);
              material.emissiveIntensity = 1.35;
            } else if (role.includes('skin')) {
              material.color.offsetHSL(0, -0.04, 0.07);
              material.emissive.set(0x000000);
              material.emissiveIntensity = 0;
            } else if (role.includes('black')) {
              material.color.set(0x28353e).lerp(teamColor, 0.035);
              material.emissive.copy(teamColor).multiplyScalar(0.008);
              material.emissiveIntensity = 0.08;
            } else {
              // Preserve the authored SWAT palette and texture contrast. Team
              // color belongs on the visor and hardware; washing every suit
              // material cyan makes the character read as a glowing blob.
              material.color.multiplyScalar(0.82).lerp(new THREE.Color(0x53616a), 0.18);
              material.emissive.copy(teamColor).multiplyScalar(0.01);
              material.emissiveIntensity = 0.12;
            }
            material.roughness = Math.max(0.28, material.roughness * 0.84);
            material.metalness = Math.min(0.8, material.metalness + 0.12);
            material.side = THREE.DoubleSide;
          }
          this.materials.push(material);
          return material;
        });
        mesh.material = Array.isArray(mesh.material) ? authoredMaterials : authoredMaterials[0];
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.modelMeshCount += 1;
      });

      model.scale.setScalar(PLAYER_MODEL_HEIGHT / SOURCE_MODEL_HEIGHT);
      model.position.set(0, 0, 0);
      model.name = 'rift-player-authored-character';

      for (const child of [...this.root.children]) {
        if (child !== this.jetpack.root) this.root.remove(child);
      }
      this.root.add(model);
      this.addTeamHardware();
      this.root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      this.modelHeight = size.y;
      this.modelWidth = size.x;
      this.modelDepth = size.z;

      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of asset.animations) {
        const action = this.mixer.clipAction(clip);
        const key = clip.name.toLowerCase();
        if (key.includes('death') || key.includes('jump') || key.includes('shoot')) {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        this.actions.set(key, action);
      }
      this.modelReady = true;
      this.playAnimation('idle_gun', 0);
    } catch {
      // The jetpack and team hardware still provide a stable presentation if
      // the optional authored character asset is unavailable.
      this.modelReady = false;
    }
  }

  private playAnimation(name: string, fade: number): void {
    if (name === this.activeAnimation) return;
    let next: THREE.AnimationAction | undefined;
    let fuzzyNext: THREE.AnimationAction | undefined;
    let previous: THREE.AnimationAction | undefined;
    for (const [key, action] of this.actions) {
      if (!fuzzyNext && key.includes(name)) fuzzyNext = action;
      if (!next && key.endsWith(`|${name}`)) next = action;
      if (!previous && this.activeAnimation && key.includes(this.activeAnimation)) previous = action;
    }
    next ??= fuzzyNext;
    if (!next) return;
    previous?.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this.activeAnimation = name;
  }

  private addTeamHardware(): void {
    const accent = new THREE.MeshStandardMaterial({
      color: 0x43e8ff,
      emissive: 0x43e8ff,
      emissiveIntensity: 0.55,
      roughness: 0.3,
      metalness: 0.58,
    });
    this.materials.push(accent);
    const beaconGeometry = new THREE.BoxGeometry(0.12, 0.035, 0.025);
    this.geometries.push(beaconGeometry);
    const beacons = new THREE.InstancedMesh(beaconGeometry, accent, 2);
    beacons.name = 'player-team-beacons';
    const matrix = new THREE.Matrix4();
    for (const [index, side] of [-1, 1].entries()) {
      matrix.makeTranslation(side * 0.2, 1.35, 0.04);
      beacons.setMatrixAt(index, matrix);
    }
    beacons.instanceMatrix.needsUpdate = true;
    this.root.add(beacons);
  }
}
