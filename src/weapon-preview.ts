import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createWeaponViewModel } from './assets/WeaponViewModel';
import { WEAPONS, type WeaponId } from './game/config';

const canvas = document.querySelector<HTMLCanvasElement>('#weapon-preview');
if (!canvas) throw new Error('Missing weapon preview canvas.');

const previewParams = new URLSearchParams(window.location.search);
const requested = previewParams.get('weapon') as WeaponId | null;
const heroView = previewParams.get('view') === 'hero';
const definition = WEAPONS.find((weapon) => weapon.id === requested) ?? WEAPONS[0];
const label = document.querySelector<HTMLElement>('#label strong');
if (label) label.textContent = definition.name;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171b21);
const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

scene.add(new THREE.HemisphereLight(0xaad9ff, 0x14171b, 0.92));
const key = new THREE.DirectionalLight(0xffffff, 4.2);
key.position.set(-3.5, 4.5, 4.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.00015;
scene.add(key);
key.intensity = 2.8;
const rim = new THREE.DirectionalLight(definition.color, 1.55);
rim.position.set(4, 1.5, -3);
scene.add(rim);
const fill = new THREE.DirectionalLight(0x9bbcff, 0.82);
fill.position.set(1, -2.5, 4);
scene.add(fill);

const visual = createWeaponViewModel(definition, false, false);
window.__WEAPON_PREVIEW_DIAGNOSTICS__ = {
  weapon: visual.weapon,
  pulseIntensity: visual.pulseMaterials.reduce(
    (maximum, material) => Math.max(maximum, material.emissiveIntensity),
    0,
  ),
  pulseMetalness: visual.pulseMaterials.map((material) => material.metalness),
  texturedPulseMaterials: visual.pulseMaterials.filter(
    (material) => Boolean(material.map && material.roughnessMap && material.normalMap && material.metalnessMap),
  ).length,
};
visual.root.traverse((object) => {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh) return;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
});
visual.root.rotation.y = heroView ? Math.PI * 0.37 : Math.PI * 0.5;
visual.root.rotation.x = heroView ? -0.055 : 0;
visual.root.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(visual.root);
const center = bounds.getCenter(new THREE.Vector3());
visual.root.position.sub(center);
visual.root.updateMatrixWorld(true);
const size = new THREE.Box3().setFromObject(visual.root).getSize(new THREE.Vector3());
scene.add(visual.root);

const horizontalFov = THREE.MathUtils.degToRad(camera.fov) * 16 / 9;
const distanceForWidth = size.x / (2 * Math.tan(horizontalFov * 0.5));
const distanceForHeight = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
camera.position.set(0, size.y * 0.025, Math.max(distanceForWidth, distanceForHeight) * 1.28);
camera.lookAt(0, 0, 0);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(size.x * 1.65, size.x * 0.7),
  new THREE.MeshStandardMaterial({ color: 0x252b32, roughness: 0.92, metalness: 0.06 }),
);
floor.rotation.x = -Math.PI * 0.5;
floor.position.y = -size.y * 0.58;
floor.receiveShadow = true;
scene.add(floor);

function resize(): void {
  const width = canvas!.clientWidth;
  const height = canvas!.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

function render(): void {
  resize();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

window.__WEAPON_PREVIEW_READY__ = true;
render();
