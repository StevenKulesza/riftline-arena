import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GRENADE } from '../game/config';
import { assetUrl } from './assetUrl';

export const GRENADE_MODEL_URL = assetUrl('assets/models/a-star-wars-grenade.glb');

/**
 * Loads the authored grenade and normalizes its Sketchfab scene hierarchy to
 * Riftline's existing collision diameter. The wrapper keeps the imported
 * model centered even though the source GLB has an offset root transform.
 */
export async function loadGrenadeAsset(): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(GRENADE_MODEL_URL);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error('Grenade GLB has no renderable bounds.');
  }

  const center = bounds.getCenter(new THREE.Vector3());
  gltf.scene.position.sub(center);

  const root = new THREE.Group();
  root.name = 'a-star-wars-grenade-source';
  root.scale.setScalar((GRENADE.radius * 2) / maxDimension);
  root.add(gltf.scene);
  root.traverse((object) => {
    object.frustumCulled = false;
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  return root;
}
