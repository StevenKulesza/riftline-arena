import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from './assetUrl';

export const SCIFI_DRONE_MODEL_URL = assetUrl('assets/models/scifi-drone.glb');

/** Verified from the supplied GLB's embedded glTF manifest. */
export const SCIFI_DRONE_DIAGNOSTICS = Object.freeze({
  fileSizeBytes: 3_205_288,
  triangleCount: 28_100,
  meshCount: 4,
  materialCount: 4,
  textureCount: 13,
  animationClipCount: 0,
  sourceAuthor: 'Doverlock',
  sourceTitle: 'Scifi Drone',
  sourceLicense: 'CC BY 4.0',
  sourceUrl: 'https://sketchfab.com/3d-models/scifi-drone-290de0f82e9e4e4b9a8ae6524311a8db',
});

export type ScifiDroneAsset = {
  scene: THREE.Group;
  animations: readonly THREE.AnimationClip[];
};

let cachedAsset: Promise<ScifiDroneAsset> | undefined;

export function loadScifiDroneAsset(): Promise<ScifiDroneAsset> {
  cachedAsset ??= new GLTFLoader().loadAsync(SCIFI_DRONE_MODEL_URL).then((gltf) => ({
    scene: gltf.scene,
    animations: gltf.animations,
  }));
  return cachedAsset;
}

export function cloneScifiDroneScene(asset: ScifiDroneAsset): THREE.Group {
  return cloneSkeleton(asset.scene) as THREE.Group;
}
