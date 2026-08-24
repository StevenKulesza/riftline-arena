import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { WeaponDefinition, WeaponId } from '../game/config';

type MaterialKit = {
  shell: THREE.MeshPhysicalMaterial;
  secondary: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
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
  pulseMaterials: THREE.MeshStandardMaterial[];
  battleWearMaterialCount: number;
  battleWearTextureCount: number;
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

const ACCENT_INTENSITY = 0.95;

const WEAPON_PALETTES: Record<WeaponId, { shell: number; secondary: number; metal: number; ceramic: number }> = {
  machine: { shell: 0x0b3040, secondary: 0x17657d, metal: 0x4f8997, ceramic: 0x66bed0 },
  shotgun: { shell: 0x422407, secondary: 0x8b541b, metal: 0x9c7742, ceramic: 0xe08d29 },
  rocket: { shell: 0x421114, secondary: 0x8b2b2e, metal: 0x81534d, ceramic: 0xdd513b },
  plasma: { shell: 0x281445, secondary: 0x633493, metal: 0x74568f, ceramic: 0xa76be0 },
  laser: { shell: 0x0a392a, secondary: 0x287e5b, metal: 0x55947e, ceramic: 0x9ce5c9 },
  sniper: { shell: 0x41102f, secondary: 0x842762, metal: 0x8a5878, ceramic: 0xd85c9e },
  rail: { shell: 0x3a3b08, secondary: 0x858027, metal: 0x969259, ceramic: 0xe1e56b },
};

const WEAPON_WEAR_SEEDS: Record<WeaponId, number> = {
  machine: 0x1a2b3c,
  shotgun: 0x2b3c4d,
  rocket: 0x3c4d5e,
  plasma: 0x4d5e6f,
  laser: 0x5e6f70,
  sniper: 0x6f7081,
  rail: 0x708192,
};

type BattleWearTextures = {
  albedo: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
};

function createBattleWearTextures(id: WeaponId): BattleWearTextures {
  const size = 256;
  const albedoCanvas = document.createElement('canvas');
  const roughnessCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = size;
  roughnessCanvas.width = roughnessCanvas.height = size;
  const albedoContext = albedoCanvas.getContext('2d');
  const roughnessContext = roughnessCanvas.getContext('2d');
  if (!albedoContext || !roughnessContext) throw new Error('Canvas textures are unavailable.');

  let state = WEAPON_WEAR_SEEDS[id] >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };

  const albedoPixels = albedoContext.createImageData(size, size);
  const roughnessPixels = roughnessContext.createImageData(size, size);
  for (let index = 0; index < size * size; index += 1) {
    const albedoGrain = Math.floor(random() * 11) - 5;
    const roughnessGrain = Math.floor(random() * 29) - 14;
    const albedoValue = 238 + albedoGrain;
    const roughnessValue = 202 + roughnessGrain;
    for (let channel = 0; channel < 3; channel += 1) {
      albedoPixels.data[index * 4 + channel] = albedoValue;
      roughnessPixels.data[index * 4 + channel] = roughnessValue;
    }
    albedoPixels.data[index * 4 + 3] = 255;
    roughnessPixels.data[index * 4 + 3] = 255;
  }
  albedoContext.putImageData(albedoPixels, 0, 0);
  roughnessContext.putImageData(roughnessPixels, 0, 0);

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
  for (let scratch = 0; scratch < 34; scratch += 1) {
    const startX = random() * size;
    const startY = random() * size;
    const length = 9 + random() * 38;
    const angle = random() * Math.PI * 2;
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length;
    const width = 0.55 + random() * 1.25;

    albedoContext.beginPath();
    albedoContext.moveTo(startX, startY);
    albedoContext.lineTo(endX, endY);
    albedoContext.lineWidth = width;
    albedoContext.strokeStyle = `rgba(28, 32, 35, ${0.2 + random() * 0.28})`;
    albedoContext.stroke();
    albedoContext.beginPath();
    albedoContext.moveTo(startX + 0.8, startY + 0.8);
    albedoContext.lineTo(endX + 0.8, endY + 0.8);
    albedoContext.lineWidth = Math.max(0.45, width * 0.52);
    albedoContext.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    albedoContext.stroke();

    roughnessContext.beginPath();
    roughnessContext.moveTo(startX, startY);
    roughnessContext.lineTo(endX, endY);
    roughnessContext.lineWidth = width * 1.35;
    roughnessContext.strokeStyle = 'rgba(82, 82, 82, 0.8)';
    roughnessContext.stroke();
  }

  const configure = (texture: THREE.CanvasTexture, name: string): THREE.CanvasTexture => {
    texture.name = `${id}-${name}`;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.25, 1.25);
    texture.anisotropy = 4;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  };
  const albedo = configure(new THREE.CanvasTexture(albedoCanvas), 'battle-wear-albedo');
  albedo.colorSpace = THREE.SRGBColorSpace;
  const roughness = configure(new THREE.CanvasTexture(roughnessCanvas), 'battle-wear-roughness');
  return { albedo, roughness };
}

function applyBattleWear<T extends THREE.MeshStandardMaterial>(
  material: T,
  textures: BattleWearTextures,
  bumpScale: number,
): T {
  material.map = textures.albedo;
  material.roughnessMap = textures.roughness;
  material.bumpMap = textures.roughness;
  material.bumpScale = bumpScale;
  material.userData.surfaceTreatment = 'battle-worn';
  return material;
}

const WEAPON_PRESENTATION: Record<WeaponId, {
  scale: number;
  rotation: [number, number, number];
  position: [number, number, number];
}> = {
  // Bore alignment is applied to the parent every frame in Game.updateCamera.
  // Keeping these roots neutral means detail asymmetry defines the silhouette
  // without pointing the physical barrel away from the crosshair.
  machine: { scale: 0.74, rotation: [0, 0, -0.018], position: [0, 0, -0.02] },
  shotgun: { scale: 0.7, rotation: [0, 0, -0.012], position: [0, -0.015, -0.03] },
  rocket: { scale: 0.64, rotation: [0, 0, -0.014], position: [0, -0.025, -0.08] },
  plasma: { scale: 0.68, rotation: [0, 0, -0.01], position: [0, 0.025, -0.05] },
  laser: { scale: 0.67, rotation: [0, 0, -0.01], position: [0, 0.035, -0.07] },
  sniper: { scale: 0.57, rotation: [0, 0, -0.012], position: [0, 0.035, -0.11] },
  rail: { scale: 0.56, rotation: [0, 0, -0.01], position: [0, 0.025, -0.12] },
};

function weaponMaterials(definition: WeaponDefinition): MaterialKit {
  const accentColor = new THREE.Color(definition.color);
  const hotColor = accentColor.clone().lerp(new THREE.Color(0xffffff), 0.48);
  const palette = WEAPON_PALETTES[definition.id];
  const wear = createBattleWearTextures(definition.id);
  return {
    shell: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.shell,
      roughness: 0.72,
      metalness: 0.28,
      clearcoat: 0.24,
      clearcoatRoughness: 0.36,
      envMapIntensity: 0.38,
    }), wear, 0.008),
    secondary: applyBattleWear(new THREE.MeshStandardMaterial({
      color: palette.secondary,
      roughness: 0.66,
      metalness: 0.58,
      envMapIntensity: 0.48,
    }), wear, 0.006),
    metal: applyBattleWear(new THREE.MeshStandardMaterial({
      color: palette.metal,
      roughness: 0.58,
      metalness: 1,
      envMapIntensity: 0.55,
    }), wear, 0.004),
    ceramic: applyBattleWear(new THREE.MeshPhysicalMaterial({
      color: palette.ceramic,
      roughness: 0.64,
      metalness: 0.08,
      clearcoat: 0.3,
      clearcoatRoughness: 0.32,
      envMapIntensity: 0.42,
    }), wear, 0.009),
    rubber: applyBattleWear(new THREE.MeshStandardMaterial({
      color: 0x05080d,
      roughness: 1,
      metalness: 0.04,
      envMapIntensity: 0.2,
    }), wear, 0.012),
    accent: new THREE.MeshStandardMaterial({
      color: accentColor.clone().multiplyScalar(0.82),
      emissive: accentColor,
      emissiveIntensity: ACCENT_INTENSITY,
      roughness: 0.19,
      metalness: 0.34,
      envMapIntensity: 0.9,
    }),
    hot: new THREE.MeshStandardMaterial({
      color: hotColor,
      emissive: hotColor,
      emissiveIntensity: 1.45,
      roughness: 0.12,
      metalness: 0.08,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: accentColor.clone().lerp(new THREE.Color(0xcffaff), 0.48),
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.42,
      clearcoat: 1,
      envMapIntensity: 1.8,
      depthWrite: false,
    }),
    decal: new THREE.MeshBasicMaterial({ color: hotColor, toneMapped: false }),
  };
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
  const rearGrip = new THREE.Vector3(0.08, -0.27, -0.01).applyMatrix4(weaponRoot.matrix);
  const frontGrip = new THREE.Vector3(-0.22, -0.15, -0.55).applyMatrix4(weaponRoot.matrix);
  const rearStart = new THREE.Vector3(0.46, -0.86, 0.24);
  const frontStart = new THREE.Vector3(-0.48, -0.78, 0.08);
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

function addCable(
  builder: Builder,
  name: string,
  points: Array<[number, number, number]>,
  radius = 0.018,
  hot = false,
): void {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  builder.part(name, new THREE.TubeGeometry(curve, 14, radius, 6, false), hot ? builder.kit.accent : builder.kit.rubber, [0, 0, 0]);
}

function addWeaponMicroDetail(builder: Builder, id: WeaponId): void {
  const { part, kit } = builder;
  if (id === 'machine') {
    part('mg-ejection-port', new RoundedBoxGeometry(0.018, 0.13, 0.28, 2, 0.008), kit.rubber, [0.295, 0.09, -0.24]);
    part('mg-charging-handle', new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), kit.metal, [0.39, 0.2, -0.18], [0, 0, Math.PI * 0.5]);
    for (let index = 0; index < 6; index += 1) {
      part(`mg-cooling-slot-${index}`, new RoundedBoxGeometry(0.018, 0.045, 0.075, 2, 0.008), index === 5 ? kit.accent : kit.rubber, [-0.286, 0.1, -0.1 - index * 0.095], [0.08, 0, 0]);
      part(`mg-feed-round-${index}`, new THREE.CylinderGeometry(0.022, 0.022, 0.095, 8), kit.metal, [0.34, -0.04, -0.08 - index * 0.07], [Math.PI * 0.5, 0, 0]);
    }
    addCable(builder, 'mg-feed-cable', [[0.27, -0.07, 0.02], [0.37, -0.02, -0.28], [0.31, 0.05, -0.62]], 0.024, true);
  } else if (id === 'shotgun') {
    for (const z of [-0.72, -1.22, -1.58]) {
      part(`shotgun-barrel-clamp-${z}`, new RoundedBoxGeometry(0.48, 0.09, 0.07, 2, 0.018), z === -1.58 ? kit.accent : kit.secondary, [0, 0.08, z]);
    }
    part('shotgun-breach-latch', new RoundedBoxGeometry(0.14, 0.08, 0.25, 2, 0.018), kit.metal, [0.31, 0.19, -0.36], [0, 0, -0.16]);
    part('shotgun-front-sight', new THREE.CylinderGeometry(0.025, 0.025, 0.11, 8), kit.hot, [0, 0.23, -1.62]);
    for (let index = 0; index < 5; index += 1) {
      part(`shotgun-heat-port-${index}`, new RoundedBoxGeometry(0.035, 0.028, 0.1, 2, 0.008), kit.rubber, [-0.29, 0.18, -0.62 - index * 0.17]);
    }
  } else if (id === 'rocket') {
    part('rocket-rangefinder', new RoundedBoxGeometry(0.22, 0.2, 0.38, 3, 0.04), kit.secondary, [0.34, 0.42, -0.46]);
    part('rocket-rangefinder-lens', new THREE.CircleGeometry(0.072, 18), kit.glass, [0.344, 0.43, -0.665], [0, Math.PI * 0.5, 0]);
    part('rocket-top-sight', new RoundedBoxGeometry(0.12, 0.09, 0.5, 2, 0.025), kit.rubber, [0, 0.52, -0.7]);
    for (let index = 0; index < 6; index += 1) {
      const angle = index / 6 * Math.PI * 2;
      part(`rocket-exhaust-vane-${index}`, new RoundedBoxGeometry(0.08, 0.17, 0.18, 2, 0.018), index % 2 ? kit.metal : kit.secondary, [Math.cos(angle) * 0.31, 0.18 + Math.sin(angle) * 0.31, 0.08], [0, 0, angle]);
    }
    addCable(builder, 'rocket-fire-control-cable', [[-0.28, -0.02, -0.15], [-0.4, 0.18, -0.52], [-0.33, 0.39, -0.82]], 0.022, true);
  } else if (id === 'plasma') {
    for (const side of [-1, 1]) {
      addCable(builder, `plasma-coolant-line-${side}`, [[side * 0.22, -0.08, -0.1], [side * 0.39, 0.06, -0.55], [side * 0.34, 0.23, -1.2]], 0.026, side > 0);
      for (let index = 0; index < 4; index += 1) {
        part(`plasma-capacitor-${side}-${index}`, new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10), index === 3 ? kit.hot : kit.metal, [side * 0.31, -0.06, -0.22 - index * 0.16], [Math.PI * 0.5, 0, 0]);
      }
    }
    part('plasma-reactor-shield', new THREE.TorusGeometry(0.28, 0.034, 8, 24, Math.PI * 1.45), kit.ceramic, [0, 0.21, -0.62], [Math.PI * 0.5, 0, 0.4]);
  } else if (id === 'laser') {
    part('laser-power-pack', new RoundedBoxGeometry(0.34, 0.29, 0.48, 3, 0.045), kit.secondary, [-0.19, -0.16, -0.3], [0.08, 0, 0.08]);
    part('laser-charge-window', new RoundedBoxGeometry(0.12, 0.2, 0.3, 2, 0.02), kit.glass, [-0.37, -0.11, -0.34], [0.08, 0, 0.08]);
    for (const side of [-1, 1]) {
      for (let index = 0; index < 5; index += 1) {
        part(`laser-radiator-${side}-${index}`, new RoundedBoxGeometry(0.04, 0.17, 0.08, 2, 0.01), index === 4 ? kit.accent : kit.metal, [side * 0.29, -0.03, -0.63 - index * 0.16], [0, side * 0.08, 0]);
      }
    }
    addCable(builder, 'laser-fiber-bus', [[0.18, 0.02, -0.22], [0.28, 0.16, -0.73], [0.2, 0.18, -1.38]], 0.016, true);
  } else if (id === 'sniper') {
    part('sniper-cheek-rest', new RoundedBoxGeometry(0.42, 0.12, 0.52, 3, 0.035), kit.secondary, [-0.02, 0.23, -0.08], [0.02, 0, 0]);
    for (const x of [-0.11, 0.11]) {
      part(`sniper-scope-bracket-${x}`, new RoundedBoxGeometry(0.06, 0.25, 0.12, 2, 0.018), kit.metal, [x, 0.27, -0.42]);
    }
    part('sniper-elevation-dial', new THREE.CylinderGeometry(0.09, 0.09, 0.09, 16), kit.accent, [0, 0.53, -0.58]);
    part('sniper-windage-dial', new THREE.CylinderGeometry(0.07, 0.07, 0.14, 14), kit.metal, [0.18, 0.41, -0.56], [0, 0, Math.PI * 0.5]);
    for (let index = 0; index < 6; index += 1) {
      part(`sniper-heat-fin-${index}`, new RoundedBoxGeometry(0.22, 0.09, 0.025, 2, 0.006), index === 5 ? kit.accent : kit.secondary, [0, 0.14, -1.04 - index * 0.16]);
    }
  } else {
    for (const side of [-1, 1]) {
      addCable(builder, `rail-flux-bus-${side}`, [[side * 0.22, -0.08, -0.18], [side * 0.42, 0.04, -0.76], [side * 0.39, 0.22, -1.74]], 0.028, true);
      for (let index = 0; index < 6; index += 1) {
        part(`rail-cap-bank-${side}-${index}`, new THREE.CylinderGeometry(0.045, 0.045, 0.18, 10), index % 3 === 2 ? kit.hot : kit.metal, [side * 0.3, -0.08, -0.18 - index * 0.14], [Math.PI * 0.5, 0, 0]);
      }
    }
    part('rail-rear-field-cage', new THREE.TorusKnotGeometry(0.16, 0.025, 48, 8, 2, 3), kit.accent, [0, 0.12, -0.12], [Math.PI * 0.5, 0, 0]);
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
    addRearMechanicalPanel(builder, id, 0.29, 0.55, 0.39, 0.02);
    part('machine-rear-power-cell', new RoundedBoxGeometry(0.15, 0.18, 0.038, 3, 0.01), kit.glass, [0, 0.02, 0.355]);
    for (let index = -1; index <= 1; index += 1) {
      part(`machine-rear-vent-${index}`, new RoundedBoxGeometry(0.1, 0.018, 0.028, 2, 0.006), index === 1 ? kit.hot : kit.metal, [0.12, 0.02 + index * 0.06, 0.38]);
    }
  } else if (id === 'shotgun') {
    addRearMechanicalPanel(builder, id, 0.27, 0.65, 0.38, 0.01);
    part('shotgun-rear-breach-door', new RoundedBoxGeometry(0.31, 0.19, 0.038, 3, 0.014), kit.ceramic, [0, 0.015, 0.34]);
    for (const x of [-0.16, 0.16]) {
      part(`shotgun-rear-hinge-${x}`, new THREE.CylinderGeometry(0.032, 0.032, 0.045, 10), kit.metal, [x, 0.015, 0.38], [Math.PI * 0.5, 0, 0]);
    }
    for (let index = -1; index <= 1; index += 1) {
      part(`shotgun-rear-shell-primer-${index}`, new THREE.CircleGeometry(0.025, 12), index === 0 ? kit.hot : kit.accent, [0.08 + index * 0.08, 0.015, 0.365]);
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
    addRearMechanicalPanel(builder, id, 0.38, 0.47, 0.34, 0.03);
    part('sniper-rear-butt-pad', new RoundedBoxGeometry(0.27, 0.2, 0.045, 4, 0.018), kit.rubber, [0, 0.03, 0.43]);
    part('sniper-rear-butt-lock', new THREE.TorusGeometry(0.052, 0.014, 7, 18), kit.accent, [0, 0.03, 0.465]);
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
  profile('mg-bullpup-shell', [[0.22, -0.12], [0.08, 0.19], [-0.26, 0.28], [-0.58, 0.18], [-0.64, -0.1], [-0.12, -0.2]], 0.52, kit.shell);
  profile('mg-cheek-plate', [[0.13, 0.03], [-0.02, 0.18], [-0.28, 0.2], [-0.49, 0.1], [-0.4, -0.03], [-0.02, -0.07]], 0.55, kit.secondary, 0.01);
  part('mg-magazine', new RoundedBoxGeometry(0.23, 0.43, 0.25, 3, 0.045), kit.secondary, [-0.2, -0.25, -0.35], [0.14, 0, 0.12]);
  part('mg-ammo-window', new RoundedBoxGeometry(0.07, 0.29, 0.15, 2, 0.018), kit.glass, [-0.32, -0.22, -0.35], [0.14, 0, 0.12]);
  part('mg-upper-rail', new RoundedBoxGeometry(0.19, 0.06, 0.74, 2, 0.018), kit.metal, [0, 0.3, -0.45]);
  for (let index = 0; index < 7; index += 1) {
    part(`mg-rail-tooth-${index}`, new RoundedBoxGeometry(0.2, 0.025, 0.035, 1, 0.006), kit.rubber, [0, 0.335, -0.18 - index * 0.09]);
  }
  const rotor = new THREE.Group();
  rotor.name = 'mg-barrel-cluster';
  rotor.position.set(0, 0.05, -0.86);
  for (let index = 0; index < 4; index += 1) {
    const angle = index * Math.PI * 0.5;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.82, 10), kit.metal);
    barrel.position.set(Math.cos(angle) * 0.075, Math.sin(angle) * 0.075, -0.38);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.frustumCulled = false;
    rotor.add(barrel);
  }
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.035, 8, 24), kit.accent);
  collar.rotation.x = Math.PI * 0.5;
  collar.position.z = -0.76;
  rotor.add(collar);
  builder.root.add(rotor);
  animatedRotors.push(rotor);
  addFasteners(builder, -0.04, 0.02, 0.58, 5);
  addSignalTicks(builder, -0.12, 0.22, 5);
  return -1.68;
}

function addShotgun(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  profile('shotgun-receiver', [[0.16, -0.18], [0.04, 0.13], [-0.36, 0.19], [-0.58, 0.08], [-0.5, -0.2], [-0.03, -0.24]], 0.7, kit.shell);
  profile('shotgun-receiver-inlay', [[0.08, -0.01], [-0.04, 0.12], [-0.31, 0.14], [-0.46, 0.05], [-0.37, -0.08], [-0.02, -0.1]], 0.73, kit.ceramic);
  for (const x of [-0.13, 0.13]) {
    part('shotgun-barrel', new THREE.CylinderGeometry(0.07, 0.085, 1.15, 16), kit.metal, [x, 0.08, -1.05], [Math.PI * 0.5, 0, 0]);
    part('shotgun-muzzle-brake', new THREE.CylinderGeometry(0.11, 0.11, 0.16, 16), kit.secondary, [x, 0.08, -1.63], [Math.PI * 0.5, 0, 0]);
    part('shotgun-bore', new THREE.CylinderGeometry(0.055, 0.055, 0.012, 16), kit.rubber, [x, 0.08, -1.718], [Math.PI * 0.5, 0, 0]);
  }
  const pump = new THREE.Group();
  pump.name = 'shotgun-pump';
  pump.position.set(0, -0.07, -0.96);
  const pumpBody = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.22, 0.5, 4, 0.055), kit.rubber);
  pump.add(pumpBody);
  for (let index = -2; index <= 2; index += 1) {
    const rib = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.235, 0.026, 2, 0.007), index === 0 ? kit.accent : kit.secondary);
    rib.position.z = index * 0.078;
    pump.add(rib);
  }
  builder.root.add(pump);
  animatedSlides.push(pump);
  for (let index = 0; index < 4; index += 1) {
    part(`shell-${index}`, new THREE.CylinderGeometry(0.035, 0.035, 0.14, 12), index === 3 ? kit.hot : kit.accent, [0.36, -0.02, -0.12 - index * 0.14], [Math.PI * 0.5, 0, 0]);
  }
  addFasteners(builder, -0.05, 0.02, 0.64, 4);
  return -1.74;
}

function addRocketLauncher(builder: Builder): number {
  const { part, kit, animatedRotors } = builder;
  // A clean, concentric launcher silhouette keeps the muzzle and rear engine
  // readable. The old diagonal tube and oversized top frame collapsed into a
  // bright triangular slab from the camera's first-person angle.
  part('rocket-launch-tube', new THREE.CylinderGeometry(0.285, 0.32, 1.48, 20, 1, false), kit.shell, [0, 0.18, -0.68], [Math.PI * 0.5, 0, 0]);
  part('rocket-front-mantlet', new THREE.CylinderGeometry(0.34, 0.31, 0.16, 20), kit.secondary, [0, 0.18, -1.46], [Math.PI * 0.5, 0, 0]);
  part('rocket-inner-bore', new THREE.CylinderGeometry(0.205, 0.205, 0.065, 20), kit.rubber, [0, 0.18, -1.56], [Math.PI * 0.5, 0, 0]);
  part('rocket-hot-ring', new THREE.TorusGeometry(0.225, 0.018, 8, 28), kit.hot, [0, 0.18, -1.6], [Math.PI * 0.5, 0, 0]);
  part('rocket-muzzle-shroud', new THREE.TorusGeometry(0.29, 0.032, 8, 28), kit.metal, [0, 0.18, -1.49], [Math.PI * 0.5, 0, 0]);

  part('rocket-rear-venturi', new THREE.CylinderGeometry(0.3, 0.245, 0.24, 20, 1, false), kit.secondary, [0, 0.18, 0.09], [Math.PI * 0.5, 0, 0]);
  part('rocket-rear-throat', new THREE.TorusGeometry(0.252, 0.026, 8, 28), kit.metal, [0, 0.18, 0.235], [Math.PI * 0.5, 0, 0]);
  part('rocket-rear-cap', new THREE.CircleGeometry(0.17, 20), kit.shell, [0, 0.18, 0.248]);
  part('rocket-rear-core', new THREE.CircleGeometry(0.074, 16), kit.rubber, [0, 0.18, 0.266]);
  for (let index = 0; index < 6; index += 1) {
    const angle = index * Math.PI * 2 / 6;
    part(`rocket-rear-port-${index}`, new THREE.CircleGeometry(0.024, 10), index % 2 ? kit.hot : kit.rubber, [Math.cos(angle) * 0.108, 0.18 + Math.sin(angle) * 0.108, 0.27]);
  }

  for (let index = 0; index < 5; index += 1) {
    const z = -0.04 - index * 0.33;
    const collar = part(
      `rocket-segment-collar-${index}`,
      new THREE.TorusGeometry(0.31, index === 4 ? 0.04 : 0.024, 8, 28),
      index === 4 ? kit.accent : index % 2 ? kit.metal : kit.secondary,
      [0, 0.2, z],
      [Math.PI * 0.5, 0, 0],
    );
    if (index === 4) animatedRotors.push(collar);
    for (const side of [-1, 1]) {
      part(`rocket-collar-bolt-${index}-${side}`, new THREE.CylinderGeometry(0.018, 0.018, 0.026, 8), kit.hot, [side * 0.295, 0.2, z], [0, 0, Math.PI * 0.5]);
    }
  }

  for (const side of [-1, 1]) {
    part(`rocket-skeletal-rail-${side}`, new RoundedBoxGeometry(0.055, 0.08, 1.12, 3, 0.014), side < 0 ? kit.metal : kit.secondary, [side * 0.34, 0.2, -0.7]);
    for (let index = 0; index < 4; index += 1) {
      part(`rocket-rail-clamp-${side}-${index}`, new RoundedBoxGeometry(0.09, 0.12, 0.045, 2, 0.01), index === 3 ? kit.accent : kit.metal, [side * 0.34, 0.2, -0.18 - index * 0.32], [0, 0, side * 0.1]);
    }
    part(`rocket-shoulder-strut-${side}`, new RoundedBoxGeometry(0.055, 0.36, 0.07, 2, 0.014), kit.secondary, [side * 0.27, -0.02, -0.03], [0.22, 0, side * 0.1]);
  }

  part('rocket-top-spine', new RoundedBoxGeometry(0.14, 0.065, 0.86, 3, 0.018), kit.secondary, [0, 0.51, -0.66]);
  for (let index = 0; index < 6; index += 1) {
    part(`rocket-top-rail-tooth-${index}`, new RoundedBoxGeometry(0.16, 0.025, 0.052, 1, 0.006), index === 5 ? kit.hot : kit.metal, [0, 0.55, -0.3 - index * 0.12]);
  }
  part('rocket-guidance-cell', new THREE.CylinderGeometry(0.072, 0.072, 0.62, 12), kit.glass, [-0.36, 0.36, -0.76], [Math.PI * 0.5, 0, 0]);
  part('rocket-guidance-core', new THREE.CylinderGeometry(0.028, 0.028, 0.55, 10), kit.hot, [-0.36, 0.36, -0.76], [Math.PI * 0.5, 0, 0]);
  addSignalTicks(builder, -0.42, 0.52, 7, 0.09);
  return -1.63;
}

function addPlasmaGun(builder: Builder): number {
  const { profile, part, kit, animatedRotors } = builder;
  profile('plasma-lower-shell', [[0.16, -0.19], [0.02, 0.13], [-0.34, 0.19], [-0.65, 0.05], [-0.5, -0.23], [-0.05, -0.25]], 0.56, kit.shell);
  for (const side of [-1, 1]) {
    profile(`plasma-prong-${side}`, [[-0.38, 0.18], [-0.76, 0.48], [-1.28, 0.34], [-1.48, 0.1], [-0.76, 0.02]], 0.11, side < 0 ? kit.ceramic : kit.secondary, side * 0.3);
    part(`plasma-conduit-${side}`, new THREE.CylinderGeometry(0.026, 0.026, 0.86, 10), kit.accent, [side * 0.32, 0.18, -0.83], [Math.PI * 0.5, side * 0.08, 0]);
  }
  const chamber = new THREE.Group();
  chamber.name = 'plasma-reactor';
  chamber.position.set(0, 0.2, -0.6);
  const glass = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.44, 8, 18), kit.glass);
  glass.rotation.x = Math.PI * 0.5;
  chamber.add(glass);
  const core = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.36, 6, 12), kit.hot);
  core.rotation.x = Math.PI * 0.5;
  chamber.add(core);
  for (let index = -2; index <= 2; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.022, 7, 24), index === 0 ? kit.accent : kit.metal);
    ring.rotation.x = Math.PI * 0.5;
    ring.position.z = index * 0.1;
    chamber.add(ring);
  }
  builder.root.add(chamber);
  animatedRotors.push(chamber);
  const emitter = part('plasma-emitter', new THREE.TorusKnotGeometry(0.15, 0.028, 56, 8, 2, 3), kit.accent, [0, 0.15, -1.47], [Math.PI * 0.5, 0, 0]);
  animatedRotors.push(emitter);
  addFasteners(builder, -0.02, -0.02, 0.62, 4);
  return -1.55;
}

function addLaser(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  profile('laser-carbine-shell', [[0.17, -0.12], [0.03, 0.13], [-0.33, 0.17], [-0.58, 0.06], [-0.46, -0.15], [-0.05, -0.19]], 0.44, kit.shell);
  profile('laser-white-shell', [[0.06, 0.01], [-0.05, 0.12], [-0.3, 0.13], [-0.46, 0.04], [-0.36, -0.03], [-0.03, -0.07]], 0.47, kit.ceramic);
  for (const side of [-1, 1]) {
    profile(`laser-emitter-prong-${side}`, [[-0.48, 0.12], [-0.86, 0.31], [-1.48, 0.24], [-1.63, 0.08], [-0.84, -0.02]], 0.075, side < 0 ? kit.secondary : kit.metal, side * 0.245);
    part(`laser-line-${side}`, new RoundedBoxGeometry(0.032, 0.035, 0.82, 2, 0.009), kit.accent, [side * 0.275, 0.18, -1.05], [0, side * 0.035, 0]);
  }
  const focusing = new THREE.Group();
  focusing.name = 'laser-focusing-assembly';
  focusing.position.set(0, 0.12, -0.93);
  for (let index = 0; index < 3; index += 1) {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.1 + index * 0.025, 0.018, 8, 28), index === 1 ? kit.hot : kit.accent);
    lens.rotation.x = Math.PI * 0.5;
    lens.position.z = -index * 0.16;
    focusing.add(lens);
  }
  builder.root.add(focusing);
  animatedSlides.push(focusing);
  part('laser-emitter-core', new THREE.CylinderGeometry(0.045, 0.075, 0.45, 14), kit.hot, [0, 0.12, -1.36], [Math.PI * 0.5, 0, 0]);
  addSignalTicks(builder, -0.12, 0.19, 7, 0.065);
  return -1.67;
}

function addSniper(builder: Builder): number {
  const { profile, part, kit, animatedSlides } = builder;
  profile('sniper-stock', [[0.31, -0.2], [0.2, 0.12], [-0.12, 0.17], [-0.42, 0.03], [-0.35, -0.2], [-0.02, -0.26]], 0.42, kit.shell);
  profile('sniper-receiver', [[-0.18, 0.02], [-0.34, 0.16], [-0.68, 0.15], [-0.82, 0.02], [-0.64, -0.07], [-0.3, -0.08]], 0.46, kit.ceramic);
  part('sniper-barrel', new THREE.CylinderGeometry(0.045, 0.075, 1.35, 16), kit.metal, [0, 0.1, -1.4], [Math.PI * 0.5, 0, 0]);
  for (let index = 0; index < 4; index += 1) {
    part(`sniper-barrel-shroud-${index}`, new THREE.TorusGeometry(0.085, 0.018, 8, 20), index === 3 ? kit.accent : kit.secondary, [0, 0.1, -0.95 - index * 0.25], [Math.PI * 0.5, 0, 0]);
  }
  part('sniper-brake', new THREE.CylinderGeometry(0.115, 0.09, 0.28, 12), kit.secondary, [0, 0.1, -2.06], [Math.PI * 0.5, 0, 0]);
  for (const side of [-1, 1]) {
    part(`sniper-brake-port-${side}`, new RoundedBoxGeometry(0.11, 0.045, 0.11, 2, 0.01), kit.rubber, [side * 0.075, 0.1, -2.08]);
  }
  const scope = new THREE.Group();
  scope.name = 'sniper-scope';
  scope.position.set(0, 0.4, -0.6);
  const scopeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.75, 18), kit.rubber);
  scopeBody.rotation.x = Math.PI * 0.5;
  scope.add(scopeBody);
  for (const z of [-0.36, 0.32]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(z < 0 ? 0.13 : 0.115, 0.026, 8, 24), z < 0 ? kit.accent : kit.metal);
    rim.rotation.x = Math.PI * 0.5;
    rim.position.z = z;
    scope.add(rim);
  }
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.105, 24), kit.glass);
  lens.position.z = -0.37;
  scope.add(lens);
  builder.root.add(scope);
  part('sniper-magazine', new RoundedBoxGeometry(0.21, 0.42, 0.25, 3, 0.04), kit.secondary, [-0.18, -0.24, -0.55], [0.12, 0, 0.1]);
  const bolt = part('sniper-bolt', new THREE.CylinderGeometry(0.035, 0.035, 0.34, 10), kit.metal, [0.31, 0.14, -0.55], [0, 0, Math.PI * 0.5]);
  animatedSlides.push(bolt);
  addFasteners(builder, -0.15, 0.02, 0.52, 6);
  return -2.22;
}

function addRailgun(builder: Builder): number {
  const { profile, part, kit, animatedRotors } = builder;
  profile('railgun-spine', [[0.21, -0.2], [0.04, 0.14], [-0.52, 0.22], [-0.78, 0.07], [-0.64, -0.2], [-0.09, -0.26]], 0.7, kit.shell);
  profile('railgun-power-cell', [[0.07, -0.03], [-0.1, 0.14], [-0.48, 0.16], [-0.62, 0.05], [-0.46, -0.08], [-0.07, -0.1]], 0.73, kit.glass);
  for (const side of [-1, 1]) {
    profile(`railgun-rail-${side}`, [[-0.32, 0.16], [-0.62, 0.45], [-1.74, 0.34], [-2.08, 0.12], [-1.72, -0.02], [-0.58, 0.02]], 0.11, side < 0 ? kit.ceramic : kit.secondary, side * 0.34);
    part(`railgun-live-rail-${side}`, new RoundedBoxGeometry(0.052, 0.065, 1.45, 2, 0.016), kit.hot, [side * 0.36, 0.2, -1.23], [0, side * 0.018, 0]);
    for (let index = 0; index < 7; index += 1) {
      part(`railgun-clamp-${side}-${index}`, new RoundedBoxGeometry(0.14, 0.18, 0.07, 2, 0.015), index % 2 ? kit.metal : kit.accent, [side * 0.34, 0.25, -0.55 - index * 0.22]);
    }
  }
  const core = new THREE.Group();
  core.name = 'railgun-flux-core';
  core.position.set(0, 0.18, -0.65);
  const coreMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.46, 8, 16), kit.hot);
  coreMesh.rotation.x = Math.PI * 0.5;
  core.add(coreMesh);
  for (let index = 0; index < 5; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 8, 24), index === 2 ? kit.hot : kit.metal);
    ring.rotation.x = Math.PI * 0.5;
    ring.position.z = (index - 2) * 0.12;
    core.add(ring);
  }
  builder.root.add(core);
  animatedRotors.push(core);
  part('railgun-muzzle-bridge', new THREE.TorusGeometry(0.31, 0.045, 8, 28, Math.PI), kit.accent, [0, 0.2, -2.08], [Math.PI * 0.5, 0, Math.PI * 0.5]);
  addSignalTicks(builder, -0.12, 0.28, 8, 0.073);
  return -2.12;
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
  }
}

export function createWeaponViewModel(definition: WeaponDefinition): WeaponViewModel {
  const builder = createBuilder(definition);
  const muzzleZ = addWeaponGeometry(builder, definition.id);
  addWeaponMicroDetail(builder, definition.id);
  if (definition.id !== 'rocket') addWeaponRearDetails(builder, definition.id);
  addCommonGrip(builder);

  const muzzleSocket = new THREE.Object3D();
  muzzleSocket.name = `${definition.id}-muzzle-socket`;
  muzzleSocket.position.set(0, definition.id === 'rocket' ? 0.18 : definition.id === 'sniper' ? 0.1 : definition.id === 'rail' ? 0.2 : 0.08, muzzleZ);
  builder.root.add(muzzleSocket);

  const presentation = WEAPON_PRESENTATION[definition.id];
  builder.root.scale.setScalar(presentation.scale);
  builder.root.rotation.set(...presentation.rotation);
  builder.root.position.set(...presentation.position);

  const viewRoot = new THREE.Group();
  viewRoot.name = `${definition.id}-first-person-view`;
  viewRoot.add(builder.root);

  return {
    root: viewRoot,
    muzzleSocket,
    animatedRotors: builder.animatedRotors,
    animatedSlides: builder.animatedSlides,
    pulseMaterials: [builder.kit.accent, builder.kit.hot],
    battleWearMaterialCount: Object.values(builder.kit).filter(
      (material) => material.userData.surfaceTreatment === 'battle-worn',
    ).length,
    battleWearTextureCount: new Set(
      Object.values(builder.kit).flatMap((material) => [
        'map' in material ? material.map : null,
        'roughnessMap' in material ? material.roughnessMap : null,
      ]).filter((texture): texture is THREE.Texture => Boolean(texture)),
    ).size,
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
  for (let index = 0; index < visual.animatedRotors.length; index += 1) {
    const rotor = visual.animatedRotors[index];
    rotor.rotation.z = elapsed * (0.7 + index * 0.28) * motion + recoil * (visual.weapon === 'machine' ? 10 : 2.2);
  }
  for (let index = 0; index < visual.animatedSlides.length; index += 1) {
    const slide = visual.animatedSlides[index];
    slide.position.z += ((slide.userData.baseZ ??= slide.position.z) + recoil * (0.1 + index * 0.025) - slide.position.z) * 0.38;
  }
  const charge = visual.weapon === 'laser' ? heat : recoil;
  visual.pulseMaterials[0].emissiveIntensity = ACCENT_INTENSITY + charge * 1.4;
  visual.pulseMaterials[1].emissiveIntensity = 1.45 + charge * 2.2;
}
