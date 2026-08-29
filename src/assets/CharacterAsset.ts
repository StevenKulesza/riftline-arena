import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type * as THREE from 'three';
import { assetUrl } from './assetUrl';

export type CharacterAsset = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

const CHARACTER_MODEL_URL = assetUrl('assets/models/quaternius-swat.glb');

// Player and bots use the same immutable source asset. Loading it from two
// modules caused two GLB parses and let four skeleton clones install during
// live play. One shared promise keeps decode work single-owner and gives the
// game a stable readiness boundary before its render loop starts.
const characterAssetPromise = new GLTFLoader()
  .loadAsync(CHARACTER_MODEL_URL)
  .then((gltf): CharacterAsset => ({ scene: gltf.scene, animations: gltf.animations }));

export function loadCharacterAsset(): Promise<CharacterAsset> {
  return characterAssetPromise;
}
