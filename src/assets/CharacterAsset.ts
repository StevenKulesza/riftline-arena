import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from './assetUrl';

export type CharacterAssetDiagnostics = {
  source: 'combat-trooper';
  sourceMeshCount: number;
  runtimeSkinnedMeshCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  sourceHadSkeleton: false;
  sourceAnimationCount: 0;
  runtimeBoneCount: number;
  runtimeAnimationCount: number;
  normalizedHeight: number;
  sourceBounds: Readonly<{ x: number; y: number; z: number }>;
  normalizationScale: number;
};

export type CharacterAsset = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  diagnostics: CharacterAssetDiagnostics;
};

export const CHARACTER_MODEL_HEIGHT = 1.78;
export const CHARACTER_MODEL_URL = assetUrl('assets/models/combat-trooper.glb');

// The supplied combat trooper is a beautifully textured static T-pose. The
// previous SWAT asset remains a motion donor only: its rendered meshes never
// enter the scene, but its stable humanoid hierarchy and 24 authored clips let
// the new model use real skeletal deformation instead of rigid limb wobble.
const MOTION_DONOR_URL = assetUrl('assets/models/quaternius-swat.glb');

type BoneRole =
  | 'hips' | 'abdomen' | 'torso' | 'chest' | 'neck' | 'head'
  | 'upperArmL' | 'lowerArmL' | 'wristL'
  | 'upperArmR' | 'lowerArmR' | 'wristR'
  | 'upperLegL' | 'lowerLegL' | 'footL'
  | 'upperLegR' | 'lowerLegR' | 'footR';

const BONE_NAMES: Record<BoneRole, string> = {
  hips: 'Hips',
  abdomen: 'Abdomen',
  torso: 'Torso',
  chest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  upperArmL: 'UpperArmL',
  lowerArmL: 'LowerArmL',
  wristL: 'WristL',
  upperArmR: 'UpperArmR',
  lowerArmR: 'LowerArmR',
  wristR: 'WristR',
  upperLegL: 'UpperLegL',
  lowerLegL: 'LowerLegL',
  footL: 'FootL',
  upperLegR: 'UpperLegR',
  lowerLegR: 'LowerLegR',
  footR: 'FootR',
};

type SkinInfluence = readonly [BoneRole, number];

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Builds stable two-bone weights from the supplied model's known T-pose.
 * The zones overlap at every major joint so armor bends continuously instead
 * of shearing at hard coordinate cuts.
 */
function classifyVertex(x: number, y: number, materialName: string): SkinInfluence[] {
  const role = materialName.toLowerCase();
  const side = x >= 0 ? 'L' : 'R';
  const absoluteX = Math.abs(x);

  if (role.includes('helmet') || (y > 1.51 && absoluteX < 0.24)) return [['head', 1]];

  // The main body material contains the full hands and forearms. Some glove
  // fingertips dip below the donor wrist height, so Y-only classification
  // incorrectly attached them to the hips and left long spikes in motion.
  const authoredArmEnvelope = role.includes('material') && absoluteX > 0.205;
  if (authoredArmEnvelope || (absoluteX > 0.235 && y > 0.88)) {
    const upper = `upperArm${side}` as BoneRole;
    const lower = `lowerArm${side}` as BoneRole;
    const wrist = `wrist${side}` as BoneRole;
    const elbowBlend = smoothstep(0.38, 0.46, absoluteX);
    const wristBlend = smoothstep(0.55, 0.65, absoluteX);
    if (wristBlend > 0) return [[lower, 1 - wristBlend], [wrist, wristBlend]];
    return [[upper, 1 - elbowBlend], [lower, elbowBlend]];
  }

  if (y < 0.91 || role.includes('pants')) {
    const upper = `upperLeg${side}` as BoneRole;
    const lower = `lowerLeg${side}` as BoneRole;
    const foot = `foot${side}` as BoneRole;
    const kneeBlend = smoothstep(0.39, 0.55, y);
    const ankleBlend = 1 - smoothstep(0.12, 0.24, y);
    if (ankleBlend > 0) return [[lower, 1 - ankleBlend], [foot, ankleBlend]];
    return [[lower, 1 - kneeBlend], [upper, kneeBlend]];
  }

  if (y < 1.02) {
    const blend = smoothstep(0.9, 1.02, y);
    return [['hips', 1 - blend], ['abdomen', blend]];
  }
  if (y < 1.22) {
    const blend = smoothstep(1.02, 1.22, y);
    return [['abdomen', 1 - blend], ['torso', blend]];
  }
  if (y < 1.42) {
    const blend = smoothstep(1.22, 1.42, y);
    return [['torso', 1 - blend], ['chest', blend]];
  }
  if (y < 1.54) {
    const blend = smoothstep(1.42, 1.54, y);
    return [['chest', 1 - blend], ['neck', blend]];
  }
  const headBlend = smoothstep(1.54, 1.64, y);
  return [['neck', 1 - headBlend], ['head', headBlend]];
}

function addProceduralSkinAttributes(
  geometry: THREE.BufferGeometry,
  skeleton: THREE.Skeleton,
  materialName: string,
): void {
  const positions = geometry.getAttribute('position');
  const boneIndices = new Map(skeleton.bones.map((bone, index) => [bone.name, index]));
  const skinIndices = new Uint16Array(positions.count * 4);
  const skinWeights = new Float32Array(positions.count * 4);

  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    const influences = classifyVertex(
      positions.getX(vertex),
      positions.getY(vertex),
      materialName,
    );
    let total = 0;
    for (let slot = 0; slot < influences.length && slot < 4; slot += 1) {
      const [role, weight] = influences[slot];
      skinIndices[vertex * 4 + slot] = boneIndices.get(BONE_NAMES[role]) ?? 0;
      skinWeights[vertex * 4 + slot] = weight;
      total += weight;
    }
    if (total <= 0) {
      skinIndices[vertex * 4] = boneIndices.get(BONE_NAMES.hips) ?? 0;
      skinWeights[vertex * 4] = 1;
    } else if (Math.abs(total - 1) > 1e-5) {
      for (let slot = 0; slot < 4; slot += 1) skinWeights[vertex * 4 + slot] /= total;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
}

/**
 * The supplied trooper's static bind pose has long, wide A-pose arms, while
 * the donor skeleton's bind pose keeps its elbows close to the torso. Skinning
 * the untouched vertices therefore rotates them around joints that can be
 * 30–40 cm away and produces the familiar stretched "rubber arm" artifact.
 * Repose only the arm envelope onto the donor's measured bind chain before
 * binding. The original cross-section, armor plates, UVs, normals and all six
 * authored materials remain untouched.
 */
function warpArmsToDonorBindPose(geometry: THREE.BufferGeometry, materialName: string): void {
  if (!materialName.toLowerCase().includes('material')) return;
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const worldUp = new THREE.Vector3(0, 1, 0);
  const source = new THREE.Vector3();
  const target = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const up = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const warped = new THREE.Vector3();

  const sourceShoulderX = 0.205;
  const sourceElbowX = 0.42;
  const sourceWristX = 0.68;
  const sourceShoulderY = 1.37;
  const sourceElbowY = 1.17;
  const sourceWristY = 1.025;
  const sourceCenterZ = 0.01;
  const targets = {
    L: [
      new THREE.Vector3(0.1571, 1.4105, 0.0908),
      new THREE.Vector3(0.227, 1.253, 0.0326),
      new THREE.Vector3(0.2604, 1.0202, 0.0409),
    ],
    R: [
      new THREE.Vector3(-0.148, 1.41, 0.0894),
      new THREE.Vector3(-0.2282, 1.2518, 0.049),
      new THREE.Vector3(-0.2249, 1.0369, 0.1448),
    ],
  } as const;

  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    source.fromBufferAttribute(positions, vertex);
    const absoluteX = Math.abs(source.x);
    if (absoluteX <= sourceShoulderX || source.y <= 0.78) continue;
    const side = source.x >= 0 ? 'L' : 'R';
    const chain = targets[side];
    const firstSegment = absoluteX <= sourceElbowX;
    const segmentStartX = firstSegment ? sourceShoulderX : sourceElbowX;
    const segmentEndX = firstSegment ? sourceElbowX : sourceWristX;
    const t = THREE.MathUtils.clamp((absoluteX - segmentStartX) / (segmentEndX - segmentStartX), 0, 1);
    const sourceStartY = firstSegment ? sourceShoulderY : sourceElbowY;
    const sourceEndY = firstSegment ? sourceElbowY : sourceWristY;
    const sourceCenterY = THREE.MathUtils.lerp(sourceStartY, sourceEndY, t);
    const targetStart = firstSegment ? chain[0] : chain[1];
    const targetEnd = firstSegment ? chain[1] : chain[2];
    target.lerpVectors(targetStart, targetEnd, t);
    tangent.subVectors(targetEnd, targetStart).normalize();
    up.copy(worldUp).addScaledVector(tangent, -worldUp.dot(tangent)).normalize();
    forward.crossVectors(tangent, up).normalize();
    if (forward.z < 0) forward.negate();

    const verticalOffset = source.y - sourceCenterY;
    const forwardOffset = source.z - sourceCenterZ;
    warped.copy(target)
      .addScaledVector(up, verticalOffset)
      .addScaledVector(forward, forwardOffset);
    // Blend the shoulder cap across its first 6 cm to preserve the authored
    // torso seam and avoid a hard crease under the pauldron.
    source.lerp(warped, smoothstep(sourceShoulderX, sourceShoulderX + 0.06, absoluteX));
    positions.setXYZ(vertex, source.x, source.y, source.z);
  }
  positions.needsUpdate = true;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return Math.floor((geometry.index?.count ?? geometry.getAttribute('position').count) / 3);
}

function buildRuntimeRig(
  combatScene: THREE.Group,
  donorScene: THREE.Group,
  donorAnimations: THREE.AnimationClip[],
): CharacterAsset {
  const rigged = cloneSkeleton(donorScene) as THREE.Group;
  rigged.name = 'combat-trooper-runtime-rig';
  rigged.updateMatrixWorld(true);
  const donorMesh = rigged.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
  if (!donorMesh) throw new Error('Combat trooper motion donor has no humanoid skeleton.');
  // Keep the animated donor bones but recalculate inverse binds in the runtime
  // rig's root space. Reusing the donor mesh's centimeter/Z-up bind matrix on
  // normalized Y-up vertices creates catastrophic full-screen triangles.
  const skeleton = new THREE.Skeleton(donorMesh.skeleton.bones);
  skeleton.calculateInverses();

  // Strip every legacy rendered surface while keeping the donor bone tree.
  const donorMeshes: THREE.Object3D[] = [];
  rigged.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) donorMeshes.push(object);
  });
  for (const mesh of donorMeshes) mesh.removeFromParent();

  combatScene.updateMatrixWorld(true);
  // Sketchfab already stores the source's Z-up correction on its authored
  // root matrix. Bake that hierarchy exactly once through matrixWorld.
  const sourceBounds = new THREE.Box3().setFromObject(combatScene);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
  const scale = CHARACTER_MODEL_HEIGHT / sourceSize.y;
  const normalize = new THREE.Matrix4()
    .makeTranslation(0, 0, 0.08)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .multiply(new THREE.Matrix4().makeTranslation(-sourceCenter.x, -sourceBounds.min.y, -sourceCenter.z));

  let runtimeSkinnedMeshCount = 0;
  let triangles = 0;
  const uniqueMaterials = new Set<THREE.Material>();
  const uniqueTextures = new Set<THREE.Texture>();

  combatScene.traverse((object) => {
    const sourceMesh = object as THREE.Mesh;
    if (!sourceMesh.isMesh || !sourceMesh.geometry) return;
    const geometry = sourceMesh.geometry.clone();
    geometry.applyMatrix4(normalize.clone().multiply(sourceMesh.matrixWorld));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const materials = Array.isArray(sourceMesh.material) ? sourceMesh.material : [sourceMesh.material];
    const materialName = materials.map((material) => material.name).join(' ');
    addProceduralSkinAttributes(geometry, skeleton, materialName);
    warpArmsToDonorBindPose(geometry, materialName);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const skinned = new THREE.SkinnedMesh(geometry, sourceMesh.material);
    skinned.name = `combat-trooper-${sourceMesh.name || runtimeSkinnedMeshCount}`;
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    skinned.frustumCulled = false;
    rigged.add(skinned);
    skinned.bind(skeleton, new THREE.Matrix4());

    triangles += triangleCount(geometry);
    runtimeSkinnedMeshCount += 1;
    for (const material of materials) {
      uniqueMaterials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) uniqueTextures.add(value);
      }
    }
  });

  rigged.updateMatrixWorld(true);
  const clips = donorAnimations.map((clip) => clip.clone().optimize());
  return {
    scene: rigged,
    animations: clips,
    diagnostics: {
      source: 'combat-trooper',
      sourceMeshCount: runtimeSkinnedMeshCount,
      runtimeSkinnedMeshCount,
      triangleCount: triangles,
      materialCount: uniqueMaterials.size,
      textureCount: uniqueTextures.size,
      sourceHadSkeleton: false,
      sourceAnimationCount: 0,
      runtimeBoneCount: skeleton.bones.length,
      runtimeAnimationCount: clips.length,
      normalizedHeight: CHARACTER_MODEL_HEIGHT,
      sourceBounds: { x: sourceSize.x, y: sourceSize.y, z: sourceSize.z },
      normalizationScale: scale,
    },
  };
}

// Player and bots clone one immutable, cached runtime-rig source. The two GLBs
// are decoded exactly once behind the deployment screen.
const characterAssetPromise = Promise.all([
  new GLTFLoader().loadAsync(CHARACTER_MODEL_URL),
  new GLTFLoader().loadAsync(MOTION_DONOR_URL),
]).then(([combat, donor]) => buildRuntimeRig(combat.scene, donor.scene, donor.animations));

export function loadCharacterAsset(): Promise<CharacterAsset> {
  return characterAssetPromise;
}
