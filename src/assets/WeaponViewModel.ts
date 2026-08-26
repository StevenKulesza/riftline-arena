import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponDefinition, WeaponId } from '../game/config';

type MaterialKit = {
  shell: THREE.MeshPhysicalMaterial;
  secondary: THREE.MeshPhysicalMaterial;
  metal: THREE.MeshPhysicalMaterial;
  ceramic: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  hot: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  decal: THREE.MeshBasicMaterial;
};

export type WeaponViewModel = {
  root: THREE.Group;
  muzzleSocket: THREE.Object3D;
  animatedRotors: THREE.Object3D[];
  animatedSlides: THREE.Object3D[];
  animationNodes: Map<string, THREE.Object3D>;
  animationState: {
    lastElapsed: number;
    lastRecoil: number;
    shotAge: number;
    shotStrength: number;
    rotorAngle: number;
    rotorVelocity: number;
  };
  pulseMaterials: THREE.MeshStandardMaterial[];
  pulseBaseIntensities: number[];
  battleWearMaterialCount: number;
  battleWearTextureCount: number;
  assetSource: 'procedural';
  meshCount: number;
  renderMeshCount: number;
  triangleCount: number;
  weapon: WeaponId;
};

type Builder = {
  root: THREE.Group;
  kit: MaterialKit;
  part: (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    rotation?: [number, number, number],
  ) => THREE.Mesh;
  group: (name: string, position?: [number, number, number]) => THREE.Group;
  profile: (
    name: string,
    points: Array<[number, number]>,
    width: number,
    material: THREE.Material,
    x?: number,
  ) => THREE.Mesh;
  animatedRotors: THREE.Object3D[];
  animatedSlides: THREE.Object3D[];
};

const ACCENT_INTENSITY = 0.42;

const WEAPON_PALETTES: Record<WeaponId, { shell: number; secondary: number; metal: number; ceramic: number }> = {
  machine: { shell: 0x050a0e, secondary: 0x13232c, metal: 0x344a54, ceramic: 0x405862 },
  shotgun: { shell: 0x080806, secondary: 0x342217, metal: 0x66533f, ceramic: 0x7b3116 },
  rocket: { shell: 0x33070a, secondary: 0x641018, metal: 0x525b60, ceramic: 0x94171d },
  plasma: { shell: 0x07060a, secondary: 0x170d22, metal: 0x37323f, ceramic: 0x2f1d45 },
  laser: { shell: 0x030907, secondary: 0x0d2618, metal: 0x20342a, ceramic: 0xb8c3ba },
  sniper: { shell: 0x1c1019, secondary: 0x4a1c39, metal: 0x625c67, ceramic: 0x8a2864 },
  rail: { shell: 0x070806, secondary: 0x181915, metal: 0x34362f, ceramic: 0x735015 },
  disc: { shell: 0x5b6469, secondary: 0x778186, metal: 0xaeb7ba, ceramic: 0x42494d },
};

const WEAPON_WEAR_SEEDS: Record<WeaponId, number> = {
  machine: 0x1a2b3c,
  shotgun: 0x2b3c4d,
  rocket: 0x3c4d5e,
  plasma: 0x4d5e6f,
  laser: 0x5e6f70,
  sniper: 0x6f7081,
  rail: 0x708192,
  disc: 0x8192a3,
};

type BattleWearTextures = {
  albedo: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  metalness: THREE.CanvasTexture;
};

function createBattleWearTextures(id: WeaponId): BattleWearTextures {
  const size = 256;
  const albedoCanvas = document.createElement('canvas');
  const roughnessCanvas = document.createElement('canvas');
  const normalCanvas = document.createElement('canvas');
  const metalnessCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = size;
  roughnessCanvas.width = roughnessCanvas.height = size;
  normalCanvas.width = normalCanvas.height = size;
  metalnessCanvas.width = metalnessCanvas.height = size;
  const albedoContext = albedoCanvas.getContext('2d');
  const roughnessContext = roughnessCanvas.getContext('2d');
  const normalContext = normalCanvas.getContext('2d');
  const metalnessContext = metalnessCanvas.getContext('2d');
  if (!albedoContext || !roughnessContext || !normalContext || !metalnessContext) {
    throw new Error('Canvas textures are unavailable.');
  }

  let state = WEAPON_WEAR_SEEDS[id] >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };

  const albedoPixels = albedoContext.createImageData(size, size);
  const roughnessPixels = roughnessContext.createImageData(size, size);
  const normalPixels = normalContext.createImageData(size, size);
  const metalnessPixels = metalnessContext.createImageData(size, size);
  for (let index = 0; index < size * size; index += 1) {
    const albedoGrain = Math.floor(random() * 7) - 3;
    const roughnessGrain = Math.floor(random() * 41) - 20;
    const normalGrainX = Math.floor(random() * 13) - 6;
    const normalGrainY = Math.floor(random() * 13) - 6;
    const metalGrain = Math.floor(random() * 18) - 9;
    const albedoValue = 244 + albedoGrain;
    const roughnessValue = 202 + roughnessGrain;
    for (let channel = 0; channel < 3; channel += 1) {
      albedoPixels.data[index * 4 + channel] = albedoValue;
      roughnessPixels.data[index * 4 + channel] = roughnessValue;
    }
    albedoPixels.data[index * 4 + 3] = 255;
    roughnessPixels.data[index * 4 + 3] = 255;
    normalPixels.data[index * 4] = 128 + normalGrainX;
    normalPixels.data[index * 4 + 1] = 128 + normalGrainY;
    normalPixels.data[index * 4 + 2] = 248;
    normalPixels.data[index * 4 + 3] = 255;
    const metalnessValue = 78 + metalGrain;
    metalnessPixels.data[index * 4] = metalnessValue;
    metalnessPixels.data[index * 4 + 1] = metalnessValue;
    metalnessPixels.data[index * 4 + 2] = metalnessValue;
    metalnessPixels.data[index * 4 + 3] = 255;
  }
  albedoContext.putImageData(albedoPixels, 0, 0);
  roughnessContext.putImageData(roughnessPixels, 0, 0);
  normalContext.putImageData(normalPixels, 0, 0);
  metalnessContext.putImageData(metalnessPixels, 0, 0);

  // Fine directional machining marks break broad highlights into brushed
  // bands. They stay subtle in albedo and do most of their work in roughness
  // and normal response, as real machined metal does.
  for (let y = 2; y < size; y += 4) {
    const alpha = 0.06 + random() * 0.08;
    roughnessContext.fillStyle = `rgba(65, 65, 65, ${alpha})`;
    roughnessContext.fillRect(0, y, size, 1);
    normalContext.fillStyle = `rgba(${116 + Math.floor(random() * 10)}, 132, 248, ${0.18 + random() * 0.18})`;
    normalContext.fillRect(0, y, size, 1);
  }

  // Broad, low-opacity carbon and handling grime breaks up the otherwise
  // pristine procedural panels without turning the weapon into camouflage.
  for (let spot = 0; spot < 9; spot += 1) {
    const x = random() * size;
    const y = random() * size;
    const radius = 16 + random() * 34;
    const squash = 0.28 + random() * 0.48;
    albedoContext.save();
    albedoContext.translate(x, y);
    albedoContext.scale(1, squash);
    const soot = albedoContext.createRadialGradient(0, 0, 0, 0, 0, radius);
    soot.addColorStop(0, 'rgba(18, 22, 25, 0.22)');
    soot.addColorStop(0.55, 'rgba(24, 27, 30, 0.1)');
    soot.addColorStop(1, 'rgba(24, 27, 30, 0)');
    albedoContext.fillStyle = soot;
    albedoContext.fillRect(-radius, -radius, radius * 2, radius * 2);
    albedoContext.restore();

    roughnessContext.save();
    roughnessContext.translate(x, y);
    roughnessContext.scale(1, squash);
    const grime = roughnessContext.createRadialGradient(0, 0, 0, 0, 0, radius);
    grime.addColorStop(0, 'rgba(252, 252, 252, 0.66)');
    grime.addColorStop(1, 'rgba(226, 226, 226, 0)');
    roughnessContext.fillStyle = grime;
    roughnessContext.fillRect(-radius, -radius, radius * 2, radius * 2);
    roughnessContext.restore();
  }

  // Paired dark/light strokes read as shallow scratches. The roughness pass is
  // smoother inside the cut, suggesting exposed, repeatedly handled material.
  for (let scratch = 0; scratch < 58; scratch += 1) {
    const startX = random() * size;
    const startY = random() * size;
    const length = 4 + random() * 18;
    const angle = random() * Math.PI * 2;
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length;
    const width = 0.28 + random() * 0.58;

    albedoContext.beginPath();
    albedoContext.moveTo(startX, startY);
    albedoContext.lineTo(endX, endY);
    albedoContext.lineWidth = width;
    albedoContext.strokeStyle = `rgba(28, 32, 35, ${0.08 + random() * 0.12})`;
    albedoContext.stroke();
    albedoContext.beginPath();
    albedoContext.moveTo(startX + 0.8, startY + 0.8);
    albedoContext.lineTo(endX + 0.8, endY + 0.8);
    albedoContext.lineWidth = Math.max(0.45, width * 0.52);
    albedoContext.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    albedoContext.stroke();

    roughnessContext.beginPath();
    roughnessContext.moveTo(startX, startY);
    roughnessContext.lineTo(endX, endY);
    roughnessContext.lineWidth = width * 1.35;
    roughnessContext.strokeStyle = 'rgba(82, 82, 82, 0.8)';
    roughnessContext.stroke();

    metalnessContext.beginPath();
    metalnessContext.moveTo(startX, startY);
    metalnessContext.lineTo(endX, endY);
    metalnessContext.lineWidth = width * 1.6;
    metalnessContext.strokeStyle = 'rgba(248, 248, 248, 0.92)';
    metalnessContext.stroke();

    normalContext.beginPath();
    normalContext.moveTo(startX, startY - 0.7);
    normalContext.lineTo(endX, endY - 0.7);
    normalContext.lineWidth = width;
    normalContext.strokeStyle = 'rgba(98, 154, 245, 0.72)';
    normalContext.stroke();
    normalContext.beginPath();
    normalContext.moveTo(startX, startY + 0.7);
    normalContext.lineTo(endX, endY + 0.7);
    normalContext.strokeStyle = 'rgba(158, 104, 245, 0.62)';
    normalContext.stroke();
  }

  // Sub-pixel pits and handling pores keep broad armor from reading like
  // painted plastic. They primarily perturb roughness/normal and only barely
  // touch albedo, so the effect appears in moving highlights instead of as a
  // noisy printed pattern.
  for (let pit = 0; pit < 190; pit += 1) {
    const x = random() * size;
    const y = random() * size;
    const radius = 0.35 + random() * 1.1;
    roughnessContext.beginPath();
    roughnessContext.arc(x, y, radius * 1.6, 0, Math.PI * 2);
    roughnessContext.fillStyle = `rgba(245, 245, 245, ${0.08 + random() * 0.16})`;
    roughnessContext.fill();
    normalContext.beginPath();
    normalContext.arc(x, y, radius, 0, Math.PI * 2);
    normalContext.fillStyle = `rgba(112, 118, 244, ${0.12 + random() * 0.18})`;
    normalContext.fill();
    if (pit % 7 === 0) {
      albedoContext.beginPath();
      albedoContext.arc(x, y, radius * 0.55, 0, Math.PI * 2);
      albedoContext.fillStyle = 'rgba(22, 25, 28, 0.07)';
      albedoContext.fill();
    }
  }

  const configure = (texture: THREE.CanvasTexture, name: string): THREE.CanvasTexture => {
    texture.name = `${id}-${name}`;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3.6, 3.6);
    texture.anisotropy = 4;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.userData.disposeWithMaterial = true;
    return texture;
  };
  const albedo = configure(new THREE.CanvasTexture(albedoCanvas), 'battle-wear-albedo');
  albedo.colorSpace = THREE.SRGBColorSpace;
  const roughness = configure(new THREE.CanvasTexture(roughnessCanvas), 'battle-wear-roughness');
  const normal = configure(new THREE.CanvasTexture(normalCanvas), 'battle-wear-normal');
  const metalness = configure(new THREE.CanvasTexture(metalnessCanvas), 'battle-wear-metalness');
  return { albedo, roughness, normal, metalness };
}

function applyBattleWear<T extends THREE.MeshStandardMaterial>(
  material: T,
  textures: BattleWearTextures,
  normalScale: number,
  exposeMetal = false,
): T {
  material.map = textures.albedo;
  material.roughnessMap = textures.roughness;
  material.normalMap = textures.normal;
  material.normalScale.setScalar(normalScale);
  if (exposeMetal) material.metalnessMap = textures.metalness;
  material.userData.surfaceTreatment = 'battle-worn';
  return material;
}

const WEAPON_PRESENTATION: Record<WeaponId, {
  scale: number;
  rotation: [number, number, number];
  position: [number, number, number];
}> = {
  // Bore alignment is applied to the parent every frame in Game.updateCamera.
  // These restrained offsets expose side-mounted detail while the authored
  // muzzle socket remains the single source of truth for shot/VFX origins.
  machine: { scale: 0.77, rotation: [-0.015, 0.075, -0.03], position: [0.055, -0.005, -0.02] },
  shotgun: { scale: 0.73, rotation: [-0.012, 0.082, -0.026], position: [0.065, -0.012, -0.035] },
  rocket: { scale: 0.67, rotation: [-0.012, 0.072, -0.026], position: [0.06, -0.02, -0.08] },
  plasma: { scale: 0.71, rotation: [-0.012, 0.078, -0.022], position: [0.06, 0.02, -0.055] },
  laser: { scale: 0.7, rotation: [-0.01, 0.082, -0.022], position: [0.06, 0.03, -0.075] },
  sniper: { scale: 0.6, rotation: [-0.008, 0.068, -0.024], position: [0.055, 0.03, -0.115] },
  rail: { scale: 0.59, rotation: [-0.01, 0.07, -0.022], position: [0.055, 0.02, -0.125] },
  disc: { scale: 0.66, rotation: [-0.014, 0.084, -0.026], position: [0.06, 0.012, -0.08] },
};

function weaponMaterials(definition: WeaponDefinition): MaterialKit {
  const accentColor = new THREE.Color(definition.color);
  const hotColor = accentColor.clone().lerp(new THREE.Color(0xffffff), 0.08).multiplyScalar(0.82);
  const palette = WEAPON_PALETTES[definition.id];
  const wear = createBattleWearTextures(definition.id);
  const metallicMachine = definition.id === 'machine';
  const machineSteel = new THREE.Color(0x71838a);
  const machineHighlight = new THREE.Color(0xa7b1b4);
  const kit: MaterialKit = {
    shell: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.shell,
      roughness: 0.48,
      metalness: 0.58,
      clearcoat: 0.12,
      clearcoatRoughness: 0.48,
      envMapIntensity: 0.42,
      anisotropy: 0.16,
    }), wear, 0.55, true),
    secondary: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.secondary,
      roughness: 0.42,
      metalness: 0.82,
      envMapIntensity: 0.54,
      clearcoat: 0.08,
      clearcoatRoughness: 0.38,
      anisotropy: 0.34,
    }), wear, 0.42, true),
    metal: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.metal,
      roughness: 0.28,
      metalness: 1,
      envMapIntensity: 0.78,
      anisotropy: 0.58,
      anisotropyRotation: Math.PI * 0.5,
    }), wear, 0.34),
    ceramic: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.ceramic,
      roughness: 0.4,
      metalness: 0.04,
      clearcoat: 0.22,
      clearcoatRoughness: 0.36,
      envMapIntensity: 0.5,
    }), wear, 0.28),
    rubber: applyBattleWear(new THREE.MeshStandardMaterial({
      color: 0x05080d,
      roughness: 0.88,
      metalness: 0.04,
      envMapIntensity: 0.28,
    }), wear, 0.48),
    accent: new THREE.MeshStandardMaterial({
      color: metallicMachine ? machineSteel : accentColor.clone().multiplyScalar(0.62),
      emissive: metallicMachine ? 0x000000 : accentColor,
      emissiveIntensity: metallicMachine ? 0 : ACCENT_INTENSITY,
      roughness: metallicMachine ? 0.36 : 0.19,
      metalness: metallicMachine ? 0.94 : 0.34,
      envMapIntensity: metallicMachine ? 0.5 : 0.9,
    }),
    hot: new THREE.MeshStandardMaterial({
      color: metallicMachine ? machineHighlight : hotColor,
      emissive: metallicMachine ? 0x000000 : hotColor,
      emissiveIntensity: metallicMachine ? 0 : 0.68,
      roughness: metallicMachine ? 0.32 : 0.12,
      metalness: metallicMachine ? 0.98 : 0.08,
      envMapIntensity: metallicMachine ? 0.56 : 1,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: metallicMachine ? 0x39474c : accentColor.clone().multiplyScalar(0.28),
      emissive: metallicMachine ? 0x000000 : accentColor,
      emissiveIntensity: metallicMachine ? 0 : 0.18,
      roughness: metallicMachine ? 0.26 : 0.16,
      metalness: metallicMachine ? 0.64 : 0,
      transparent: true,
      opacity: metallicMachine ? 0.72 : 0.3,
      clearcoat: metallicMachine ? 0.28 : 1,
      envMapIntensity: metallicMachine ? 0.58 : 0.42,
      depthWrite: false,
    }),
    decal: new THREE.MeshBasicMaterial({
      color: metallicMachine ? 0x829196 : hotColor,
      toneMapped: metallicMachine,
    }),
  };
  if (metallicMachine) {
    // Reuse the existing correctly color-managed battle-wear texture set on
    // the former glow channels. They remain one shared set of four maps, so
    // this changes the response from flashing neon to brushed, worn steel
    // without increasing texture memory or the weapon's draw count.
    for (const material of [kit.accent, kit.hot]) {
      material.map = wear.albedo;
      material.roughnessMap = wear.roughness;
      material.normalMap = wear.normal;
      material.normalScale.setScalar(0.22);
      material.metalnessMap = wear.metalness;
    }
  }
  return kit;
}

function createBuilder(definition: WeaponDefinition): Builder {
  const root = new THREE.Group();
  root.name = `${definition.id}-view-model`;
  const kit = weaponMaterials(definition);
  const animatedRotors: THREE.Object3D[] = [];
  const animatedSlides: THREE.Object3D[] = [];

  const part: Builder['part'] = (name, geometry, material, position, rotation = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };

  const group: Builder['group'] = (name, position = [0, 0, 0]) => {
    const result = new THREE.Group();
    result.name = name;
    result.position.set(...position);
    root.add(result);
    return result;
  };

  const profile: Builder['profile'] = (name, points, width, material, x = 0) => {
    const shape = new THREE.Shape();
    shape.moveTo(-points[0][0], points[0][1]);
    for (const [z, y] of points.slice(1)) shape.lineTo(-z, y);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      steps: 1,
      bevelEnabled: true,
      bevelSize: 0.018,
      bevelThickness: 0.018,
      bevelSegments: 2,
    });
    geometry.translate(0, 0, -width * 0.5);
    geometry.rotateY(Math.PI * 0.5);
    geometry.computeVertexNormals();
    return part(name, geometry, material, [x, 0, 0]);
  };

  return { root, kit, part, group, profile, animatedRotors, animatedSlides };
}

function addCommonGrip(builder: Builder): void {
  const { part, kit } = builder;
  part('grip-spine', new RoundedBoxGeometry(0.2, 0.5, 0.25, 4, 0.045), kit.rubber, [0.06, -0.28, -0.02], [-0.28, 0, 0.04]);
  for (let index = 0; index < 4; index += 1) {
    part(
      `grip-rib-${index}`,
      new RoundedBoxGeometry(0.215, 0.025, 0.27, 2, 0.008),
      kit.secondary,
      [0.06, -0.17 - index * 0.085, -0.015 + index * 0.024],
      [-0.28, 0, 0.04],
    );
  }
  part('trigger-guard', new THREE.TorusGeometry(0.105, 0.018, 7, 20, Math.PI * 1.45), kit.metal, [0.04, -0.13, -0.23], [Math.PI * 0.5, 0.12, 0.2]);
  part('trigger', new RoundedBoxGeometry(0.025, 0.12, 0.025, 2, 0.008), kit.accent, [0.03, -0.13, -0.26], [0.32, 0, 0]);
}

export function addHands(viewRoot: THREE.Group, weaponRoot: THREE.Group, kit: MaterialKit): void {
  weaponRoot.updateMatrix();
  const armRoot = new THREE.Group();
  armRoot.name = 'first-person-armature';
  viewRoot.add(armRoot);

  const addMesh = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: THREE.Vector3,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.copy(position);
    mesh.frustumCulled = false;
    armRoot.add(mesh);
    return mesh;
  };
  const addLimb = (name: string, start: THREE.Vector3, end: THREE.Vector3, radius: number): void => {
    const direction = end.clone().sub(start);
    const distance = direction.length();
    const sleeve = addMesh(
      name,
      new THREE.CapsuleGeometry(radius, Math.max(0.02, distance - radius * 2), 6, 12),
      kit.rubber,
      start.clone().add(end).multiplyScalar(0.5),
    );
    sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  };

  // Grip anchors follow each weapon's authored presentation transform, while
  // forearms remain in camera space and enter from below the viewport. This
  // keeps long-range weapons from shrinking their hands into floating blobs.
  const rearGrip = new THREE.Vector3(0.1, -0.18, -0.01).applyMatrix4(weaponRoot.matrix);
  const frontGrip = new THREE.Vector3(-0.24, -0.08, -0.55).applyMatrix4(weaponRoot.matrix);
  const rearStart = new THREE.Vector3(0.49, -0.68, 0.2);
  const frontStart = new THREE.Vector3(-0.5, -0.64, 0.06);
  addLimb('rear-camera-forearm', rearStart, rearGrip, 0.13);
  addLimb('front-camera-forearm', frontStart, frontGrip, 0.125);

  const rearGauntlet = addMesh(
    'rear-gauntlet',
    new RoundedBoxGeometry(0.27, 0.18, 0.3, 3, 0.045),
    kit.secondary,
    rearGrip,
  );
  rearGauntlet.rotation.set(-0.2, 0.08, -0.08);
  const frontGauntlet = addMesh(
    'front-gauntlet',
    new RoundedBoxGeometry(0.26, 0.17, 0.31, 3, 0.045),
    kit.secondary,
    frontGrip,
  );
  frontGauntlet.rotation.set(0.44, 0.08, 0.2);

  for (let finger = 0; finger < 3; finger += 1) {
    const rearKnuckle = addMesh(
      `rear-knuckle-${finger}`,
      new RoundedBoxGeometry(0.047, 0.05, 0.12, 2, 0.012),
      kit.metal,
      rearGrip.clone().add(new THREE.Vector3(-0.07 + finger * 0.058, 0.075, -0.1)),
    );
    rearKnuckle.rotation.copy(rearGauntlet.rotation);
    const frontKnuckle = addMesh(
      `front-knuckle-${finger}`,
      new RoundedBoxGeometry(0.044, 0.045, 0.11, 2, 0.01),
      kit.metal,
      frontGrip.clone().add(new THREE.Vector3(-0.075 + finger * 0.058, 0.07, -0.1)),
    );
    frontKnuckle.rotation.copy(frontGauntlet.rotation);
  }
}

function addFasteners(builder: Builder, z: number, y: number, width: number, count = 4): void {
  const { part, kit } = builder;
  for (const side of [-1, 1]) {
    for (let index = 0; index < count; index += 1) {
      part(
        `fastener-${z}-${side}-${index}`,
        new THREE.CylinderGeometry(0.016, 0.016, 0.012, 8),
        kit.metal,
        [side * (width * 0.5 + 0.012), y, z - index * 0.12],
        [0, 0, Math.PI * 0.5],
      );
    }
  }
}

function addSignalTicks(builder: Builder, startZ: number, y: number, count: number, spacing = 0.075): void {
  const { part, kit } = builder;
  for (let index = 0; index < count; index += 1) {
    part(
      `signal-tick-${index}`,
      new RoundedBoxGeometry(0.025, 0.015, 0.045 + index * 0.006, 2, 0.005),
      index === count - 1 ? kit.hot : kit.decal,
      [0.305, y, startZ - index * spacing],
      [0, 0, -0.22],
    );
  }
}

function addReceiverSurfaceDetail(builder: Builder, id: WeaponId): void {
  const layouts: Record<WeaponId, { x: number; top: number; bottom: number; rear: number; front: number }> = {
    machine: { x: 0.205, top: 0.145, bottom: -0.1, rear: 0.3, front: -1.02 },
    shotgun: { x: 0.255, top: 0.16, bottom: -0.115, rear: 0.28, front: -0.54 },
    rocket: { x: 0.245, top: 0.32, bottom: -0.035, rear: 0.18, front: -1.46 },
    plasma: { x: 0.235, top: 0.2, bottom: -0.12, rear: 0.38, front: -0.3 },
    laser: { x: 0.225, top: 0.19, bottom: -0.12, rear: 0.46, front: -0.28 },
    sniper: { x: 0.205, top: 0.12, bottom: -0.075, rear: 0.18, front: -0.82 },
    rail: { x: 0.285, top: 0.19, bottom: -0.12, rear: 0.42, front: -0.38 },
    disc: { x: 0.245, top: 0.17, bottom: -0.11, rear: 0.42, front: -1.24 },
  };
  const layout = layouts[id];
  const { part, kit } = builder;
  for (const side of [-1, 1]) {
    for (let index = 0; index < 6; index += 1) {
      const t = index / 5;
      const z = THREE.MathUtils.lerp(layout.rear, layout.front, t);
      for (const [row, y] of [['top', layout.top], ['bottom', layout.bottom]] as const) {
        part(
          `${id}-receiver-bolt-${side}-${row}-${index}`,
          new THREE.CylinderGeometry(0.016, 0.016, 0.018, 10),
          index % 3 === 2 ? kit.secondary : kit.metal,
          [side * layout.x, y, z],
          [0, 0, Math.PI * 0.5],
        );
      }
    }
    for (let index = 0; index < 4; index += 1) {
      part(
        `${id}-side-vent-${side}-${index}`,
        new RoundedBoxGeometry(0.022, 0.045, 0.1, 2, 0.008),
        kit.rubber,
        [side * (layout.x + 0.006), layout.top - 0.11, layout.front + 0.12 + index * 0.12],
        [0.08, 0, 0],
      );
    }
    part(
      `${id}-status-light-${side}`,
      new RoundedBoxGeometry(0.024, 0.032, 0.19, 2, 0.008),
      kit.accent,
      [side * (layout.x + 0.01), layout.bottom + 0.09, layout.front + 0.22],
    );
    part(
      `${id}-service-rail-${side}`,
      new RoundedBoxGeometry(0.026, 0.025, Math.abs(layout.front - layout.rear) * 0.56, 2, 0.006),
      kit.metal,
      [side * (layout.x + 0.004), layout.bottom + 0.035, (layout.front + layout.rear) * 0.5],
    );
  }
}

function addArmoredHose(
  builder: Builder,
  name: string,
  points: Array<[number, number, number]>,
  radius = 0.025,
  collarMaterial: THREE.Material = builder.kit.metal,
): void {
  const { part, kit } = builder;
  const curve = new THREE.CatmullRomCurve3(
    points.map((point) => new THREE.Vector3(...point)),
    false,
    'centripetal',
  );
  part(
    `${name}-hose`,
    new THREE.TubeGeometry(curve, 56, radius, 10, false),
    kit.rubber,
    [0, 0, 0],
  );

  const orientRing = (mesh: THREE.Mesh, t: number): void => {
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      curve.getTangentAt(t).normalize(),
    );
  };
  for (let index = 1; index < 18; index += 1) {
    const t = index / 18;
    const ring = part(
      `${name}-rib-${index}`,
      new THREE.TorusGeometry(radius + 0.0045, 0.004, 6, 12),
      index % 6 === 0 ? collarMaterial : kit.secondary,
      curve.getPointAt(t).toArray() as [number, number, number],
    );
    orientRing(ring, t);
  }

  for (const [label, t] of [['input', 0.025], ['output', 0.975]] as const) {
    const tangent = curve.getTangentAt(t).normalize();
    const point = curve.getPointAt(t);
    const ferrule = part(
      `${name}-${label}-ferrule`,
      new THREE.CylinderGeometry(radius * 1.42, radius * 1.42, radius * 2.5, 12),
      collarMaterial,
      point.toArray() as [number, number, number],
    );
    ferrule.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    const lockRing = part(
      `${name}-${label}-lock-ring`,
      new THREE.TorusGeometry(radius * 1.48, radius * 0.18, 7, 16),
      kit.accent,
      point.clone().addScaledVector(tangent, label === 'input' ? -radius * 1.1 : radius * 1.1).toArray() as [number, number, number],
    );
    lockRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
  }
}

function addCurvedProfile(
  builder: Builder,
  name: string,
  points: Array<[number, number]>,
  width: number,
  material: THREE.Material,
  x = 0,
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([z, y]) => new THREE.Vector3(-z, y, 0)),
    true,
    'centripetal',
  );
  const outline = curve.getPoints(points.length * 8);
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, outline[0].y);
  for (const point of outline.slice(1)) shape.lineTo(point.x, point.y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    steps: 1,
    bevelEnabled: true,
    bevelSize: 0.016,
    bevelThickness: 0.016,
    bevelSegments: 3,
  });
  geometry.translate(0, 0, -width * 0.5);
  geometry.rotateY(Math.PI * 0.5);
  geometry.computeVertexNormals();
  return builder.part(name, geometry, material, [x, 0, 0]);
}

function addTopPlate(
  builder: Builder,
  name: string,
  points: Array<[number, number]>,
  height: number,
  material: THREE.Material,
  y: number,
): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, z] of points.slice(1)) shape.lineTo(x, z);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    steps: 1,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 2,
  });
  geometry.translate(0, 0, -height * 0.5);
  geometry.rotateX(Math.PI * 0.5);
  geometry.computeVertexNormals();
  return builder.part(name, geometry, material, [0, y, 0]);
}

function addWeaponMicroDetail(builder: Builder, id: WeaponId): void {
  const { part, kit } = builder;
  if (id === 'machine') {
    for (const side of [-1, 1]) {
      part(`mg-ejection-port-frame-${side}`, new RoundedBoxGeometry(0.022, 0.125, 0.285, 3, 0.012), kit.metal, [side * 0.205, 0.055, -0.34]);
      part(`mg-ejection-port-${side}`, new RoundedBoxGeometry(0.026, 0.078, 0.225, 3, 0.009), kit.rubber, [side * 0.22, 0.055, -0.34]);
      part(`mg-bolt-carrier-${side}`, new THREE.CapsuleGeometry(0.029, 0.145, 5, 12), kit.metal, [side * 0.238, 0.058, -0.34], [Math.PI * 0.5, 0, 0]);
      part(`mg-charging-handle-pivot-${side}`, new THREE.CylinderGeometry(0.034, 0.034, 0.046, 12), kit.secondary, [side * 0.248, 0.03, -0.2], [0, 0, Math.PI * 0.5]);
      part(`mg-charging-handle-${side}`, new THREE.CylinderGeometry(0.016, 0.021, 0.135, 10), kit.metal, [side * 0.272, -0.018, -0.2], [0.3, 0, side * 0.12]);
      part(`mg-charging-handle-knob-${side}`, new THREE.CylinderGeometry(0.031, 0.031, 0.035, 12), kit.rubber, [side * 0.29, -0.077, -0.18], [0.3, 0, side * 0.12]);
      part(`mg-service-release-${side}`, new RoundedBoxGeometry(0.026, 0.033, 0.08, 2, 0.007), kit.ceramic, [side * 0.232, -0.035, -0.47]);
    }
    for (let index = 0; index < 6; index += 1) {
      part(`mg-cooling-slot-${index}`, new RoundedBoxGeometry(0.02, 0.03, 0.105, 2, 0.008), index === 5 ? kit.accent : kit.rubber, [-0.211, 0.1, -0.34 - index * 0.115], [0.08, 0, 0]);
      part(`mg-feed-round-${index}`, new THREE.CylinderGeometry(0.018, 0.018, 0.074, 10), kit.metal, [0.245, -0.02 + index * 0.034, 0.48], [0, 0, 0]);
      part(`mg-feed-tip-${index}`, new THREE.CylinderGeometry(0.012, 0.018, 0.025, 10), index === 5 ? kit.hot : kit.ceramic, [0.245, 0.03 + index * 0.034, 0.48]);
    }
    for (const side of [-1, 1]) {
      addArmoredHose(builder, `mg-feed-hose-${side}`, [
        [side * 0.215, 0.115, 0.47],
        [side * 0.27, 0.22, 0.35],
        [side * 0.285, 0.24, 0.18],
        [side * 0.29, 0.13, 0.03],
        [side * 0.28, 0.015, -0.12],
        [side * 0.265, -0.015, -0.28],
        [side * 0.25, 0.085, -0.44],
        [side * 0.215, 0.15, -0.58],
      ], 0.024, kit.metal);
      for (const [label, y, z] of [['rear', 0.115, 0.47], ['front', 0.15, -0.58]] as const) {
        part(`mg-hose-${label}-socket-well-${side}`, new THREE.CylinderGeometry(0.072, 0.072, 0.025, 16), kit.rubber, [side * 0.194, y, z], [0, 0, Math.PI * 0.5]);
        part(`mg-hose-${label}-bulkhead-${side}`, new THREE.CylinderGeometry(0.052, 0.058, 0.046, 14), kit.metal, [side * 0.216, y, z], [0, 0, Math.PI * 0.5]);
        part(`mg-hose-${label}-lock-${side}`, new THREE.TorusGeometry(0.058, 0.008, 7, 18), kit.metal, [side * 0.243, y, z], [0, Math.PI * 0.5, 0]);
        part(`mg-hose-${label}-index-${side}`, new RoundedBoxGeometry(0.014, 0.018, 0.032, 2, 0.005), label === 'front' ? kit.hot : kit.accent, [side * 0.256, y + 0.052, z]);
      }
      for (const [retainerIndex, y, z, angle] of [
        [0, 0.224, 0.235, -0.14],
        [1, 0.015, -0.15, 0.08],
        [2, 0.082, -0.45, -0.12],
      ] as const) {
        part(`mg-hose-retainer-${side}-${retainerIndex}`, new RoundedBoxGeometry(0.046, 0.07, 0.032, 2, 0.009), kit.metal, [side * 0.3, y, z], [0, 0, side * angle]);
        part(`mg-hose-retainer-bolt-${side}-${retainerIndex}`, new THREE.CylinderGeometry(0.012, 0.012, 0.052, 9), retainerIndex === 2 ? kit.hot : kit.secondary, [side * 0.307, y - 0.027, z], [0, 0, Math.PI * 0.5]);
      }
    }
  } else if (id === 'shotgun') {
    for (const [clampIndex, z] of [-0.66, -1.08, -1.49].entries()) {
      part(`shotgun-barrel-clamp-${z}`, new RoundedBoxGeometry(0.3, 0.255, 0.055, 3, 0.012), clampIndex === 2 ? kit.ceramic : kit.metal, [0, 0.035, z]);
      part(`shotgun-clamp-inset-${z}`, new RoundedBoxGeometry(0.31, 0.145, 0.025, 2, 0.006), kit.shell, [0, 0.035, z - 0.008]);
      for (const side of [-1, 1]) {
        part(`shotgun-clamp-bolt-${clampIndex}-${side}`, new THREE.CylinderGeometry(0.017, 0.017, 0.025, 10), kit.secondary, [side * 0.145, 0.035, z - 0.035], [0, 0, Math.PI * 0.5]);
        part(`shotgun-clamp-hinge-${clampIndex}-${side}`, new THREE.CylinderGeometry(0.023, 0.023, 0.04, 12), kit.metal, [side * 0.16, -0.065, z], [0, 0, Math.PI * 0.5]);
      }
      part(`shotgun-clamp-latch-${clampIndex}`, new RoundedBoxGeometry(0.11, 0.045, 0.075, 2, 0.009), clampIndex === 2 ? kit.hot : kit.secondary, [0, -0.105, z]);
    }
    part('shotgun-breach-latch-bed', new RoundedBoxGeometry(0.025, 0.1, 0.31, 3, 0.014), kit.secondary, [0.275, 0.12, -0.31]);
    part('shotgun-breach-latch', new RoundedBoxGeometry(0.075, 0.052, 0.22, 3, 0.013), kit.metal, [0.3, 0.12, -0.31], [0.08, 0, -0.08]);
    part('shotgun-breach-pin', new THREE.CylinderGeometry(0.035, 0.035, 0.04, 12), kit.ceramic, [0.315, 0.12, -0.22], [0, 0, Math.PI * 0.5]);
    part('shotgun-front-sight-base', new RoundedBoxGeometry(0.11, 0.052, 0.16, 2, 0.012), kit.metal, [0, 0.188, -1.48]);
    part('shotgun-front-sight-post', new RoundedBoxGeometry(0.055, 0.075, 0.065, 2, 0.009), kit.secondary, [0, 0.243, -1.48]);
    part('shotgun-front-sight', new RoundedBoxGeometry(0.028, 0.032, 0.032, 2, 0.007), kit.hot, [0, 0.292, -1.48]);
    for (let index = 0; index < 4; index += 1) {
      part(`shotgun-heat-port-${index}`, new RoundedBoxGeometry(0.022, 0.028, 0.095, 2, 0.008), kit.rubber, [-0.17, 0.105, -1.46 - index * 0.075]);
    }
  } else if (id === 'rocket') {
    part('rocket-rangefinder', new RoundedBoxGeometry(0.18, 0.16, 0.34, 3, 0.028), kit.secondary, [0.255, 0.41, -0.5]);
    part('rocket-rangefinder-armor', new RoundedBoxGeometry(0.19, 0.08, 0.2, 2, 0.014), kit.metal, [0.258, 0.47, -0.49]);
    part('rocket-rangefinder-lens', new THREE.CircleGeometry(0.058, 20), kit.glass, [0.349, 0.41, -0.62], [0, Math.PI * 0.5, 0]);
    part('rocket-rangefinder-reticle', new THREE.TorusGeometry(0.058, 0.009, 7, 20), kit.hot, [0.352, 0.41, -0.62], [0, Math.PI * 0.5, 0]);
    part('rocket-top-sight', new RoundedBoxGeometry(0.095, 0.055, 0.58, 2, 0.016), kit.rubber, [0, 0.41, -0.68]);
    for (const z of [-0.38, -0.62]) {
      part(`rocket-optic-mount-${z}`, new RoundedBoxGeometry(0.13, 0.14, 0.06, 2, 0.012), kit.metal, [0, 0.34, z]);
      part(`rocket-optic-mount-foot-${z}`, new RoundedBoxGeometry(0.19, 0.035, 0.1, 2, 0.008), kit.secondary, [0, 0.285, z]);
    }
    addArmoredHose(builder, 'rocket-fire-control-cable', [
      [-0.235, 0.01, 0.12],
      [-0.3, -0.1, 0.02],
      [-0.315, -0.15, -0.2],
      [-0.295, -0.08, -0.4],
      [-0.315, -0.13, -0.63],
      [-0.285, -0.045, -0.86],
      [-0.235, 0.02, -1.02],
    ], 0.017, kit.metal);
    for (const [label, y, z] of [['rear', 0.01, 0.12], ['front', 0.02, -1.02]] as const) {
      part(`rocket-cable-${label}-mount-plate`, new RoundedBoxGeometry(0.025, 0.12, 0.14, 2, 0.012), kit.secondary, [-0.221, y, z]);
      part(`rocket-cable-${label}-socket`, new THREE.CylinderGeometry(0.044, 0.05, 0.065, 14), kit.metal, [-0.255, y, z], [0, 0, Math.PI * 0.5]);
      part(`rocket-cable-${label}-boot`, new THREE.CylinderGeometry(0.027, 0.039, 0.09, 14), kit.rubber, [-0.3, y, z], [0, 0, Math.PI * 0.5]);
      part(`rocket-cable-${label}-flange`, new THREE.TorusGeometry(0.049, 0.008, 7, 18), kit.metal, [-0.285, y, z], [0, Math.PI * 0.5, 0]);
    }
    for (let index = 0; index < 4; index += 1) {
      part(`rocket-fire-control-key-${index}`, new RoundedBoxGeometry(0.018, 0.025, 0.055, 2, 0.006), index === 3 ? kit.hot : kit.metal, [0.252, 0.24, -0.46 - index * 0.08]);
    }
  } else if (id === 'plasma') {
    for (const side of [-1, 1]) {
      // Two intentionally different S-routes make the plumbing feel fitted to
      // a machine instead of drawn across its silhouette. Every end lands in
      // a visible socket and the hose helper adds 17 raised armor ribs.
      addArmoredHose(builder, `plasma-upper-coolant-${side}`, [
        [side * 0.302, 0.17, 0.42],
        [side * 0.355, 0.25, 0.31],
        [side * 0.378, 0.28, 0.16],
        [side * 0.386, 0.2, 0],
        [side * 0.372, 0.1, -0.14],
        [side * 0.34, 0.11, -0.3],
        [side * 0.29, 0.15, -0.45],
      ], 0.024, kit.metal);
      addArmoredHose(builder, `plasma-lower-coolant-${side}`, [
        [side * 0.3, -0.1, 0.37],
        [side * 0.36, -0.18, 0.25],
        [side * 0.385, -0.2, 0.1],
        [side * 0.39, -0.12, -0.04],
        [side * 0.365, -0.025, -0.17],
        [side * 0.33, -0.02, -0.3],
        [side * 0.29, -0.06, -0.4],
      ], 0.026, kit.secondary);

      for (const [label, y, z] of [
        ['upper-rear', 0.17, 0.42], ['lower-rear', -0.1, 0.37],
        ['upper-reactor', 0.15, -0.45], ['lower-reactor', -0.06, -0.4],
      ] as const) {
        part(`plasma-${label}-socket-${side}`, new THREE.CylinderGeometry(0.045, 0.052, 0.055, 14), kit.metal, [side * 0.275, y, z], [0, 0, Math.PI * 0.5]);
        part(`plasma-${label}-socket-ring-${side}`, new THREE.TorusGeometry(0.052, 0.009, 8, 18), label.includes('reactor') ? kit.accent : kit.secondary, [side * 0.305, y, z], [0, Math.PI * 0.5, 0]);
        part(`plasma-${label}-strain-relief-${side}`, new THREE.CylinderGeometry(0.027, 0.039, 0.075, 14), kit.rubber, [side * 0.336, y, z], [0, 0, Math.PI * 0.5]);
      }

      // The reference carries a compact two-by-two exposed capacitor block.
      for (let index = 0; index < 2; index += 1) {
        const y = 0.135 - index * 0.145;
        part(`plasma-capacitor-${side}-${index}`, new THREE.CylinderGeometry(0.048, 0.048, 0.3, 16), index === 0 ? kit.secondary : kit.metal, [side * 0.292, y, 0.06], [Math.PI * 0.5, 0, 0]);
        for (const ringZ of [-0.08, 0.19]) {
          part(`plasma-capacitor-collar-${side}-${index}-${ringZ}`, new THREE.TorusGeometry(0.054, 0.008, 7, 18), index === 0 ? kit.accent : kit.secondary, [side * 0.292, y, ringZ]);
        }
        part(`plasma-capacitor-terminal-${side}-${index}`, new THREE.CylinderGeometry(0.025, 0.032, 0.045, 12), kit.hot, [side * 0.292, y, -0.115], [Math.PI * 0.5, 0, 0]);
      }

      part(`plasma-upper-hose-retainer-${side}`, new RoundedBoxGeometry(0.045, 0.066, 0.034, 2, 0.008), kit.metal, [side * 0.397, 0.155, -0.06], [0, 0, side * 0.12]);
      part(`plasma-lower-hose-retainer-${side}`, new RoundedBoxGeometry(0.045, 0.066, 0.034, 2, 0.008), kit.metal, [side * 0.397, -0.085, -0.08], [0, 0, side * -0.12]);
    }
    part('plasma-reactor-shield', new THREE.TorusGeometry(0.255, 0.032, 8, 30, Math.PI * 1.56), kit.ceramic, [0, 0.065, -0.5], [0, Math.PI * 0.5, 0.22]);
  } else if (id === 'laser') {
    for (const side of [-1, 1]) {
      part(`laser-charge-window-${side}`, new RoundedBoxGeometry(0.026, 0.11, 0.3, 3, 0.014), kit.glass, [side * 0.247, 0.075, 0.12], [0.04, 0, 0.04]);
      for (let index = 0; index < 6; index += 1) {
        part(`laser-charge-segment-${side}-${index}`, new RoundedBoxGeometry(0.03, 0.061, 0.026, 2, 0.007), index === 5 ? kit.hot : kit.accent, [side * 0.265, 0.075, 0.245 - index * 0.049]);
      }
      addArmoredHose(builder, `laser-focusing-feed-${side}`, [
        [side * 0.278, 0.21, 0.3],
        [side * 0.325, 0.28, 0.17],
        [side * 0.34, 0.23, 0.02],
        [side * 0.335, 0.09, -0.12],
        [side * 0.31, 0.0, -0.27],
        [side * 0.285, 0.08, -0.4],
        [side * 0.268, 0.16, -0.49],
      ], 0.018, kit.accent);
      for (const [label, y, z] of [['stock', 0.21, 0.3], ['lens', 0.16, -0.49]] as const) {
        part(`laser-${label}-feed-socket-${side}`, new THREE.CylinderGeometry(0.036, 0.043, 0.05, 14), kit.metal, [side * 0.25, y, z], [0, 0, Math.PI * 0.5]);
        part(`laser-${label}-feed-lock-${side}`, new THREE.TorusGeometry(0.044, 0.007, 7, 18), label === 'lens' ? kit.hot : kit.accent, [side * 0.279, y, z], [0, Math.PI * 0.5, 0]);
        part(`laser-${label}-feed-strain-relief-${side}`, new THREE.CylinderGeometry(0.021, 0.031, 0.064, 12), kit.rubber, [side * 0.307, y, z], [0, 0, Math.PI * 0.5]);
      }

      const hardline = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.267, 0.09, 0.23),
        new THREE.Vector3(side * 0.302, 0.13, 0.11),
        new THREE.Vector3(side * 0.31, 0.08, -0.02),
        new THREE.Vector3(side * 0.295, 0.015, -0.15),
        new THREE.Vector3(side * 0.267, 0.055, -0.31),
      ], false, 'centripetal');
      part(`laser-control-hardline-${side}`, new THREE.TubeGeometry(hardline, 36, 0.009, 8, false), kit.hot, [0, 0, 0]);
      for (const [label, point] of [['rear', hardline.getPointAt(0.02)], ['front', hardline.getPointAt(0.98)]] as const) {
        part(`laser-hardline-${label}-socket-${side}`, new THREE.TorusGeometry(0.024, 0.006, 7, 16), kit.metal, point.toArray() as [number, number, number], [0, Math.PI * 0.5, 0]);
      }
    }
    for (let index = 0; index < 10; index += 1) {
      const y = -0.165 + index * 0.047;
      const finWidth = 0.19 - Math.abs(4.5 - index) * 0.004;
      for (const side of [-1, 1]) {
        part(
          `laser-radiator-fin-${index}-${side}`,
          new RoundedBoxGeometry(finWidth, 0.024, 0.58, 2, 0.007),
          index % 2 ? kit.metal : kit.rubber,
          [side * 0.19, y, -0.78],
        );
        part(`laser-radiator-fin-root-${side}-${index}`, new RoundedBoxGeometry(0.035, 0.04, 0.055, 2, 0.007), kit.secondary, [side * 0.286, y, -0.53]);
        part(`laser-radiator-signal-${side}-${index}`, new RoundedBoxGeometry(0.018, 0.012, 0.075, 2, 0.004), index === 9 ? kit.hot : kit.accent, [side * 0.29, y, -0.51]);
      }
    }
  } else if (id === 'sniper') {
    part('sniper-cheek-rest', new RoundedBoxGeometry(0.29, 0.075, 0.42, 3, 0.022), kit.shell, [-0.02, 0.245, 0.18], [0.02, 0, 0]);
    part('sniper-cheek-rest-pad', new RoundedBoxGeometry(0.25, 0.032, 0.32, 2, 0.01), kit.rubber, [-0.02, 0.292, 0.18], [0.02, 0, 0]);
    for (const z of [-0.22, -0.62]) {
      part(`sniper-scope-bracket-${z}`, new RoundedBoxGeometry(0.2, 0.19, 0.06, 2, 0.014), kit.metal, [0, 0.29, z]);
      part(`sniper-scope-clamp-${z}`, new THREE.TorusGeometry(0.104, 0.016, 8, 22), kit.secondary, [0, 0.39, z]);
      part(`sniper-scope-foot-${z}`, new RoundedBoxGeometry(0.24, 0.045, 0.11, 2, 0.009), kit.shell, [0, 0.255, z]);
      for (const side of [-1, 1]) {
        part(`sniper-scope-mount-bolt-${z}-${side}`, new THREE.CylinderGeometry(0.013, 0.013, 0.02, 10), kit.hot, [side * 0.1, 0.27, z], [0, 0, Math.PI * 0.5]);
      }
    }
    part('sniper-elevation-dial', new THREE.CylinderGeometry(0.082, 0.082, 0.085, 18), kit.metal, [0, 0.515, -0.43]);
    part('sniper-elevation-dial-ring', new THREE.TorusGeometry(0.083, 0.009, 7, 20), kit.accent, [0, 0.56, -0.43], [Math.PI * 0.5, 0, 0]);
    part('sniper-elevation-dial-cap', new THREE.CylinderGeometry(0.055, 0.055, 0.016, 18), kit.rubber, [0, 0.565, -0.43]);
    part('sniper-windage-dial', new THREE.CylinderGeometry(0.065, 0.065, 0.14, 16), kit.metal, [0.15, 0.405, -0.43], [0, 0, Math.PI * 0.5]);
    for (let index = 0; index < 9; index += 1) {
      part(`sniper-heat-fin-${index}`, new RoundedBoxGeometry(0.19, 0.068, 0.02, 2, 0.005), index === 5 ? kit.accent : kit.secondary, [0, 0.13, -1.06 - index * 0.155]);
    }
    for (const side of [-1, 1]) {
      for (let index = 0; index < 6; index += 1) {
        part(`sniper-mlok-slot-${side}-${index}`, new RoundedBoxGeometry(0.015, 0.022, 0.09, 2, 0.006), kit.rubber, [side * 0.207, 0.04, -0.34 - index * 0.11]);
      }
    }
    for (let index = 0; index < 5; index += 1) {
      part(`sniper-range-mark-${index}`, new RoundedBoxGeometry(0.014, 0.012, 0.045, 1, 0.004), index === 4 ? kit.hot : kit.decal, [0.205, 0.135, -0.3 - index * 0.08]);
    }
  } else if (id === 'rail') {
    for (const side of [-1, 1]) {
      addArmoredHose(builder, `rail-flux-bus-${side}`, [
        [side * 0.278, 0.18, 0.45],
        [side * 0.345, 0.26, 0.32],
        [side * 0.365, 0.22, 0.16],
        [side * 0.37, 0.08, 0.01],
        [side * 0.355, -0.05, -0.13],
        [side * 0.325, -0.03, -0.3],
        [side * 0.285, 0.08, -0.43],
      ], 0.023, kit.ceramic);
      for (const [label, y, z] of [['bank', 0.18, 0.45], ['core', 0.08, -0.43]] as const) {
        part(`rail-${label}-bus-socket-${side}`, new THREE.CylinderGeometry(0.041, 0.048, 0.052, 14), kit.metal, [side * 0.255, y, z], [0, 0, Math.PI * 0.5]);
        part(`rail-${label}-bus-lock-${side}`, new THREE.TorusGeometry(0.048, 0.008, 7, 18), kit.accent, [side * 0.285, y, z], [0, Math.PI * 0.5, 0]);
        part(`rail-${label}-bus-strain-relief-${side}`, new THREE.CylinderGeometry(0.025, 0.036, 0.072, 12), kit.rubber, [side * 0.316, y, z], [0, 0, Math.PI * 0.5]);
      }
      for (let index = 0; index < 4; index += 1) {
        part(`rail-bus-retainer-${side}-${index}`, new RoundedBoxGeometry(0.04, 0.07, 0.032, 2, 0.008), kit.metal, [side * 0.385, 0.02 + index * 0.035, -0.04 - index * 0.08], [0, 0, side * 0.18]);
      }
    }
    part('rail-rear-field-cage', new THREE.TorusGeometry(0.175, 0.022, 8, 28), kit.accent, [0, 0.075, -0.38]);
    part('rail-rear-field-core', new THREE.CylinderGeometry(0.056, 0.07, 0.18, 16), kit.hot, [0, 0.075, -0.38], [Math.PI * 0.5, 0, 0]);
  } else if (id === 'disc') {
    for (const side of [-1, 1]) {
      for (let index = 0; index < 6; index += 1) {
        const z = 0.42 - index * 0.21;
        part(`disc-service-louver-${side}-${index}`, new RoundedBoxGeometry(0.021, 0.025, 0.105, 2, 0.006), index === 5 ? kit.hot : kit.rubber, [side * 0.248, 0.02 + index * 0.012, z], [0.07, 0, side * 0.08]);
        part(`disc-captive-case-bolt-${side}-${index}`, new THREE.CylinderGeometry(0.013, 0.013, 0.02, 10), index % 3 === 2 ? kit.accent : kit.metal, [side * 0.259, 0.155, z], [0, 0, Math.PI * 0.5]);
      }
      part(`disc-field-calibration-dial-${side}`, new THREE.CylinderGeometry(0.045, 0.045, 0.03, 16), kit.metal, [side * 0.267, 0.075, -0.96], [0, 0, Math.PI * 0.5]);
      part(`disc-field-calibration-ring-${side}`, new THREE.TorusGeometry(0.046, 0.008, 7, 18), side > 0 ? kit.hot : kit.accent, [side * 0.285, 0.075, -0.96], [0, Math.PI * 0.5, 0]);
    }
    for (let index = 0; index < 7; index += 1) {
      part(`disc-top-charge-tick-${index}`, new RoundedBoxGeometry(0.018, 0.014, 0.04, 2, 0.005), index === 6 ? kit.hot : kit.accent, [0.26, 0.228, -0.41 - index * 0.0475], [0, 0, -0.12]);
    }
  }
}

function addRearMechanicalPanel(
  builder: Builder,
  id: WeaponId,
  z: number,
  width: number,
  height: number,
  y = 0,
): void {
  const { part, kit } = builder;
  part(
    `${id}-rear-armor-frame`,
    new RoundedBoxGeometry(width, height, 0.055, 4, 0.028),
    kit.secondary,
    [0, y, z],
  );
  part(
    `${id}-rear-service-inset`,
    new RoundedBoxGeometry(width * 0.72, height * 0.58, 0.028, 4, 0.012),
    kit.shell,
    [0, y, z + 0.041],
  );
  for (const side of [-1, 1]) {
    part(
      `${id}-rear-shoulder-rail-${side}`,
      new RoundedBoxGeometry(0.045, height * 0.72, 0.032, 2, 0.01),
      kit.metal,
      [side * width * 0.36, y, z + 0.048],
      [0, 0, side * 0.08],
    );
    for (const row of [-1, 1]) {
      part(
        `${id}-rear-bolt-${side}-${row}`,
        new THREE.CylinderGeometry(0.019, 0.019, 0.026, 10),
        kit.hot,
        [side * width * 0.34, y + row * height * 0.29, z + 0.068],
        [Math.PI * 0.5, 0, 0],
      );
    }
  }
}

function addWeaponRearDetails(builder: Builder, id: WeaponId): void {
  const { part, kit } = builder;
  if (id === 'machine') {
    part('machine-rear-butt-frame', new RoundedBoxGeometry(0.43, 0.29, 0.055, 4, 0.028), kit.secondary, [0, 0.015, 0.715]);
    part('machine-rear-butt-pad', new RoundedBoxGeometry(0.36, 0.245, 0.045, 5, 0.026), kit.rubber, [0, 0.005, 0.755], [-0.04, 0, 0]);
    part('machine-rear-spine-cap', new RoundedBoxGeometry(0.29, 0.09, 0.11, 3, 0.018), kit.metal, [0, 0.175, 0.68], [0.06, 0, 0]);
    for (const side of [-1, 1]) {
      part(`machine-rear-corner-rail-${side}`, new RoundedBoxGeometry(0.044, 0.21, 0.07, 2, 0.01), kit.metal, [side * 0.19, 0.015, 0.73], [0, 0, side * 0.09]);
      part(`machine-rear-latch-${side}`, new THREE.CylinderGeometry(0.024, 0.024, 0.032, 10), kit.hot, [side * 0.19, -0.09, 0.765], [Math.PI * 0.5, 0, 0]);
    }
    for (let index = -1; index <= 1; index += 1) {
      part(`machine-rear-vent-${index}`, new RoundedBoxGeometry(0.15, 0.018, 0.025, 2, 0.006), index === 1 ? kit.hot : kit.metal, [0, 0.015 + index * 0.057, 0.787]);
    }
  } else if (id === 'shotgun') {
    for (const side of [-1, 1]) {
      builder.profile(`shotgun-rear-armor-layer-${side}`, [[0.55, -0.1], [0.55, 0.105], [0.47, 0.17], [0.32, 0.155], [0.27, 0.07], [0.29, -0.085], [0.39, -0.14]], 0.022, kit.metal, side * 0.245);
      builder.profile(`shotgun-rear-armor-inset-${side}`, [[0.515, -0.07], [0.515, 0.075], [0.45, 0.125], [0.36, 0.112], [0.325, 0.055], [0.34, -0.06], [0.405, -0.1]], 0.014, kit.secondary, side * 0.262);
      part(`shotgun-rear-side-bolt-${side}`, new THREE.CylinderGeometry(0.018, 0.018, 0.024, 10), kit.hot, [side * 0.275, 0.1, 0.43], [0, 0, Math.PI * 0.5]);
    }
    const visibleSide = -1;
    part('shotgun-rear-cycle-wheel', new THREE.CylinderGeometry(0.04, 0.04, 0.03, 16), kit.metal, [visibleSide * 0.282, 0.035, 0.35], [0, 0, Math.PI * 0.5]);
    part('shotgun-rear-cycle-wheel-ring', new THREE.TorusGeometry(0.044, 0.009, 8, 20), kit.secondary, [visibleSide * 0.301, 0.035, 0.35], [0, Math.PI * 0.5, 0]);
    part('shotgun-rear-cycle-wheel-core', new THREE.CylinderGeometry(0.015, 0.015, 0.034, 12), kit.ceramic, [visibleSide * 0.305, 0.035, 0.35], [0, 0, Math.PI * 0.5]);
    part('shotgun-rear-cycle-lever', new RoundedBoxGeometry(0.025, 0.085, 0.028, 2, 0.007), kit.metal, [visibleSide * 0.31, -0.025, 0.35], [0, 0, -0.2]);
    part('shotgun-rear-cycle-lever-knob', new THREE.SphereGeometry(0.022, 12, 8), kit.rubber, [visibleSide * 0.31, -0.07, 0.36]);
    part('shotgun-rear-breach-frame', new RoundedBoxGeometry(0.46, 0.29, 0.055, 4, 0.024), kit.metal, [0, 0.015, 0.525]);
    part('shotgun-rear-breach-door', new RoundedBoxGeometry(0.36, 0.215, 0.04, 4, 0.018), kit.shell, [0, 0.015, 0.565]);
    part('shotgun-rear-butt-pad', new RoundedBoxGeometry(0.34, 0.225, 0.032, 5, 0.022), kit.rubber, [0, 0.005, 0.603], [-0.04, 0, 0]);
    for (const x of [-0.17, 0.17]) {
      part(`shotgun-rear-hinge-${x}`, new THREE.CylinderGeometry(0.027, 0.027, 0.04, 10), kit.secondary, [x, -0.072, 0.59], [Math.PI * 0.5, 0, 0]);
    }
    for (let index = -1; index <= 1; index += 1) {
      part(`shotgun-rear-shell-primer-${index}`, new THREE.CircleGeometry(0.019, 12), index === 0 ? kit.hot : kit.accent, [index * 0.066, 0.015, 0.625]);
    }
  } else if (id === 'plasma') {
    addRearMechanicalPanel(builder, id, 0.28, 0.58, 0.4, 0.04);
    part('plasma-rear-reactor-ring', new THREE.TorusGeometry(0.12, 0.022, 8, 24), kit.accent, [0, 0.04, 0.345]);
    part('plasma-rear-reactor-core', new THREE.CircleGeometry(0.065, 16), kit.hot, [0, 0.04, 0.37]);
    for (const side of [-1, 1]) {
      part(`plasma-rear-capacitor-${side}`, new RoundedBoxGeometry(0.08, 0.2, 0.03, 2, 0.008), kit.metal, [side * 0.19, 0.04, 0.35]);
    }
  } else if (id === 'laser') {
    addRearMechanicalPanel(builder, id, 0.25, 0.53, 0.34, 0.02);
    part('laser-rear-charge-window', new RoundedBoxGeometry(0.16, 0.17, 0.038, 3, 0.012), kit.glass, [0, 0.02, 0.31]);
    for (let index = -1; index <= 1; index += 1) {
      part(`laser-rear-radiator-${index}`, new RoundedBoxGeometry(0.04, 0.22, 0.03, 2, 0.008), index === 1 ? kit.hot : kit.metal, [0.16 + index * 0.065, 0.02, 0.34], [0, 0, 0.04]);
    }
  } else if (id === 'sniper') {
    // Keep the stock's central void open. Small adjusters and exposed hardware
    // provide rear detail without filling the skeletal Longshot silhouette.
    part('sniper-rear-butt-lock', new THREE.CylinderGeometry(0.045, 0.045, 0.085, 14), kit.accent, [0, 0.015, 0.59], [Math.PI * 0.5, 0, 0]);
    part('sniper-rear-butt-lock-cap', new THREE.TorusGeometry(0.052, 0.011, 7, 18), kit.metal, [0, 0.015, 0.64]);
    for (const side of [-1, 1]) {
      part(`sniper-butt-adjustment-rail-${side}`, new RoundedBoxGeometry(0.026, 0.24, 0.026, 2, 0.007), kit.metal, [side * 0.19, -0.02, 0.585]);
      for (const row of [-1, 1]) {
        part(`sniper-butt-adjustment-bolt-${side}-${row}`, new THREE.CylinderGeometry(0.015, 0.015, 0.018, 10), row > 0 ? kit.hot : kit.metal, [side * 0.205, row * 0.085 - 0.02, 0.595], [0, 0, Math.PI * 0.5]);
      }
    }
  } else if (id === 'rail') {
    addRearMechanicalPanel(builder, id, 0.29, 0.63, 0.4, 0.04);
    part('rail-rear-flux-window', new THREE.CylinderGeometry(0.075, 0.075, 0.04, 14), kit.glass, [0, 0.04, 0.345], [Math.PI * 0.5, 0, 0]);
    part('rail-rear-flux-core', new THREE.CylinderGeometry(0.03, 0.03, 0.055, 10), kit.hot, [0, 0.04, 0.375], [Math.PI * 0.5, 0, 0]);
    for (const side of [-1, 1]) {
      part(`rail-rear-bus-${side}`, new RoundedBoxGeometry(0.05, 0.24, 0.032, 2, 0.008), kit.accent, [side * 0.19, 0.04, 0.35]);
    }
  }
}

function addMachineGun(builder: Builder): number {
  const { profile, part, kit, animatedRotors } = builder;
  // The VX is dark coated gunmetal rather than bare chrome. Keep narrow steel
  // highlights on edges, while the broad armor panels absorb most studio fill.
  kit.shell.metalness = 0.58;
  kit.shell.roughness = 0.4;
  kit.shell.envMapIntensity = 0.28;
  kit.secondary.metalness = 0.78;
  kit.secondary.roughness = 0.34;
  kit.secondary.envMapIntensity = 0.4;
  kit.metal.roughness = 0.38;
  kit.metal.envMapIntensity = 0.46;
  kit.ceramic.roughness = 0.48;
  kit.ceramic.envMapIntensity = 0.32;
  kit.accent.emissiveIntensity = 0;
  kit.hot.emissiveIntensity = 0;
  // The receiver is a dark structural chassis with six independent armor and
  // mechanism masses. Visible chassis gaps prevent the old single-slab read.
  profile('mg-internal-chassis', [[0.43, -0.08], [0.43, 0.1], [0.28, 0.15], [-0.18, 0.16], [-0.68, 0.13], [-1.12, 0.055], [-1.16, -0.025], [-1.06, -0.07], [-0.55, -0.09], [-0.08, -0.095]], 0.3, kit.rubber);
  profile('mg-lower-chassis-keel', [[0.28, -0.145], [-0.05, -0.13], [-0.46, -0.125], [-0.62, -0.185], [-1.04, -0.165], [-1.15, -0.08], [-0.98, -0.045], [-0.4, -0.065], [0.22, -0.075]], 0.28, kit.secondary);
  profile('mg-raised-spine', [[0.4, 0.125], [0.28, 0.205], [0.04, 0.235], [-0.36, 0.235], [-0.82, 0.185], [-1.06, 0.12], [-0.88, 0.105], [-0.28, 0.175]], 0.22, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`mg-rear-shoulder-plate-${side}`, [[0.4, -0.065], [0.38, 0.12], [0.25, 0.17], [0.04, 0.16], [-0.03, 0.07], [0.02, -0.065], [0.2, -0.1]], 0.024, kit.shell, side * 0.168);
    profile(`mg-rear-shoulder-inset-${side}`, [[0.32, -0.035], [0.3, 0.09], [0.2, 0.125], [0.08, 0.115], [0.04, 0.055], [0.08, -0.035], [0.2, -0.065]], 0.014, kit.secondary, side * 0.184);
    profile(`mg-mid-receiver-plate-${side}`, [[0.01, -0.055], [-0.03, 0.145], [-0.24, 0.18], [-0.51, 0.145], [-0.59, 0.045], [-0.51, -0.065], [-0.2, -0.09]], 0.024, kit.shell, side * 0.174);
    profile(`mg-ejection-housing-${side}`, [[-0.16, -0.02], [-0.19, 0.115], [-0.35, 0.135], [-0.5, 0.085], [-0.47, 0.0], [-0.3, -0.045]], 0.014, kit.metal, side * 0.194);
    profile(`mg-forward-plate-gasket-${side}`, [[-0.48, -0.085], [-0.5, 0.145], [-0.72, 0.175], [-1.03, 0.115], [-1.16, 0.025], [-1.06, -0.095], [-0.72, -0.12]], 0.025, kit.rubber, side * 0.178);
    profile(`mg-forward-ceramic-panel-${side}`, [[-0.51, -0.065], [-0.54, 0.125], [-0.73, 0.15], [-1.01, 0.1], [-1.12, 0.02], [-1.04, -0.075], [-0.73, -0.098]], 0.026, kit.ceramic, side * 0.194);
    profile(`mg-forward-panel-inset-${side}`, [[-0.64, -0.028], [-0.66, 0.085], [-0.78, 0.105], [-1.0, 0.06], [-1.04, 0.01], [-0.97, -0.045], [-0.76, -0.06]], 0.014, kit.secondary, side * 0.21);
    profile(`mg-lower-control-pod-${side}`, [[-0.4, -0.1], [-0.52, -0.205], [-0.91, -0.19], [-1.05, -0.095], [-0.92, -0.045], [-0.55, -0.06]], 0.024, kit.shell, side * 0.176);
    part(`mg-control-light-bed-${side}`, new RoundedBoxGeometry(0.02, 0.04, 0.16, 2, 0.008), kit.rubber, [side * 0.194, -0.145, -0.79]);
    part(`mg-control-light-${side}`, new RoundedBoxGeometry(0.022, 0.018, 0.105, 2, 0.006), kit.accent, [side * 0.207, -0.145, -0.79]);
    part(`mg-forward-captive-pin-${side}`, new THREE.CylinderGeometry(0.018, 0.018, 0.024, 10), kit.metal, [side * 0.218, -0.02, -1.02], [0, 0, Math.PI * 0.5]);
    part(`mg-upper-machined-seam-${side}`, new RoundedBoxGeometry(0.018, 0.018, 0.26, 2, 0.005), kit.metal, [side * 0.207, 0.145, -0.13]);
    part(`mg-lower-machined-seam-${side}`, new RoundedBoxGeometry(0.018, 0.016, 0.23, 2, 0.005), kit.metal, [side * 0.205, -0.074, -0.35]);
    for (let index = 0; index < 4; index += 1) {
      part(`mg-side-captive-bolt-${side}-${index}`, new THREE.CylinderGeometry(0.013, 0.013, 0.02, 10), index === 3 ? kit.hot : kit.metal, [side * 0.222, 0.13, 0.05 - index * 0.18], [0, 0, Math.PI * 0.5]);
    }
  }
  part('mg-barrel-bearing', new THREE.CylinderGeometry(0.14, 0.165, 0.25, 18), kit.secondary, [0, 0.03, -1.16], [Math.PI * 0.5, 0, 0]);
  part('mg-bearing-collar', new THREE.TorusGeometry(0.15, 0.034, 10, 28), kit.metal, [0, 0.03, -1.305]);
  part('mg-bearing-gasket', new THREE.TorusGeometry(0.118, 0.018, 8, 26), kit.rubber, [0, 0.03, -1.327]);
  part('mg-bearing-glow-ring', new THREE.TorusGeometry(0.112, 0.009, 7, 24), kit.accent, [0, 0.03, -1.33]);

  // The bullpup ammunition canister is deep enough to feel substantial, but
  // uses a chamfered perimeter and inset window instead of a vertical box.
  profile('mg-ammo-canister', [[0.73, -0.155], [0.73, 0.115], [0.64, 0.185], [0.33, 0.18], [0.23, 0.105], [0.25, -0.12], [0.34, -0.185], [0.62, -0.19]], 0.4, kit.shell);
  for (const side of [-1, 1]) {
    profile(`mg-canister-frame-${side}`, [[0.7, -0.13], [0.7, 0.09], [0.62, 0.15], [0.37, 0.145], [0.3, 0.085], [0.31, -0.1], [0.39, -0.15], [0.61, -0.155]], 0.025, kit.secondary, side * 0.214);
    profile(`mg-ammo-window-well-${side}`, [[0.625, -0.11], [0.625, 0.08], [0.56, 0.125], [0.395, 0.12], [0.35, 0.065], [0.36, -0.085], [0.425, -0.13], [0.575, -0.13]], 0.018, kit.rubber, side * 0.229);
    profile(`mg-ammo-window-${side}`, [[0.6, -0.095], [0.6, 0.067], [0.545, 0.105], [0.415, 0.1], [0.38, 0.052], [0.39, -0.07], [0.44, -0.108], [0.555, -0.108]], 0.014, kit.glass, side * 0.242);
    for (const edgeZ of [0.395, 0.585]) {
      part(`mg-window-edge-light-${side}-${edgeZ}`, new RoundedBoxGeometry(0.016, 0.145, 0.014, 2, 0.005), kit.accent, [side * 0.253, -0.005, edgeZ]);
    }
    for (let index = 0; index < 6; index += 1) {
      const y = -0.07 + index * 0.029;
      part(`mg-window-round-${side}-${index}`, new THREE.CapsuleGeometry(0.015, 0.09, 4, 10), kit.ceramic, [side * 0.257, y, 0.5], [Math.PI * 0.5, 0, 0]);
      part(`mg-window-round-tip-${side}-${index}`, new THREE.CylinderGeometry(0.007, 0.015, 0.026, 10), kit.metal, [side * 0.258, y, 0.432], [Math.PI * 0.5, 0, 0]);
      part(`mg-window-round-light-${side}-${index}`, new RoundedBoxGeometry(0.012, 0.01, 0.015, 2, 0.004), index === 0 || index === 5 ? kit.hot : kit.accent, [side * 0.267, y, 0.408]);
    }
    part(`mg-canister-latch-${side}`, new RoundedBoxGeometry(0.025, 0.055, 0.12, 2, 0.009), kit.metal, [side * 0.24, 0.13, 0.43], [0, 0, side * 0.12]);
  }
  part('mg-upper-rail', new RoundedBoxGeometry(0.13, 0.045, 1.05, 2, 0.01), kit.secondary, [0, 0.255, -0.38]);
  for (let index = 0; index < 10; index += 1) {
    part(`mg-rail-tooth-${index}`, new RoundedBoxGeometry(0.15, 0.025, 0.045, 1, 0.005), index === 9 ? kit.accent : kit.metal, [0, 0.287, 0.02 - index * 0.105]);
  }
  addTopPlate(builder, 'mg-top-rear-gasket', [[-0.185, 0.44], [0.185, 0.44], [0.17, 0.08], [0.115, 0.015], [-0.115, 0.015], [-0.17, 0.08]], 0.028, kit.rubber, 0.183);
  addTopPlate(builder, 'mg-top-rear-shell', [[-0.16, 0.41], [0.16, 0.41], [0.145, 0.1], [0.095, 0.045], [-0.095, 0.045], [-0.145, 0.1]], 0.032, kit.shell, 0.208);
  addTopPlate(builder, 'mg-top-mid-gasket', [[-0.17, 0.05], [0.17, 0.05], [0.155, -0.5], [0.105, -0.56], [-0.105, -0.56], [-0.155, -0.5]], 0.027, kit.rubber, 0.185);
  addTopPlate(builder, 'mg-top-mid-shell', [[-0.145, 0.02], [0.145, 0.02], [0.13, -0.47], [0.085, -0.525], [-0.085, -0.525], [-0.13, -0.47]], 0.035, kit.secondary, 0.211);
  addTopPlate(builder, 'mg-top-forward-shell', [[-0.17, -0.48], [0.17, -0.48], [0.135, -0.98], [0.08, -1.08], [-0.08, -1.08], [-0.135, -0.98]], 0.036, kit.ceramic, 0.155);
  part('mg-top-recess-channel', new RoundedBoxGeometry(0.06, 0.018, 0.88, 2, 0.006), kit.rubber, [0, 0.248, -0.41]);
  for (const side of [-1, 1]) {
    part(`mg-top-spine-rail-${side}`, new RoundedBoxGeometry(0.035, 0.026, 0.9, 2, 0.007), kit.metal, [side * 0.075, 0.266, -0.4]);
    for (let index = 0; index < 4; index += 1) {
      part(`mg-top-vent-${side}-${index}`, new RoundedBoxGeometry(0.034, 0.015, 0.09, 2, 0.005), kit.rubber, [side * 0.105, 0.237, -0.06 - index * 0.125], [0, side * 0.08, 0]);
      part(`mg-top-fastener-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.016, 10), index === 3 ? kit.hot : kit.metal, [side * 0.135, 0.237, 0.32 - index * 0.31]);
    }
  }
  part('mg-top-feed-connector-saddle', new RoundedBoxGeometry(0.25, 0.045, 0.13, 3, 0.014), kit.secondary, [0, 0.208, 0.38]);
  part('mg-top-feed-connector-inset', new RoundedBoxGeometry(0.14, 0.02, 0.08, 2, 0.008), kit.rubber, [0, 0.239, 0.38]);
  // Raised, split armor shoulders expose stepped height changes from the FPS
  // camera. They deliberately stop short of the centre rail and the feed bay.
  for (const side of [-1, 1]) {
    const inner = side * 0.055;
    const outer = side * 0.175;
    addTopPlate(builder, `mg-top-rear-shoulder-gasket-${side}`, [
      [inner, 0.34], [outer, 0.31], [outer, 0.1],
      [side * 0.145, 0.035], [inner, 0.065],
    ], 0.025, kit.rubber, 0.246);
    addTopPlate(builder, `mg-top-rear-shoulder-${side}`, [
      [side * 0.065, 0.315], [side * 0.154, 0.29], [side * 0.15, 0.115],
      [side * 0.126, 0.07], [side * 0.065, 0.09],
    ], 0.03, kit.ceramic, 0.269);
    addTopPlate(builder, `mg-top-mid-wing-${side}`, [
      [side * 0.06, -0.03], [side * 0.155, -0.06], [side * 0.145, -0.39],
      [side * 0.115, -0.46], [side * 0.06, -0.43],
    ], 0.028, kit.metal, 0.257);
    addTopPlate(builder, `mg-top-forward-wing-${side}`, [
      [side * 0.055, -0.48], [side * 0.145, -0.52], [side * 0.125, -0.88],
      [side * 0.075, -0.99], [side * 0.055, -0.91],
    ], 0.03, kit.secondary, 0.213);
    for (const [index, z] of [0.255, -0.16, -0.62].entries()) {
      part(`mg-top-shoulder-lock-${side}-${index}`, new THREE.CylinderGeometry(0.014, 0.014, 0.014, 10), index === 2 ? kit.hot : kit.metal, [side * 0.125, 0.29 - index * 0.021, z]);
    }
  }
  // A compact top window makes the bullpup feed unmistakable even when the
  // side window is foreshortened. These are the exposed crowns of its rounds.
  part('mg-top-ammo-window-well', new RoundedBoxGeometry(0.15, 0.018, 0.29, 3, 0.012), kit.rubber, [-0.105, 0.283, 0.255], [0, 0, -0.025]);
  part('mg-top-ammo-window-glass', new RoundedBoxGeometry(0.112, 0.012, 0.25, 3, 0.01), kit.glass, [-0.105, 0.297, 0.255], [0, 0, -0.025]);
  for (let index = 0; index < 4; index += 1) {
    const z = 0.34 - index * 0.058;
    part(`mg-top-visible-round-${index}`, new THREE.CapsuleGeometry(0.012, 0.07, 4, 10), kit.ceramic, [-0.105, 0.307, z], [0, 0, Math.PI * 0.5]);
    part(`mg-top-visible-round-tip-${index}`, new THREE.CylinderGeometry(0.006, 0.012, 0.018, 9), kit.metal, [-0.105, 0.31, z - 0.047], [Math.PI * 0.5, 0, 0]);
  }
  // The rotor carrier rises above the barrel centreline: two bearing towers,
  // a bridged clamp, and exposed upper sleeves keep all four short tubes legible.
  part('mg-top-rotor-cradle', new RoundedBoxGeometry(0.27, 0.055, 0.18, 3, 0.016), kit.secondary, [0, 0.13, -1.25]);
  part('mg-top-rotor-cradle-recess', new RoundedBoxGeometry(0.17, 0.02, 0.105, 2, 0.008), kit.rubber, [0, 0.169, -1.27]);
  for (const side of [-1, 1]) {
    part(`mg-top-rotor-bearing-${side}`, new THREE.CylinderGeometry(0.052, 0.058, 0.075, 16), kit.metal, [side * 0.074, 0.175, -1.29]);
    part(`mg-top-rotor-bearing-lock-${side}`, new THREE.TorusGeometry(0.054, 0.009, 7, 18), kit.accent, [side * 0.074, 0.216, -1.29], [Math.PI * 0.5, 0, 0]);
    part(`mg-top-upper-barrel-sleeve-${side}`, new THREE.CapsuleGeometry(0.027, 0.17, 5, 12), kit.metal, [side * 0.052, 0.14, -1.43], [Math.PI * 0.5, 0, 0]);
  }
  const triggerGuardCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.09, -0.34),
    new THREE.Vector3(0, -0.235, -0.32),
    new THREE.Vector3(0, -0.255, -0.13),
    new THREE.Vector3(0, -0.14, -0.065),
  ], false, 'centripetal');
  part('mg-resolved-trigger-guard', new THREE.TubeGeometry(triggerGuardCurve, 28, 0.015, 8, false), kit.metal, [0, 0, 0]);
  part('mg-resolved-trigger', new RoundedBoxGeometry(0.035, 0.105, 0.025, 2, 0.007), kit.ceramic, [0, -0.155, -0.16], [0.2, 0, 0]);
  const rotor = new THREE.Group();
  rotor.name = 'mg-barrel-cluster';
  rotor.position.set(0, 0.03, -1.27);
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.043, 0.22, 14), kit.metal);
    barrel.name = `mg-barrel-${index}`;
    barrel.position.set(Math.cos(angle) * 0.07, Math.sin(angle) * 0.07, -0.11);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.frustumCulled = false;
    rotor.add(barrel);
    const muzzleSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.048, 0.075, 16), kit.secondary);
    muzzleSleeve.name = `mg-muzzle-sleeve-${index}`;
    muzzleSleeve.position.set(Math.cos(angle) * 0.07, Math.sin(angle) * 0.07, -0.25);
    muzzleSleeve.rotation.x = Math.PI * 0.5;
    rotor.add(muzzleSleeve);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.009, 7, 18), kit.metal);
    muzzle.position.set(Math.cos(angle) * 0.07, Math.sin(angle) * 0.07, -0.295);
    rotor.add(muzzle);
    const bore = new THREE.Mesh(new THREE.CircleGeometry(0.031, 14), kit.rubber);
    bore.position.set(Math.cos(angle) * 0.07, Math.sin(angle) * 0.07, -0.306);
    rotor.add(bore);
    for (const collarZ of [-0.055, -0.16]) {
      const support = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.005, 6, 14), kit.secondary);
      support.position.set(Math.cos(angle) * 0.07, Math.sin(angle) * 0.07, collarZ);
      rotor.add(support);
    }
  }
  for (const [ringIndex, ringZ] of [-0.025, -0.17].entries()) {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.108, ringIndex === 0 ? 0.021 : 0.014, 8, 24), ringIndex === 1 ? kit.secondary : kit.metal);
    collar.name = `mg-cluster-carrier-${ringIndex}`;
    collar.position.z = ringZ;
    rotor.add(collar);
  }
  const muzzleCage = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.018, 8, 28), kit.secondary);
  muzzleCage.name = 'mg-muzzle-cage';
  muzzleCage.position.z = -0.311;
  rotor.add(muzzleCage);
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5 + Math.PI * 0.25;
    const bridge = new THREE.Mesh(new RoundedBoxGeometry(0.022, 0.075, 0.025, 2, 0.006), kit.metal);
    bridge.name = `mg-muzzle-cage-bridge-${index}`;
    bridge.position.set(Math.cos(angle) * 0.097, Math.sin(angle) * 0.097, -0.31);
    bridge.rotation.z = angle;
    rotor.add(bridge);
  }
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5;
    const status = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.04, 0.016, 2, 0.005), kit.accent);
    status.position.set(Math.cos(angle) * 0.121, Math.sin(angle) * 0.121, -0.175);
    status.rotation.z = angle;
    rotor.add(status);
  }
  builder.root.add(rotor);
  animatedRotors.push(rotor);
  addFasteners(builder, 0.22, 0.02, 0.42, 6);
  addSignalTicks(builder, -0.12, 0.22, 5);
  return -1.59;
}

function addShotgun(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  // Blued receiver steel, oxidized bronze hardware, and worn anodized orange
  // need controlled highlights rather than the bright toy-plastic response of
  // a uniformly polished material.
  kit.shell.metalness = 0.62;
  kit.shell.roughness = 0.39;
  kit.shell.envMapIntensity = 0.3;
  kit.secondary.metalness = 0.8;
  kit.secondary.roughness = 0.33;
  kit.secondary.envMapIntensity = 0.43;
  kit.metal.envMapIntensity = 0.68;
  kit.ceramic.roughness = 0.5;
  kit.ceramic.envMapIntensity = 0.34;
  kit.accent.emissiveIntensity = 0.22;
  kit.hot.emissiveIntensity = 0.3;
  profile('shotgun-receiver', [
    [0.49, -0.11], [0.49, 0.105], [0.39, 0.18], [0.08, 0.205],
    [-0.28, 0.18], [-0.55, 0.105], [-0.62, -0.015], [-0.52, -0.135],
    [-0.16, -0.155], [0.23, -0.145],
  ], 0.46, kit.shell);
  profile('shotgun-upper-receiver-spine', [[0.42, 0.12], [0.32, 0.205], [-0.2, 0.225], [-0.54, 0.15], [-0.4, 0.11], [0.05, 0.155]], 0.29, kit.secondary);
  profile('shotgun-lower-receiver-keel', [[0.35, -0.15], [0.12, -0.175], [-0.34, -0.17], [-0.57, -0.11], [-0.48, -0.055], [-0.05, -0.09], [0.28, -0.09]], 0.36, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`shotgun-orange-panel-gasket-${side}`, [[0.105, -0.015], [0.085, 0.15], [-0.19, 0.17], [-0.46, 0.095], [-0.425, -0.045], [-0.145, -0.08]], 0.024, kit.rubber, side * 0.238);
    profile(`shotgun-orange-side-panel-${side}`, [[0.08, 0.005], [0.06, 0.135], [-0.18, 0.15], [-0.43, 0.085], [-0.39, -0.025], [-0.15, -0.06]], 0.024, kit.ceramic, side * 0.242);
    profile(`shotgun-side-backplate-${side}`, [[0.43, -0.09], [0.42, 0.105], [0.31, 0.155], [0.17, 0.14], [0.13, -0.08], [0.24, -0.12]], 0.018, kit.secondary, side * 0.247);
    profile(`shotgun-bronze-side-rail-${side}`, [[0.3, 0.14], [0.2, 0.2], [-0.34, 0.19], [-0.5, 0.13], [-0.32, 0.12], [0.12, 0.15]], 0.026, kit.metal, side * 0.252);
    profile(`shotgun-side-mechanism-inset-${side}`, [[0.31, -0.04], [0.28, 0.075], [0.1, 0.105], [-0.09, 0.08], [-0.13, -0.035], [0.04, -0.075]], 0.012, kit.rubber, side * 0.262);
    part(`shotgun-rear-lock-wheel-${side}`, new THREE.CylinderGeometry(0.032, 0.032, 0.024, 12), kit.metal, [side * 0.267, 0.035, 0.31], [0, 0, Math.PI * 0.5]);
    for (const [boltIndex, y, z] of [[0, 0.12, -0.03], [1, 0.105, -0.35], [2, -0.02, -0.31]] as const) {
      part(`shotgun-orange-panel-bolt-${side}-${boltIndex}`, new THREE.CylinderGeometry(0.013, 0.013, 0.021, 10), boltIndex === 0 ? kit.hot : kit.metal, [side * 0.258, y, z], [0, 0, Math.PI * 0.5]);
    }
    for (let index = 0; index < 3; index += 1) {
      part(`shotgun-rear-vent-${side}-${index}`, new RoundedBoxGeometry(0.016, 0.02, 0.095, 2, 0.006), kit.metal, [side * 0.271, 0.08 - index * 0.038, 0.24]);
    }
  }
  addTopPlate(builder, 'shotgun-top-rear-gasket', [[-0.225, 0.48], [0.225, 0.48], [0.205, 0.12], [0.145, 0.055], [-0.145, 0.055], [-0.205, 0.12]], 0.028, kit.rubber, 0.17);
  addTopPlate(builder, 'shotgun-top-rear-armor', [[-0.2, 0.45], [0.2, 0.45], [0.18, 0.145], [0.125, 0.09], [-0.125, 0.09], [-0.18, 0.145]], 0.036, kit.metal, 0.197);
  addTopPlate(builder, 'shotgun-top-orange-gasket', [[-0.22, 0.12], [0.22, 0.12], [0.205, -0.43], [0.145, -0.5], [-0.145, -0.5], [-0.205, -0.43]], 0.027, kit.rubber, 0.176);
  addTopPlate(builder, 'shotgun-top-orange-armor', [[-0.195, 0.09], [0.195, 0.09], [0.18, -0.4], [0.125, -0.465], [-0.125, -0.465], [-0.18, -0.4]], 0.038, kit.ceramic, 0.204);
  part('shotgun-top-cycle-channel', new RoundedBoxGeometry(0.09, 0.02, 0.42, 2, 0.007), kit.rubber, [0, 0.232, -0.17]);
  part('shotgun-top-cycle-bolt', new RoundedBoxGeometry(0.052, 0.025, 0.14, 3, 0.009), kit.metal, [0, 0.248, -0.1]);
  for (const side of [-1, 1]) {
    for (let index = 0; index < 3; index += 1) {
      part(`shotgun-top-receiver-bolt-${side}-${index}`, new THREE.CylinderGeometry(0.013, 0.013, 0.017, 10), index === 2 ? kit.hot : kit.metal, [side * 0.155, 0.23, 0.34 - index * 0.34]);
    }
  }
  for (const [saddleIndex, z] of [-0.66, -1.08, -1.49].entries()) {
    addTopPlate(builder, `shotgun-top-barrel-saddle-${saddleIndex}`, [[-0.17, z + 0.05], [0.17, z + 0.05], [0.15, z - 0.05], [-0.15, z - 0.05]], 0.035, saddleIndex === 1 ? kit.ceramic : kit.metal, 0.185);
    for (const side of [-1, 1]) {
      part(`shotgun-top-saddle-fastener-${saddleIndex}-${side}`, new THREE.CylinderGeometry(0.013, 0.013, 0.018, 10), kit.secondary, [side * 0.12, 0.217, z]);
    }
  }
  // Split breach laminations give the broad orange deck a hard mechanical
  // hierarchy: gasket, bronze locking ledge, then narrower armored cover.
  for (const side of [-1, 1]) {
    addTopPlate(builder, `shotgun-top-breach-wing-gasket-${side}`, [
      [side * 0.05, 0.08], [side * 0.205, 0.06], [side * 0.195, -0.39],
      [side * 0.145, -0.455], [side * 0.05, -0.42],
    ], 0.024, kit.rubber, 0.225);
    addTopPlate(builder, `shotgun-top-breach-locking-wing-${side}`, [
      [side * 0.062, 0.045], [side * 0.18, 0.025], [side * 0.17, -0.31],
      [side * 0.132, -0.375], [side * 0.062, -0.35],
    ], 0.031, side < 0 ? kit.metal : kit.ceramic, 0.248);
    part(`shotgun-top-breach-edge-${side}`, new RoundedBoxGeometry(0.022, 0.025, 0.35, 2, 0.006), kit.metal, [side * 0.178, 0.266, -0.16], [0, side * 0.035, 0]);
    for (const [lockIndex, z] of [-0.01, -0.31].entries()) {
      part(`shotgun-top-breach-wing-lock-${side}-${lockIndex}`, new THREE.CylinderGeometry(0.014, 0.014, 0.014, 10), lockIndex ? kit.secondary : kit.hot, [side * 0.14, 0.272, z]);
    }
  }
  part('shotgun-top-breech-crossbolt', new RoundedBoxGeometry(0.34, 0.052, 0.085, 3, 0.012), kit.metal, [0, 0.224, -0.51]);
  part('shotgun-top-breech-crossbolt-inset', new RoundedBoxGeometry(0.2, 0.018, 0.044, 2, 0.006), kit.rubber, [0, 0.262, -0.51]);
  // The pump stays cylindrical and low, while these exposed edge ribs and
  // clamp ears let its deep ribbing survive the downward FPS sightline.
  for (let index = 0; index < 7; index += 1) {
    const z = -0.86 - index * 0.064;
    for (const side of [-1, 1]) {
      part(`shotgun-pump-top-rib-cap-${side}-${index}`, new RoundedBoxGeometry(0.034, 0.04, 0.027, 2, 0.008), index === 6 ? kit.ceramic : kit.secondary, [side * 0.164, -0.005, z], [0, 0, side * 0.11]);
    }
  }
  for (const [index, z] of [-0.78, -1.3].entries()) {
    part(`shotgun-pump-top-clamp-${index}`, new RoundedBoxGeometry(0.36, 0.042, 0.06, 3, 0.012), kit.metal, [0, 0.04, z]);
    part(`shotgun-pump-top-clamp-hinge-${index}`, new THREE.CylinderGeometry(0.022, 0.022, 0.045, 12), kit.secondary, [-0.165, 0.068, z]);
    part(`shotgun-pump-top-clamp-lock-${index}`, new THREE.CylinderGeometry(0.014, 0.014, 0.048, 10), kit.hot, [0.165, 0.07, z]);
  }
  part('shotgun-breech-block', new RoundedBoxGeometry(0.38, 0.27, 0.16, 4, 0.026), kit.secondary, [0, 0.03, -0.53]);
  part('shotgun-breech-gasket', new RoundedBoxGeometry(0.34, 0.225, 0.045, 3, 0.016), kit.rubber, [0, 0.03, -0.625]);
  for (const side of [-1, 1]) {
    profile(`shotgun-orange-transition-shroud-${side}`, [[-0.43, -0.09], [-0.46, 0.14], [-0.59, 0.16], [-0.69, 0.105], [-0.69, -0.085], [-0.58, -0.12]], 0.022, kit.ceramic, side * 0.205);
    profile(`shotgun-transition-shroud-inset-${side}`, [[-0.49, -0.06], [-0.51, 0.105], [-0.6, 0.12], [-0.66, 0.08], [-0.66, -0.055], [-0.58, -0.085]], 0.014, kit.rubber, side * 0.218);
    part(`shotgun-breech-lock-bar-${side}`, new RoundedBoxGeometry(0.026, 0.19, 0.12, 2, 0.009), kit.metal, [side * 0.205, 0.03, -0.54]);
    part(`shotgun-breech-lock-pin-${side}`, new THREE.CylinderGeometry(0.018, 0.018, 0.025, 10), kit.ceramic, [side * 0.22, -0.05, -0.55], [0, 0, Math.PI * 0.5]);
    part(`shotgun-barrel-side-rail-${side}`, new RoundedBoxGeometry(0.026, 0.027, 0.92, 2, 0.006), kit.metal, [side * 0.155, 0.03, -1.12]);
  }
  for (const [barrelIndex, y] of [0.105, -0.045].entries()) {
    part(`shotgun-barrel-${barrelIndex}`, new THREE.CylinderGeometry(0.07, 0.078, 1.18, 20), kit.metal, [0, y, -1.08], [Math.PI * 0.5, 0, 0]);
    part(`shotgun-breech-sleeve-${barrelIndex}`, new THREE.CylinderGeometry(0.084, 0.084, 0.25, 18), kit.secondary, [0, y, -0.54], [Math.PI * 0.5, 0, 0]);
    part(`shotgun-muzzle-brake-${barrelIndex}`, new THREE.CylinderGeometry(0.078, 0.086, 0.2, 18), kit.secondary, [0, y, -1.7], [Math.PI * 0.5, 0, 0]);
    part(`shotgun-muzzle-rim-${barrelIndex}`, new THREE.TorusGeometry(0.081, 0.01, 8, 22), kit.metal, [0, y, -1.81]);
    part(`shotgun-bore-${barrelIndex}`, new THREE.CircleGeometry(0.057, 20), kit.rubber, [0, y, -1.822]);
    for (const side of [-1, 1]) {
      for (let portIndex = 0; portIndex < 3; portIndex += 1) {
        part(
          `shotgun-brake-port-${barrelIndex}-${side}-${portIndex}`,
          new RoundedBoxGeometry(0.012, 0.025, 0.035, 2, 0.006),
          kit.rubber,
          [side * 0.08, y, -1.65 - portIndex * 0.05],
        );
      }
    }
  }
  const pump = new THREE.Group();
  pump.name = 'shotgun-pump';
  pump.position.set(0, -0.145, -1.05);
  const pumpBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.38, 8, 18), kit.shell);
  pumpBody.name = 'shotgun-pump-body';
  pumpBody.rotation.x = Math.PI * 0.5;
  pumpBody.scale.x = 1.48;
  pump.add(pumpBody);
  for (let index = -4; index <= 4; index += 1) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.119, 0.011, 7, 20), index === 4 ? kit.ceramic : kit.rubber);
    rib.name = `shotgun-pump-rib-${index + 4}`;
    rib.position.z = index * 0.055;
    rib.scale.x = 1.48;
    pump.add(rib);
  }
  for (const endZ of [-0.295, 0.295]) {
    const endBand = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.017, 8, 22), kit.metal);
    endBand.name = `shotgun-pump-end-band-${endZ}`;
    endBand.position.z = endZ;
    endBand.scale.x = 1.48;
    pump.add(endBand);
  }
  builder.root.add(pump);
  animatedSlides.push(pump);
  for (const side of [-1, 1]) {
    part(`shotgun-pump-action-bar-${side}`, new RoundedBoxGeometry(0.025, 0.025, 0.78, 2, 0.006), kit.metal, [side * 0.175, -0.08, -0.84]);
  }
  const shellSide = -1;
  part('shotgun-shell-rack-frame', new RoundedBoxGeometry(0.026, 0.265, 0.5, 3, 0.018), kit.metal, [shellSide * 0.26, 0.045, -0.06]);
  part('shotgun-shell-rack-backplate', new RoundedBoxGeometry(0.029, 0.21, 0.445, 3, 0.013), kit.rubber, [shellSide * 0.271, 0.045, -0.06]);
  part('shotgun-shell-rack-top-rail', new RoundedBoxGeometry(0.033, 0.026, 0.455, 2, 0.007), kit.secondary, [shellSide * 0.282, 0.16, -0.06]);
  part('shotgun-shell-rack-bottom-rail', new RoundedBoxGeometry(0.033, 0.026, 0.455, 2, 0.007), kit.secondary, [shellSide * 0.282, -0.07, -0.06]);
  for (let index = 0; index < 4; index += 1) {
    const z = 0.095 - index * 0.105;
    part(`shell-${shellSide}-${index}`, new THREE.CylinderGeometry(0.032, 0.032, 0.14, 16), kit.ceramic, [shellSide * 0.288, 0.05, z]);
    part(`shell-brass-cap-${shellSide}-${index}`, new THREE.CylinderGeometry(0.034, 0.034, 0.026, 16), kit.metal, [shellSide * 0.288, -0.033, z]);
    part(`shell-primer-${shellSide}-${index}`, new THREE.CylinderGeometry(0.011, 0.011, 0.028, 10), index === 3 ? kit.hot : kit.secondary, [shellSide * 0.288, -0.05, z]);
    part(`shell-retainer-${shellSide}-${index}`, new RoundedBoxGeometry(0.026, 0.042, 0.064, 2, 0.008), kit.secondary, [shellSide * 0.303, 0.06, z]);
    // Exactly four crimped shell crowns are raised into the top silhouette;
    // they continue the existing side-mounted rounds rather than duplicating them.
    part(`shell-visible-crimp-${shellSide}-${index}`, new THREE.CylinderGeometry(0.026, 0.031, 0.024, 14), kit.ceramic, [shellSide * 0.288, 0.132, z]);
    part(`shell-visible-retainer-tab-${shellSide}-${index}`, new RoundedBoxGeometry(0.045, 0.014, 0.052, 2, 0.007), kit.metal, [shellSide * 0.26, 0.151, z]);
  }
  const mechanismSide = 1;
  part('shotgun-cycle-mechanism-frame', new RoundedBoxGeometry(0.027, 0.17, 0.46, 3, 0.014), kit.metal, [mechanismSide * 0.27, 0.045, -0.08]);
  part('shotgun-cycle-mechanism-track', new RoundedBoxGeometry(0.031, 0.09, 0.32, 3, 0.012), kit.rubber, [mechanismSide * 0.286, 0.045, -0.08]);
  part('shotgun-cycle-mechanism-bolt', new THREE.CapsuleGeometry(0.034, 0.15, 5, 14), kit.metal, [mechanismSide * 0.306, 0.045, -0.08], [Math.PI * 0.5, 0, 0]);
  part('shotgun-cycle-mechanism-cam', new THREE.CylinderGeometry(0.046, 0.046, 0.035, 14), kit.ceramic, [mechanismSide * 0.315, 0.045, 0.095], [0, 0, Math.PI * 0.5]);

  const triggerGuardCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.095, -0.32),
    new THREE.Vector3(0, -0.225, -0.3),
    new THREE.Vector3(0, -0.245, -0.12),
    new THREE.Vector3(0, -0.14, -0.06),
  ], false, 'centripetal');
  part('shotgun-resolved-trigger-guard', new THREE.TubeGeometry(triggerGuardCurve, 28, 0.021, 10, false), kit.metal, [0, 0, 0]);
  part('shotgun-resolved-trigger', new RoundedBoxGeometry(0.036, 0.102, 0.026, 2, 0.007), kit.ceramic, [0, -0.158, -0.155], [0.22, 0, 0]);
  addFasteners(builder, 0.22, 0.015, 0.5, 5);
  return -1.84;
}

function addRocketLauncher(builder: Builder): number {
  const { part, profile, kit, animatedRotors } = builder;
  const centerY = 0.15;
  kit.shell.roughness = 0.38;
  kit.secondary.roughness = 0.31;
  kit.metal.roughness = 0.24;
  kit.ceramic.roughness = 0.46;
  kit.ceramic.clearcoat = 0.12;
  const addBrace = (
    name: string,
    start: [number, number, number],
    end: [number, number, number],
    radius: number,
    material: THREE.Material,
  ): THREE.Mesh => {
    const from = new THREE.Vector3(...start);
    const to = new THREE.Vector3(...end);
    const direction = to.clone().sub(from);
    const mesh = part(
      name,
      new THREE.CapsuleGeometry(radius, Math.max(0.01, direction.length() - radius * 2), 6, 12),
      material,
      from.clone().add(to).multiplyScalar(0.5).toArray() as [number, number, number],
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  };

  // Four visibly different pressure stages replace the old single thick
  // capsule. Radius changes, collar gaps, and the exposed rails now carry the
  // silhouette in the same way as the reference launcher.
  part('rocket-rear-propellant-chamber', new THREE.CylinderGeometry(0.225, 0.235, 0.82, 24, 1, false), kit.ceramic, [0, centerY, -0.02], [Math.PI * 0.5, 0, 0]);
  part('rocket-mid-pressure-tube', new THREE.CylinderGeometry(0.19, 0.215, 0.66, 24, 1, false), kit.ceramic, [0, centerY, -0.73], [Math.PI * 0.5, 0, 0]);
  part('rocket-forward-guide-tube', new THREE.CylinderGeometry(0.16, 0.18, 0.66, 24, 1, false), kit.secondary, [0, centerY, -1.34], [Math.PI * 0.5, 0, 0]);
  part('rocket-forward-pressure-chamber', new THREE.CylinderGeometry(0.225, 0.17, 0.43, 20, 1, false), kit.secondary, [0, centerY, -1.86], [Math.PI * 0.5, 0, 0]);

  // Separate, thin armor islands let the cylindrical construction and
  // changing diameter remain readable instead of creating one flat side wall.
  for (const side of [-1, 1]) {
    profile(`rocket-rear-service-panel-${side}`, [[0.31, 0.045], [0.28, 0.26], [-0.12, 0.31], [-0.36, 0.23], [-0.34, 0.04], [-0.08, 0.005]], 0.021, kit.ceramic, side * 0.234);
    profile(`rocket-mid-service-panel-${side}`, [[-0.42, 0.06], [-0.5, 0.27], [-0.84, 0.27], [-1.02, 0.19], [-0.96, 0.035], [-0.62, 0.015]], 0.02, kit.secondary, side * 0.218);
    profile(`rocket-forward-service-panel-${side}`, [[-1.08, 0.06], [-1.15, 0.22], [-1.48, 0.22], [-1.63, 0.16], [-1.55, 0.02], [-1.22, 0.01]], 0.018, kit.ceramic, side * 0.184);
    profile(`rocket-rear-shadow-recess-${side}`, [[0.2, 0.08], [0.15, 0.22], [-0.08, 0.25], [-0.25, 0.19], [-0.22, 0.08], [-0.02, 0.045]], 0.012, kit.secondary, side * 0.247);
    profile(`rocket-mid-shadow-recess-${side}`, [[-0.54, 0.09], [-0.59, 0.21], [-0.79, 0.215], [-0.91, 0.17], [-0.86, 0.08], [-0.65, 0.055]], 0.011, kit.secondary, side * 0.231);
    part(`rocket-longitudinal-rail-${side}`, new RoundedBoxGeometry(0.038, 0.044, 1.75, 2, 0.009), kit.metal, [side * 0.242, centerY, -0.7]);
    for (let index = 0; index < 6; index += 1) {
      const z = 0.08 - index * 0.315;
      part(`rocket-rail-saddle-${side}-${index}`, new RoundedBoxGeometry(0.062, 0.08, 0.04, 2, 0.008), index === 4 ? kit.accent : kit.metal, [side * 0.244, centerY, z], [0, 0, side * 0.08]);
    }
    part(`rocket-lower-truss-${side}`, new RoundedBoxGeometry(0.032, 0.045, 0.94, 2, 0.008), kit.metal, [side * 0.205, -0.105, -0.7], [-0.055, 0, 0]);
    for (let index = 0; index < 4; index += 1) {
      part(`rocket-truss-web-${side}-${index}`, new RoundedBoxGeometry(0.03, 0.21, 0.032, 2, 0.007), kit.metal, [side * 0.205, -0.015, -0.38 - index * 0.24], [0, 0, side * (index % 2 ? -0.18 : 0.18)]);
    }
    for (let index = 0; index < 3; index += 1) {
      part(`rocket-forward-vent-${side}-${index}`, new RoundedBoxGeometry(0.012, 0.032, 0.085, 2, 0.007), kit.rubber, [side * 0.197, 0.125, -1.22 - index * 0.11], [0.06, 0, 0]);
    }
    part(`rocket-armor-seam-${side}`, new RoundedBoxGeometry(0.014, 0.018, 0.31, 2, 0.005), kit.metal, [side * 0.252, 0.075, -0.06], [0, 0, side * 0.05]);
    // A true triangular load brace connects the rear fire-control block to
    // the forward pressure stage. It remains open through the middle.
    addBrace(`rocket-lower-brace-rear-${side}`, [side * 0.22, -0.04, 0.12], [side * 0.22, -0.19, -0.58], 0.018, kit.metal);
    addBrace(`rocket-lower-brace-front-${side}`, [side * 0.22, -0.19, -0.58], [side * 0.2, -0.025, -1.28], 0.018, kit.metal);
    part(`rocket-lower-brace-joint-${side}`, new THREE.CylinderGeometry(0.036, 0.036, 0.025, 12), kit.secondary, [side * 0.235, -0.19, -0.58], [0, 0, Math.PI * 0.5]);
  }

  // The muzzle is imposing but only the final mantlet flares to this diameter;
  // most of the launcher stays lean.
  part('rocket-front-mantlet', new THREE.CylinderGeometry(0.315, 0.235, 0.27, 8), kit.ceramic, [0, centerY, -2.18], [Math.PI * 0.5, 0, Math.PI / 8]);
  part('rocket-muzzle-armor-ring', new THREE.TorusGeometry(0.294, 0.034, 8, 24), kit.metal, [0, centerY, -2.335]);
  part('rocket-muzzle-gasket', new THREE.TorusGeometry(0.235, 0.036, 10, 28), kit.rubber, [0, centerY, -2.35]);
  part('rocket-hot-ring', new THREE.TorusGeometry(0.198, 0.012, 8, 28), kit.hot, [0, centerY, -2.366]);
  part('rocket-recessed-bore-wall', new THREE.CylinderGeometry(0.183, 0.183, 0.3, 24, 1, true), kit.rubber, [0, centerY, -2.22], [Math.PI * 0.5, 0, 0]);
  part('rocket-inner-bore', new THREE.CircleGeometry(0.18, 28), kit.rubber, [0, centerY, -2.382]);
  part('rocket-bore-throat', new THREE.CircleGeometry(0.078, 22), kit.rubber, [0, centerY, -2.39]);
  for (let index = 0; index < 4; index += 1) {
    const angle = Math.PI * 0.25 + index * Math.PI * 0.5;
    part(`rocket-muzzle-jaw-${index}`, new RoundedBoxGeometry(0.08, 0.16, 0.12, 2, 0.012), kit.shell, [Math.cos(angle) * 0.286, centerY + Math.sin(angle) * 0.286, -2.27], [0, 0, angle]);
  }
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    part(`rocket-mantlet-bolt-${index}`, new THREE.CylinderGeometry(0.014, 0.014, 0.018, 8), index === 0 ? kit.hot : kit.metal, [Math.cos(angle) * 0.248, centerY + Math.sin(angle) * 0.248, -2.305], [Math.PI * 0.5, 0, 0]);
  }

  // Compact rear venturi and turbine: narrower than the body, with a visible
  // throat and individual exhaust vanes rather than a blunt capsule end.
  part('rocket-rear-venturi', new THREE.CylinderGeometry(0.135, 0.215, 0.3, 18, 1, false), kit.secondary, [0, centerY, 0.53], [Math.PI * 0.5, 0, 0]);
  part('rocket-rear-throat', new THREE.TorusGeometry(0.148, 0.022, 8, 24), kit.metal, [0, centerY, 0.7]);
  part('rocket-rear-core', new THREE.CircleGeometry(0.095, 20), kit.rubber, [0, centerY, 0.715]);
  // Staggered annuli sit at real depth offsets rather than sharing one face,
  // so the rear mechanism reads as a machined venturi from above.
  part('rocket-rear-annulus-outer', new THREE.TorusGeometry(0.176, 0.014, 8, 30), kit.ceramic, [0, centerY, 0.706]);
  part('rocket-rear-annulus-mid', new THREE.TorusGeometry(0.119, 0.012, 8, 26), kit.metal, [0, centerY, 0.724]);
  part('rocket-rear-annulus-hot', new THREE.TorusGeometry(0.067, 0.009, 7, 22), kit.hot, [0, centerY, 0.744]);
  part('rocket-rear-annulus-hub', new THREE.CylinderGeometry(0.027, 0.039, 0.038, 14), kit.secondary, [0, centerY, 0.753], [Math.PI * 0.5, 0, 0]);
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    const blade = part(`rocket-rear-turbine-blade-${index}`, new RoundedBoxGeometry(0.025, 0.095, 0.02, 2, 0.005), index % 2 ? kit.metal : kit.secondary, [Math.cos(angle) * 0.078, centerY + Math.sin(angle) * 0.078, 0.728], [0, 0, angle]);
    if (index === 0) animatedRotors.push(blade);
  }
  part('rocket-rear-igniter', new THREE.CircleGeometry(0.025, 14), kit.hot, [0, centerY, 0.738]);
  part('rocket-rear-fin-cage-ring', new THREE.TorusGeometry(0.21, 0.022, 8, 26), kit.metal, [0, centerY, 0.69]);
  for (let index = 0; index < 6; index += 1) {
    const angle = index / 6 * Math.PI * 2;
    part(`rocket-rear-cage-fin-${index}`, new RoundedBoxGeometry(0.045, 0.17, 0.26, 2, 0.01), index % 2 ? kit.secondary : kit.metal, [Math.cos(angle) * 0.215, centerY + Math.sin(angle) * 0.215, 0.69], [0, 0, angle]);
    part(`rocket-rear-cage-fin-tip-${index}`, new RoundedBoxGeometry(0.05, 0.055, 0.1, 2, 0.008), kit.ceramic, [Math.cos(angle) * 0.292, centerY + Math.sin(angle) * 0.292, 0.77], [0, 0, angle]);
  }

  const collars: Array<[number, number, THREE.Material]> = [
    [0.39, 0.236, kit.metal], [-0.39, 0.232, kit.metal], [-1.04, 0.195, kit.metal],
    [-1.66, 0.185, kit.metal], [-2.02, 0.238, kit.metal],
  ];
  collars.forEach(([z, radius, material], index) => {
    part(`rocket-stage-collar-${index}`, new THREE.TorusGeometry(radius, index === 4 ? 0.029 : 0.021, 8, 28), material, [0, centerY, z]);
    for (const side of [-1, 1]) {
      part(`rocket-stage-collar-bolt-${index}-${side}`, new THREE.CylinderGeometry(0.014, 0.014, 0.023, 8), index === 4 ? kit.hot : kit.metal, [side * radius, centerY, z], [0, 0, Math.PI * 0.5]);
      part(`rocket-stage-side-shoe-${index}-${side}`, new RoundedBoxGeometry(0.055, 0.12, 0.075, 2, 0.009), kit.metal, [side * (radius + 0.012), centerY, z]);
    }
    part(`rocket-stage-top-shoe-${index}`, new RoundedBoxGeometry(0.13, 0.055, 0.075, 2, 0.009), kit.metal, [0, centerY + radius + 0.012, z]);
    part(`rocket-stage-bottom-shoe-${index}`, new RoundedBoxGeometry(0.13, 0.055, 0.075, 2, 0.009), kit.metal, [0, centerY - radius - 0.012, z]);
    // Raised saddle bridges turn each pressure-stage break into a readable
    // top bracket, with a dark mechanical joint and visible captive bolts.
    part(`rocket-stage-top-bridge-${index}`, new RoundedBoxGeometry(0.235, 0.04, 0.105, 3, 0.012), index === 2 || index === 4 ? kit.ceramic : kit.secondary, [0, centerY + radius + 0.058, z]);
    part(`rocket-stage-top-bridge-joint-${index}`, new RoundedBoxGeometry(0.105, 0.016, 0.054, 2, 0.006), kit.rubber, [0, centerY + radius + 0.087, z]);
    for (const side of [-1, 1]) {
      part(`rocket-stage-top-bridge-bolt-${index}-${side}`, new THREE.CylinderGeometry(0.013, 0.013, 0.014, 10), index === 4 && side === 1 ? kit.hot : kit.metal, [side * 0.088, centerY + radius + 0.104, z]);
    }
  });

  addTopPlate(builder, 'rocket-top-rear-gasket', [[-0.195, 0.32], [0.195, 0.32], [0.185, -0.32], [0.125, -0.38], [-0.125, -0.38], [-0.185, -0.32]], 0.028, kit.rubber, 0.37);
  addTopPlate(builder, 'rocket-top-rear-shell', [[-0.17, 0.29], [0.17, 0.29], [0.16, -0.29], [0.105, -0.35], [-0.105, -0.35], [-0.16, -0.29]], 0.034, kit.ceramic, 0.391);
  addTopPlate(builder, 'rocket-top-mid-gasket', [[-0.18, -0.38], [0.18, -0.38], [0.16, -0.98], [0.105, -1.04], [-0.105, -1.04], [-0.16, -0.98]], 0.026, kit.rubber, 0.346);
  addTopPlate(builder, 'rocket-top-mid-shell', [[-0.155, -0.41], [0.155, -0.41], [0.14, -0.95], [0.09, -1.01], [-0.09, -1.01], [-0.14, -0.95]], 0.032, kit.secondary, 0.366);
  addTopPlate(builder, 'rocket-top-forward-shell', [[-0.145, -1.03], [0.145, -1.03], [0.12, -1.56], [0.07, -1.64], [-0.07, -1.64], [-0.12, -1.56]], 0.032, kit.ceramic, 0.318);
  part('rocket-top-spine', new RoundedBoxGeometry(0.085, 0.045, 1.64, 3, 0.012), kit.metal, [0, 0.407, -0.72]);
  part('rocket-bottom-spine', new RoundedBoxGeometry(0.085, 0.045, 1.56, 3, 0.012), kit.metal, [0, -0.09, -0.72]);
  for (let index = 0; index < 11; index += 1) {
    part(`rocket-top-rail-tooth-${index}`, new RoundedBoxGeometry(0.11, 0.018, 0.04, 1, 0.005), index === 10 ? kit.hot : kit.secondary, [0, 0.438, -0.08 - index * 0.14]);
  }
  part('rocket-top-junction-housing', new RoundedBoxGeometry(0.18, 0.065, 0.18, 3, 0.018), kit.secondary, [0, 0.424, -0.18]);
  part('rocket-top-junction-inset', new RoundedBoxGeometry(0.11, 0.025, 0.11, 2, 0.008), kit.rubber, [0, 0.468, -0.18]);
  for (const side of [-1, 1]) {
    for (let index = 0; index < 4; index += 1) {
      part(`rocket-top-vent-${side}-${index}`, new RoundedBoxGeometry(0.04, 0.014, 0.095, 2, 0.005), kit.rubber, [side * 0.115, 0.393, -0.5 - index * 0.15], [0, side * 0.08, 0]);
      part(`rocket-top-fastener-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.016, 10), index === 3 ? kit.hot : kit.metal, [side * 0.15, 0.402, 0.2 - index * 0.5]);
    }
  }
  part('rocket-guidance-cell', new THREE.CylinderGeometry(0.045, 0.045, 0.46, 14), kit.glass, [-0.258, 0.285, -0.64], [Math.PI * 0.5, 0, 0]);
  part('rocket-guidance-core', new THREE.CylinderGeometry(0.012, 0.012, 0.41, 10), kit.hot, [-0.258, 0.285, -0.64], [Math.PI * 0.5, 0, 0]);
  addSignalTicks(builder, -0.24, 0.345, 4, 0.09);
  return -2.4;
}

function addPlasmaGun(builder: Builder): number {
  const { profile, part, kit, animatedRotors } = builder;
  kit.hot.emissiveIntensity = 1.35;
  kit.accent.emissiveIntensity = 0.64;
  kit.glass.emissiveIntensity = 0.34;
  kit.glass.opacity = 0.22;
  kit.glass.roughness = 0.1;
  kit.ceramic.metalness = 0.24;
  kit.ceramic.roughness = 0.34;
  kit.ceramic.clearcoat = 0.18;
  kit.shell.metalness = 0.68;
  kit.shell.roughness = 0.34;
  kit.secondary.metalness = 0.86;
  kit.secondary.roughness = 0.3;
  kit.metal.roughness = 0.23;
  kit.metal.envMapIntensity = 0.86;
  // A narrow curved spine and two floating armor saddles leave the capacitor
  // bank/plumbing exposed. The negative space is as important as the shell:
  // it removes the old rectangular slab and matches the concept's inward
  // waist before the long reactor chamber.
  addCurvedProfile(builder, 'plasma-curved-inner-chassis', [
    [0.58, -0.1], [0.56, 0.1], [0.42, 0.2], [0.18, 0.24],
    [-0.04, 0.2], [-0.28, 0.11], [-0.43, 0.0], [-0.31, -0.1],
    [-0.05, -0.15], [0.25, -0.16], [0.47, -0.14],
  ], 0.34, kit.shell);
  addCurvedProfile(builder, 'plasma-crowned-rear-armor', [
    [0.56, 0.07], [0.48, 0.2], [0.28, 0.29], [0.02, 0.29],
    [-0.18, 0.23], [-0.34, 0.13], [-0.18, 0.11], [0.05, 0.17],
    [0.3, 0.16], [0.48, 0.1],
  ], 0.4, kit.secondary);
  profile('plasma-swept-lower-keel', [[0.47, -0.13], [0.25, -0.2], [-0.05, -0.19], [-0.34, -0.08], [-0.43, 0], [-0.25, -0.02], [0.05, -0.1], [0.36, -0.08]], 0.38, kit.secondary);
  profile('plasma-rear-ridge', [[0.49, 0.17], [0.35, 0.27], [0.1, 0.33], [-0.08, 0.31], [-0.01, 0.27], [0.3, 0.22]], 0.24, kit.metal);
  part('plasma-faceted-butt-cap', new THREE.CylinderGeometry(0.185, 0.15, 0.105, 10), kit.metal, [0, 0.015, 0.57], [Math.PI * 0.5, 0, Math.PI * 0.1]);
  part('plasma-butt-core-cap', new THREE.CylinderGeometry(0.096, 0.105, 0.04, 16), kit.rubber, [0, 0.015, 0.635], [Math.PI * 0.5, 0, 0]);
  for (const side of [-1, 1]) {
    // Three discrete plates follow the rear curve without filling its center.
    profile(`plasma-rear-shoulder-plate-${side}`, [[0.5, 0.01], [0.43, 0.16], [0.27, 0.23], [0.08, 0.21], [0.02, 0.13], [0.21, 0.09], [0.41, 0.07]], 0.026, kit.ceramic, side * 0.19);
    profile(`plasma-mid-shoulder-plate-${side}`, [[0.04, 0.13], [-0.08, 0.22], [-0.25, 0.17], [-0.39, 0.06], [-0.29, 0.01], [-0.12, 0.07]], 0.026, kit.ceramic, side * 0.19);
    profile(`plasma-lower-cheek-${side}`, [[0.42, -0.11], [0.19, -0.15], [-0.08, -0.14], [-0.28, -0.06], [-0.19, -0.01], [0.05, -0.08], [0.31, -0.07]], 0.024, kit.metal, side * 0.185);
    profile(`plasma-shoulder-inset-${side}`, [[0.39, 0.06], [0.31, 0.15], [0.17, 0.18], [0.09, 0.13], [0.21, 0.1]], 0.014, kit.rubber, side * 0.208);
    profile(`plasma-butt-overlap-shell-${side}`, [[0.56, -0.07], [0.54, 0.08], [0.44, 0.15], [0.31, 0.13], [0.25, 0.04], [0.39, -0.02]], 0.02, kit.ceramic, side * 0.213);
    profile(`plasma-capacitor-overlap-shell-${side}`, [[0.17, -0.14], [0.04, -0.11], [-0.1, -0.08], [-0.24, -0.015], [-0.18, 0.035], [-0.01, -0.02]], 0.018, kit.secondary, side * 0.212);
    profile(`plasma-reactor-jaw-recess-${side}`, [[-0.15, 0.02], [-0.3, 0.11], [-0.52, 0.1], [-0.61, 0.055], [-0.48, 0.015], [-0.27, -0.01]], 0.015, kit.rubber, side * 0.206);
    profile(`plasma-reactor-jaw-knife-${side}`, [[-0.28, 0.12], [-0.46, 0.16], [-0.62, 0.12], [-0.51, 0.09], [-0.33, 0.09]], 0.012, kit.metal, side * 0.214);
    for (let index = 0; index < 5; index += 1) {
      part(
        `plasma-rear-louver-${side}-${index}`,
        new RoundedBoxGeometry(0.02, 0.02, 0.095 - index * 0.005, 2, 0.005),
        index === 4 ? kit.accent : kit.metal,
        [side * 0.22, 0.115 + index * 0.022, 0.3 - index * 0.045],
        [0, 0, -0.12],
      );
    }
    for (const [y, z] of [[0.2, 0.03], [0.15, -0.17], [-0.1, 0.17]] as const) {
      part(`plasma-floating-bolt-${side}-${y}-${z}`, new THREE.CylinderGeometry(0.014, 0.014, 0.018, 10), kit.hot, [side * 0.218, y, z], [0, 0, Math.PI * 0.5]);
    }
  }

  // FPS-facing top deck. These islands sit inside the existing side-profile
  // envelope and split the formerly broad rear highlight into nested armor,
  // a recessed service channel, and readable fastener/vent scale.
  part('plasma-top-service-recess', new RoundedBoxGeometry(0.082, 0.018, 0.5, 3, 0.008), kit.rubber, [0, 0.286, 0.13]);
  for (let index = 0; index < 3; index += 1) {
    const z = 0.36 - index * 0.21;
    const outer = 0.122 - index * 0.007;
    for (const side of [-1, 1]) {
      const innerX = side * 0.027;
      const outerX = side * outer;
      addTopPlate(builder, `plasma-top-overlap-blade-${index}-${side}`, [
        [innerX, z + 0.07], [outerX, z + 0.064],
        [outerX + side * 0.012, z], [outerX, z - 0.064],
        [innerX, z - 0.07], [innerX + side * 0.009, z],
      ], 0.024, index === 1 ? kit.ceramic : kit.secondary, 0.307 + index * 0.003);
      part(`plasma-top-overlap-bolt-${index}-${side}`, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10), index === 2 ? kit.hot : kit.metal, [side * (outer - 0.022), 0.326, z]);
    }
  }
  for (const x of [-0.155, 0.155]) {
    part(`plasma-top-deck-rail-${x}`, new RoundedBoxGeometry(0.026, 0.024, 0.55, 2, 0.007), kit.metal, [x, 0.299, 0.12]);
    part(`plasma-top-manifold-${x}`, new THREE.CylinderGeometry(0.042, 0.05, 0.045, 14), kit.secondary, [x, 0.314, -0.18]);
    part(`plasma-top-manifold-lock-${x}`, new THREE.TorusGeometry(0.049, 0.008, 7, 18), kit.accent, [x, 0.337, -0.18], [Math.PI * 0.5, 0, 0]);
  }
  for (let index = 0; index < 5; index += 1) {
    part(`plasma-top-machined-vent-${index}`, new RoundedBoxGeometry(0.028, 0.012, 0.075, 2, 0.005), index === 4 ? kit.accent : kit.metal, [-0.07 + index * 0.035, 0.324, 0.13], [0, 0, -0.12]);
  }

  // Two short armored jumpers terminate the rear manifolds directly into the
  // reactor collar. Their S routes stay outside the sightline to the chamber,
  // while raised ferrules and lock rings make both endpoints unambiguous.
  for (const side of [-1, 1]) {
    addArmoredHose(builder, `plasma-top-reactor-feed-${side}`, [
      [side * 0.155, 0.337, -0.18],
      [side * 0.205, 0.35, -0.25],
      [side * 0.225, 0.335, -0.34],
      [side * 0.205, 0.305, -0.42],
      [side * 0.17, 0.275, -0.49],
    ], 0.012, kit.metal);
    part(`plasma-top-reactor-feed-well-${side}`, new THREE.CylinderGeometry(0.031, 0.036, 0.024, 12), kit.rubber, [side * 0.17, 0.264, -0.49]);
    part(`plasma-top-reactor-feed-lock-${side}`, new THREE.TorusGeometry(0.034, 0.006, 7, 16), kit.accent, [side * 0.17, 0.278, -0.49], [Math.PI * 0.5, 0, 0]);
  }

  // A pair of slim upper beams preserves the side silhouette while opening a
  // deep central sightline onto the glass reactor from the actual FPS camera.
  for (const side of [-1, 1]) {
    profile(`plasma-upper-prong-beam-${side}`, [[-0.31, 0.17], [-0.48, 0.3], [-1.47, 0.29], [-1.78, 0.22], [-1.67, 0.15], [-0.53, 0.14]], 0.09, kit.ceramic, side * 0.11);
  }
  profile('plasma-lower-prong', [[-0.31, -0.03], [-0.5, -0.17], [-1.48, -0.15], [-1.78, -0.08], [-1.66, -0.02], [-0.52, 0.01]], 0.31, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`plasma-upper-prong-inset-${side}`, [[-0.53, 0.19], [-0.64, 0.255], [-1.4, 0.25], [-1.6, 0.21], [-1.46, 0.18], [-0.65, 0.17]], 0.017, kit.secondary, side * 0.166);
    profile(`plasma-lower-prong-inset-${side}`, [[-0.53, -0.015], [-0.65, -0.125], [-1.41, -0.115], [-1.6, -0.075], [-1.46, -0.045], [-0.65, -0.025]], 0.017, kit.metal, side * 0.166);
    part(`plasma-upper-prong-edge-channel-${side}`, new RoundedBoxGeometry(0.015, 0.018, 0.96, 2, 0.005), kit.hot, [side * 0.181, 0.226, -1.09]);
    part(`plasma-lower-prong-edge-channel-${side}`, new RoundedBoxGeometry(0.015, 0.018, 0.96, 2, 0.005), kit.accent, [side * 0.181, -0.073, -1.09]);
    for (const z of [-0.55, -1.02, -1.49]) {
      part(`plasma-prong-step-bridge-${side}-${z}`, new RoundedBoxGeometry(0.025, 0.09, 0.045, 2, 0.008), kit.metal, [side * 0.186, 0.075, z]);
    }
    for (let index = 0; index < 6; index += 1) {
      const z = -0.61 - index * 0.185;
      part(`plasma-upper-prong-fastener-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.016, 10), kit.metal, [side * 0.174, 0.265, z], [0, 0, Math.PI * 0.5]);
      part(`plasma-lower-prong-fastener-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.016, 10), kit.metal, [side * 0.174, -0.115, z], [0, 0, Math.PI * 0.5]);
    }
  }
  part('plasma-upper-conduit', new RoundedBoxGeometry(0.025, 0.022, 1.04, 2, 0.007), kit.accent, [0, 0.245, -1.08]);
  part('plasma-lower-conduit', new RoundedBoxGeometry(0.025, 0.022, 1.04, 2, 0.007), kit.accent, [0, -0.09, -1.08]);
  for (const x of [-0.12, 0.12]) {
    part(`plasma-top-reactor-tie-${x}`, new THREE.CylinderGeometry(0.01, 0.01, 1.02, 8), kit.metal, [x, 0.274, -1.08], [Math.PI * 0.5, 0, 0]);
    part(`plasma-upper-prong-top-live-channel-${x}`, new RoundedBoxGeometry(0.018, 0.014, 0.9, 2, 0.005), kit.hot, [x, 0.307, -1.08]);
  }
  for (let index = 0; index < 4; index += 1) {
    const z = -0.64 - index * 0.27;
    part(`plasma-upper-prong-top-saddle-${index}`, new RoundedBoxGeometry(0.26, 0.02, 0.07, 2, 0.007), index === 3 ? kit.ceramic : kit.metal, [0, 0.314, z]);
    for (const x of [-0.105, 0.105]) {
      part(`plasma-upper-prong-top-saddle-bolt-${index}-${x}`, new THREE.CylinderGeometry(0.01, 0.01, 0.011, 9), index === 3 ? kit.hot : kit.rubber, [x, 0.329, z]);
    }
  }

  const chamber = new THREE.Group();
  chamber.name = 'plasma-reactor';
  chamber.position.set(0, 0.065, -1.08);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.202, 0.202, 1.08, 32, 1, true), kit.glass);
  glass.name = 'plasma-reactor-thick-outer-glass';
  glass.rotation.x = Math.PI * 0.5;
  chamber.add(glass);
  const innerGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.174, 0.174, 1.035, 28, 1, true), kit.glass);
  innerGlass.name = 'plasma-reactor-inner-glass-wall';
  innerGlass.rotation.x = Math.PI * 0.5;
  chamber.add(innerGlass);
  const core = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.84, 8, 18), kit.hot);
  core.name = 'plasma-reactor-energy-column';
  core.rotation.x = Math.PI * 0.5;
  chamber.add(core);
  for (const x of [-0.064, 0.064]) {
    const chargeRail = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.82, 6, 12), kit.accent);
    chargeRail.name = `plasma-reactor-charge-rail-${x}`;
    chargeRail.position.set(x, 0.055, 0);
    chargeRail.rotation.x = Math.PI * 0.5;
    chamber.add(chargeRail);
  }
  for (let index = -4; index <= 4; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.208, index === 0 ? 0.03 : 0.019, 8, 30), index === 0 ? kit.accent : index % 2 ? kit.metal : kit.secondary);
    ring.position.z = index * 0.12;
    chamber.add(ring);
  }
  builder.root.add(chamber);
  animatedRotors.push(chamber);

  // Machined reactor bulkheads and exposed tie rods make the long chamber
  // look structurally mounted instead of floating between two blades.
  for (const z of [-0.51, -1.64]) {
    part(`plasma-reactor-bulkhead-${z}`, new THREE.TorusGeometry(0.222, 0.031, 10, 32), kit.metal, [0, 0.065, z]);
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2;
      part(`plasma-bulkhead-bolt-${z}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.025, 8), kit.hot, [Math.cos(angle) * 0.225, 0.065 + Math.sin(angle) * 0.225, z + 0.018], [Math.PI * 0.5, 0, 0]);
    }
  }
  for (const x of [-0.19, 0.19]) {
    part(`plasma-reactor-tie-rod-${x}`, new THREE.CylinderGeometry(0.011, 0.011, 1.08, 8), kit.metal, [x, 0.065, -1.08], [Math.PI * 0.5, 0, 0]);
  }

  const emitter = new THREE.Group();
  emitter.name = 'plasma-emitter-turbine';
  emitter.position.set(0, 0.065, -1.69);
  const emitterRing = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.03, 8, 28), kit.metal);
  emitter.add(emitterRing);
  const emitterStator = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.018, 8, 28), kit.secondary);
  emitterStator.position.z = -0.035;
  emitter.add(emitterStator);
  const emitterCore = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 0.14, 18), kit.hot);
  emitterCore.rotation.x = Math.PI * 0.5;
  emitter.add(emitterCore);
  for (let index = 0; index < 12; index += 1) {
    const angle = index / 12 * Math.PI * 2;
    const blade = new THREE.Mesh(new RoundedBoxGeometry(0.018, 0.09, 0.036, 2, 0.005), index % 3 === 0 ? kit.accent : kit.secondary);
    blade.position.set(Math.cos(angle) * 0.116, Math.sin(angle) * 0.116, -0.015);
    blade.rotation.z = angle;
    emitter.add(blade);
  }
  builder.root.add(emitter);
  animatedRotors.push(emitter);
  part('plasma-emitter-outer-collar', new THREE.TorusGeometry(0.192, 0.035, 10, 32), kit.shell, [0, 0.065, -1.7]);
  part('plasma-emitter-rear-shroud', new THREE.TorusGeometry(0.226, 0.027, 10, 32), kit.ceramic, [0, 0.065, -1.655]);
  part('plasma-emitter-armored-nozzle', new THREE.CylinderGeometry(0.12, 0.16, 0.135, 18), kit.metal, [0, 0.065, -1.765], [Math.PI * 0.5, 0, 0]);
  part('plasma-emitter-bore', new THREE.CircleGeometry(0.073, 20), kit.rubber, [0, 0.065, -1.838]);
  part('plasma-emitter-hot-aperture', new THREE.CircleGeometry(0.041, 18), kit.hot, [0, 0.065, -1.842]);
  addFasteners(builder, 0.16, 0.015, 0.42, 4);
  return -1.81;
}

function addLaser(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  kit.hot.emissiveIntensity = 1.4;
  kit.accent.emissiveIntensity = 0.68;
  kit.glass.emissiveIntensity = 0.36;
  kit.glass.opacity = 0.2;
  kit.glass.roughness = 0.09;
  kit.ceramic.metalness = 0.07;
  kit.ceramic.roughness = 0.31;
  kit.ceramic.clearcoat = 0.28;
  kit.ceramic.clearcoatRoughness = 0.24;
  kit.shell.metalness = 0.74;
  kit.shell.roughness = 0.35;
  kit.secondary.metalness = 0.88;
  kit.secondary.roughness = 0.3;
  kit.metal.roughness = 0.22;
  kit.metal.envMapIntensity = 0.88;
  // The stock is a swept clamshell around a narrow internal spine. Separating
  // roof, cheek, and keel panels creates curved highlight breaks and preserves
  // the waist around the power-cell window.
  addCurvedProfile(builder, 'laser-tapered-stock-spine', [
    [0.66, -0.08], [0.65, 0.09], [0.53, 0.16], [0.28, 0.18],
    [0.04, 0.13], [-0.19, 0.07], [-0.32, -0.02], [-0.18, -0.09],
    [0.08, -0.12], [0.36, -0.13], [0.56, -0.12],
  ], 0.32, kit.shell);
  for (const side of [-1, 1]) {
    addCurvedProfile(builder, `laser-swept-ceramic-roof-${side}`, [
      [0.62, 0.08], [0.52, 0.21], [0.26, 0.29], [-0.02, 0.28],
      [-0.25, 0.19], [-0.37, 0.09], [-0.2, 0.08], [0.03, 0.15],
      [0.3, 0.17], [0.53, 0.12],
    ], 0.115, kit.ceramic, side * 0.137);
  }
  profile('laser-stock-keel', [[0.54, -0.1], [0.32, -0.18], [0.02, -0.18], [-0.25, -0.11], [-0.37, -0.02], [-0.2, -0.01], [0.08, -0.08], [0.39, -0.06]], 0.36, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`laser-raised-spine-trim-${side}`, [[0.51, 0.18], [0.34, 0.26], [0.07, 0.31], [-0.12, 0.28], [-0.01, 0.24], [0.31, 0.21]], 0.05, kit.metal, side * 0.086);
  }
  part('laser-faceted-butt-pad', new THREE.CylinderGeometry(0.16, 0.135, 0.1, 10), kit.rubber, [0, 0, 0.665], [Math.PI * 0.5, 0, Math.PI * 0.1]);
  for (const side of [-1, 1]) {
    profile(`laser-rear-cheek-plate-${side}`, [[0.56, -0.03], [0.5, 0.14], [0.31, 0.2], [0.1, 0.17], [0.03, 0.08], [0.23, 0.04], [0.45, 0.05]], 0.025, kit.ceramic, side * 0.18);
    profile(`laser-forward-cheek-plate-${side}`, [[0.03, 0.08], [-0.08, 0.17], [-0.25, 0.12], [-0.38, 0.02], [-0.27, -0.03], [-0.1, 0.03]], 0.025, kit.ceramic, side * 0.18);
    profile(`laser-stock-dark-inset-${side}`, [[0.42, 0], [0.35, 0.1], [0.2, 0.14], [0.1, 0.09], [0.23, 0.05]], 0.014, kit.rubber, side * 0.2);
    profile(`laser-power-cell-recess-${side}`, [[0.32, -0.025], [0.3, 0.145], [0.03, 0.15], [-0.08, 0.055], [0.02, -0.035]], 0.016, kit.rubber, side * 0.212);
    profile(`laser-power-cell-upper-knife-${side}`, [[0.32, 0.155], [0.18, 0.19], [-0.03, 0.18], [-0.1, 0.145], [0.08, 0.14]], 0.012, kit.metal, side * 0.22);
    profile(`laser-butt-facet-${side}`, [[0.63, -0.07], [0.62, 0.1], [0.53, 0.17], [0.42, 0.14], [0.39, 0.02], [0.51, -0.045]], 0.019, kit.metal, side * 0.202);
    profile(`laser-stock-breaker-plate-${side}`, [[0.02, 0.16], [-0.1, 0.22], [-0.25, 0.17], [-0.34, 0.08], [-0.23, 0.04], [-0.07, 0.09]], 0.018, kit.secondary, side * 0.207);
    profile(`laser-lower-wear-plate-${side}`, [[0.47, -0.09], [0.24, -0.13], [-0.02, -0.13], [-0.2, -0.07], [-0.11, -0.02], [0.14, -0.07]], 0.021, kit.metal, side * 0.185);
    for (let index = 0; index < 5; index += 1) {
      part(`laser-rear-vent-${side}-${index}`, new RoundedBoxGeometry(0.017, 0.018, 0.09 - index * 0.005, 2, 0.005), index === 4 ? kit.accent : kit.metal, [side * 0.215, 0.115 + index * 0.02, 0.35 - index * 0.043]);
    }
    part(`laser-butt-lock-${side}`, new THREE.CylinderGeometry(0.026, 0.026, 0.02, 12), kit.accent, [side * 0.19, 0.015, 0.56], [0, 0, Math.PI * 0.5]);
    for (const z of [0.48, 0.28, 0.02, -0.2]) {
      part(`laser-stock-seam-bolt-${side}-${z}`, new THREE.CylinderGeometry(0.011, 0.011, 0.016, 9), z === 0.02 ? kit.hot : kit.metal, [side * 0.222, 0.175, z], [0, 0, Math.PI * 0.5]);
    }
  }

  // Layered top clamshell and exposed power module are authored for the real
  // first-person view. The additions stay below the existing roof crown so
  // the approved side silhouette and weapon placement remain unchanged.
  part('laser-top-power-recess', new RoundedBoxGeometry(0.25, 0.018, 0.36, 3, 0.008), kit.rubber, [0, 0.273, 0.15]);
  part('laser-top-power-window', new RoundedBoxGeometry(0.18, 0.018, 0.27, 3, 0.008), kit.glass, [0, 0.293, 0.15]);
  for (let index = 0; index < 5; index += 1) {
    part(`laser-top-charge-cell-${index}`, new RoundedBoxGeometry(0.022, 0.014, 0.04, 2, 0.005), index === 4 ? kit.hot : kit.accent, [-0.06 + index * 0.03, 0.307, 0.24 - index * 0.045]);
  }
  for (const [index, z] of [0.47, 0.34, -0.08].entries()) {
    part(`laser-top-armor-island-${index}`, new RoundedBoxGeometry(0.29 - index * 0.025, 0.024, index === 2 ? 0.2 : 0.105, 3, 0.008), index === 1 ? kit.metal : kit.ceramic, [0, 0.295, z], [0, index * 0.025 - 0.02, 0]);
    for (const x of [-0.11, 0.11]) {
      part(`laser-top-island-bolt-${index}-${x}`, new THREE.CylinderGeometry(0.011, 0.011, 0.011, 10), index === 2 ? kit.hot : kit.metal, [x, 0.314, z]);
    }
  }
  for (const side of [-1, 1]) {
    const topHardline = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.095, 0.31, 0.43),
      new THREE.Vector3(side * 0.13, 0.315, 0.25),
      new THREE.Vector3(side * 0.105, 0.31, 0.08),
      new THREE.Vector3(side * 0.14, 0.302, -0.1),
      new THREE.Vector3(side * 0.115, 0.285, -0.29),
    ], false, 'centripetal');
    part(`laser-top-control-hardline-${side}`, new THREE.TubeGeometry(topHardline, 40, 0.008, 8, false), kit.hot, [0, 0, 0]);
    for (const [label, point] of [['rear', topHardline.getPointAt(0.015)], ['front', topHardline.getPointAt(0.985)]] as const) {
      part(`laser-top-hardline-${label}-socket-${side}`, new THREE.TorusGeometry(0.025, 0.006, 7, 16), kit.metal, point.toArray() as [number, number, number], [Math.PI * 0.5, 0, 0]);
    }
  }
  for (let index = 0; index < 6; index += 1) {
    part(`laser-top-exhaust-slot-${index}`, new RoundedBoxGeometry(0.024, 0.01, 0.085, 2, 0.004), index === 5 ? kit.accent : kit.rubber, [-0.075 + index * 0.03, 0.307, -0.03], [0, 0, -0.15]);
  }

  // A skeletal throat connects the stock to the radiator instead of another
  // solid receiver box.
  profile('laser-upper-throat-frame', [[0.05, 0.06], [-0.1, 0.15], [-0.46, 0.15], [-0.58, 0.09], [-0.45, 0.05], [-0.08, 0.08]], 0.36, kit.shell);
  profile('laser-lower-throat-frame', [[0.04, -0.11], [-0.14, -0.08], [-0.48, -0.06], [-0.59, -0.01], [-0.44, 0.02], [-0.08, -0.03]], 0.34, kit.secondary);
  for (const side of [-1, 1]) {
    part(`laser-throat-tension-rod-${side}`, new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8), kit.metal, [side * 0.19, 0.03, -0.36], [Math.PI * 0.5, 0, 0]);
  }

  // Split the upper shell into independent ceramic tines. The central aperture
  // now exposes the complete radiator/focus train instead of presenting one
  // pale roof slab to the first-person camera.
  for (const side of [-1, 1]) {
    profile(`laser-upper-emitter-prong-${side}`, [[-0.43, 0.2], [-0.61, 0.31], [-1.55, 0.29], [-1.84, 0.2], [-1.72, 0.14], [-0.62, 0.14]], 0.086, kit.ceramic, side * 0.108);
  }
  profile('laser-lower-emitter-prong', [[-0.43, -0.04], [-0.61, -0.17], [-1.55, -0.15], [-1.84, -0.08], [-1.72, -0.02], [-0.62, 0.02]], 0.3, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`laser-upper-prong-inset-${side}`, [[-0.64, 0.19], [-0.76, 0.27], [-1.47, 0.25], [-1.67, 0.2], [-1.53, 0.17], [-0.76, 0.16]], 0.017, kit.metal, side * 0.162);
    profile(`laser-lower-prong-inset-${side}`, [[-0.64, -0.02], [-0.76, -0.13], [-1.47, -0.12], [-1.67, -0.075], [-1.53, -0.045], [-0.76, -0.01]], 0.017, kit.metal, side * 0.162);
    part(`laser-upper-prong-live-channel-${side}`, new RoundedBoxGeometry(0.015, 0.018, 0.98, 2, 0.005), kit.hot, [side * 0.177, 0.226, -1.19]);
    part(`laser-lower-prong-live-channel-${side}`, new RoundedBoxGeometry(0.015, 0.018, 0.98, 2, 0.005), kit.hot, [side * 0.177, -0.074, -1.19]);
    for (const z of [-0.65, -1.08, -1.51]) {
      part(`laser-prong-stepped-clamp-${side}-${z}`, new RoundedBoxGeometry(0.024, 0.082, 0.042, 2, 0.008), kit.secondary, [side * 0.184, 0.075, z]);
    }
    for (let index = 0; index < 5; index += 1) {
      const z = -0.75 - index * 0.19;
      part(`laser-prong-lock-${side}-${index}`, new THREE.CylinderGeometry(0.011, 0.011, 0.016, 10), index === 4 ? kit.hot : kit.metal, [side * 0.17, 0.26, z], [0, 0, Math.PI * 0.5]);
    }
  }
  part('laser-upper-line', new RoundedBoxGeometry(0.024, 0.026, 1.02, 2, 0.007), kit.accent, [0, 0.25, -1.18]);
  part('laser-lower-line', new RoundedBoxGeometry(0.024, 0.026, 1.02, 2, 0.007), kit.accent, [0, -0.105, -1.18]);
  for (const x of [-0.115, 0.115]) {
    part(`laser-upper-prong-top-live-channel-${x}`, new RoundedBoxGeometry(0.016, 0.014, 0.94, 2, 0.005), kit.hot, [x, 0.302, -1.19]);
  }
  for (let index = 0; index < 5; index += 1) {
    const z = -0.7 - index * 0.22;
    part(`laser-upper-prong-top-saddle-${index}`, new RoundedBoxGeometry(0.25, 0.018, 0.055, 2, 0.006), index === 4 ? kit.ceramic : kit.metal, [0, 0.31, z]);
    for (const x of [-0.1, 0.1]) {
      part(`laser-upper-prong-top-saddle-bolt-${index}-${x}`, new THREE.CylinderGeometry(0.009, 0.009, 0.011, 9), index === 4 ? kit.hot : kit.rubber, [x, 0.324, z]);
    }
  }

  const focusing = new THREE.Group();
  focusing.name = 'laser-focusing-assembly';
  focusing.position.set(0, 0.055, -0.9);
  const focusingGlass = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.66, 8, 20), kit.glass);
  focusingGlass.rotation.x = Math.PI * 0.5;
  focusing.add(focusingGlass);
  const focusingCore = new THREE.Mesh(new THREE.CapsuleGeometry(0.061, 0.61, 6, 16), kit.hot);
  focusingCore.name = 'laser-focus-energy-column';
  focusingCore.rotation.x = Math.PI * 0.5;
  focusing.add(focusingCore);
  for (const x of [-0.052, 0.052]) {
    const focusConductor = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.58, 5, 10), kit.accent);
    focusConductor.name = `laser-focus-conductor-${x}`;
    focusConductor.position.set(x, 0.045, 0);
    focusConductor.rotation.x = Math.PI * 0.5;
    focusing.add(focusConductor);
  }
  for (let index = 0; index < 7; index += 1) {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.177 + Math.abs(3 - index) * 0.006, index === 3 ? 0.028 : 0.018, 8, 30), index === 3 ? kit.hot : index % 2 ? kit.metal : kit.secondary);
    lens.position.z = (3 - index) * 0.105;
    focusing.add(lens);
  }
  builder.root.add(focusing);
  animatedSlides.push(focusing);

  // Nine radiator blades wrap the focus core, with two long side rails and a
  // prominent forward lens stack as in the concept.
  for (const x of [-0.19, 0.19]) {
    for (const y of [-0.14, 0.25]) {
      part(`laser-radiator-rail-${x}-${y}`, new RoundedBoxGeometry(0.025, 0.025, 0.72, 2, 0.007), kit.metal, [x, y, -0.9]);
    }
  }
  for (const z of [-0.5, -1.3]) {
    part(`laser-radiator-bulkhead-${z}`, new THREE.TorusGeometry(0.196, 0.025, 9, 28), kit.metal, [0, 0.055, z]);
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2;
      part(`laser-radiator-bulkhead-bolt-${z}-${index}`, new THREE.CylinderGeometry(0.01, 0.01, 0.02, 8), kit.hot, [Math.cos(angle) * 0.198, 0.055 + Math.sin(angle) * 0.198, z + 0.015], [Math.PI * 0.5, 0, 0]);
    }
  }
  part('laser-emitter-core', new THREE.CylinderGeometry(0.046, 0.078, 0.48, 16), kit.hot, [0, 0.055, -1.42], [Math.PI * 0.5, 0, 0]);
  for (let index = 0; index < 4; index += 1) {
    part(`laser-forward-lens-${index}`, new THREE.TorusGeometry(0.11 - index * 0.012, 0.017, 8, 24), index === 3 ? kit.hot : kit.metal, [0, 0.055, -1.52 - index * 0.07]);
  }
  part('laser-nozzle-armor-ring', new THREE.TorusGeometry(0.105, 0.025, 10, 28), kit.shell, [0, 0.055, -1.75]);
  part('laser-nozzle-housing', new THREE.CylinderGeometry(0.075, 0.1, 0.13, 18), kit.metal, [0, 0.055, -1.8], [Math.PI * 0.5, 0, 0]);
  part('laser-nozzle-bore', new THREE.CircleGeometry(0.049, 18), kit.rubber, [0, 0.055, -1.872]);
  part('laser-nozzle-aperture', new THREE.CircleGeometry(0.027, 16), kit.hot, [0, 0.055, -1.876]);
  addSignalTicks(builder, -0.08, 0.19, 7, 0.06);
  return -1.86;
}

function addSniper(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  kit.shell.roughness = 0.4;
  kit.secondary.roughness = 0.32;
  kit.metal.roughness = 0.23;
  kit.ceramic.roughness = 0.45;
  kit.ceramic.clearcoat = 0.14;
  const addStrut = (
    name: string,
    start: [number, number, number],
    end: [number, number, number],
    radius: number,
    material: THREE.Material,
  ): THREE.Mesh => {
    const from = new THREE.Vector3(...start);
    const to = new THREE.Vector3(...end);
    const direction = to.clone().sub(from);
    const length = direction.length();
    const mesh = part(
      name,
      new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 6, 12),
      material,
      from.clone().add(to).multiplyScalar(0.5).toArray() as [number, number, number],
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  };

  // Tall shoulder pad plus four narrow load paths form an actual open stock.
  // The empty triangular center is intentional and matches the Longshot's
  // adjustable chassis instead of reading as a solid sci-fi block.
  profile('sniper-butt-pad-chassis', [[0.88, -0.28], [0.9, 0.23], [0.81, 0.28], [0.72, 0.2], [0.71, -0.23], [0.79, -0.3]], 0.31, kit.shell);
  profile('sniper-butt-pad-rubber', [[0.915, -0.25], [0.925, 0.2], [0.87, 0.23], [0.8, 0.17], [0.79, -0.21], [0.85, -0.27]], 0.335, kit.rubber);
  profile('sniper-cheek-chassis', [[0.78, 0.13], [0.7, 0.25], [0.24, 0.27], [-0.02, 0.2], [-0.12, 0.13], [0.12, 0.14], [0.38, 0.2], [0.68, 0.18]], 0.28, kit.secondary);
  profile('sniper-cheek-armor', [[0.69, 0.18], [0.58, 0.245], [0.29, 0.25], [0.1, 0.2], [0.2, 0.17], [0.47, 0.2]], 0.305, kit.ceramic);
  addCurvedProfile(builder, 'sniper-lower-stock-beam', [
    [0.8, -0.24], [0.69, -0.18], [0.45, -0.14], [0.18, -0.08],
    [-0.02, -0.015], [0.08, 0.035], [0.31, -0.035], [0.58, -0.1],
    [0.77, -0.16],
  ], 0.25, kit.secondary);
  profile('sniper-stock-shoulder-collar', [[0.86, -0.25], [0.87, 0.22], [0.79, 0.25], [0.73, 0.17], [0.73, -0.2], [0.79, -0.27]], 0.345, kit.metal);
  addTopPlate(builder, 'sniper-stock-top-gasket', [[-0.145, 0.76], [0.145, 0.76], [0.14, 0.2], [0.095, 0.1], [-0.095, 0.1], [-0.14, 0.2]], 0.025, kit.rubber, 0.235);
  addTopPlate(builder, 'sniper-stock-top-shell', [[-0.12, 0.72], [0.12, 0.72], [0.115, 0.22], [0.075, 0.135], [-0.075, 0.135], [-0.115, 0.22]], 0.032, kit.ceramic, 0.258);
  for (const side of [-1, 1]) {
    addTopPlate(builder, `sniper-stock-top-overlap-${side}`, [
      [side * 0.035, 0.68], [side * 0.112, 0.65], [side * 0.108, 0.31],
      [side * 0.078, 0.205], [side * 0.035, 0.24],
    ], 0.024, side < 0 ? kit.secondary : kit.ceramic, 0.285);
    part(`sniper-stock-top-overlap-seam-${side}`, new RoundedBoxGeometry(0.018, 0.018, 0.31, 2, 0.005), kit.metal, [side * 0.103, 0.305, 0.46]);
    part(`sniper-stock-top-overlap-lock-${side}`, new THREE.CylinderGeometry(0.013, 0.013, 0.014, 10), kit.hot, [side * 0.082, 0.316, 0.31]);
  }
  for (const side of [-1, 1]) {
    const x = side * 0.135;
    profile(`sniper-cheek-shadow-cut-${side}`, [[0.58, 0.185], [0.49, 0.225], [0.29, 0.23], [0.19, 0.2], [0.31, 0.182], [0.49, 0.19]], 0.012, kit.rubber, side * 0.162);
    profile(`sniper-lower-stock-armor-${side}`, [[0.74, -0.2], [0.58, -0.13], [0.35, -0.09], [0.1, -0.02], [0.17, 0.015], [0.43, -0.055], [0.67, -0.12]], 0.016, kit.ceramic, side * 0.145);
    addStrut(`sniper-stock-upper-strut-${side}`, [x, 0.15, 0.72], [x, 0.08, 0.03], 0.026, kit.metal);
    addStrut(`sniper-stock-lower-strut-${side}`, [x, -0.19, 0.74], [x, -0.055, 0.02], 0.028, kit.secondary);
    addStrut(`sniper-stock-cross-brace-${side}`, [x, -0.18, 0.66], [x, 0.13, 0.27], 0.019, kit.metal);
    part(`sniper-stock-hinge-${side}`, new THREE.CylinderGeometry(0.04, 0.04, 0.025, 14), kit.accent, [side * 0.155, 0.025, 0.04], [0, 0, Math.PI * 0.5]);
    part(`sniper-stock-tensioner-${side}`, new THREE.CylinderGeometry(0.032, 0.032, 0.026, 12), kit.metal, [side * 0.155, -0.03, 0.45], [0, 0, Math.PI * 0.5]);
  }

  // Slim receiver with separate armor, ejection bay, and a taper into the
  // handguard. Its height stays close to the bore so the rifle reads precise.
  profile('sniper-receiver-core', [[0.13, -0.07], [0.1, 0.14], [-0.18, 0.18], [-0.66, 0.17], [-0.88, 0.08], [-0.82, -0.08], [-0.55, -0.12], [-0.08, -0.105]], 0.34, kit.shell);
  profile('sniper-upper-receiver-spine', [[0.08, 0.13], [-0.12, 0.22], [-0.63, 0.205], [-0.83, 0.13], [-0.7, 0.11], [-0.1, 0.14]], 0.29, kit.secondary);
  profile('sniper-upper-receiver-blade', [[-0.04, 0.185], [-0.18, 0.235], [-0.59, 0.22], [-0.76, 0.16], [-0.62, 0.145], [-0.16, 0.18]], 0.19, kit.metal);
  addTopPlate(builder, 'sniper-receiver-top-gasket', [[-0.17, 0.1], [0.17, 0.1], [0.16, -0.7], [0.11, -0.8], [-0.11, -0.8], [-0.16, -0.7]], 0.026, kit.rubber, 0.176);
  addTopPlate(builder, 'sniper-receiver-top-shell', [[-0.145, 0.065], [0.145, 0.065], [0.135, -0.68], [0.085, -0.765], [-0.085, -0.765], [-0.135, -0.68]], 0.034, kit.secondary, 0.2);
  for (const side of [-1, 1]) {
    addTopPlate(builder, `sniper-receiver-top-wing-gasket-${side}`, [
      [side * 0.045, 0.035], [side * 0.155, 0.005], [side * 0.145, -0.61],
      [side * 0.098, -0.72], [side * 0.045, -0.66],
    ], 0.022, kit.rubber, 0.216);
    addTopPlate(builder, `sniper-receiver-top-wing-${side}`, [
      [side * 0.058, 0.005], [side * 0.135, -0.02], [side * 0.126, -0.57],
      [side * 0.09, -0.665], [side * 0.058, -0.61],
    ], 0.028, side === 1 ? kit.ceramic : kit.secondary, 0.237);
    for (const [index, z] of [-0.08, -0.61].entries()) {
      part(`sniper-receiver-top-wing-lock-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.013, 10), index ? kit.hot : kit.metal, [side * 0.105, 0.263, z]);
    }
  }
  part('sniper-top-bolt-channel', new RoundedBoxGeometry(0.055, 0.018, 0.48, 2, 0.006), kit.rubber, [0.07, 0.226, -0.39]);
  part('sniper-top-ejection-cover', new RoundedBoxGeometry(0.095, 0.025, 0.22, 3, 0.009), kit.metal, [0.065, 0.243, -0.47]);
  part('sniper-top-action-bed', new RoundedBoxGeometry(0.085, 0.025, 0.42, 3, 0.009), kit.rubber, [0.105, 0.265, -0.38]);
  part('sniper-top-action-carrier', new THREE.CapsuleGeometry(0.027, 0.3, 6, 14), kit.metal, [0.105, 0.297, -0.38], [Math.PI * 0.5, 0, 0]);
  part('sniper-top-action-locking-lug', new THREE.CylinderGeometry(0.045, 0.045, 0.038, 14), kit.secondary, [0.105, 0.318, -0.22]);
  part('sniper-top-action-handle', new RoundedBoxGeometry(0.13, 0.025, 0.034, 2, 0.007), kit.metal, [0.165, 0.327, -0.27], [0, 0.22, -0.22]);
  part('sniper-top-action-knob', new THREE.SphereGeometry(0.035, 14, 10), kit.rubber, [0.225, 0.342, -0.258]);
  for (const side of [-1, 1]) {
    profile(`sniper-receiver-armor-${side}`, [[0.04, -0.005], [-0.08, 0.12], [-0.35, 0.145], [-0.66, 0.12], [-0.78, 0.04], [-0.64, -0.055], [-0.28, -0.07]], 0.02, kit.ceramic, side * 0.183);
    profile(`sniper-receiver-inset-${side}`, [[-0.09, 0.02], [-0.19, 0.1], [-0.43, 0.105], [-0.62, 0.07], [-0.54, 0.005], [-0.26, -0.015]], 0.014, kit.rubber, side * 0.196);
    part(`sniper-ejection-bay-${side}`, new RoundedBoxGeometry(0.016, 0.075, 0.21, 2, 0.01), kit.metal, [side * 0.207, 0.065, -0.53]);
    for (let index = 0; index < 3; index += 1) {
      part(`sniper-receiver-pin-${side}-${index}`, new THREE.CylinderGeometry(0.013, 0.013, 0.017, 10), index === 1 ? kit.hot : kit.metal, [side * 0.209, -0.035 + index * 0.075, -0.16 - index * 0.19], [0, 0, Math.PI * 0.5]);
    }
  }
  part('sniper-bolt-body', new THREE.CylinderGeometry(0.035, 0.035, 0.48, 14), kit.metal, [0.205, 0.115, -0.45], [Math.PI * 0.5, 0, 0]);
  part('sniper-bolt-rear-cap', new THREE.TorusGeometry(0.041, 0.009, 7, 18), kit.secondary, [0.205, 0.115, -0.2], [0, Math.PI * 0.5, 0]);
  addStrut('sniper-bolt-handle', [0.215, 0.12, -0.37], [0.31, -0.015, -0.27], 0.018, kit.metal);
  part('sniper-bolt-handle-knob', new THREE.SphereGeometry(0.052, 16, 12), kit.rubber, [0.31, -0.015, -0.27]);
  part('sniper-barrel-receiver-lock', new THREE.TorusGeometry(0.105, 0.022, 8, 22), kit.metal, [0, 0.085, -0.84]);

  // Ventilated fore-end: two thin rails frame the barrel without hiding it.
  profile('sniper-upper-handguard', [[-0.7, 0.13], [-0.85, 0.2], [-1.85, 0.18], [-2.02, 0.13], [-1.9, 0.09], [-0.86, 0.1]], 0.27, kit.shell);
  profile('sniper-lower-handguard', [[-0.72, -0.08], [-0.88, -0.13], [-1.84, -0.11], [-1.98, -0.06], [-1.86, -0.025], [-0.9, -0.04]], 0.27, kit.secondary);
  addTopPlate(builder, 'sniper-handguard-top-gasket', [[-0.145, -0.76], [0.145, -0.76], [0.13, -1.87], [0.075, -1.98], [-0.075, -1.98], [-0.13, -1.87]], 0.024, kit.rubber, 0.16);
  addTopPlate(builder, 'sniper-handguard-top-shell', [[-0.12, -0.8], [0.12, -0.8], [0.11, -1.84], [0.06, -1.94], [-0.06, -1.94], [-0.11, -1.84]], 0.03, kit.shell, 0.183);
  for (const side of [-1, 1]) {
    for (let index = 0; index < 5; index += 1) {
      part(`sniper-top-handguard-vent-${side}-${index}`, new RoundedBoxGeometry(0.028, 0.014, 0.105, 2, 0.005), kit.rubber, [side * 0.085, 0.205, -0.92 - index * 0.19], [0, side * 0.08, 0]);
      part(`sniper-top-handguard-bolt-${side}-${index}`, new THREE.CylinderGeometry(0.011, 0.011, 0.015, 10), index === 4 ? kit.hot : kit.metal, [side * 0.112, 0.211, -0.84 - index * 0.235]);
    }
  }
  for (const side of [-1, 1]) {
    profile(`sniper-handguard-armor-${side}`, [[-0.82, 0.085], [-0.92, 0.17], [-1.74, 0.15], [-1.93, 0.105], [-1.79, 0.075], [-0.94, 0.08]], 0.016, kit.metal, side * 0.15);
    profile(`sniper-handguard-lower-armor-${side}`, [[-0.87, -0.07], [-0.98, -0.105], [-1.72, -0.09], [-1.9, -0.055], [-1.76, -0.035], [-0.98, -0.045]], 0.014, kit.ceramic, side * 0.15);
    part(`sniper-handguard-live-rail-${side}`, new RoundedBoxGeometry(0.012, 0.016, 0.76, 2, 0.004), kit.accent, [side * 0.145, 0.1, -1.32]);
    for (let index = 0; index < 6; index += 1) {
      profile(`sniper-handguard-vent-${side}-${index}`, [
        [-0.9 - index * 0.145, 0.07], [-0.93 - index * 0.145, 0.13],
        [-1.02 - index * 0.145, 0.13], [-1.04 - index * 0.145, 0.07],
      ], 0.012, kit.rubber, side * 0.151);
    }
  }

  // Long, exposed barrel and staged muzzle brake carry most of the overall
  // length. The outer support rings stay small so it remains sleek.
  part('sniper-chamber-barrel', new THREE.CylinderGeometry(0.058, 0.068, 1.22, 18), kit.metal, [0, 0.085, -1.45], [Math.PI * 0.5, 0, 0]);
  part('sniper-free-float-barrel', new THREE.CylinderGeometry(0.032, 0.045, 1.35, 18), kit.metal, [0, 0.085, -2.67], [Math.PI * 0.5, 0, 0]);
  for (let index = 0; index < 10; index += 1) {
    const z = -0.88 - index * 0.13;
    part(`sniper-barrel-support-ring-${index}`, new THREE.TorusGeometry(0.078, index % 3 === 0 ? 0.017 : 0.012, 7, 20), index === 5 ? kit.accent : index % 2 ? kit.metal : kit.secondary, [0, 0.085, z]);
    part(`sniper-underbarrel-rail-tooth-${index}`, new RoundedBoxGeometry(0.13, 0.025, 0.04, 1, 0.005), kit.metal, [0, -0.045, z]);
    if (index % 3 === 0) {
      part(`sniper-barrel-top-clamp-${index}`, new RoundedBoxGeometry(0.19, 0.05, 0.055, 2, 0.008), kit.metal, [0, 0.175, z]);
      part(`sniper-barrel-bottom-clamp-${index}`, new RoundedBoxGeometry(0.19, 0.05, 0.055, 2, 0.008), kit.secondary, [0, -0.005, z]);
      part(`sniper-barrel-top-clamp-armor-${index}`, new RoundedBoxGeometry(0.145, 0.025, 0.082, 2, 0.009), index === 6 ? kit.ceramic : kit.secondary, [0, 0.216, z]);
      for (const side of [-1, 1]) {
        part(`sniper-barrel-top-clamp-lock-${index}-${side}`, new THREE.CylinderGeometry(0.011, 0.011, 0.014, 9), index === 9 ? kit.hot : kit.metal, [side * 0.058, 0.238, z]);
      }
    }
  }
  part('sniper-barrel-step-collar', new THREE.TorusGeometry(0.055, 0.016, 8, 20), kit.secondary, [0, 0.085, -2.05]);
  part('sniper-muzzle-brake-body', new THREE.CylinderGeometry(0.083, 0.062, 0.34, 10), kit.shell, [0, 0.085, -3.41], [Math.PI * 0.5, 0, Math.PI / 10]);
  part('sniper-muzzle-brake-rear-collar', new THREE.TorusGeometry(0.067, 0.016, 7, 18), kit.metal, [0, 0.085, -3.23]);
  part('sniper-muzzle-brake-tip', new THREE.TorusGeometry(0.075, 0.017, 7, 18), kit.rubber, [0, 0.085, -3.595]);
  part('sniper-muzzle-bore', new THREE.CircleGeometry(0.029, 16), kit.rubber, [0, 0.085, -3.61]);
  for (let index = 0; index < 3; index += 1) {
    part(`sniper-brake-top-vent-${index}`, new RoundedBoxGeometry(0.04, 0.045, 0.058, 2, 0.007), kit.rubber, [0, 0.15, -3.31 - index * 0.085]);
    part(`sniper-brake-bottom-vent-${index}`, new RoundedBoxGeometry(0.04, 0.045, 0.058, 2, 0.007), kit.rubber, [0, 0.02, -3.31 - index * 0.085]);
  }
  for (const side of [-1, 1]) {
    for (let index = 0; index < 3; index += 1) {
      part(`sniper-muzzle-port-${side}-${index}`, new RoundedBoxGeometry(0.052, 0.035, 0.055, 2, 0.008), kit.rubber, [side * 0.06, 0.085, -3.3 - index * 0.09]);
    }
  }

  // Multi-stage optic with distinct ocular/objective housings, fine control
  // rings, and a recessed emissive lens—not a single featureless tube.
  const scope = new THREE.Group();
  scope.name = 'sniper-scope';
  scope.position.set(0, 0.39, -0.39);
  const scopeCenter = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.46, 16), kit.rubber);
  scopeCenter.rotation.x = Math.PI * 0.5;
  scope.add(scopeCenter);
  const objective = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.078, 0.34, 12), kit.shell);
  objective.rotation.x = Math.PI * 0.5;
  objective.position.z = -0.38;
  scope.add(objective);
  const objectiveArmor = new THREE.Mesh(new RoundedBoxGeometry(0.205, 0.18, 0.23, 3, 0.025), kit.secondary);
  objectiveArmor.name = 'sniper-scope-objective-armor';
  objectiveArmor.position.z = -0.35;
  scope.add(objectiveArmor);
  const ocular = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.074, 0.3, 12), kit.secondary);
  ocular.rotation.x = Math.PI * 0.5;
  ocular.position.z = 0.34;
  scope.add(ocular);
  const ocularArmor = new THREE.Mesh(new RoundedBoxGeometry(0.175, 0.15, 0.2, 3, 0.022), kit.shell);
  ocularArmor.name = 'sniper-scope-ocular-armor';
  ocularArmor.position.z = 0.34;
  scope.add(ocularArmor);
  const scopeBridge = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.12, 0.32, 3, 0.018), kit.rubber);
  scopeBridge.name = 'sniper-scope-bridge-armor';
  scope.add(scopeBridge);
  const focusWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.075, 18), kit.metal);
  focusWheel.name = 'sniper-scope-side-focus-wheel';
  focusWheel.position.set(0.11, 0.005, -0.02);
  focusWheel.rotation.z = Math.PI * 0.5;
  scope.add(focusWheel);
  const focusWheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.066, 0.009, 7, 20), kit.accent);
  focusWheelRing.name = 'sniper-scope-side-focus-ring';
  focusWheelRing.position.set(0.151, 0.005, -0.02);
  focusWheelRing.rotation.y = Math.PI * 0.5;
  scope.add(focusWheelRing);
  for (const [z, radius, material] of [
    [-0.57, 0.118, kit.accent], [-0.22, 0.082, kit.metal], [0.18, 0.082, kit.metal], [0.5, 0.096, kit.metal],
  ] as Array<[number, number, THREE.Material]>) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.015, 7, 22), material);
    rim.position.z = z;
    scope.add(rim);
  }
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), kit.glass);
  lens.position.z = -0.585;
  scope.add(lens);
  const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.101, 0.011, 7, 22), kit.hot);
  lensRing.position.z = -0.592;
  scope.add(lensRing);
  builder.root.add(scope);

  part('sniper-optic-rail', new RoundedBoxGeometry(0.16, 0.035, 0.93, 2, 0.008), kit.metal, [0, 0.25, -0.4]);
  for (let index = 0; index < 9; index += 1) {
    part(`sniper-optic-rail-tooth-${index}`, new RoundedBoxGeometry(0.18, 0.018, 0.038, 1, 0.004), kit.secondary, [0, 0.277, -0.02 - index * 0.095]);
  }
  for (const [mountIndex, z] of [-0.13, -0.62].entries()) {
    part(`sniper-scope-mount-foot-${mountIndex}`, new RoundedBoxGeometry(0.235, 0.055, 0.11, 3, 0.012), kit.ceramic, [0, 0.302, z]);
    part(`sniper-scope-mount-saddle-${mountIndex}`, new RoundedBoxGeometry(0.16, 0.085, 0.075, 3, 0.013), kit.secondary, [0, 0.35, z]);
    for (const side of [-1, 1]) {
      part(`sniper-scope-mount-crossbolt-${mountIndex}-${side}`, new THREE.CylinderGeometry(0.015, 0.015, 0.04, 10), mountIndex === 1 && side === 1 ? kit.hot : kit.metal, [side * 0.097, 0.337, z], [0, 0, Math.PI * 0.5]);
    }
  }
  for (const side of [-1, 1]) {
    part(`sniper-grip-side-armor-${side}`, new RoundedBoxGeometry(0.014, 0.34, 0.19, 3, 0.012), kit.secondary, [side * 0.112, -0.31, -0.02], [-0.28, 0, 0.04]);
    part(`sniper-grip-palm-inset-${side}`, new RoundedBoxGeometry(0.012, 0.22, 0.13, 2, 0.009), kit.rubber, [side * 0.121, -0.33, -0.025], [-0.28, 0, 0.04]);
    for (let index = 0; index < 3; index += 1) {
      part(`sniper-grip-fastener-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.016, 9), index === 2 ? kit.hot : kit.metal, [side * 0.125, -0.22 - index * 0.11, -0.03], [0, 0, Math.PI * 0.5]);
    }
  }
  part('sniper-magazine', new RoundedBoxGeometry(0.19, 0.35, 0.25, 3, 0.03), kit.rubber, [-0.1, -0.235, -0.5], [0.1, 0, 0.06]);
  part('sniper-magazine-front-rib', new RoundedBoxGeometry(0.198, 0.3, 0.026, 2, 0.006), kit.metal, [-0.1, -0.225, -0.635], [0.1, 0, 0.06]);
  for (let index = 0; index < 4; index += 1) {
    part(`sniper-magazine-side-rib-${index}`, new RoundedBoxGeometry(0.204, 0.025, 0.245, 2, 0.006), index === 3 ? kit.ceramic : kit.secondary, [-0.1, -0.12 - index * 0.075, -0.5], [0.1, 0, 0.06]);
  }
  part('sniper-magazine-floorplate', new RoundedBoxGeometry(0.215, 0.04, 0.27, 2, 0.012), kit.metal, [-0.1, -0.43, -0.48], [0.1, 0, 0.06]);
  const bolt = part('sniper-bolt-carrier', new THREE.CylinderGeometry(0.026, 0.026, 0.28, 12), kit.metal, [0.255, 0.115, -0.51], [0, 0, Math.PI * 0.5]);
  animatedSlides.push(bolt);
  addFasteners(builder, -0.12, 0.02, 0.41, 6);
  return -3.62;
}

function addRailgun(builder: Builder): number {
  const { profile, part, kit, animatedRotors } = builder;
  kit.hot.emissiveIntensity = 1.48;
  kit.accent.emissiveIntensity = 0.7;
  kit.glass.emissiveIntensity = 0.38;
  kit.glass.opacity = 0.2;
  kit.glass.roughness = 0.11;
  kit.ceramic.metalness = 0.22;
  kit.ceramic.roughness = 0.47;
  kit.ceramic.clearcoat = 0.08;
  kit.shell.metalness = 0.76;
  kit.shell.roughness = 0.38;
  kit.secondary.metalness = 0.9;
  kit.secondary.roughness = 0.34;
  kit.metal.roughness = 0.24;
  kit.metal.envMapIntensity = 0.84;
  // The rear is an exposed capacitor cage carried by two curved chassis rails.
  // There is deliberately no full-height rear box: the cells, hoop, cable bus,
  // and negative space form the silhouette.
  for (const side of [-1, 1]) {
    addCurvedProfile(builder, `railgun-rear-top-spine-${side}`, [
      [0.72, 0.08], [0.64, 0.19], [0.43, 0.25], [0.16, 0.24],
      [-0.08, 0.18], [-0.35, 0.09], [-0.26, 0.04], [0.03, 0.11],
      [0.32, 0.14], [0.57, 0.12],
    ], 0.09, kit.shell, side * 0.155);
  }
  profile('railgun-rear-bottom-spine', [[0.66, -0.14], [0.43, -0.2], [0.12, -0.19], [-0.16, -0.13], [-0.37, -0.04], [-0.24, 0.01], [0.04, -0.07], [0.38, -0.09]], 0.38, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`railgun-rear-crown-${side}`, [[0.62, 0.17], [0.45, 0.28], [0.18, 0.31], [-0.04, 0.27], [0.06, 0.23], [0.37, 0.22]], 0.055, kit.ceramic, side * 0.0975);
  }
  for (const side of [-1, 1]) {
    profile(`railgun-rear-upper-cheek-${side}`, [[0.61, 0.08], [0.5, 0.2], [0.28, 0.24], [0.08, 0.2], [0.01, 0.13], [0.24, 0.1], [0.5, 0.12]], 0.024, kit.ceramic, side * 0.215);
    profile(`railgun-rear-lower-cheek-${side}`, [[0.58, -0.1], [0.34, -0.16], [0.08, -0.15], [-0.12, -0.09], [-0.03, -0.03], [0.25, -0.08]], 0.022, kit.metal, side * 0.21);
    profile(`railgun-capacitor-brow-${side}`, [[0.55, 0.17], [0.43, 0.22], [0.08, 0.21], [-0.04, 0.17], [0.12, 0.15], [0.43, 0.16]], 0.011, kit.metal, side * 0.244);
    part(`railgun-capacitor-cage-top-${side}`, new RoundedBoxGeometry(0.035, 0.036, 0.62, 2, 0.008), kit.rubber, [side * 0.27, 0.19, 0.25]);
    part(`railgun-capacitor-cage-bottom-${side}`, new RoundedBoxGeometry(0.035, 0.036, 0.62, 2, 0.008), kit.rubber, [side * 0.27, -0.13, 0.25]);
    for (let index = 0; index < 7; index += 1) {
      const z = 0.51 - index * 0.088;
      part(`railgun-capacitor-cell-${side}-${index}`, new THREE.CapsuleGeometry(0.031, 0.205, 5, 12), kit.rubber, [side * 0.282, 0.025, z]);
      part(`railgun-capacitor-core-${side}-${index}`, new THREE.CylinderGeometry(0.012, 0.012, 0.205, 8), index % 3 === 2 ? kit.hot : kit.accent, [side * 0.322, 0.025, z]);
      part(`railgun-capacitor-cell-guard-${side}-${index}`, new RoundedBoxGeometry(0.028, 0.3, 0.014, 2, 0.005), index % 2 ? kit.metal : kit.secondary, [side * 0.302, 0.025, z]);
      for (const y of [-0.098, 0.148]) {
        part(`railgun-cell-terminal-${side}-${index}-${y}`, new THREE.CylinderGeometry(0.013, 0.013, 0.025, 8), kit.metal, [side * 0.284, y, z]);
      }
    }
    part(`railgun-cage-front-post-${side}`, new RoundedBoxGeometry(0.04, 0.39, 0.04, 2, 0.009), kit.metal, [side * 0.27, 0.025, -0.08]);
    part(`railgun-cage-rear-post-${side}`, new RoundedBoxGeometry(0.04, 0.39, 0.04, 2, 0.009), kit.metal, [side * 0.27, 0.025, 0.58]);
    part(`railgun-cage-diagonal-${side}`, new RoundedBoxGeometry(0.035, 0.035, 0.67, 2, 0.008), kit.ceramic, [side * 0.29, 0.025, 0.25], [0.43, 0, 0]);
    part(`railgun-cage-rear-lock-${side}`, new THREE.CylinderGeometry(0.032, 0.032, 0.022, 12), kit.accent, [side * 0.292, 0.19, 0.53], [0, 0, Math.PI * 0.5]);
  }

  // Open top capacitor bay and overlapping crown armor. These are below the
  // existing rear crown height but finally expose readable cells, crossbars,
  // locks, and coating contrast from the FPS camera.
  part('railgun-top-capacitor-bed', new RoundedBoxGeometry(0.39, 0.018, 0.55, 3, 0.008), kit.rubber, [0, 0.253, 0.27]);
  for (let index = 0; index < 5; index += 1) {
    const x = -0.14 + index * 0.07;
    part(`railgun-top-capacitor-shell-${index}`, new THREE.CylinderGeometry(0.026, 0.026, 0.31, 14), kit.metal, [x, 0.279, 0.27], [Math.PI * 0.5, 0, 0]);
    part(`railgun-top-capacitor-core-${index}`, new THREE.CylinderGeometry(0.011, 0.011, 0.275, 9), index === 2 ? kit.hot : kit.accent, [x, 0.298, 0.27], [Math.PI * 0.5, 0, 0]);
    for (const z of [0.11, 0.43]) {
      part(`railgun-top-capacitor-collar-${index}-${z}`, new THREE.TorusGeometry(0.029, 0.006, 7, 16), kit.secondary, [x, 0.279, z]);
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const z = 0.06 + index * 0.14;
    part(`railgun-top-cage-crossbar-${index}`, new RoundedBoxGeometry(0.46, 0.024, 0.035, 2, 0.007), index === 3 ? kit.ceramic : kit.metal, [0, 0.308, z]);
    for (const x of [-0.205, 0.205]) {
      part(`railgun-top-cage-bolt-${index}-${x}`, new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10), index === 3 ? kit.hot : kit.rubber, [x, 0.328, z]);
    }
  }
  for (const [index, z] of [0.58, -0.06].entries()) {
    part(`railgun-top-crown-island-${index}`, new RoundedBoxGeometry(0.31 - index * 0.04, 0.024, 0.1, 3, 0.008), index === 0 ? kit.ceramic : kit.secondary, [0, 0.294, z]);
  }

  // Faceted butt hoop closes the cage without covering the glowing cells.
  for (const x of [-0.27, 0.27]) {
    part(`railgun-butt-hoop-side-${x}`, new RoundedBoxGeometry(0.04, 0.42, 0.04, 2, 0.01), kit.metal, [x, 0.025, 0.67]);
  }
  part('railgun-butt-hoop-top', new RoundedBoxGeometry(0.58, 0.045, 0.045, 2, 0.01), kit.metal, [0, 0.235, 0.67]);
  part('railgun-butt-hoop-bottom', new RoundedBoxGeometry(0.58, 0.045, 0.045, 2, 0.01), kit.metal, [0, -0.185, 0.67]);
  part('railgun-butt-pad', new RoundedBoxGeometry(0.5, 0.24, 0.04, 3, 0.018), kit.rubber, [0, 0.025, 0.705]);

  for (const side of [-1, 1]) {
    profile(`railgun-upper-core-cradle-${side}`, [[0.07, 0.07], [-0.12, 0.17], [-0.56, 0.2], [-0.9, 0.12], [-0.77, 0.065], [-0.15, 0.09]], 0.11, kit.shell, side * 0.195);
  }
  profile('railgun-lower-core-cradle', [[0.05, -0.13], [-0.14, -0.1], [-0.58, -0.08], [-0.9, -0.01], [-0.76, 0.035], [-0.13, -0.035]], 0.48, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`railgun-core-cradle-chevron-${side}`, [[-0.11, 0.1], [-0.25, 0.16], [-0.58, 0.17], [-0.78, 0.11], [-0.64, 0.08], [-0.27, 0.09]], 0.019, kit.ceramic, side * 0.258);
    profile(`railgun-core-cradle-lower-chevron-${side}`, [[-0.11, -0.09], [-0.27, -0.055], [-0.6, -0.035], [-0.78, 0], [-0.64, 0.025], [-0.26, -0.01]], 0.019, kit.metal, side * 0.258);
  }

  // Twin upper channels occupy the former outer envelope but leave a deep
  // central slot. From above the clamp cadence, live conductors, and flux
  // chamber now read as separate mechanisms rather than one yellow slab.
  for (const side of [-1, 1]) {
    profile(`railgun-upper-rail-channel-${side}`, [[-0.34, 0.17], [-0.56, 0.27], [-2.02, 0.255], [-2.38, 0.19], [-2.26, 0.145], [-0.58, 0.135]], 0.08, kit.ceramic, side * 0.13);
  }
  profile('railgun-lower-rail', [[-0.34, -0.015], [-0.57, -0.125], [-2.02, -0.11], [-2.38, -0.055], [-2.26, -0.015], [-0.58, 0.04]], 0.34, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`railgun-upper-inner-rail-${side}`, [[-0.61, 0.17], [-0.74, 0.245], [-1.94, 0.232], [-2.18, 0.19], [-2.04, 0.165], [-0.75, 0.155]], 0.017, kit.rubber, side * 0.182);
    profile(`railgun-lower-inner-rail-${side}`, [[-0.61, 0], [-0.75, -0.1], [-1.94, -0.088], [-2.18, -0.055], [-2.04, -0.03], [-0.75, 0.018]], 0.017, kit.rubber, side * 0.182);
  }
  for (const side of [-1, 1]) {
    part(`railgun-upper-channel-bed-${side}`, new RoundedBoxGeometry(0.072, 0.018, 1.66, 2, 0.006), kit.rubber, [side * 0.13, 0.267, -1.42]);
    part(`railgun-upper-live-rail-${side}`, new RoundedBoxGeometry(0.024, 0.012, 1.62, 2, 0.005), kit.hot, [side * 0.13, 0.281, -1.42]);
  }
  part('railgun-lower-live-rail', new RoundedBoxGeometry(0.042, 0.032, 1.64, 2, 0.008), kit.hot, [0, -0.075, -1.42]);
  for (const side of [-1, 1]) {
    part(`railgun-upper-side-live-rail-${side}`, new RoundedBoxGeometry(0.018, 0.03, 1.56, 2, 0.007), kit.hot, [side * 0.188, 0.17, -1.42]);
    part(`railgun-lower-side-live-rail-${side}`, new RoundedBoxGeometry(0.018, 0.03, 1.56, 2, 0.007), kit.hot, [side * 0.188, -0.012, -1.42]);
  }
  for (const lane of [-1, 1]) {
    const y = lane > 0 ? 0.225 : -0.075;
    for (let index = 0; index < 7; index += 1) {
      const z = -0.65 - index * 0.25;
      part(`railgun-clamp-bridge-${lane}-${index}`, new RoundedBoxGeometry(0.39, 0.06, 0.066, 2, 0.011), index % 2 ? kit.metal : kit.ceramic, [0, y, z]);
      part(`railgun-clamp-inner-shoe-${lane}-${index}`, new RoundedBoxGeometry(0.3, 0.033, 0.082, 2, 0.007), kit.rubber, [0, y - lane * 0.025, z]);
      for (const side of [-1, 1]) {
        part(`railgun-clamp-ear-${lane}-${index}-${side}`, new RoundedBoxGeometry(0.035, 0.105, 0.075, 2, 0.009), kit.metal, [side * 0.195, y, z]);
        part(`railgun-clamp-bolt-${lane}-${index}-${side}`, new THREE.CylinderGeometry(0.014, 0.014, 0.022, 10), index === 6 ? kit.hot : kit.rubber, [side * 0.215, y, z + 0.038], [0, 0, Math.PI * 0.5]);
      }
      if (lane > 0) {
        for (const x of [-0.135, 0.135]) {
          part(`railgun-clamp-top-bolt-${index}-${x}`, new THREE.CylinderGeometry(0.012, 0.012, 0.014, 10), index === 6 ? kit.hot : kit.metal, [x, 0.277, z]);
        }
      }
    }
  }

  const core = new THREE.Group();
  core.name = 'railgun-flux-core';
  core.position.set(0, 0.065, -0.73);
  const coreGlass = new THREE.Mesh(new THREE.CapsuleGeometry(0.185, 0.82, 8, 20), kit.glass);
  coreGlass.name = 'railgun-flux-chamber-glass';
  coreGlass.rotation.x = Math.PI * 0.5;
  core.add(coreGlass);
  const coreMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.76, 8, 18), kit.hot);
  coreMesh.name = 'railgun-flux-energy-column';
  coreMesh.rotation.x = Math.PI * 0.5;
  core.add(coreMesh);
  for (const x of [-0.057, 0.057]) {
    const conductor = new THREE.Mesh(new THREE.CapsuleGeometry(0.015, 0.72, 5, 10), kit.accent);
    conductor.name = `railgun-flux-conductor-${x}`;
    conductor.position.set(x, 0.045, 0);
    conductor.rotation.x = Math.PI * 0.5;
    core.add(conductor);
  }
  for (let index = 0; index < 8; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.212, index === 3 || index === 4 ? 0.027 : 0.018, 8, 28), index === 3 || index === 4 ? kit.hot : index % 2 ? kit.metal : kit.secondary);
    ring.position.z = (index - 3.5) * 0.115;
    core.add(ring);
  }
  builder.root.add(core);
  animatedRotors.push(core);

  for (const z of [-0.29, -1.18]) {
    part(`railgun-core-bulkhead-${z}`, new THREE.TorusGeometry(0.228, 0.03, 9, 30), kit.metal, [0, 0.065, z]);
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2;
      part(`railgun-core-bulkhead-bolt-${z}-${index}`, new THREE.CylinderGeometry(0.011, 0.011, 0.022, 8), kit.hot, [Math.cos(angle) * 0.229, 0.065 + Math.sin(angle) * 0.229, z + 0.017], [Math.PI * 0.5, 0, 0]);
    }
  }
  for (const x of [-0.21, 0.21]) {
    part(`railgun-core-tie-rod-${x}`, new THREE.CylinderGeometry(0.011, 0.011, 0.95, 8), kit.metal, [x, 0.065, -0.735], [Math.PI * 0.5, 0, 0]);
  }
  part('railgun-upper-muzzle-cap', new RoundedBoxGeometry(0.31, 0.105, 0.13, 3, 0.021), kit.ceramic, [0, 0.2, -2.34], [0, 0, -0.08]);
  part('railgun-lower-muzzle-cap', new RoundedBoxGeometry(0.31, 0.105, 0.13, 3, 0.021), kit.secondary, [0, -0.05, -2.34], [0, 0, 0.08]);
  for (const side of [-1, 1]) {
    part(`railgun-upper-muzzle-recess-${side}`, new RoundedBoxGeometry(0.018, 0.056, 0.094, 2, 0.009), kit.rubber, [side * 0.16, 0.2, -2.345], [0, 0, -0.08]);
    part(`railgun-lower-muzzle-recess-${side}`, new RoundedBoxGeometry(0.018, 0.056, 0.094, 2, 0.009), kit.rubber, [side * 0.16, -0.05, -2.345], [0, 0, 0.08]);
    part(`railgun-muzzle-lock-${side}`, new THREE.CylinderGeometry(0.015, 0.015, 0.022, 10), kit.hot, [side * 0.153, 0.2, -2.414], [Math.PI * 0.5, 0, 0]);
  }
  part('railgun-muzzle-field-node', new THREE.CylinderGeometry(0.052, 0.07, 0.12, 16), kit.metal, [0, 0.075, -2.34], [Math.PI * 0.5, 0, 0]);
  part('railgun-muzzle-field-bore', new THREE.CircleGeometry(0.038, 16), kit.rubber, [0, 0.075, -2.407]);
  part('railgun-muzzle-field-aperture', new THREE.CircleGeometry(0.021, 14), kit.hot, [0, 0.075, -2.411]);
  addSignalTicks(builder, -0.06, 0.24, 8, 0.067);
  return -2.43;
}

function addDiscLauncher(builder: Builder): number {
  const { profile, part, kit } = builder;

  // Polished chrome is the dominant read. Mid-gray base colors retain form in
  // bright arenas while low roughness and strong environment response produce
  // the mirror-like steel highlights the launcher and blade need.
  kit.shell.color.setHex(0x5b6469);
  kit.shell.metalness = 1;
  kit.shell.roughness = 0.32;
  kit.shell.envMapIntensity = 0.55;
  kit.shell.anisotropy = 0.9;
  kit.secondary.color.setHex(0x778186);
  kit.secondary.metalness = 1;
  kit.secondary.roughness = 0.28;
  kit.secondary.envMapIntensity = 0.6;
  kit.secondary.anisotropy = 0.95;
  kit.metal.color.setHex(0xaeb7ba);
  kit.metal.metalness = 1;
  kit.metal.roughness = 0.24;
  kit.metal.envMapIntensity = 0.65;
  kit.metal.anisotropy = 1;
  kit.ceramic.color.setHex(0x42494d);
  kit.ceramic.metalness = 0.95;
  kit.ceramic.roughness = 0.35;
  kit.ceramic.clearcoat = 0;
  kit.ceramic.envMapIntensity = 0.5;
  kit.accent.color.setHex(0x07565c);
  kit.accent.emissive.setHex(0x000000);
  kit.accent.emissiveIntensity = 0;
  kit.hot.color.setHex(0x9b5c1e);
  kit.hot.emissive.setHex(0x000000);
  kit.hot.emissiveIntensity = 0;
  kit.glass.color.setHex(0x0b4247);
  kit.glass.emissive.setHex(0x000000);
  kit.glass.emissiveIntensity = 0;
  kit.glass.opacity = 0.18;
  const bladeSteel = kit.metal.clone();
  bladeSteel.name = 'disc-machined-blade-steel';
  bladeSteel.color.setHex(0x9ea7aa);
  bladeSteel.metalness = 1;
  // A slightly broader highlight avoids high-frequency specular shimmer as
  // the exposed blade spins across sub-pixel teeth.
  bladeSteel.roughness = 0.3;
  bladeSteel.envMapIntensity = 0.55;
  bladeSteel.anisotropy = 1;
  bladeSteel.anisotropyRotation = 0;

  // Curved rear armor wraps an exposed field mechanism instead of terminating
  // in a box. Its cropped tail is intentionally allowed to leave the FPS frame.
  addCurvedProfile(builder, 'disc-curved-rear-chassis', [
    [0.7, -0.11], [0.69, 0.09], [0.59, 0.22], [0.39, 0.29],
    [0.12, 0.27], [-0.12, 0.17], [-0.3, 0.03], [-0.18, -0.09],
    [0.07, -0.16], [0.4, -0.17], [0.61, -0.14],
  ], 0.39, kit.shell);
  profile('disc-lower-keel', [
    [0.61, -0.1], [0.35, -0.2], [0.03, -0.2], [-0.42, -0.14],
    [-1.2, -0.11], [-1.42, -0.04], [-1.27, 0.01], [-0.3, -0.045],
    [0.13, -0.08], [0.46, -0.07],
  ], 0.36, kit.secondary);
  for (const side of [-1, 1]) {
    profile(`disc-rear-swept-shoulder-${side}`, [
      [0.65, -0.035], [0.6, 0.12], [0.45, 0.23], [0.22, 0.25],
      [-0.03, 0.18], [-0.2, 0.07], [-0.11, 0.015], [0.16, 0.1],
      [0.43, 0.12],
    ], 0.027, kit.ceramic, side * 0.205);
    profile(`disc-rear-shoulder-inset-${side}`, [
      [0.56, 0.015], [0.5, 0.12], [0.36, 0.18], [0.18, 0.19],
      [0.02, 0.14], [-0.1, 0.075], [0.01, 0.05], [0.24, 0.105],
      [0.45, 0.095],
    ], 0.016, side > 0 ? kit.secondary : kit.metal, side * 0.227);
    profile(`disc-lower-cheek-${side}`, [
      [0.56, -0.1], [0.36, -0.16], [0.08, -0.16], [-0.27, -0.1],
      [-0.42, -0.035], [-0.27, 0.01], [0.04, -0.07], [0.4, -0.075],
    ], 0.022, kit.metal, side * 0.207);
  }
  part('disc-rear-armor-hoop', new THREE.TorusGeometry(0.235, 0.042, 10, 36, Math.PI * 1.72), kit.metal, [0, 0.035, 0.65], [0, 0, 0.44]);
  part('disc-rear-butt-pad', new RoundedBoxGeometry(0.39, 0.22, 0.04, 5, 0.025), kit.rubber, [0, 0.015, 0.705], [-0.05, 0, 0]);
  for (const side of [-1, 1]) {
    part(`disc-rear-hoop-lock-${side}`, new THREE.CylinderGeometry(0.027, 0.027, 0.034, 12), side > 0 ? kit.hot : kit.accent, [side * 0.194, -0.085, 0.66], [Math.PI * 0.5, 0, 0]);
  }

  // A single oversized horizontal blade sits openly above the receiver. The
  // compact undertray leaves the aggressive tooth band exposed from the FPS
  // camera while the broken outer cradle makes its rotation readable.
  const discCenterX = -0.055;
  const discCenterZ = 0.055;
  const discOuterRadius = 0.43;
  const discRootRadius = 0.372;
  const discCradleRadius = 0.425;
  part('disc-magazine-undertray', new THREE.CylinderGeometry(0.255, 0.27, 0.09, 32), kit.rubber, [discCenterX, 0.226, discCenterZ]);
  part('disc-magazine-field-well', new THREE.CylinderGeometry(0.232, 0.248, 0.036, 32), kit.glass, [discCenterX, 0.29, discCenterZ]);
  part('disc-magazine-rear-cradle', new THREE.TorusGeometry(discCradleRadius, 0.044, 10, 52, Math.PI * 1.18), kit.secondary, [discCenterX, 0.318, discCenterZ], [Math.PI * 0.5, 0.08, -0.28]);
  part('disc-magazine-inner-bearing', new THREE.TorusGeometry(0.145, 0.028, 9, 30), kit.metal, [discCenterX, 0.328, discCenterZ], [Math.PI * 0.5, 0, 0]);
  for (const [index, angle] of [-2.35, -1.25, -0.15, 0.9].entries()) {
    const x = discCenterX + Math.cos(angle) * discCradleRadius;
    const z = discCenterZ + Math.sin(angle) * discCradleRadius;
    part(`disc-cradle-clamp-${index}`, new RoundedBoxGeometry(index === 3 ? 0.12 : 0.095, 0.082, 0.125, 3, 0.018), index === 3 ? kit.ceramic : kit.metal, [x, 0.318, z], [0, -angle, 0]);
    part(`disc-cradle-clamp-bolt-${index}`, new THREE.CylinderGeometry(0.018, 0.018, 0.018, 10), index === 3 ? kit.hot : kit.accent, [x, 0.368, z]);
  }

  const bladeShape = new THREE.Shape();
  const bladeTeeth = 48;
  for (let index = 0; index < bladeTeeth; index += 1) {
    const step = Math.PI * 2 / bladeTeeth;
    const points: Array<[number, number]> = [
      [index * step, discRootRadius],
      [(index + 0.2) * step, discOuterRadius],
      [(index + 0.43) * step, discOuterRadius * 0.985],
      [(index + 0.78) * step, discRootRadius],
    ];
    for (const [angle, radius] of points) {
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (index === 0 && angle === 0) bladeShape.moveTo(x, z);
      else bladeShape.lineTo(x, z);
    }
  }
  bladeShape.closePath();
  const bladeGeometry = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.018,
    steps: 1,
    bevelEnabled: true,
    bevelSize: 0.0018,
    bevelThickness: 0.0018,
    bevelSegments: 1,
  });
  bladeGeometry.translate(0, 0, -0.009);
  bladeGeometry.rotateX(Math.PI * 0.5);
  bladeGeometry.computeVertexNormals();

  const loadedDisc = new THREE.Group();
  loadedDisc.name = 'disc-loaded-disc';
  loadedDisc.position.set(discCenterX, 0.342, discCenterZ);
  const blade = new THREE.Mesh(bladeGeometry, bladeSteel);
  blade.name = 'disc-loaded-blade';
  loadedDisc.add(blade);
  const bladeHub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.052, 20), kit.secondary);
  bladeHub.name = 'disc-loaded-hub';
  loadedDisc.add(bladeHub);
  const bladeHubCore = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.063, 14), kit.hot);
  bladeHubCore.name = 'disc-loaded-hub-core';
  loadedDisc.add(bladeHubCore);
  for (const radius of [0.12, 0.225, 0.295]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, radius === 0.12 ? 0.014 : 0.01, 7, 40), radius === 0.12 ? kit.accent : kit.secondary);
    ring.name = `disc-loaded-machined-ring-${radius}`;
    ring.rotation.x = Math.PI * 0.5;
    ring.position.y = 0.026;
    loadedDisc.add(ring);
  }
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    const slot = new THREE.Mesh(new RoundedBoxGeometry(0.024, 0.016, 0.078, 2, 0.006), index % 2 ? kit.rubber : kit.ceramic);
    slot.name = `disc-loaded-radial-slot-${index}`;
    slot.position.set(Math.cos(angle) * 0.19, 0.034, Math.sin(angle) * 0.19);
    slot.rotation.y = -angle;
    loadedDisc.add(slot);
  }
  builder.root.add(loadedDisc);

  // Compress only the forward launch mechanism. All Z coordinates beyond the
  // shuttle pivot use the same 0.5 transform, keeping the two-stage mechanical
  // relationships intact while halving the visible rail length.
  const railPivotZ = -0.34;
  const railZ = (z: number): number => railPivotZ + (z - railPivotZ) * 0.5;

  // The disc indexes into a powered shuttle before crossing two visibly
  // different magnetic stages. Each stage has its own rail section, winding
  // cadence, clamps, and live conductor color.
  const shuttle = new THREE.Group();
  shuttle.name = 'disc-launch-shuttle';
  shuttle.position.set(0.025, 0.135, -0.34);
  for (const side of [-1, 1]) {
    const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.115, 0.13, 0.18, 3, 0.022), side > 0 ? kit.ceramic : kit.secondary);
    shoe.name = `disc-shuttle-shoe-${side}`;
    shoe.position.x = side * 0.155;
    shuttle.add(shoe);
    const contact = new THREE.Mesh(new RoundedBoxGeometry(0.045, 0.035, 0.14, 2, 0.009), kit.hot);
    contact.name = `disc-shuttle-live-contact-${side}`;
    contact.position.set(side * 0.117, 0.055, -0.008);
    shuttle.add(contact);
  }
  const shuttleBridge = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.055, 0.11, 3, 0.014), kit.metal);
  shuttleBridge.name = 'disc-shuttle-bridge';
  shuttleBridge.position.y = -0.055;
  shuttle.add(shuttleBridge);
  builder.root.add(shuttle);

  for (const side of [-1, 1]) {
    profile(`disc-stage-one-armored-rail-${side}`, [
      [railZ(-0.34), 0.08], [railZ(-0.49), 0.18], [railZ(-1.09), 0.18], [railZ(-1.22), 0.12],
      [railZ(-1.1), 0.075], [railZ(-0.5), 0.08],
    ], 0.095, side > 0 ? kit.ceramic : kit.secondary, side * 0.16);
    part(`disc-stage-one-rail-bed-${side}`, new RoundedBoxGeometry(0.068, 0.038, 0.385, 2, 0.01), kit.rubber, [side * 0.16, 0.195, railZ(-0.79)]);
    part(`disc-stage-one-live-rail-${side}`, new RoundedBoxGeometry(0.022, 0.018, 0.365, 2, 0.006), kit.accent, [side * 0.16, 0.225, railZ(-0.79)]);
    profile(`disc-stage-two-armored-rail-${side}`, [
      [railZ(-1.17), 0.1], [railZ(-1.29), 0.2], [railZ(-2.08), 0.17], [railZ(-2.25), 0.1],
      [railZ(-2.08), 0.055], [railZ(-1.31), 0.075],
    ], 0.082, kit.metal, side * 0.125);
    part(`disc-stage-two-rail-bed-${side}`, new RoundedBoxGeometry(0.06, 0.034, 0.425, 2, 0.009), kit.rubber, [side * 0.125, 0.202, railZ(-1.68)], [0.025, 0, 0]);
    part(`disc-stage-two-live-rail-${side}`, new RoundedBoxGeometry(0.019, 0.015, 0.4, 2, 0.005), kit.hot, [side * 0.125, 0.228, railZ(-1.68)], [0.025, 0, 0]);
    for (let index = 0; index < 5; index += 1) {
      const z = railZ(-0.52 - index * 0.145);
      part(`disc-stage-one-winding-${side}-${index}`, new RoundedBoxGeometry(0.038, 0.088, 0.035, 2, 0.008), index === 4 ? kit.hot : kit.metal, [side * 0.205, 0.13, z], [0, 0, side * 0.09]);
    }
    for (let index = 0; index < 6; index += 1) {
      const z = railZ(-1.3 - index * 0.145);
      part(`disc-stage-two-winding-${side}-${index}`, new RoundedBoxGeometry(0.034, 0.075, 0.03, 2, 0.007), index === 5 ? kit.hot : kit.secondary, [side * 0.165, 0.14, z], [0, 0, side * -0.07]);
    }
  }
  profile('disc-launch-keel', [
    [railZ(-0.36), -0.08], [railZ(-0.52), -0.14], [railZ(-2.05), -0.1], [railZ(-2.28), -0.025],
    [railZ(-2.12), 0.02], [railZ(-0.52), 0.01],
  ], 0.3, kit.shell);

  for (const [stage, positions] of [[1, [-0.48, -0.79, -1.1].map(railZ)], [2, [-1.3, -1.61, -1.92, -2.16].map(railZ)]] as const) {
    positions.forEach((z, index) => {
      part(`disc-stage-${stage}-clamp-bridge-${index}`, new RoundedBoxGeometry(stage === 1 ? 0.43 : 0.36, 0.052, 0.055, 2, 0.011), index === positions.length - 1 ? kit.ceramic : kit.metal, [0, 0.115, z]);
      for (const side of [-1, 1]) {
        part(`disc-stage-${stage}-clamp-ear-${index}-${side}`, new RoundedBoxGeometry(0.044, 0.15, 0.07, 2, 0.011), kit.secondary, [side * (stage === 1 ? 0.21 : 0.175), 0.12, z]);
        part(`disc-stage-${stage}-clamp-fastener-${index}-${side}`, new THREE.CylinderGeometry(0.014, 0.014, 0.022, 10), index === positions.length - 1 ? kit.hot : kit.metal, [side * (stage === 1 ? 0.232 : 0.197), 0.17, z], [0, 0, Math.PI * 0.5]);
      }
    });
  }

  const stageCoupler = new THREE.Group();
  stageCoupler.name = 'disc-stage-coupler';
  stageCoupler.position.set(0, 0.115, railZ(-1.18));
  const couplerFrame = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.035, 9, 30, Math.PI * 1.62), kit.metal);
  couplerFrame.name = 'disc-stage-coupler-frame';
  stageCoupler.add(couplerFrame);
  const couplerCore = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.02, 8, 28, Math.PI * 1.62), kit.hot);
  couplerCore.name = 'disc-stage-coupler-core';
  couplerCore.position.z = -0.012;
  stageCoupler.add(couplerCore);
  for (let index = 0; index < 6; index += 1) {
    const angle = -0.5 + index * 0.52;
    const node = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 9), index % 2 ? kit.accent : kit.hot);
    node.name = `disc-stage-coupler-node-${index}`;
    node.position.set(Math.cos(angle) * 0.18, Math.sin(angle) * 0.18, -0.025);
    stageCoupler.add(node);
  }
  builder.root.add(stageCoupler);

  // Armored power and telemetry looms terminate in visibly machined sockets.
  addArmoredHose(builder, 'disc-right-field-bus', [
    [0.23, 0.12, 0.43], [0.32, 0.23, 0.3], [0.35, 0.24, 0.08],
    [0.34, 0.13, -0.15], [0.31, 0.02, railZ(-0.36)], [0.27, 0.08, railZ(-0.58)],
  ], 0.021, kit.ceramic);
  addArmoredHose(builder, 'disc-left-telemetry-loom', [
    [-0.23, -0.02, 0.38], [-0.3, -0.12, 0.22], [-0.34, -0.1, 0],
    [-0.33, 0.02, -0.2], [-0.29, 0.11, railZ(-0.42)], [-0.24, 0.1, railZ(-0.7)],
  ], 0.016, kit.metal);
  for (const [side, y, z] of [[1, 0.12, 0.43], [1, 0.08, railZ(-0.58)], [-1, -0.02, 0.38], [-1, 0.1, railZ(-0.7)]] as const) {
    part(`disc-loom-socket-well-${side}-${z}`, new THREE.CylinderGeometry(0.052, 0.052, 0.025, 14), kit.rubber, [side * 0.215, y, z], [0, 0, Math.PI * 0.5]);
    part(`disc-loom-socket-${side}-${z}`, new THREE.CylinderGeometry(0.033, 0.042, 0.06, 14), kit.metal, [side * 0.247, y, z], [0, 0, Math.PI * 0.5]);
    part(`disc-loom-socket-lock-${side}-${z}`, new THREE.TorusGeometry(0.043, 0.007, 7, 18), side > 0 ? kit.hot : kit.accent, [side * 0.28, y, z], [0, Math.PI * 0.5, 0]);
  }

  // Weapon-specific control furniture sits above the common grip so the hand
  // connection looks engineered rather than attached to the hull afterward.
  part('disc-grip-neck', new RoundedBoxGeometry(0.27, 0.16, 0.3, 4, 0.035), kit.shell, [0.055, -0.105, 0.025], [-0.15, 0, 0.035]);
  part('disc-trigger-guard-frame', new THREE.TorusGeometry(0.12, 0.019, 8, 24, Math.PI * 1.5), kit.metal, [0.035, -0.14, -0.25], [Math.PI * 0.5, 0.08, 0.18]);
  part('disc-primary-trigger', new RoundedBoxGeometry(0.027, 0.125, 0.027, 2, 0.008), kit.hot, [0.025, -0.145, -0.27], [0.3, 0, 0]);
  part('disc-index-release', new RoundedBoxGeometry(0.055, 0.028, 0.075, 2, 0.008), kit.accent, [0.148, -0.04, -0.11], [0.04, 0, -0.12]);

  // Open fork muzzle: the disc exits between field shoes rather than through a
  // generic barrel. The hot center bridge gives muzzle VFX a plausible origin.
  for (const side of [-1, 1]) {
    part(`disc-muzzle-fork-${side}`, new RoundedBoxGeometry(0.095, 0.15, 0.16, 3, 0.02), side > 0 ? kit.ceramic : kit.secondary, [side * 0.13, 0.12, railZ(-2.25)], [0.02, side * 0.04, 0]);
    part(`disc-muzzle-field-shoe-${side}`, new RoundedBoxGeometry(0.042, 0.075, 0.1, 2, 0.012), kit.hot, [side * 0.082, 0.16, railZ(-2.29)]);
    part(`disc-muzzle-lock-${side}`, new THREE.CylinderGeometry(0.018, 0.018, 0.026, 10), kit.metal, [side * 0.184, 0.175, railZ(-2.31)], [0, 0, Math.PI * 0.5]);
  }
  part('disc-muzzle-field-bridge', new RoundedBoxGeometry(0.17, 0.035, 0.055, 2, 0.009), kit.accent, [0, 0.075, railZ(-2.31)]);
  part('disc-muzzle-launch-aperture', new RoundedBoxGeometry(0.095, 0.028, 0.02, 2, 0.006), kit.hot, [0, 0.135, railZ(-2.42)]);

  addFasteners(builder, 0.24, -0.015, 0.44, 6);
  addSignalTicks(builder, railZ(-0.54), 0.265, 7, 0.0475);
  return railZ(-2.43);
}

function addWeaponGeometry(builder: Builder, id: WeaponId): number {
  switch (id) {
    case 'machine': return addMachineGun(builder);
    case 'shotgun': return addShotgun(builder);
    case 'rocket': return addRocketLauncher(builder);
    case 'plasma': return addPlasmaGun(builder);
    case 'laser': return addLaser(builder);
    case 'sniper': return addSniper(builder);
    case 'rail': return addRailgun(builder);
    case 'disc': return addDiscLauncher(builder);
  }
}

function isIndividuallyAnimatedWeaponNode(name: string): boolean {
  return name === 'rocket-rangefinder'
    || name === 'sniper-scope'
    || name.startsWith('rocket-rear-turbine-blade-')
    || name.startsWith('rocket-stage-top-shoe-')
    || name.startsWith('laser-radiator-fin-')
    || name.startsWith('railgun-clamp-bridge-');
}

function consolidateStaticWeaponMeshes(
  viewRoot: THREE.Group,
  animatedRoots: readonly THREE.Object3D[],
): number {
  const dynamicRoots = new Set(animatedRoots);
  const isProtected = (object: THREE.Object3D): boolean => {
    let cursor: THREE.Object3D | null = object;
    while (cursor && cursor !== viewRoot) {
      if (dynamicRoots.has(cursor)
        || cursor.name === 'first-person-armature'
        || isIndividuallyAnimatedWeaponNode(cursor.name)) return true;
      cursor = cursor.parent;
    }
    return false;
  };
  const geometrySignature = (geometry: THREE.BufferGeometry): string => {
    const attributes = Object.entries(geometry.attributes)
      .map(([name, attribute]) => `${name}:${attribute.itemSize}:${attribute.normalized}:${attribute.array.constructor.name}`)
      .sort()
      .join('|');
    return `${geometry.index ? 'indexed' : 'plain'}:${attributes}`;
  };

  viewRoot.updateMatrixWorld(true);
  const inverseRoot = viewRoot.matrixWorld.clone().invert();
  const batches = new Map<string, { material: THREE.Material; meshes: THREE.Mesh[] }>();
  viewRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || isProtected(mesh) || Array.isArray(mesh.material) || mesh.material.transparent) return;
    const key = `${mesh.material.uuid}:${geometrySignature(mesh.geometry)}`;
    const batch = batches.get(key) ?? { material: mesh.material, meshes: [] };
    batch.meshes.push(mesh);
    batches.set(key, batch);
  });

  let batchIndex = 0;
  for (const { material, meshes } of batches.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map((mesh) => {
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(inverseRoot.clone().multiply(mesh.matrixWorld));
      return geometry;
    });
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const batch = new THREE.Mesh(merged, material);
    batch.name = `weapon-static-material-batch-${batchIndex}`;
    batch.castShadow = false;
    batch.receiveShadow = false;
    batch.frustumCulled = false;
    batchIndex += 1;
    viewRoot.add(batch);
    for (const mesh of meshes) mesh.parent?.remove(mesh);
  }

  let renderMeshCount = 0;
  viewRoot.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) renderMeshCount += 1;
  });
  return renderMeshCount;
}

export function createWeaponViewModel(
  definition: WeaponDefinition,
  includeHands = true,
  applyPresentation = true,
): WeaponViewModel {
  const builder = createBuilder(definition);
  const muzzleZ = addWeaponGeometry(builder, definition.id);
  addWeaponMicroDetail(builder, definition.id);
  if (definition.id !== 'rocket') addReceiverSurfaceDetail(builder, definition.id);
  if (definition.id === 'machine' || definition.id === 'shotgun' || definition.id === 'sniper') {
    addWeaponRearDetails(builder, definition.id);
  }
  addCommonGrip(builder);

  const muzzleSocket = new THREE.Object3D();
  muzzleSocket.name = `${definition.id}-muzzle-socket`;
  muzzleSocket.position.set(
    0,
    definition.id === 'rocket' ? 0.18 : definition.id === 'disc' ? 0.135 : definition.id === 'sniper' ? 0.1 : 0.08,
    muzzleZ,
  );
  builder.root.add(muzzleSocket);

  if (applyPresentation) {
    const presentation = WEAPON_PRESENTATION[definition.id];
    builder.root.scale.setScalar(presentation.scale);
    builder.root.rotation.set(...presentation.rotation);
    builder.root.position.set(...presentation.position);
  }

  const viewRoot = new THREE.Group();
  viewRoot.name = `${definition.id}-first-person-view`;
  viewRoot.add(builder.root);
  if (includeHands) addHands(viewRoot, builder.root, builder.kit);

  let meshCount = 0;
  let triangleCount = 0;
  viewRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshCount += 1;
    const position = mesh.geometry.getAttribute('position');
    triangleCount += mesh.geometry.index
      ? mesh.geometry.index.count / 3
      : (position?.count ?? 0) / 3;
  });

  // The query switch exists solely for the production profiler's controlled
  // A/B. Normal gameplay always takes the batched path.
  const renderMeshCount = new URLSearchParams(window.location.search).has('perf-unbatched')
    ? meshCount
    : consolidateStaticWeaponMeshes(
      viewRoot,
      [...builder.animatedRotors, ...builder.animatedSlides],
    );

  const animationNodes = new Map<string, THREE.Object3D>();
  viewRoot.traverse((object) => {
    if (object.name) animationNodes.set(object.name, object);
    object.userData.weaponAnimationBase = {
      position: object.position.clone(),
      rotation: object.rotation.clone(),
      scale: object.scale.clone(),
    };
  });

  return {
    root: viewRoot,
    muzzleSocket,
    animatedRotors: builder.animatedRotors,
    animatedSlides: builder.animatedSlides,
    animationNodes,
    animationState: {
      lastElapsed: Number.NaN,
      lastRecoil: 0,
      shotAge: Number.POSITIVE_INFINITY,
      shotStrength: 0,
      rotorAngle: 0,
      rotorVelocity: 0,
    },
    pulseMaterials: definition.id === 'disc' ? [] : [builder.kit.accent, builder.kit.hot],
    pulseBaseIntensities: definition.id === 'disc'
      ? []
      : definition.id === 'machine'
      ? [0, 0]
      : [ACCENT_INTENSITY, 0.68],
    battleWearMaterialCount: Object.values(builder.kit).filter(
      (material) => material.userData.surfaceTreatment === 'battle-worn',
    ).length,
    battleWearTextureCount: new Set(
      Object.values(builder.kit).flatMap((material) => [
        'map' in material ? material.map : null,
        'roughnessMap' in material ? material.roughnessMap : null,
        'normalMap' in material ? material.normalMap : null,
        'metalnessMap' in material ? material.metalnessMap : null,
      ]).filter((texture): texture is THREE.Texture => Boolean(texture)),
    ).size,
    assetSource: 'procedural',
    meshCount,
    renderMeshCount,
    triangleCount: Math.round(triangleCount),
    weapon: definition.id,
  };
}

export function updateWeaponViewModel(
  visual: WeaponViewModel,
  elapsed: number,
  recoil: number,
  heat: number,
  reducedMotion: boolean,
): void {
  const motion = reducedMotion ? 0 : 1;
  const state = visual.animationState;
  const delta = Number.isFinite(state.lastElapsed)
    ? THREE.MathUtils.clamp(elapsed - state.lastElapsed, 0, 1 / 20)
    : 0;
  const fired = recoil > state.lastRecoil + 0.004 && recoil > 0.012;
  if (fired) {
    state.shotAge = 0;
    state.shotStrength = THREE.MathUtils.clamp(Math.max(recoil * 3.2, 0.65), 0.65, 1);
    state.rotorVelocity = Math.max(
      state.rotorVelocity,
      visual.weapon === 'machine' ? 38 : visual.weapon === 'disc' ? 64 : 16,
    );
  } else {
    state.shotAge += delta;
  }
  state.rotorVelocity *= Math.exp(-delta * (
    visual.weapon === 'machine' ? 3.8 : visual.weapon === 'disc' ? 4.8 : 6.5
  ));
  state.rotorAngle += state.rotorVelocity * delta * motion;
  state.lastElapsed = elapsed;
  state.lastRecoil = recoil;

  const smooth = (edge0: number, edge1: number, value: number): number => {
    const t = THREE.MathUtils.clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const envelope = (attackStart: number, attackEnd: number, releaseStart: number, releaseEnd: number): number => (
    smooth(attackStart, attackEnd, state.shotAge) - smooth(releaseStart, releaseEnd, state.shotAge)
  ) * state.shotStrength * motion;
  const baseOf = (object: THREE.Object3D): { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } => (
    object.userData.weaponAnimationBase as { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }
  );
  const restore = (object: THREE.Object3D): void => {
    const base = baseOf(object);
    object.position.copy(base.position);
    object.rotation.copy(base.rotation);
    object.scale.copy(base.scale);
  };
  for (const rotor of visual.animatedRotors) restore(rotor);
  for (const slide of visual.animatedSlides) restore(slide);

  if (visual.weapon === 'machine') {
    const rotor = visual.animatedRotors[0];
    if (rotor) {
      const base = baseOf(rotor);
      rotor.rotation.z = base.rotation.z + state.rotorAngle;
      rotor.position.z = base.position.z + envelope(0, 0.025, 0.055, 0.13) * 0.055;
      rotor.position.x = base.position.x + Math.sin(elapsed * 92) * recoil * 0.004 * motion;
    }
  } else if (visual.weapon === 'shotgun') {
    const pump = visual.animatedSlides[0];
    if (pump) {
      const base = baseOf(pump);
      const rearward = envelope(0.055, 0.14, 0.24, 0.48);
      pump.position.z = base.position.z + rearward * 0.32;
      pump.rotation.x = base.rotation.x - rearward * 0.075;
      pump.position.y = base.position.y - Math.sin(Math.PI * rearward) * 0.012;
    }
  } else if (visual.weapon === 'rocket') {
    const turbineKick = envelope(0, 0.04, 0.12, 0.32);
    for (const [name, node] of visual.animationNodes) {
      if (name.startsWith('rocket-rear-turbine-blade-')) {
        const base = baseOf(node);
        node.rotation.z = base.rotation.z + state.rotorAngle * 0.48 + turbineKick * 0.32;
      } else if (name.startsWith('rocket-stage-top-shoe-')) {
        const base = baseOf(node);
        const index = Number(name.slice(name.lastIndexOf('-') + 1)) || 0;
        node.position.y = base.position.y + turbineKick * (0.018 + index * 0.003);
      }
    }
    const rangefinder = visual.animationNodes.get('rocket-rangefinder');
    if (rangefinder) {
      const base = baseOf(rangefinder);
      rangefinder.rotation.z = base.rotation.z - turbineKick * 0.035;
      rangefinder.position.z = base.position.z + turbineKick * 0.045;
    }
  } else if (visual.weapon === 'plasma') {
    const reactor = visual.animatedRotors[0];
    const turbine = visual.animatedRotors[1];
    const pulse = envelope(0, 0.045, 0.11, 0.34);
    if (reactor) {
      const base = baseOf(reactor);
      reactor.rotation.z = base.rotation.z - state.rotorAngle * 0.18;
      reactor.scale.set(base.scale.x * (1 + pulse * 0.035), base.scale.y * (1 + pulse * 0.035), base.scale.z * (1 + pulse * 0.055));
    }
    if (turbine) {
      const base = baseOf(turbine);
      turbine.rotation.z = base.rotation.z + state.rotorAngle * 0.62;
      turbine.position.z = base.position.z - pulse * 0.045;
    }
  } else if (visual.weapon === 'laser') {
    const focusing = visual.animatedSlides[0];
    const focus = THREE.MathUtils.clamp(heat * 3.2 + recoil * 1.4, 0, 1) * motion;
    if (focusing) {
      const base = baseOf(focusing);
      focusing.position.z = base.position.z - focus * 0.09 - Math.sin(elapsed * 18) * focus * 0.008;
      focusing.scale.set(base.scale.x * (1 + focus * 0.035), base.scale.y * (1 + focus * 0.035), base.scale.z * (1 - focus * 0.045));
      focusing.rotation.z = base.rotation.z + Math.sin(elapsed * 11) * focus * 0.018;
    }
    for (const [name, node] of visual.animationNodes) {
      if (!name.startsWith('laser-radiator-fin-')) continue;
      const base = baseOf(node);
      const index = Number(name.slice(name.lastIndexOf('-') + 1)) || 0;
      node.position.x = base.position.x + Math.sign(base.position.x || (index % 2 ? 1 : -1)) * focus * 0.018;
      node.position.y = base.position.y + Math.sign(base.position.y - 0.055) * focus * 0.012;
    }
  } else if (visual.weapon === 'sniper') {
    const bolt = visual.animatedSlides[0];
    if (bolt) {
      const base = baseOf(bolt);
      const unlock = envelope(0.045, 0.1, 0.31, 0.48);
      const pull = envelope(0.11, 0.2, 0.29, 0.5);
      bolt.rotation.z = base.rotation.z + unlock * 0.8;
      bolt.position.z = base.position.z + pull * 0.27;
    }
    const scope = visual.animationNodes.get('sniper-scope');
    if (scope) {
      const base = baseOf(scope);
      scope.position.z = base.position.z + envelope(0, 0.025, 0.07, 0.18) * 0.018;
    }
  } else if (visual.weapon === 'disc') {
    const loadedDisc = visual.animatedRotors[0];
    const shuttle = visual.animatedSlides[0];
    const charge = envelope(0, 0.025, 0.095, 0.31);
    const launch = envelope(0.018, 0.055, 0.085, 0.22);
    const recoilKick = envelope(0, 0.018, 0.06, 0.17);
    const recovery = envelope(0.1, 0.19, 0.28, 0.45);
    if (loadedDisc) {
      const base = baseOf(loadedDisc);
      loadedDisc.rotation.y = base.rotation.y + state.rotorAngle * 1.45;
      // Sweep the already-spinning disc from its offset cradle, onto the rail
      // centerline, and almost to the authored muzzle in one fast frisbee-like
      // throw. Perspective supplies the apparent size change; the blade itself
      // stays rigid, thin, and horizontal.
      loadedDisc.position.x = THREE.MathUtils.lerp(base.position.x, 0, launch);
      loadedDisc.position.z = base.position.z - launch * 1.34 + recovery * 0.025;
      loadedDisc.position.y = base.position.y - launch * 0.13 + Math.sin(Math.PI * launch) * 0.035;
      loadedDisc.rotation.x = base.rotation.x;
      loadedDisc.scale.copy(base.scale);
    }
    if (shuttle) {
      const base = baseOf(shuttle);
      shuttle.position.z = base.position.z + charge * 0.07 - launch * 0.42 + recoilKick * 0.055;
      shuttle.position.y = base.position.y - charge * 0.018 + launch * 0.025;
      shuttle.scale.set(base.scale.x * (1 + charge * 0.045), base.scale.y, base.scale.z * (1 - charge * 0.06));
    }
  } else if (visual.weapon === 'rail') {
    const core = visual.animatedRotors[0];
    const discharge = envelope(0, 0.03, 0.08, 0.26);
    if (core) {
      const base = baseOf(core);
      core.rotation.z = base.rotation.z + state.rotorAngle * 0.35;
      core.scale.set(base.scale.x * (1 + discharge * 0.055), base.scale.y * (1 + discharge * 0.055), base.scale.z * (1 - discharge * 0.08));
      core.position.z = base.position.z - discharge * 0.06;
    }
    for (const [name, node] of visual.animationNodes) {
      if (!name.startsWith('railgun-clamp-bridge-')) continue;
      const base = baseOf(node);
      const index = Number(name.slice(name.lastIndexOf('-') + 1)) || 0;
      const wave = Math.max(0, 1 - Math.abs(state.shotAge - index * 0.018) / 0.075) * state.shotStrength * motion;
      node.position.y = base.position.y + Math.sign(base.position.y - 0.075) * wave * 0.018;
      node.scale.x = base.scale.x * (1 + wave * 0.045);
    }
  }
  const charge = visual.weapon === 'laser'
    ? heat
    : visual.weapon === 'disc'
      ? 0
      : recoil;
  for (let index = 0; index < visual.pulseMaterials.length; index += 1) {
    const material = visual.pulseMaterials[index];
    if (visual.weapon === 'machine') {
      material.emissiveIntensity = 0;
      continue;
    }
    const base = visual.pulseBaseIntensities[index] ?? material.emissiveIntensity;
    const pulseBoost = index === 0 ? 1.4 : 2.2;
    material.emissiveIntensity = base + charge * pulseBoost;
  }
}
