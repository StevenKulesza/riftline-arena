import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildMonsoonRockField, createMonsoonRockGeometry, ROCK_ARCHETYPES } from '../src/game/maps/MonsoonRockField';
import { buildMonsoonTerrainGeometry, sampleMonsoonMeshHeight } from '../src/game/maps/MonsoonDivide';

const seed = 450600;
const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas')!, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.03;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9aafb0);
scene.fog = new THREE.Fog(0x9aafb0, 200, 1200);
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 8000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = new RoomEnvironment();
scene.environment = pmrem.fromScene(environment, 0.03).texture;
scene.environmentIntensity = 0.7;
environment.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xb8dce8, 0x1f3126, 0.76));
scene.add(new THREE.AmbientLight(0x6f8792, 0.075));
const key = new THREE.DirectionalLight(0xffe1b7, 3.65);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -100;
key.shadow.camera.right = key.shadow.camera.top = 100;
key.shadow.camera.near = 1; key.shadow.camera.far = 600;
key.shadow.normalBias = 0.04;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0x78a9c4, 0.31);
fill.position.set(-250, 184, -330); scene.add(fill);

const field = buildMonsoonRockField(seed);
scene.add(field.group);
const terrain = new THREE.Mesh(buildMonsoonTerrainGeometry(seed).geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
terrain.receiveShadow = true; scene.add(terrain);
const families = new THREE.Group();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 70), new THREE.MeshStandardMaterial({ color: 0x596653, roughness: 0.97 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; families.add(floor);
ROCK_ARCHETYPES.forEach((_, archetype) => {
  for (let variant = 0; variant < 2; variant += 1) {
    const geometry = createMonsoonRockGeometry(archetype, variant, 0);
    const mesh = new THREE.Mesh(geometry, field.material);
    const size = variant === 0 ? 4.8 : 2.3;
    mesh.scale.setScalar(size);
    mesh.position.set((archetype % 3 - 1) * 19 + variant * 6, -geometry.boundingBox!.min.y * size - 0.5, Math.floor(archetype / 3) * 20 - 10);
    mesh.rotation.y = archetype * 0.3;
    mesh.castShadow = mesh.receiveShadow = true;
    families.add(mesh);
  }
});
families.visible = false; scene.add(families);
const anchors = field.rocks.filter((rock) => rock.tier === 'anchor');
let index = 0;
let activeView = 'field';

function render(): void { renderer.render(scene, camera); }
function setView(view: string): void {
  if (view === 'next') { index = (index + 1) % anchors.length; view = activeView === 'families' ? 'field' : activeView; }
  activeView = view;
  const catalog = view === 'families';
  field.group.visible = terrain.visible = !catalog;
  families.visible = catalog;
  const anchor = anchors[index];
  const target = catalog ? new THREE.Vector3(0, 2, 0) : anchor.position.clone();
  if (catalog) camera.position.set(48, 42, 66);
  else {
    const groundView = view === 'ground';
    camera.position.set(target.x + (groundView ? 24 : 44), 0, target.z + (groundView ? 35 : 66));
    camera.position.y = sampleMonsoonMeshHeight(camera.position.x, camera.position.z, seed) + (groundView ? 2.2 : 28);
    target.y = anchor.bounds.min.y + (anchor.bounds.max.y - anchor.bounds.min.y) * 0.45;
  }
  controls.target.copy(target); camera.lookAt(target); controls.update();
  key.position.copy(target).add(new THREE.Vector3(130, 190, 98)); key.target.position.copy(target);
  key.shadow.needsUpdate = true;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  document.querySelector('#caption')!.textContent = catalog
    ? 'Weathered blocks · bedded slabs · split fins · rounded corestones · talus wedges · broken outcrops'
    : `${ROCK_ARCHETYPES[anchor.archetype]} field ${index + 1} / ${anchors.length} — primary outcrop, broken blocks, cobbles and downhill rubble`;
  const diagnostics = field.diagnostics;
  document.querySelector('#status')!.textContent = `${diagnostics.placedCount.toLocaleString()} rocks · ${diagnostics.triangles.toLocaleString()} total rock triangles · ${diagnostics.drawCalls} instanced batches · same runtime geometry and materials`;
  render();
}
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view!)));
controls.addEventListener('change', render);
function resize(): void { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); render(); }
window.addEventListener('resize', resize);
resize(); setView('field');
