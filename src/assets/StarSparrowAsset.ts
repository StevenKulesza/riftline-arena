import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from './assetUrl';

export const STAR_SPARROW_MODEL_URL = assetUrl('assets/models/star-sparrow-modular-spaceship.glb');

/** Verified directly from the supplied GLB container and its glTF JSON chunk. */
export const STAR_SPARROW_DIAGNOSTICS = Object.freeze({
  fileSizeBytes: 1_935_760,
  triangleCount: 3_296,
  meshCount: 32,
  materialCount: 1,
  textureCount: 5,
  animationClipCount: 1,
  animationName: 'Animation',
  animationDurationSeconds: 9.333333015441895,
  sourceAuthor: 'Ebal Studios',
  sourceTitle: 'Star Sparrow Modular Spaceship',
  sourceLicense: 'Sketchfab Standard License',
  sourceUrl: 'https://sketchfab.com/3d-models/star-sparrow-modular-spaceship-28806b168f8043bbb5c1c922f98452c9',
});

export type StarSparrowAsset = {
  scene: THREE.Group;
  animations: readonly THREE.AnimationClip[];
};

let cachedAsset: Promise<StarSparrowAsset> | undefined;

/**
 * Lazily fetches and parses the GLB once. Instances clone this immutable source,
 * so spawning several pad fighters does not repeat texture decode or network IO.
 */
export function loadStarSparrowAsset(): Promise<StarSparrowAsset> {
  cachedAsset ??= new GLTFLoader().loadAsync(STAR_SPARROW_MODEL_URL).then((gltf) => ({
    scene: gltf.scene,
    animations: gltf.animations,
  }));
  return cachedAsset;
}

/** Skeleton-safe today and future-proof if a later fighter revision adds rigs. */
export function cloneStarSparrowScene(asset: StarSparrowAsset): THREE.Group {
  return cloneSkeleton(asset.scene) as THREE.Group;
}
