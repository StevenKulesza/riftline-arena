import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../../utils/random';
import { MONSOON_DIVIDE, MONSOON_WORLD_SCALE, sampleMonsoonMasks, sampleMonsoonMeshHeight, sampleMonsoonMeshNormal } from './MonsoonDivide';

export const ROCK_ARCHETYPES = [
  'WeatheredBlock', 'BeddedSlab', 'SplitFin', 'RiverCorestone', 'TalusWedge', 'BrokenOutcrop',
] as const;
export const ROCK_TIERS = ['anchor', 'companion', 'cobble', 'rubble'] as const;
export type RockTier = typeof ROCK_TIERS[number];
const TIER_DETAIL = [4, 2, 1, 0] as const;
const CLUSTER_COUNT = 56;
const CLUSTER_TIER_COUNTS = [1, 4, 7, 13] as const;
const UP = new THREE.Vector3(0, 1, 0);

export const MONSOON_TALUS_ZONES: ReadonlyArray<readonly [number, number, number, number]> = [
  [-184, 82, 34, 20], [-151, -62, 39, 24], [-56, 151, 43, 18],
  [132, 101, 38, 24], [169, -74, 44, 21], [24, -151, 48, 18],
  [-193, -116, 31, 17], [196, 38, 30, 23], [-18, 24, 51, 19],
  [-112, 112, 36, 18], [-108, -138, 42, 20], [72, 136, 42, 19],
  [148, 48, 33, 24], [142, -119, 38, 18], [-42, -157, 49, 17],
  [-207, 18, 27, 31], [207, -22, 25, 30], [34, 96, 38, 18],
];

export type MonsoonRock = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  bounds: THREE.Box3;
  geometryIndex: number;
  archetype: number;
  tier: RockTier;
  cluster: number;
  nominalDiameter: number;
  footprintRadius: number;
  color: number;
};

export type MonsoonRockFieldBuild = {
  group: THREE.Group;
  rocks: MonsoonRock[];
  geometries: THREE.BufferGeometry[];
  material: THREE.MeshStandardMaterial;
  textures: THREE.DataTexture[];
  colliderBoxes: Array<{ name: string; box: THREE.Box3 }>;
  diagnostics: {
    archetypes: readonly string[];
    variantsPerArchetype: number;
    clusterCount: number;
    tierCounts: Record<RockTier, number>;
    requestedCount: number;
    placedCount: number;
    triangles: number;
    drawCalls: number;
    shadowDrawCalls: number;
    geometryCount: number;
    materialCount: number;
    textureCount: number;
    diameterRange: number[];
    routeMaskLimit: number;
    baseClearance: number;
  };
};

/** Plane-cut masses, not randomly stretched copies of an icosphere. */
export function createMonsoonRockGeometry(archetype: number, variant: number, tier: number): THREE.BufferGeometry {
  const random = createSeededRandom(0x0b01de7 ^ archetype * 7919 ^ variant * 104729);
  const source = new THREE.IcosahedronGeometry(1, TIER_DETAIL[tier]);
  const position = source.getAttribute('position');
  const phase = random() * Math.PI * 2;
  const axes = [
    [1.02, 0.82, 0.88], [1.28, 0.38, 0.91], [0.48, 1.5, 0.65],
    [1.06, 0.86, 0.94], [1.12, 0.66, 0.87], [1.14, 0.97, 0.82],
  ][archetype];
  const ax = axes[0] * (0.94 + random() * 0.12);
  const ay = axes[1] * (0.91 + random() * 0.18);
  const az = axes[2] * (0.92 + random() * 0.16);
  const cuts = [
    new THREE.Vector4(0.72, 0.63, 0.29, 1.0 + random() * 0.14),
    new THREE.Vector4(-0.61, 0.74, -0.27, 0.9 + random() * 0.15),
    new THREE.Vector4(0.39, -0.22, -0.88, 0.97 + random() * 0.1),
    new THREE.Vector4(-0.69, -0.32, 0.65, 0.96 + random() * 0.12),
  ];
  if (archetype === 4) cuts.push(new THREE.Vector4(0.62, 0.78, 0.12, 0.72));
  if (archetype === 2) cuts.push(new THREE.Vector4(-0.35, 0.86, 0.37, 0.92));
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index).normalize();
    const { x, y, z } = point;
    const rounded = 1 / Math.sqrt((x / ax) ** 2 + (y / ay) ** 2 + (z / az) ** 2);
    const power = [3.4, 4.2, 2.6, 2, 3.1, 3.2][archetype];
    let radius = 1 / Math.pow((Math.abs(x) / ax) ** power + (Math.abs(y) / ay) ** power + (Math.abs(z) / az) ** power, 1 / power);
    for (const cut of cuts) {
      const facing = x * cut.x + y * cut.y + z * cut.z;
      if (facing > 0) radius = Math.min(radius, cut.w / facing);
    }
    // A narrow rounded transition softens chipped planes without erasing them.
    radius = THREE.MathUtils.lerp(radius, rounded, archetype === 3 ? 0.16 : 0.1);
    radius *= 1 + Math.sin(x * 4.8 + z * 3.1 + phase) * 0.086
      + Math.sin(y * 7.3 - z * 5.2 + phase * 0.7) * 0.043;
    point.multiplyScalar(radius);
    point.x += point.y * (archetype === 2 ? 0.16 : 0.045) * (variant === 0 ? 1 : -1);
    if (archetype === 5 || archetype === 2) {
      const split = Math.exp(-(((point.x - 0.07) / 0.19) ** 2))
        * THREE.MathUtils.smoothstep(point.y, -0.1, 0.8);
      point.z -= split * (archetype === 5 ? 0.24 : 0.12);
      point.y -= split * 0.09;
    }
    position.setXYZ(index, point.x, point.y, point.z);
  }
  source.computeBoundingBox();
  const size = source.boundingBox!.getSize(new THREE.Vector3());
  const center = source.boundingBox!.getCenter(new THREE.Vector3());
  source.translate(-center.x, -center.y, -center.z);
  source.scale(2 / Math.max(size.x, size.y, size.z), 2 / Math.max(size.x, size.y, size.z), 2 / Math.max(size.x, size.y, size.z));
  const geometry = toCreasedNormals(source, Math.PI * 0.16);
  if (geometry !== source) source.dispose();
  geometry.name = `Monsoon${ROCK_ARCHETYPES[archetype]}Variant${variant + 1}${ROCK_TIERS[tier]}`;
  const normals = geometry.getAttribute('normal');
  const points = geometry.getAttribute('position');
  const colors = new Float32Array(points.count * 3);
  const stone = new THREE.Color(archetype === 3 ? 0x777e72 : archetype === 1 ? 0x68736b : 0x626f6c);
  const fresh = new THREE.Color(0x959b91);
  const damp = new THREE.Color(0x515c4b);
  const color = new THREE.Color();
  for (let index = 0; index < points.count; index += 1) {
    point.fromBufferAttribute(points, index);
    const bedding = Math.sin(point.y * 12 + point.x * 1.8 + phase) * 0.045;
    const weathering = 0.5 + Math.sin(point.x * 3.4 + point.z * 4.3 + phase) * 0.5;
    color.copy(stone).multiplyScalar(0.91 + weathering * 0.12 + bedding);
    color.lerp(fresh, Math.max(0, point.y + 0.15) * 0.15);
    color.lerp(damp, Math.max(0, normals.getY(index)) * (1 - THREE.MathUtils.smoothstep(point.y, -0.5, 0.55)) * 0.36);
    color.toArray(colors, index * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createMonsoonRockMaterial(): { material: THREE.MeshStandardMaterial; textures: THREE.DataTexture[] } {
  const size = 128;
  const random = createSeededRandom(0x570ae);
  const heights = new Float32Array(size * size);
  for (let index = 0; index < heights.length; index += 1) heights[index] = random();
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const heightAt = (x: number, y: number): number => heights[((y + size) % size) * size + (x + size) % size];
  const noise = (x: number, y: number, cellSize: number): number => {
    const ix = Math.floor(x / cellSize); const iy = Math.floor(y / cellSize);
    const fx = (x / cellSize) % 1; const fy = (y / cellSize) % 1;
    const u = fx * fx * (3 - 2 * fx); const v = fy * fy * (3 - 2 * fy);
    const period = size / cellSize;
    const at = (dx: number, dy: number): number => heightAt(((ix + dx) % period) * 7, ((iy + dy) % period) * 7);
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(at(0, 0), at(1, 0), u), THREE.MathUtils.lerp(at(0, 1), at(1, 1), u), v);
  };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const grain = heightAt(x, y);
    const mineral = noise(x, y, 32) * 0.5 + noise(x, y, 16) * 0.3 + noise(x, y, 8) * 0.2;
    const vein = Math.exp(-Math.abs(noise(x, y, 16) - 0.48) * 70);
    const value = Math.round(174 + mineral * 55 + grain * 19 + vein * 11 - (grain < 0.035 ? 24 : 0));
    albedo.set([value, value + 1, value - 3, 255], offset);
    normal.set([128 + (heightAt(x - 1, y) - heightAt(x + 1, y)) * 38, 128 + (heightAt(x, y - 1) - heightAt(x, y + 1)) * 38, 248, 255], offset);
    const rough = Math.round(228 + grain * 25);
    roughness.set([rough, rough, rough, 255], offset);
  }
  const textures = [albedo, normal, roughness].map((data, index) => {
    const texture = new THREE.DataTexture(data, size, size);
    texture.name = ['MonsoonRockMineralGrain', 'MonsoonRockPittedNormal', 'MonsoonRockRoughness'][index];
    texture.colorSpace = index === 0 ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(6, 6);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  });
  return {
    material: new THREE.MeshStandardMaterial({
      name: 'MonsoonBiomeRockMaterial', color: 0xffffff, vertexColors: true,
      roughness: 0.94, metalness: 0.01,
      map: textures[0], normalMap: textures[1], normalScale: new THREE.Vector2(0.3, 0.3), roughnessMap: textures[2],
    }),
    textures,
  };
}

/** Sample the complete footprint, not just a large boulder's center. */
export function isMonsoonRockFootprintClear(
  x: number, z: number, radius: number, seed: number, blocked: (x: number, z: number, radius: number) => boolean,
): boolean {
  // Test solid structures against the whole disk too: a narrow pillar can sit
  // between perimeter samples or entirely inside a large rock's footprint.
  if (blocked(x, z, radius + 2.5)) return false;
  for (let sample = -1; sample < 12; sample += 1) {
    const angle = sample / 12 * Math.PI * 2;
    const sx = x + (sample < 0 ? 0 : Math.cos(angle) * (radius + 2.5));
    const sz = z + (sample < 0 ? 0 : Math.sin(angle) * (radius + 2.5));
    const masks = sampleMonsoonMasks(sx, sz);
    if (sampleMonsoonMeshHeight(sx, sz, seed) <= MONSOON_DIVIDE.waterY + 3.5
      || masks.route >= 0.18 || masks.coast >= 0.91
      || Math.hypot(sx + 85 * MONSOON_WORLD_SCALE, sz - 130 * MONSOON_WORLD_SCALE) <= 285
      || Math.hypot(sx - 95 * MONSOON_WORLD_SCALE, sz + 120 * MONSOON_WORLD_SCALE) <= 285
      || blocked(sx, sz, 0)) return false;
  }
  return true;
}

export function buildMonsoonRockField(seed: number, blocked: (x: number, z: number, radius: number) => boolean = () => false): MonsoonRockFieldBuild {
  const random = createSeededRandom(seed ^ 0x71a55eed);
  const geometries = ROCK_TIERS.flatMap((_, tier) => ROCK_ARCHETYPES.flatMap((_, archetype) =>
    [0, 1].map((variant) => createMonsoonRockGeometry(archetype, variant, tier))));
  const { material, textures } = createMonsoonRockMaterial();
  const group = new THREE.Group();
  group.name = 'MonsoonHierarchicalGeologicalBoulderFields';
  const rocks: MonsoonRock[] = [];
  const matrix = new THREE.Matrix4();
  const normal = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  const yawRotation = new THREE.Quaternion();
  let clusterCount = 0;

  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster += 1) {
    const members: MonsoonRock[] = [];
    let heading = random() * Math.PI * 2;
    const geology = cluster % ROCK_ARCHETYPES.length;
    for (let tier = 0; tier < ROCK_TIERS.length; tier += 1) for (let member = 0; member < CLUSTER_TIER_COUNTS[tier]; member += 1) {
      if (tier > 0 && members.length === 0) break;
      let diameter = tier === 0 ? 12 + random() * 14 : tier === 1 ? 3.2 + random() * 5.2 : tier === 2 ? 0.8 + random() * 1.8 : 0.22 + random() * 0.63;
      const archetype = random() < 0.76 ? geology : (geology + 1 + Math.floor(random() * 3)) % ROCK_ARCHETYPES.length;
      const geometryIndex = tier * 12 + archetype * 2 + Math.floor(random() * 2);
      const geometry = geometries[geometryIndex];
      const scale = new THREE.Vector3(diameter * (0.43 + random() * 0.14), diameter * (0.44 + random() * 0.12), diameter * (0.43 + random() * 0.14));
      let radius = diameter * 0.76;
      const yaw = heading + (random() - 0.5) * (tier < 2 ? 0.95 : 2.8);
      for (let attempt = 0; attempt < (tier === 0 ? 2_000 : 120); attempt += 1) {
        if (tier === 0 && attempt > 0 && attempt % 480 === 0) {
          // A narrow shelf gets a smaller primary, not a forced giant that
          // overhangs a ski lane. Keep the field's hierarchy and clearance.
          const nextDiameter = Math.max(10, diameter * 0.8);
          scale.multiplyScalar(nextDiameter / diameter);
          diameter = nextDiameter;
          radius = diameter * 0.76;
        }
        let x: number;
        let z: number;
        if (tier === 0) {
          // Some authored zones intersect steep ridges or water for a given
          // seed. Search neighbouring zones without relaxing route clearance.
          const zone = MONSOON_TALUS_ZONES[(cluster + Math.floor(attempt / 16)) % MONSOON_TALUS_ZONES.length];
          const angle = random() * Math.PI * 2;
          const radial = Math.sqrt(random());
          x = (zone[0] + Math.cos(angle) * zone[2] * radial) * MONSOON_WORLD_SCALE;
          z = (zone[1] + Math.sin(angle) * zone[3] * radial) * MONSOON_WORLD_SCALE;
          if (rocks.some((rock) => rock.tier === 'anchor' && Math.hypot(rock.position.x - x, rock.position.z - z) < Math.max(34, rock.footprintRadius + radius + 10))) continue;
        } else {
          const anchor = members[0];
          const fan = heading + (random() - 0.5) * (tier === 1 ? 3.9 : 2.6);
          const reach = anchor.footprintRadius * 0.72 + radius + random() * (tier === 1 ? 17 : tier === 2 ? 29 : 43) * (1 + attempt / 100);
          x = anchor.position.x + Math.sin(fan) * reach;
          z = anchor.position.z + Math.cos(fan) * reach;
          if (members.some((rock) => Math.hypot(rock.position.x - x, rock.position.z - z) < (rock.footprintRadius + radius) * 0.61)) continue;
        }
        if (!isMonsoonRockFootprintClear(x, z, radius, seed, blocked)) continue;
        sampleMonsoonMeshNormal(x, z, normal, seed);
        if (normal.y < (tier === 0 ? 0.8 : tier === 1 ? 0.69 : 0.52)) continue;
        tilt.identity().slerp(new THREE.Quaternion().setFromUnitVectors(UP, normal), tier === 0 && archetype === 2 ? 0.3 : 0.85);
        yawRotation.setFromAxisAngle(UP, yaw);
        const quaternion = tilt.clone().multiply(yawRotation);
        matrix.compose(new THREE.Vector3(), quaternion, scale);
        const relativeBounds = geometry.boundingBox!.clone().applyMatrix4(matrix);
        const height = relativeBounds.max.y - relativeBounds.min.y;
        const baseY = sampleMonsoonMeshHeight(x, z, seed);
        const burial = tier === 0 ? 0.24 + random() * 0.12 : 0.18 + random() * 0.1;
        const position = new THREE.Vector3(x, baseY - relativeBounds.min.y - height * burial, z);
        const rock: MonsoonRock = {
          position, quaternion, scale, bounds: relativeBounds.translate(position), geometryIndex, archetype,
          tier: ROCK_TIERS[tier], cluster, nominalDiameter: diameter, footprintRadius: radius,
          color: new THREE.Color().setHSL(0.14 + random() * 0.025, 0.055 + random() * 0.045, 0.82 + random() * 0.13).getHex(),
        };
        rocks.push(rock);
        members.push(rock);
        if (tier === 0) {
          // Surface normals point horizontally downhill. Keep talus fans
          // following drainage rather than arranging rocks into radial rings.
          if (Math.hypot(normal.x, normal.z) > 0.04) heading = Math.atan2(normal.x, normal.z);
          clusterCount += 1;
        }
        break;
      }
    }
  }

  let triangles = 0;
  let shadowDraws = 0;
  const color = new THREE.Color();
  geometries.forEach((geometry, geometryIndex) => {
    const instances = rocks.filter((rock) => rock.geometryIndex === geometryIndex);
    if (instances.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
    mesh.name = `${geometry.name}Instances`;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    instances.forEach((rock, index) => {
      matrix.compose(rock.position, rock.quaternion, rock.scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.setHex(rock.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) { mesh.instanceColor.setUsage(THREE.StaticDrawUsage); mesh.instanceColor.needsUpdate = true; }
    mesh.castShadow = geometryIndex < 24;
    mesh.receiveShadow = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    triangles += (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3 * mesh.count;
    shadowDraws += Number(mesh.castShadow);
  });
  const colliderBoxes = rocks.filter((rock) => rock.tier === 'anchor' || rock.tier === 'companion').map((rock, index) => {
    // Keep the established simple solid-core collision strategy, but derive
    // dimensions from each new rotated form rather than unrelated scale axes.
    const box = rock.bounds.clone();
    const size = box.getSize(new THREE.Vector3());
    box.min.x += size.x * 0.2; box.max.x -= size.x * 0.2;
    box.min.z += size.z * 0.2; box.max.z -= size.z * 0.2;
    box.max.y -= size.y * 0.12;
    return { name: `talus-${rock.tier}-${index}`, box };
  });
  const tierCounts = Object.fromEntries(ROCK_TIERS.map((tier) => [tier, rocks.filter((rock) => rock.tier === tier).length])) as Record<RockTier, number>;
  const diagnostics: MonsoonRockFieldBuild['diagnostics'] = {
    archetypes: ROCK_ARCHETYPES, variantsPerArchetype: 2, clusterCount, tierCounts,
    requestedCount: CLUSTER_COUNT * 25, placedCount: rocks.length, triangles,
    drawCalls: group.children.length, shadowDrawCalls: shadowDraws,
    geometryCount: geometries.length, materialCount: 1, textureCount: textures.length,
    diameterRange: rocks.length ? [Math.min(...rocks.map((rock) => rock.nominalDiameter)), Math.max(...rocks.map((rock) => rock.nominalDiameter))] : [],
    routeMaskLimit: 0.18, baseClearance: 285,
  };
  group.userData.rockField = diagnostics;
  return { group, rocks, geometries, material, textures, colliderBoxes, diagnostics };
}
