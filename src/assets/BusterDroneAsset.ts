import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from './assetUrl';

export const BUSTER_DRONE_MODEL_URL = assetUrl('assets/models/buster-drone.glb');

/** Verified from the supplied binary glTF manifest on 2026-08-31. */
export const BUSTER_DRONE_DIAGNOSTICS = Object.freeze({
  fileSizeBytes: 15_241_508,
  triangleCount: 32_720,
  nodeCount: 92,
  meshCount: 39,
  materialCount: 3,
  textureCount: 10,
  animationClipCount: 1,
  animationClipNames: ['Start_Liftoff'] as const,
  animationDurationSeconds: 25,
  animatedChannelCount: 100,
  rigType: 'authored-transform-hierarchy' as const,
  sourceAuthor: 'LaVADraGoN',
  sourceModelCredit: 'Evil Cloud',
  sourceTitle: 'Buster Drone',
  sourceLicense: 'CC BY 4.0',
  sourceUrl: 'https://sketchfab.com/3d-models/buster-drone-294e79652f494130ad2ab00a13fdbafd',
});

export type BusterDroneAsset = {
  scene: THREE.Group;
  animations: readonly THREE.AnimationClip[];
};

let cachedAsset: Promise<BusterDroneAsset> | undefined;

export function loadBusterDroneAsset(): Promise<BusterDroneAsset> {
  cachedAsset ??= new GLTFLoader().loadAsync(BUSTER_DRONE_MODEL_URL).then((gltf) => ({
    scene: gltf.scene,
    animations: gltf.animations,
  }));
  return cachedAsset;
}

export function cloneBusterDroneScene(asset: BusterDroneAsset): THREE.Group {
  return cloneSkeleton(asset.scene) as THREE.Group;
}
