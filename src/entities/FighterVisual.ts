import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  cloneStarSparrowScene,
  loadStarSparrowAsset,
  STAR_SPARROW_DIAGNOSTICS,
  type StarSparrowAsset,
} from '../assets/StarSparrowAsset';

const DEFAULT_LENGTH_METERS = 7;
export const FIGHTER_VISIBLE_SCALE_CORRECTION = 4;
// The completed modular hull occupies only part of the source animation's
// 114 m travel envelope. Area-weighted silhouette sampling of the baked pose
// produces a nose/tail silhouette midpoint 53.300% forward of that AABB pivot
// (and a negligible 0.289% left bias). Recenter the visible extents—not the
// asymmetric surface-area centroid—so opposing pad margins read balanced while
// the flight/AI root remains on the exact deck centroid.
const OCCUPIED_FOOTPRINT_CENTER_X_PER_LENGTH = -0.00288898;
const OCCUPIED_FOOTPRINT_CENTER_Z_PER_LENGTH = -0.53299756;
const MAX_THRUSTER_INSTANCES = 8;
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

export type FighterVisualState = {
  /** Normalized engine demand. */
  throttle?: number;
  boost?: boolean;
  /** Normalized hull and shield values. */
  health?: number;
  shield?: number;
  /** Short, normalized hit impulses supplied by gameplay. */
  hullHit?: number;
  shieldHit?: number;
  destroyed?: boolean;
  respawning?: boolean;
  reducedMotion?: boolean;
  visible?: boolean;
  /** Optional 0..1 control of the source clip's modular assembly animation. */
  assemblyProgress?: number;
};

export type FighterVisualOptions = {
  targetLength?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  shieldColor?: THREE.ColorRepresentation;
  engineColor?: THREE.ColorRepresentation;
};

type EmissiveMaterialState = {
  material: THREE.MeshStandardMaterial;
  baseEmissive: THREE.Color;
  baseIntensity: number;
};

/**
 * Reusable Star Sparrow presentation entity. Gameplay owns physics and health;
 * this class owns import normalization, hardpoints, collision metadata, and VFX.
 * Its local convention is -Z forward and +Y up, matching the flight body.
 */
export class FighterVisual {
  readonly root = new THREE.Group();
  readonly dimensions = new THREE.Vector3(3.25, 1.25, DEFAULT_LENGTH_METERS);
  readonly collisionHalfExtents = new THREE.Vector3();
  readonly collisionProxy: THREE.Mesh;
  readonly weaponSockets: THREE.Object3D[] = [];
  readonly thrusterSockets: THREE.Object3D[] = [];
  readonly weaponNodes: THREE.Object3D[] = [];
  readonly thrusterNodes: THREE.Object3D[] = [];
  readonly forward = FORWARD.clone();
  readonly up = UP.clone();
  readonly ready: Promise<void>;
  readonly visibleScaleCorrection = FIGHTER_VISIBLE_SCALE_CORRECTION;

  radius = this.dimensions.length() * 0.5;
  isReady = false;
  loadError: Error | undefined;

  private readonly targetLength: number;
  private readonly castShadow: boolean;
  private readonly receiveShadow: boolean;
  private readonly fallback: THREE.Group;
  private readonly fallbackSignal: THREE.MeshStandardMaterial;
  private readonly shieldMaterial: THREE.MeshPhysicalMaterial;
  private readonly shieldMesh: THREE.Mesh;
  private readonly engineGlowMaterial: THREE.MeshBasicMaterial;
  private readonly engineTrailMaterial: THREE.MeshBasicMaterial;
  private readonly engineGlows: THREE.InstancedMesh;
  private readonly engineTrails: THREE.InstancedMesh;
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly importedMaterials = new Set<THREE.Material>();
  private readonly emissiveMaterials: EmissiveMaterialState[] = [];
  private readonly thrusterOffsets: THREE.Vector3[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly identityRotation = new THREE.Quaternion();
  private readonly trailRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI * 0.5,
  );
  private readonly matrixPosition = new THREE.Vector3();
  private readonly matrixScale = new THREE.Vector3();
  private readonly damageColor = new THREE.Color(0xff2b12);
  private model: THREE.Group | undefined;
  private renderBatch: THREE.Group | undefined;
  private mixer: THREE.AnimationMixer | undefined;
  private assemblyAction: THREE.AnimationAction | undefined;
  private assemblyDuration = 0;
  private assemblyProgress = 1;
  private elapsed = 0;
  private engineIntensity = 0;
  private disposed = false;

  constructor(options: FighterVisualOptions = {}) {
    this.targetLength = Math.max(1, options.targetLength ?? DEFAULT_LENGTH_METERS);
    this.castShadow = options.castShadow ?? true;
    this.receiveShadow = options.receiveShadow ?? true;
    this.dimensions.multiplyScalar(this.targetLength / DEFAULT_LENGTH_METERS);
    this.radius = this.dimensions.length() * 0.5;

    this.root.name = 'star-sparrow-fighter';
    this.root.userData = {
      fighterVisual: true,
      asset: STAR_SPARROW_DIAGNOSTICS.sourceTitle,
      forwardAxis: '-Z',
      upAxis: '+Y',
      targetLengthMeters: this.targetLength,
      diagnostics: STAR_SPARROW_DIAGNOSTICS,
    };

    const fallbackResult = this.createFallback();
    this.fallback = fallbackResult.root;
    this.fallbackSignal = fallbackResult.signal;
    this.root.add(this.fallback);

    const collisionGeometry = new THREE.BoxGeometry(1, 1, 1);
    const collisionMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.ownedGeometries.push(collisionGeometry);
    this.ownedMaterials.push(collisionMaterial);
    this.collisionProxy = new THREE.Mesh(collisionGeometry, collisionMaterial);
    this.collisionProxy.name = 'fighter-collision-proxy';
    this.collisionProxy.visible = false;
    this.root.add(this.collisionProxy);

    const shieldGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.shieldMaterial = new THREE.MeshPhysicalMaterial({
      color: options.shieldColor ?? 0x65dcff,
      emissive: options.shieldColor ?? 0x65dcff,
      emissiveIntensity: 1.2,
      roughness: 0.12,
      metalness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.ownedGeometries.push(shieldGeometry);
    this.ownedMaterials.push(this.shieldMaterial);
    this.shieldMesh = new THREE.Mesh(shieldGeometry, this.shieldMaterial);
    this.shieldMesh.name = 'fighter-shield-shell';
    this.shieldMesh.renderOrder = 4;
    this.shieldMesh.frustumCulled = false;
    this.root.add(this.shieldMesh);

    const glowGeometry = new THREE.SphereGeometry(0.13, 8, 6);
    const trailGeometry = new THREE.ConeGeometry(0.14, 1, 8, 1, true);
    this.engineGlowMaterial = new THREE.MeshBasicMaterial({
      color: options.engineColor ?? 0x56e7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.engineTrailMaterial = new THREE.MeshBasicMaterial({
      color: options.engineColor ?? 0x56e7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.ownedGeometries.push(glowGeometry, trailGeometry);
    this.ownedMaterials.push(this.engineGlowMaterial, this.engineTrailMaterial);
    this.engineGlows = new THREE.InstancedMesh(glowGeometry, this.engineGlowMaterial, MAX_THRUSTER_INSTANCES);
    this.engineTrails = new THREE.InstancedMesh(trailGeometry, this.engineTrailMaterial, MAX_THRUSTER_INSTANCES);
    for (const effect of [this.engineGlows, this.engineTrails]) {
      effect.name = effect === this.engineGlows ? 'fighter-engine-glows' : 'fighter-engine-trails';
      effect.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      effect.frustumCulled = false;
      effect.renderOrder = 5;
      effect.userData.fighterEngineVfx = true;
      this.root.add(effect);
    }

    this.setDefaultThrusterOffsets();
    this.updateCollisionProxy();
    this.updateEffectScale();

    this.ready = loadStarSparrowAsset()
      .then((asset) => this.installAsset(asset))
      .catch((error: unknown) => {
        const loadError = error instanceof Error ? error : new Error(String(error));
        this.loadError = loadError;
        this.root.userData.loadError = loadError.message;
        this.fallbackSignal.emissive.setHex(0xff3018);
        this.fallbackSignal.color.setHex(0x711006);
        throw loadError;
      });
  }

  updateVisual(delta: number, state: FighterVisualState): void {
    if (this.disposed) return;
    const frameDelta = THREE.MathUtils.clamp(delta, 0, 0.1);
    this.elapsed += frameDelta;

    if (state.assemblyProgress !== undefined) {
      const progress = THREE.MathUtils.clamp(state.assemblyProgress, 0, 1);
      if (Math.abs(progress - this.assemblyProgress) > 0.0001) this.poseAssembly(progress);
    }

    const destroyed = state.destroyed ?? false;
    const throttleTarget = destroyed ? 0 : Math.max(0.07, THREE.MathUtils.clamp(state.throttle ?? 0, 0, 1));
    const response = 1 - Math.exp(-frameDelta * (throttleTarget > this.engineIntensity ? 12 : 18));
    this.engineIntensity = THREE.MathUtils.lerp(this.engineIntensity, throttleTarget, response);
    const reducedMotion = state.reducedMotion ?? false;
    const flicker = reducedMotion
      ? 1
      : 0.92 + Math.sin(this.elapsed * 37) * 0.045 + Math.sin(this.elapsed * 63) * 0.025;
    const boost = state.boost && !destroyed ? 1 : 0;
    const visibleEngine = this.engineIntensity * flicker;
    this.engineGlowMaterial.opacity = visibleEngine * (0.58 + boost * 0.28);
    this.engineTrailMaterial.opacity = visibleEngine * (0.34 + boost * 0.34);
    this.engineGlows.visible = visibleEngine > 0.005;
    this.engineTrails.visible = visibleEngine > 0.015;
    this.updateEngineInstances(visibleEngine, boost);

    const health = THREE.MathUtils.clamp(state.health ?? 1, 0, 1);
    const hullHit = THREE.MathUtils.clamp(state.hullHit ?? 0, 0, 1);
    const damage = 1 - health;
    const damageCue = THREE.MathUtils.clamp(damage * 0.48 + hullHit * 0.82 + (destroyed ? 0.9 : 0), 0, 1);
    const destructionFlicker = destroyed && !reducedMotion ? 0.65 + Math.sin(this.elapsed * 24) * 0.35 : 1;
    for (const stateMaterial of this.emissiveMaterials) {
      stateMaterial.material.emissive.copy(stateMaterial.baseEmissive).lerp(this.damageColor, damageCue);
      stateMaterial.material.emissiveIntensity = stateMaterial.baseIntensity
        * (1 + damageCue * 1.35)
        * destructionFlicker;
    }
    this.fallbackSignal.emissive.copy(this.damageColor);
    this.fallbackSignal.emissiveIntensity = 0.55 + damageCue * 1.8;

    const shield = THREE.MathUtils.clamp(state.shield ?? 0, 0, 1);
    const shieldHit = THREE.MathUtils.clamp(state.shieldHit ?? 0, 0, 1);
    const shieldPulse = reducedMotion ? 0.8 : 0.72 + Math.sin(this.elapsed * 5.5) * 0.12;
    // A full-time shield shell reads as a giant dome and conceals the actual
    // parked hull. Keep shields in the HUD; reveal the mesh only on impact.
    this.shieldMaterial.opacity = shield > 0
      ? shieldHit * 0.26 * shieldPulse
      : shieldHit * 0.22;
    this.shieldMaterial.emissiveIntensity = 0.35 + shieldHit * 2.6;
    this.shieldMesh.visible = shieldHit > 0.01 && this.shieldMaterial.opacity > 0.003 && !destroyed;

    const respawnVisible = !(state.respawning ?? false)
      || reducedMotion
      || Math.sin(this.elapsed * 18) > -0.2;
    this.root.visible = state.visible !== false && respawnVisible;
  }

  /**
   * Keeps a cheap authored silhouette resident for distant mobile craft while
   * avoiding the imported hull's full triangle cost. Both representations are
   * uploaded during the loading screen, so crossing the LOD boundary cannot
   * introduce a live-play asset stall.
   */
  setHighDetail(highDetail: boolean): void {
    if (!this.isReady || !this.renderBatch) return;
    this.renderBatch.visible = highDetail;
    this.fallback.visible = !highDetail;
    this.root.userData.highDetail = highDetail;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer?.stopAllAction();
    if (this.mixer && this.model) this.mixer.uncacheRoot(this.model);
    for (const material of this.importedMaterials) material.dispose();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.weaponSockets.length = 0;
    this.thrusterSockets.length = 0;
    this.weaponNodes.length = 0;
    this.thrusterNodes.length = 0;
    this.root.removeFromParent();
    this.root.clear();
  }

  private installAsset(asset: StarSparrowAsset): void {
    if (this.disposed) return;
    const model = cloneStarSparrowScene(asset);
    model.name = 'star-sparrow-imported-model';
    this.model = model;
    this.cloneAndTuneMaterials(model);
    this.identifyAuthoredParts(model);
    this.setupAssemblyAnimation(model, asset.animations);
    this.poseAssembly(1);

    const modelFrame = this.normalizeModel(model);
    this.root.add(modelFrame);
    this.root.updateWorldMatrix(true, true);
    this.createAuthoredSockets();
    const batchedModel = this.createStaticRenderBatch(modelFrame);
    this.renderBatch = batchedModel;
    this.root.remove(modelFrame);
    this.root.add(batchedModel);
    this.fallback.visible = false;
    this.isReady = true;
    this.root.userData.ready = true;
    this.root.userData.dimensionsMeters = {
      x: this.dimensions.x,
      y: this.dimensions.y,
      z: this.dimensions.z,
    };
    this.root.userData.boundingRadiusMeters = this.radius;
  }

  private cloneAndTuneMaterials(model: THREE.Object3D): void {
    const clones = new Map<THREE.Material, THREE.Material>();
    const cloneMaterial = (source: THREE.Material): THREE.Material => {
      const cached = clones.get(source);
      if (cached) return cached;
      const material = source.clone();
      material.name = `${source.name || 'fighter-pbr'}-instance`;
      material.userData = { ...source.userData, fighterInstanceMaterial: true };
      clones.set(source, material);
      this.importedMaterials.add(material);
      if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.envMapIntensity = Math.max(1.15, standard.envMapIntensity * 1.18);
        standard.roughness = THREE.MathUtils.clamp(standard.roughness, 0.18, 0.9);
        standard.dithering = true;
        this.emissiveMaterials.push({
          material: standard,
          baseEmissive: standard.emissive.clone(),
          baseIntensity: Math.max(0.7, standard.emissiveIntensity),
        });
      }
      return material;
    };

    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(cloneMaterial)
        : cloneMaterial(mesh.material);
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      mesh.userData.fighterVisualMesh = true;
    });
  }

  private identifyAuthoredParts(model: THREE.Object3D): void {
    model.traverse((object) => {
      if (/StarSparrow_(?:Weapon|Plasma)/i.test(object.name)) {
        object.userData.fighterPart = 'weapon';
        this.weaponNodes.push(object);
      }
      if (/StarSparrow_(?:Thruster|Engine)/i.test(object.name)) {
        object.userData.fighterPart = 'thruster';
        this.thrusterNodes.push(object);
      }
    });
  }

  private setupAssemblyAnimation(model: THREE.Group, animations: readonly THREE.AnimationClip[]): void {
    const clip = animations[0];
    if (!clip) return;
    this.mixer = new THREE.AnimationMixer(model);
    this.assemblyAction = this.mixer.clipAction(clip, model);
    this.assemblyAction.setLoop(THREE.LoopOnce, 1);
    this.assemblyAction.clampWhenFinished = true;
    this.assemblyAction.play();
    this.assemblyDuration = clip.duration;
  }

  private poseAssembly(progress: number): void {
    this.assemblyProgress = THREE.MathUtils.clamp(progress, 0, 1);
    if (!this.mixer || !this.assemblyAction || this.assemblyDuration <= 0) return;
    this.assemblyAction.paused = false;
    this.assemblyAction.enabled = true;
    this.assemblyAction.time = Math.min(
      this.assemblyDuration - 0.0001,
      this.assemblyDuration * this.assemblyProgress,
    );
    this.mixer.update(0);
    this.assemblyAction.paused = true;
    this.model?.updateMatrixWorld(true);
  }

  private normalizeModel(model: THREE.Group): THREE.Group {
    const modelFrame = new THREE.Group();
    const centerRoot = new THREE.Group();
    const forwardRoot = new THREE.Group();
    const axisRoot = new THREE.Group();
    modelFrame.name = 'fighter-normalized-frame';
    centerRoot.name = 'fighter-centered-pivot';
    forwardRoot.name = 'fighter-forward-orientation';
    axisRoot.name = 'fighter-length-axis-normalization';
    modelFrame.add(centerRoot);
    centerRoot.add(forwardRoot);
    forwardRoot.add(axisRoot);
    axisRoot.add(model);

    let bounds = localBounds(model, modelFrame);
    const rawSize = bounds.getSize(new THREE.Vector3());
    if (rawSize.x >= rawSize.y && rawSize.x >= rawSize.z) axisRoot.rotation.y = -Math.PI * 0.5;
    else if (rawSize.y >= rawSize.z) axisRoot.rotation.x = Math.PI * 0.5;

    bounds = localBounds(model, modelFrame);
    const center = bounds.getCenter(new THREE.Vector3());
    let thrusterZ = 0;
    let validThrusters = 0;
    for (const node of this.thrusterNodes) {
      const nodeBounds = localBounds(node, modelFrame);
      if (nodeBounds.isEmpty()) continue;
      thrusterZ += nodeBounds.getCenter(new THREE.Vector3()).z;
      validThrusters += 1;
    }
    if (validThrusters > 0 && thrusterZ / validThrusters < center.z) {
      forwardRoot.rotation.y = Math.PI;
      bounds = localBounds(model, modelFrame);
    }

    const finalSize = bounds.getSize(new THREE.Vector3());
    const finalCenter = bounds.getCenter(new THREE.Vector3());
    if (!Number.isFinite(finalSize.z) || finalSize.z < 0.0001) {
      throw new Error('Star Sparrow model produced invalid runtime bounds.');
    }
    centerRoot.position.copy(finalCenter).multiplyScalar(-1);
    // Preserve the authored 32.78 : 13.62 : 1.01 proportions. Earlier passes
    // forced independent width/height targets, visibly stretching the supplied
    // model. A single scale now makes the ship pad-sized without distortion.
    const uniformScale = this.targetLength / finalSize.z;
    // The animation hierarchy retains an assembly-travel envelope after
    // posing, so the visible completed hull occupies only a fraction of the
    // measured length. A blind 10x correction spanned multiple pads; 5x still
    // read oversized in live play, so the accepted uniform correction is 4x.
    // Keep the gameplay footprint at 28.5 m.
    modelFrame.scale.setScalar(uniformScale * this.visibleScaleCorrection);
    modelFrame.position.set(
      -OCCUPIED_FOOTPRINT_CENTER_X_PER_LENGTH * this.targetLength,
      0,
      -OCCUPIED_FOOTPRINT_CENTER_Z_PER_LENGTH * this.targetLength,
    );
    this.dimensions.set(
      finalSize.x * uniformScale,
      finalSize.y * uniformScale,
      this.targetLength,
    );
    this.radius = this.dimensions.length() * 0.5;
    this.updateCollisionProxy();
    this.updateEffectScale();
    return modelFrame;
  }

  private createAuthoredSockets(): void {
    for (const socket of [...this.weaponSockets, ...this.thrusterSockets]) socket.removeFromParent();
    this.weaponSockets.length = 0;
    this.thrusterSockets.length = 0;

    for (const [index, node] of this.weaponNodes.entries()) {
      const bounds = localBounds(node, this.root);
      if (bounds.isEmpty()) continue;
      const socket = new THREE.Object3D();
      socket.name = `fighter-weapon-socket-${index + 1}`;
      socket.position.copy(bounds.getCenter(new THREE.Vector3()));
      socket.position.z = bounds.min.z - 0.025;
      socket.userData = { fighterWeaponSocket: true, sourceNode: node.name, forwardAxis: '-Z' };
      this.weaponSockets.push(socket);
      this.root.add(socket);
    }
    this.weaponSockets.sort((left, right) => left.position.x - right.position.x);

    for (const [index, node] of this.thrusterNodes.entries()) {
      const bounds = localBounds(node, this.root);
      if (bounds.isEmpty()) continue;
      const socket = new THREE.Object3D();
      socket.name = `fighter-thruster-socket-${index + 1}`;
      socket.position.copy(bounds.getCenter(new THREE.Vector3()));
      socket.position.z = bounds.max.z + 0.015;
      socket.userData = { fighterThrusterSocket: true, sourceNode: node.name, exhaustAxis: '+Z' };
      this.thrusterSockets.push(socket);
      this.root.add(socket);
    }
    this.thrusterSockets.sort((left, right) => left.position.x - right.position.x);
    this.thrusterOffsets.length = 0;
    for (const socket of this.thrusterSockets.slice(0, MAX_THRUSTER_INSTANCES)) {
      this.thrusterOffsets.push(socket.position.clone());
    }
    if (this.thrusterOffsets.length === 0) this.setDefaultThrusterOffsets();
  }

  /**
   * The supplied fighter is a modular one-material GLB with 32 rigid mesh
   * nodes. Its assembly pose is fixed during ordinary play, so submitting each
   * module separately made four parked ships cost roughly 128 draws. Bake the
   * posed nodes into one mesh per material while retaining the detached source
   * hierarchy for authored socket bounds and animation metadata.
   */
  private createStaticRenderBatch(modelFrame: THREE.Group): THREE.Group {
    this.root.updateWorldMatrix(true, true);
    const rootInverse = this.root.matrixWorld.clone().invert();
    const transform = new THREE.Matrix4();
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

    modelFrame.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      for (const attribute of Object.keys(geometry.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attribute)) geometry.deleteAttribute(attribute);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      if (!geometry.getAttribute('uv')) {
        const positions = geometry.getAttribute('position');
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.count * 2), 2));
      }
      for (const attributeName of ['position', 'normal', 'uv']) {
        const attribute = geometry.getAttribute(attributeName);
        const values = new Float32Array(attribute.count * attribute.itemSize);
        for (let index = 0; index < attribute.count; index += 1) {
          const offset = index * attribute.itemSize;
          values[offset] = attribute.getX(index);
          if (attribute.itemSize > 1) values[offset + 1] = attribute.getY(index);
          if (attribute.itemSize > 2) values[offset + 2] = attribute.getZ(index);
          if (attribute.itemSize > 3) values[offset + 3] = attribute.getW(index);
        }
        geometry.setAttribute(attributeName, new THREE.Float32BufferAttribute(values, attribute.itemSize));
      }
      transform.multiplyMatrices(rootInverse, mesh.matrixWorld);
      geometry.applyMatrix4(transform);
      const materialGeometries = groups.get(mesh.material) ?? [];
      materialGeometries.push(geometry);
      groups.set(mesh.material, materialGeometries);
    });

    const batch = new THREE.Group();
    batch.name = 'fighter-static-render-batch';
    for (const [material, geometries] of groups) {
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      this.ownedGeometries.push(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = 'fighter-static-material-batch';
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      mesh.userData.fighterVisualMesh = true;
      batch.add(mesh);
    }
    if (batch.children.length === 0) throw new Error('Star Sparrow render batching produced no visible geometry.');
    return batch;
  }

  private updateCollisionProxy(): void {
    this.collisionHalfExtents.set(
      this.dimensions.x * 0.39,
      this.dimensions.y * 0.42,
      this.dimensions.z * 0.43,
    );
    this.collisionProxy.scale.copy(this.collisionHalfExtents).multiplyScalar(2);
    this.collisionProxy.userData = {
      collisionProxy: true,
      role: 'fighter-physics-proxy',
      shape: 'oriented-box',
      forwardAxis: '-Z',
      halfExtents: {
        x: this.collisionHalfExtents.x,
        y: this.collisionHalfExtents.y,
        z: this.collisionHalfExtents.z,
      },
      boundingRadius: this.radius,
    };
  }

  private updateEffectScale(): void {
    this.shieldMesh.scale.set(
      this.dimensions.x * 0.56,
      this.dimensions.y * 0.68,
      this.dimensions.z * 0.54,
    );
  }

  private setDefaultThrusterOffsets(): void {
    this.thrusterOffsets.length = 0;
    for (const x of [-0.34, -0.17, 0, 0.17, 0.34]) {
      this.thrusterOffsets.push(new THREE.Vector3(
        this.dimensions.x * x,
        -this.dimensions.y * 0.08,
        this.dimensions.z * 0.49,
      ));
    }
  }

  private updateEngineInstances(intensity: number, boost: number): void {
    const count = Math.min(this.thrusterOffsets.length, MAX_THRUSTER_INSTANCES);
    const glowRadius = Math.max(0.055, this.dimensions.y * (0.075 + intensity * 0.02));
    const trailLength = this.dimensions.z * intensity * (0.075 + boost * 0.095);
    for (let index = 0; index < count; index += 1) {
      const offset = this.thrusterOffsets[index];
      this.matrixPosition.copy(offset);
      this.matrixScale.setScalar(glowRadius / 0.13);
      this.matrix.compose(this.matrixPosition, this.identityRotation, this.matrixScale);
      this.engineGlows.setMatrixAt(index, this.matrix);

      this.matrixPosition.copy(offset);
      this.matrixPosition.z += trailLength * 0.48;
      this.matrixScale.set(
        0.7 + boost * 0.25,
        Math.max(0.001, trailLength),
        0.7 + boost * 0.25,
      );
      this.matrix.compose(this.matrixPosition, this.trailRotation, this.matrixScale);
      this.engineTrails.setMatrixAt(index, this.matrix);
    }
    this.engineGlows.count = count;
    this.engineTrails.count = count;
    this.engineGlows.instanceMatrix.needsUpdate = true;
    this.engineTrails.instanceMatrix.needsUpdate = true;
  }

  private createFallback(): { root: THREE.Group; signal: THREE.MeshStandardMaterial } {
    const root = new THREE.Group();
    root.name = 'fighter-loading-fallback';
    root.userData.loadingFallback = true;
    root.scale.setScalar(this.targetLength / DEFAULT_LENGTH_METERS);
    const shell = new THREE.MeshStandardMaterial({
      color: 0x13252e,
      metalness: 0.74,
      roughness: 0.34,
    });
    const signal = new THREE.MeshStandardMaterial({
      color: 0x65e8ff,
      emissive: 0x65e8ff,
      emissiveIntensity: 0.55,
      metalness: 0.35,
      roughness: 0.22,
    });
    this.ownedMaterials.push(shell, signal);

    const hullGeometry = new THREE.ConeGeometry(0.72, 6.2, 5);
    hullGeometry.rotateX(-Math.PI * 0.5);
    const wingGeometry = new THREE.BoxGeometry(3.35, 0.12, 2.65);
    const canopyGeometry = new THREE.SphereGeometry(0.52, 10, 6);
    const engineGeometry = new THREE.CylinderGeometry(0.2, 0.28, 0.68, 8);
    engineGeometry.rotateX(-Math.PI * 0.5);
    this.ownedGeometries.push(hullGeometry, wingGeometry, canopyGeometry, engineGeometry);

    const hull = new THREE.Mesh(hullGeometry, shell);
    hull.scale.set(1.22, 0.62, 1);
    const wing = new THREE.Mesh(wingGeometry, shell);
    wing.position.z = 0.45;
    const canopy = new THREE.Mesh(canopyGeometry, signal);
    canopy.position.set(0, 0.45, -0.75);
    canopy.scale.set(0.76, 0.42, 1.45);
    root.add(hull, wing, canopy);
    for (const x of [-0.62, 0, 0.62]) {
      const engine = new THREE.Mesh(engineGeometry, signal);
      engine.position.set(x, -0.08, 3.05);
      root.add(engine);
    }
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
    });
    return { root, signal };
  }
}

/** Computes an exact mesh AABB in another object's local coordinate system. */
function localBounds(target: THREE.Object3D, relativeRoot: THREE.Object3D): THREE.Box3 {
  relativeRoot.updateWorldMatrix(true, true);
  target.updateWorldMatrix(true, true);
  const inverseRoot = new THREE.Matrix4().copy(relativeRoot.matrixWorld).invert();
  const objectToRoot = new THREE.Matrix4();
  const corner = new THREE.Vector3();
  const bounds = new THREE.Box3().makeEmpty();
  target.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const geometryBounds = mesh.geometry.boundingBox;
    if (!geometryBounds) return;
    objectToRoot.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    for (const x of [geometryBounds.min.x, geometryBounds.max.x]) {
      for (const y of [geometryBounds.min.y, geometryBounds.max.y]) {
        for (const z of [geometryBounds.min.z, geometryBounds.max.z]) {
          corner.set(x, y, z).applyMatrix4(objectToRoot);
          bounds.expandByPoint(corner);
        }
      }
    }
  });
  return bounds;
}
