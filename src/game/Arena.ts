import * as THREE from 'three';
import { KTXLoader } from 'three/addons/loaders/KTXLoader.js';
import { acceleratedRaycast, MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import { assetUrl } from '../assets/assetUrl';
import { MOVEMENT } from './config';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

type ArenaMaterialName = 'concrete' | 'wall' | 'floor' | 'trim' | 'metal' | 'blue' | 'red' | 'light' | 'glass' | 'screen';

type ArenaManifest = {
  source: string;
  sourceUrl: string;
  license: string;
  collision: {
    source: string;
    brushCount: number;
    vertexCount: number;
    patchVertexCount: number;
    positionOffset: number;
    brushRecordOffset: number;
    brushRecordStride: number;
    brushPlaneOffset: number;
    brushPlaneCount: number;
  };
  groups: Array<{
    name: ArenaMaterialName;
    shader: string;
    vertexCount: number;
    positionOffset: number;
    normalOffset: number;
    uvOffset: number;
    colorOffset: number;
  }>;
};

type ArenaMaterialAsset = {
  source: string | null;
  map: string | null;
  normalMap: string | null;
  roughnessMap: string | null;
};

type ArenaMaterialManifest = {
  source: string;
  sourceUrl: string;
  license: string;
  materials: Record<string, ArenaMaterialAsset>;
};

export type JumpPad = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  launchSpeed: number;
};

export type CapsuleContact = {
  grounded: boolean;
  contactNormal: THREE.Vector3;
  wallContact: boolean;
  wallNormal: THREE.Vector3;
  correction: THREE.Vector3;
  contacts: number;
};

export type SurfaceHit = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
};

const SOURCE_SCALE = 1 / 56;
const SOURCE_ORIGIN = new THREE.Vector3(-528, 80, 64);
const MAP_MANIFEST_URL = assetUrl('assets/maps/wca1-remix.json');
const MAP_BINARY_URL = assetUrl('assets/maps/wca1-remix.bin');
const MAP_MATERIALS_URL = assetUrl('assets/maps/wca1-materials.json');

function sourcePoint(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(
    (x - SOURCE_ORIGIN.x) * SOURCE_SCALE,
    (z - SOURCE_ORIGIN.z) * SOURCE_SCALE,
    -(y - SOURCE_ORIGIN.y) * SOURCE_SCALE,
  );
}

function sourcePad(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
  target: [number, number, number],
  launchSpeed: number,
): JumpPad {
  const center = sourcePoint(
    (boundsMin[0] + boundsMax[0]) * 0.5,
    (boundsMin[1] + boundsMax[1]) * 0.5,
    (boundsMin[2] + boundsMax[2]) * 0.5,
  );
  const targetPoint = sourcePoint(...target);
  return {
    position: center,
    direction: targetPoint.sub(center).normalize(),
    radius: Math.max(1.65, Math.hypot(boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1]) * SOURCE_SCALE * 0.7),
    launchSpeed,
  };
}

// These are the six actual push-trigger routes in Warsow's wca1/Funpark layout.
export const JUMP_PADS: JumpPad[] = [
  sourcePad([-128, 2304, 256], [0, 2464, 312], [-64, 1776, 888], 24),
  sourcePad([1280, 1312, 128], [1472, 1504, 160], [1216, 1408, 800], 25),
  sourcePad([-2048, -704, 0], [-1920, -576, 16], [-2096, -640, 432], 21),
  sourcePad([-812, -395, -96], [-660, -245, -80], [-736, -320, 1040], 27),
  sourcePad([-2112, 1488, 0], [-2000, 1600, 16], [-2048, 1584, 400], 20),
  sourcePad([-16, -1888, 8], [112, -1760, 16], [-68, -1792, 832], 25),
];

const MATERIALS: Record<ArenaMaterialName, {
  color: number;
  emissive: number;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
}> = {
  concrete: { color: 0x4a5868, emissive: 0x07131d, emissiveIntensity: 0.12, roughness: 0.82, metalness: 0.04 },
  wall: { color: 0x647386, emissive: 0x08131d, emissiveIntensity: 0.12, roughness: 0.68, metalness: 0.12 },
  floor: { color: 0x435565, emissive: 0x06131c, emissiveIntensity: 0.16, roughness: 0.48, metalness: 0.3 },
  trim: { color: 0x26394a, emissive: 0x061621, emissiveIntensity: 0.16, roughness: 0.3, metalness: 0.68 },
  metal: { color: 0x5a6978, emissive: 0x07121a, emissiveIntensity: 0.1, roughness: 0.25, metalness: 0.78 },
  blue: { color: 0x2a9ec7, emissive: 0x006d9d, emissiveIntensity: 0.48, roughness: 0.3, metalness: 0.42 },
  red: { color: 0xd93c62, emissive: 0x8c0b35, emissiveIntensity: 0.5, roughness: 0.32, metalness: 0.38 },
  light: { color: 0xbdefff, emissive: 0x43dff5, emissiveIntensity: 1.55, roughness: 0.18, metalness: 0.08 },
  glass: { color: 0x6ad9ed, emissive: 0x0b91ae, emissiveIntensity: 0.46, roughness: 0.12, metalness: 0.08 },
  screen: { color: 0x8ff8ff, emissive: 0x20dfff, emissiveIntensity: 1.35, roughness: 0.2, metalness: 0.18 },
};

export class Arena {
  readonly group = new THREE.Group();
  readonly collisionTriangles: number;
  readonly corePosition = sourcePoint(-736, -320, 464);
  readonly spawnPoints = [
    sourcePoint(-768, -2176, 64),
    sourcePoint(832, 1184, 192),
    sourcePoint(-2448, -240, 288),
    sourcePoint(-2448, -1024, 288),
    sourcePoint(-1072, 1312, 48),
    sourcePoint(-2128, -1392, 800),
    sourcePoint(960, 1184, 768),
    sourcePoint(-1728, 832, 64),
    sourcePoint(-1872, 2112, 320),
    sourcePoint(-240, 2400, 320),
    sourcePoint(176, 272, 64),
    sourcePoint(-768, -2224, 752),
    sourcePoint(-608, 272, 64),
    sourcePoint(-800, -1184, 64),
    sourcePoint(-1120, 240, 800),
  ];
  readonly itemPoints: Record<string, THREE.Vector3> = {
    'health-a': sourcePoint(-784, -944, 64).add(new THREE.Vector3(0, 0.9, 0)),
    'health-b': sourcePoint(800, 1504, 192).add(new THREE.Vector3(0, 0.9, 0)),
    armor: sourcePoint(-1088, 2368, 320).add(new THREE.Vector3(0, 0.9, 0)),
    damage: sourcePoint(-736, -320, 464).add(new THREE.Vector3(0, 0.9, 0)),
    speed: sourcePoint(-784, -2048, 704).add(new THREE.Vector3(0, 0.9, 0)),
    rail: sourcePoint(640, 1184, 768).add(new THREE.Vector3(0, 0.9, 0)),
    rocket: sourcePoint(-2448, -640, 288).add(new THREE.Vector3(0, 0.9, 0)),
    plasma: sourcePoint(-768, -1904, 64).add(new THREE.Vector3(0, 0.9, 0)),
    shotgun: sourcePoint(128, -256, 64).add(new THREE.Vector3(0, 0.9, 0)),
    sniper: sourcePoint(-1600, 800, 800).add(new THREE.Vector3(0, 0.9, 0)),
    laser: sourcePoint(-1536, -640, 800).add(new THREE.Vector3(0, 0.9, 0)),
  };

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly collisionGeometry: THREE.BufferGeometry;
  private readonly boundsTree: MeshBVH;
  private readonly patchCollisionGeometry: THREE.BufferGeometry;
  private readonly patchBoundsTree: MeshBVH;
  private readonly brushRecords: Float32Array;
  private readonly brushPlanes: Float32Array;
  private readonly capsuleSegment = new THREE.Line3();
  private readonly capsuleBounds = new THREE.Box3();
  private readonly trianglePoint = new THREE.Vector3();
  private readonly capsulePoint = new THREE.Vector3();
  private readonly contactNormal = new THREE.Vector3();
  private readonly bestGroundNormal = new THREE.Vector3(0, 1, 0);
  private readonly bestWallNormal = new THREE.Vector3();
  private readonly correction = new THREE.Vector3();
  private readonly downRay = new THREE.Ray();
  private readonly capsuleTranslation = new THREE.Vector3();
  private readonly jumpPadRingPositions = JUMP_PADS.map((pad) => pad.position.clone().add(new THREE.Vector3(0, 1.23, 0)));
  private readonly jumpPadRingMatrices = JUMP_PADS.map(() => new THREE.Matrix4());
  private readonly jumpPadRingQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0));
  private readonly jumpPadRingScale = new THREE.Vector3();
  private readonly atmosphereSignalInstances: Array<{
    mesh: THREE.InstancedMesh;
    index: number;
    position: THREE.Vector3;
    phase: number;
  }> = [];
  private readonly atmosphereInstanceMatrix = new THREE.Matrix4();
  private readonly atmosphereInstanceQuaternion = new THREE.Quaternion();
  private readonly atmosphereInstanceScale = new THREE.Vector3(1, 1, 1);

  static async load(): Promise<Arena> {
    const [manifestResponse, binaryResponse, materialResponse] = await Promise.all([
      fetch(MAP_MANIFEST_URL),
      fetch(MAP_BINARY_URL),
      fetch(MAP_MATERIALS_URL),
    ]);
    if (!manifestResponse.ok || !binaryResponse.ok) {
      throw new Error(`Failed to load CA arena data (${manifestResponse.status}/${binaryResponse.status}).`);
    }
    const manifest = await manifestResponse.json() as ArenaManifest;
    const binary = await binaryResponse.arrayBuffer();
    const authoredMaterials = materialResponse.ok
      ? (await materialResponse.json() as ArenaMaterialManifest)
      : { source: 'procedural fallback', sourceUrl: '', license: '', materials: {} };
    for (const material of Object.values(authoredMaterials.materials)) {
      if (material.map) material.map = assetUrl(material.map);
      if (material.normalMap) material.normalMap = assetUrl(material.normalMap);
      if (material.roughnessMap) material.roughnessMap = assetUrl(material.roughnessMap);
    }
    const textureLoader = new THREE.TextureLoader();
    const ktxLoader = new KTXLoader();
    const mobileQuality = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600;
    const textureUrls = new Set<string>();
    for (const asset of Object.values(authoredMaterials.materials)) {
      if (asset.map) textureUrls.add(asset.map);
      // Keep authored albedo identity on mobile, but avoid loading secondary
      // material maps that multiply texture bindings across the entire WCA1
      // surface set. Desktop retains the full normal/roughness treatment.
      if (!mobileQuality && asset.normalMap) textureUrls.add(asset.normalMap);
      if (!mobileQuality && asset.roughnessMap) textureUrls.add(asset.roughnessMap);
    }
    const loadedTextures = new Map<string, THREE.Texture>();
    await Promise.all([...textureUrls].map(async (url) => {
      try {
        const texture = url.endsWith('.ktx')
          ? await ktxLoader.loadAsync(url)
          : await textureLoader.loadAsync(url);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 8;
        loadedTextures.set(url, texture);
      } catch (error) {
        console.warn(`WCA1 authored texture fallback: ${url}`, error);
      }
    }));
    return new Arena(manifest, binary, authoredMaterials, loadedTextures);
  }

  private constructor(
    manifest: ArenaManifest,
    binary: ArrayBuffer,
    authoredMaterials: ArenaMaterialManifest,
    loadedTextures: Map<string, THREE.Texture>,
  ) {
    this.group.name = 'WCA1RiftlineRemix';
    this.group.userData.source = manifest.source;
    this.group.userData.sourceUrl = manifest.sourceUrl;
    this.group.userData.license = manifest.license;
    this.group.userData.materialSource = authoredMaterials.source;
    this.group.userData.materialSourceUrl = authoredMaterials.sourceUrl;
    this.group.userData.materialLicense = authoredMaterials.license;
    this.textures.push(...new Set(loadedTextures.values()));

    for (const entry of manifest.groups) {
      const positions = new Float32Array(binary, entry.positionOffset, entry.vertexCount * 3);
      const normals = new Float32Array(binary, entry.normalOffset, entry.vertexCount * 3);
      const uvs = new Float32Array(binary, entry.uvOffset, entry.vertexCount * 2);
      const colors = new Uint8Array(binary, entry.colorOffset, entry.vertexCount * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uvs.slice(), 2));
      geometry.setAttribute('color', new THREE.Uint8BufferAttribute(colors.slice(), 3, true));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      this.geometries.push(geometry);

      const material = this.createMaterial(
        entry.name,
        entry.shader,
        authoredMaterials.materials[entry.shader],
        loadedTextures,
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `Arena_${entry.name}_${entry.shader.replace(/[^a-z0-9]+/gi, '_')}`;
      mesh.castShadow = entry.name === 'metal' || entry.name === 'concrete';
      mesh.receiveShadow = entry.name !== 'glass' && entry.name !== 'light';
      mesh.renderOrder = entry.name === 'glass' ? 4 : entry.name === 'light' ? 3 : 0;
      this.group.add(mesh);
    }

    const collisionPositions = new Float32Array(
      binary,
      manifest.collision.positionOffset,
      manifest.collision.vertexCount * 3,
    );
    this.collisionGeometry = new THREE.BufferGeometry();
    this.collisionGeometry.setAttribute('position', new THREE.BufferAttribute(collisionPositions.slice(), 3));
    this.collisionGeometry.computeVertexNormals();
    this.collisionGeometry.computeBoundingBox();
    this.collisionTriangles = manifest.collision.vertexCount / 3;
    this.boundsTree = new MeshBVH(this.collisionGeometry, { maxLeafSize: 16 });
    this.patchCollisionGeometry = new THREE.BufferGeometry();
    this.patchCollisionGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(collisionPositions.slice(0, manifest.collision.patchVertexCount * 3), 3),
    );
    this.patchBoundsTree = new MeshBVH(this.patchCollisionGeometry, { maxLeafSize: 12 });
    this.brushRecords = new Float32Array(
      binary,
      manifest.collision.brushRecordOffset,
      manifest.collision.brushCount * manifest.collision.brushRecordStride,
    ).slice();
    this.brushPlanes = new Float32Array(
      binary,
      manifest.collision.brushPlaneOffset,
      manifest.collision.brushPlaneCount * 4,
    ).slice();
    this.validateSpawnPoints();
    this.createJumpPadVisuals();
    this.createAtmosphereSetDressing();
    this.createArchitecturalLighting();
  }

  update(elapsed: number, reducedMotion: boolean): void {
    if (reducedMotion) return;
    for (const child of this.group.children) {
      if (child.userData.pulse === true) {
        const pulse = 0.94 + Math.sin(elapsed * 4.8 + Number(child.userData.phase ?? 0)) * 0.06;
        child.scale.setScalar(pulse);
      }
    }
    for (const signal of this.atmosphereSignalInstances) {
      this.atmosphereInstanceQuaternion.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        elapsed * 0.55 + signal.phase,
      );
      this.atmosphereInstanceMatrix.compose(
        signal.position,
        this.atmosphereInstanceQuaternion,
        this.atmosphereInstanceScale,
      );
      signal.mesh.setMatrixAt(signal.index, this.atmosphereInstanceMatrix);
      signal.mesh.instanceMatrix.needsUpdate = true;
    }
    const ringMesh = this.group.getObjectByName('JumpPadRings') as THREE.InstancedMesh | undefined;
    if (ringMesh?.isInstancedMesh) {
      for (let index = 0; index < this.jumpPadRingPositions.length; index += 1) {
        this.jumpPadRingScale.setScalar(0.94 + Math.sin(elapsed * 4.8 + index * 0.7) * 0.06);
        this.jumpPadRingMatrices[index].compose(
          this.jumpPadRingPositions[index],
          this.jumpPadRingQuaternion,
          this.jumpPadRingScale,
        );
        ringMesh.setMatrixAt(index, this.jumpPadRingMatrices[index]);
      }
      ringMesh.instanceMatrix.needsUpdate = true;
    }
  }

  private validateSpawnPoints(): void {
    const velocity = new THREE.Vector3();
    for (const spawn of this.spawnPoints) {
      const authoredHeight = spawn.y;
      const floor = this.floorHeightAt(spawn.x, spawn.z, authoredHeight + 0.5);
      if (floor !== null && floor <= authoredHeight + 0.5 && authoredHeight - floor < 5) {
        spawn.y = floor + 1e-4;
      }
      velocity.set(0, 0, 0);
      this.resolvePlayerCapsule(spawn, velocity);
    }
  }

  resolvePlayerCapsule(position: THREE.Vector3, velocity: THREE.Vector3): CapsuleContact {
    return this.resolveCapsule(position, velocity, MOVEMENT.playerRadius, MOVEMENT.playerHeight);
  }

  resolveCapsule(position: THREE.Vector3, velocity: THREE.Vector3, radius: number, height: number): CapsuleContact {
    const halfHeight = height * 0.5;
    const segmentHalfHeight = halfHeight - radius;
    const center = this.capsulePoint.set(position.x, position.y + halfHeight, position.z);
    this.contactNormal.set(0, 0, 0);
    this.bestGroundNormal.set(0, 1, 0);
    this.bestWallNormal.set(0, 0, 0);
    this.correction.set(0, 0, 0);
    let contacts = 0;
    let bestGround = 0;
    let wallContact = false;

    for (let iteration = 0; iteration < 4; iteration += 1) {
      let resolvedAny = false;
      for (let brushOffset = 0; brushOffset < this.brushRecords.length; brushOffset += 8) {
        const minimumX = this.brushRecords[brushOffset + 2];
        const minimumY = this.brushRecords[brushOffset + 3];
        const minimumZ = this.brushRecords[brushOffset + 4];
        const maximumX = this.brushRecords[brushOffset + 5];
        const maximumY = this.brushRecords[brushOffset + 6];
        const maximumZ = this.brushRecords[brushOffset + 7];
        if (center.x + radius < minimumX || center.x - radius > maximumX
          || center.y + halfHeight < minimumY || center.y - halfHeight > maximumY
          || center.z + radius < minimumZ || center.z - radius > maximumZ) continue;

        const firstPlane = Math.round(this.brushRecords[brushOffset]);
        const planeCount = Math.round(this.brushRecords[brushOffset + 1]);
        let inside = true;
        let shallowestDepth = Infinity;
        let shallowestPlane = -1;
        for (let planeIndex = firstPlane; planeIndex < firstPlane + planeCount; planeIndex += 1) {
          const planeOffset = planeIndex * 4;
          const normalX = this.brushPlanes[planeOffset];
          const normalY = this.brushPlanes[planeOffset + 1];
          const normalZ = this.brushPlanes[planeOffset + 2];
          const distance = this.brushPlanes[planeOffset + 3];
          const support = radius + Math.abs(normalY) * segmentHalfHeight;
          const separation = center.x * normalX + center.y * normalY + center.z * normalZ - distance - support;
          if (separation > 1e-4) {
            inside = false;
            break;
          }
          const depth = -separation;
          if (depth < shallowestDepth) {
            shallowestDepth = depth;
            shallowestPlane = planeOffset;
          }
        }
        if (!inside || shallowestPlane < 0 || !Number.isFinite(shallowestDepth)) continue;

        this.contactNormal.set(
          this.brushPlanes[shallowestPlane],
          this.brushPlanes[shallowestPlane + 1],
          this.brushPlanes[shallowestPlane + 2],
        );
        const depth = shallowestDepth + 1e-4;
        center.addScaledVector(this.contactNormal, depth);
        this.correction.addScaledVector(this.contactNormal, depth);
        if (this.contactNormal.y > bestGround) {
          bestGround = this.contactNormal.y;
          this.bestGroundNormal.copy(this.contactNormal);
        }
        if (Math.abs(this.contactNormal.y) < 0.42) {
          wallContact = true;
          this.bestWallNormal.copy(this.contactNormal);
        }
        const intoSurface = velocity.dot(this.contactNormal);
        if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
        contacts += 1;
        resolvedAny = true;
      }
      if (!resolvedAny) break;
    }

    position.set(center.x, center.y - halfHeight, center.z);
    this.capsuleSegment.start.set(position.x, position.y + radius, position.z);
    this.capsuleSegment.end.set(position.x, position.y + height - radius, position.z);
    this.capsuleBounds.makeEmpty();
    this.capsuleBounds.expandByPoint(this.capsuleSegment.start);
    this.capsuleBounds.expandByPoint(this.capsuleSegment.end);
    this.capsuleBounds.expandByScalar(radius);
    this.patchBoundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(this.capsuleBounds),
      intersectsTriangle: (triangle: ExtendedTriangle) => {
        const distance = triangle.closestPointToSegment(
          this.capsuleSegment,
          this.trianglePoint,
          this.capsulePoint,
        );
        if (distance > radius + 1e-4) return false;

        const depth = Math.max(0, radius - distance + 1e-5);
        this.contactNormal.copy(this.capsulePoint).sub(this.trianglePoint);
        if (this.contactNormal.lengthSq() < 1e-8) triangle.getNormal(this.contactNormal);
        else this.contactNormal.normalize();
        this.capsuleSegment.start.addScaledVector(this.contactNormal, depth);
        this.capsuleSegment.end.addScaledVector(this.contactNormal, depth);
        this.capsuleTranslation.copy(this.contactNormal).multiplyScalar(depth);
        this.capsuleBounds.translate(this.capsuleTranslation);
        this.correction.add(this.capsuleTranslation);
        if (this.contactNormal.y > bestGround) {
          bestGround = this.contactNormal.y;
          this.bestGroundNormal.copy(this.contactNormal);
        }
        if (Math.abs(this.contactNormal.y) < 0.42) {
          wallContact = true;
          this.bestWallNormal.copy(this.contactNormal);
        }
        const intoSurface = velocity.dot(this.contactNormal);
        if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
        contacts += 1;
        return false;
      },
    });

    position.copy(this.capsuleSegment.start).addScaledVector(THREE.Object3D.DEFAULT_UP, -radius);
    return {
      grounded: bestGround >= MOVEMENT.maxSlopeCosine && velocity.y <= 1.2,
      contactNormal: (bestGround > 0 ? this.bestGroundNormal : this.contactNormal).clone(),
      wallContact,
      wallNormal: this.bestWallNormal.clone(),
      correction: this.correction.clone(),
      contacts,
    };
  }

  floorHeightAt(x: number, z: number, fromY = 40): number | null {
    this.downRay.origin.set(x, fromY, z);
    this.downRay.direction.set(0, -1, 0);
    const hit = this.boundsTree.raycastFirst(this.downRay, THREE.DoubleSide, 0, 120);
    return hit ? hit.point.y : null;
  }

  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    const direction = end.clone().sub(start);
    const distance = direction.length();
    if (distance < 1e-6) return null;
    direction.multiplyScalar(1 / distance);
    const ray = new THREE.Ray(start, direction);
    const brushHit = this.raycastSurface(this.collisionGeometry, this.boundsTree, ray, distance);
    const patchHit = this.raycastSurface(this.patchCollisionGeometry, this.patchBoundsTree, ray, distance);
    if (!brushHit) return patchHit;
    if (!patchHit) return brushHit;
    return brushHit.distance <= patchHit.distance ? brushHit : patchHit;
  }

  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null {
    return this.segmentHitDetails(start, end)?.point ?? null;
  }

  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance = 0.12): boolean {
    const hit = this.segmentHit(start, end);
    return hit === null || hit.distanceToSquared(end) <= endTolerance * endTolerance;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.collisionGeometry.dispose();
    this.patchCollisionGeometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
  }

  private raycastSurface(
    geometry: THREE.BufferGeometry,
    bvh: MeshBVH,
    ray: THREE.Ray,
    far: number,
  ): SurfaceHit | null {
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, far);
    if (!hit) return null;
    const position = geometry.getAttribute('position');
    const faceIndex = hit.faceIndex ?? 0;
    const offset = faceIndex * 3;
    const a = new THREE.Vector3().fromBufferAttribute(position, offset);
    const b = new THREE.Vector3().fromBufferAttribute(position, offset + 1);
    const c = new THREE.Vector3().fromBufferAttribute(position, offset + 2);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    // Face winding is not guaranteed for imported brush patches. Orient the
    // normal against the incoming ray so floors point up and ceilings down.
    if (normal.dot(ray.direction) > 0) normal.negate();
    return { point: hit.point.clone(), normal, distance: hit.distance };
  }

  private createMaterial(
    name: ArenaMaterialName,
    shader: string,
    asset: ArenaMaterialAsset | undefined,
    loadedTextures: Map<string, THREE.Texture>,
  ): THREE.Material {
    const definition = MATERIALS[name];
    const authoredMap = asset?.map ? loadedTextures.get(asset.map) : undefined;
    const map = authoredMap ?? this.createSurfaceTexture(name);
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = asset?.normalMap ? loadedTextures.get(asset.normalMap) : undefined;
    const roughnessMap = asset?.roughnessMap ? loadedTextures.get(asset.roughnessMap) : undefined;
    if (normalMap) normalMap.colorSpace = THREE.NoColorSpace;
    if (roughnessMap) roughnessMap.colorSpace = THREE.NoColorSpace;
    const authored = Boolean(authoredMap);
    const additiveSurface = /halo|glow_cone|flare_sphere/i.test(shader);
    if (additiveSurface) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      this.materials.push(material);
      return material;
    }
    if (name === 'glass') {
      const parameters: THREE.MeshPhysicalMaterialParameters = {
        color: authored ? 0xa9dbe4 : definition.color,
        emissive: definition.emissive,
        emissiveIntensity: authored ? 0.16 : definition.emissiveIntensity,
        roughness: definition.roughness,
        metalness: definition.metalness,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
        map,
      };
      if (normalMap) parameters.normalMap = normalMap;
      if (roughnessMap) parameters.roughnessMap = roughnessMap;
      const material = new THREE.MeshPhysicalMaterial(parameters);
      this.materials.push(material);
      return material;
    }
    const luminous = name === 'light' || name === 'screen';
    const parameters: THREE.MeshStandardMaterialParameters = {
      color: authored ? (luminous ? 0xaab8bd : 0xffffff) : definition.color,
      emissive: luminous ? (name === 'screen' ? 0x77dcea : 0x9beef4) : authored ? 0x05080a : definition.emissive,
      // Authored light textures already contain bright texels. A full-strength
      // white emissive map counted the fixture twice and clipped it into a
      // featureless slab after ACES + bloom.
      emissiveIntensity: luminous ? (name === 'screen' ? 0.64 : 0.78) : authored ? 0.08 : definition.emissiveIntensity,
      roughness: definition.roughness,
      metalness: definition.metalness,
      map,
      emissiveMap: luminous ? map : null,
      // Qfusion stores baked illumination/occlusion in the FBSP vertex-color
      // channels. The converter has always preserved them; enabling them here
      // restores the room-to-room lighting hierarchy of the authored map.
      vertexColors: !luminous,
    };
    if (normalMap) {
      parameters.normalMap = normalMap;
      parameters.normalScale = new THREE.Vector2(0.62, 0.62);
    }
    if (roughnessMap) parameters.roughnessMap = roughnessMap;
    const material = new THREE.MeshStandardMaterial(parameters);
    this.materials.push(material);
    return material;
  }

  private createSurfaceTexture(name: ArenaMaterialName): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for arena surface synthesis.');

    context.fillStyle = name === 'screen' ? '#172431' : '#c6cdd1';
    context.fillRect(0, 0, 256, 256);
    let seed = name.split('').reduce((sum, character) => sum + character.charCodeAt(0), 71);
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    if (name === 'concrete' || name === 'wall') {
      context.strokeStyle = 'rgba(18, 31, 42, .42)';
      context.lineWidth = 3;
      for (const coordinate of [2, 64, 128, 192, 254]) {
        context.beginPath();
        context.moveTo(coordinate, 0);
        context.lineTo(coordinate, 256);
        context.stroke();
        context.beginPath();
        context.moveTo(0, coordinate);
        context.lineTo(256, coordinate);
        context.stroke();
      }
      context.strokeStyle = 'rgba(220, 241, 246, .2)';
      context.lineWidth = 1;
      for (let index = 0; index < 26; index += 1) {
        const x = random() * 256;
        const y = random() * 256;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + (random() - 0.5) * 34, y + (random() - 0.5) * 12);
        context.stroke();
      }
    } else if (name === 'floor') {
      context.strokeStyle = 'rgba(12, 28, 39, .52)';
      context.lineWidth = 2;
      for (let coordinate = 0; coordinate <= 256; coordinate += 32) {
        context.beginPath();
        context.moveTo(coordinate, 0);
        context.lineTo(coordinate, 256);
        context.stroke();
        context.beginPath();
        context.moveTo(0, coordinate);
        context.lineTo(256, coordinate);
        context.stroke();
      }
      context.strokeStyle = 'rgba(80, 236, 255, .3)';
      context.lineWidth = 1;
      context.strokeRect(5, 5, 246, 246);
    } else if (name === 'metal' || name === 'trim') {
      for (let y = 0; y < 256; y += 16) {
        context.fillStyle = y % 32 === 0 ? 'rgba(17, 30, 41, .28)' : 'rgba(240, 250, 252, .08)';
        context.fillRect(0, y, 256, 3);
      }
      context.fillStyle = 'rgba(15, 25, 34, .65)';
      for (const x of [10, 246]) for (const y of [10, 74, 138, 202, 246]) {
        context.beginPath();
        context.arc(x, y, 3, 0, Math.PI * 2);
        context.fill();
      }
    } else if (name === 'blue' || name === 'red') {
      context.fillStyle = 'rgba(9, 20, 30, .22)';
      for (let offset = -256; offset < 512; offset += 64) {
        context.beginPath();
        context.moveTo(offset, 0);
        context.lineTo(offset + 24, 0);
        context.lineTo(offset + 280, 256);
        context.lineTo(offset + 256, 256);
        context.closePath();
        context.fill();
      }
    } else if (name === 'screen') {
      context.fillStyle = 'rgba(95, 244, 255, .48)';
      for (let y = 4; y < 256; y += 8) context.fillRect(0, y, 256, 2);
      context.strokeStyle = 'rgba(230, 255, 255, .72)';
      context.lineWidth = 4;
      context.strokeRect(12, 12, 232, 232);
    }

    for (let index = 0; index < 900; index += 1) {
      const value = Math.floor(110 + random() * 145);
      context.fillStyle = `rgba(${value}, ${value}, ${value}, .035)`;
      context.fillRect(random() * 256, random() * 256, 1, 1);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    this.textures.push(texture);
    return texture;
  }

  private createJumpPadVisuals(): void {
    const shell = new THREE.MeshStandardMaterial({ color: 0x1a2638, roughness: 0.25, metalness: 0.82 });
    const energy = new THREE.MeshStandardMaterial({
      color: 0x7eefff,
      emissive: 0x18dfff,
      emissiveIntensity: 2.1,
      roughness: 0.15,
      metalness: 0.12,
    });
    this.materials.push(shell, energy);
    const baseGeometry = new THREE.CylinderGeometry(1.05, 1.3, 0.18, 12);
    const ringGeometry = new THREE.TorusGeometry(0.78, 0.07, 8, 32);
    this.geometries.push(baseGeometry, ringGeometry);
    const baseMesh = new THREE.InstancedMesh(baseGeometry, shell, JUMP_PADS.length);
    baseMesh.name = 'JumpPadBases';
    const ringMesh = new THREE.InstancedMesh(ringGeometry, energy, JUMP_PADS.length);
    ringMesh.name = 'JumpPadRings';
    const baseMatrix = new THREE.Matrix4();
    const ringMatrix = new THREE.Matrix4();
    const identityQuaternion = new THREE.Quaternion();
    const identityScale = new THREE.Vector3(1, 1, 1);
    JUMP_PADS.forEach((pad, index) => {
      baseMatrix.compose(pad.position.clone().add(new THREE.Vector3(0, 1.1, 0)), identityQuaternion, identityScale);
      baseMesh.setMatrixAt(index, baseMatrix);
      ringMatrix.compose(this.jumpPadRingPositions[index], this.jumpPadRingQuaternion, identityScale);
      ringMesh.setMatrixAt(index, ringMatrix);
    });
    baseMesh.instanceMatrix.needsUpdate = true;
    ringMesh.instanceMatrix.needsUpdate = true;
    this.group.add(baseMesh, ringMesh);
  }

  private createAtmosphereSetDressing(): void {
    const cyan = new THREE.MeshStandardMaterial({ color: 0x9bf6ff, emissive: 0x23cfff, emissiveIntensity: 1.5 });
    const magenta = new THREE.MeshStandardMaterial({ color: 0xff769f, emissive: 0xe62064, emissiveIntensity: 1.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x101724, roughness: 0.24, metalness: 0.86 });
    this.materials.push(cyan, magenta, dark);
    const mastGeometry = new THREE.CylinderGeometry(0.16, 0.3, 9, 8);
    const signalGeometry = new THREE.OctahedronGeometry(0.52, 0);
    this.geometries.push(mastGeometry, signalGeometry);
    const points = [
      new THREE.Vector3(-38, 8, -45),
      new THREE.Vector3(38, 10, -42),
      new THREE.Vector3(-40, 7, 42),
      new THREE.Vector3(40, 11, 44),
    ];
    const mastMesh = new THREE.InstancedMesh(mastGeometry, dark, points.length);
    mastMesh.name = 'AtmosphereMasts';
    const cyanSignals = new THREE.InstancedMesh(signalGeometry, cyan, 2);
    cyanSignals.name = 'AtmosphereCyanSignals';
    const magentaSignals = new THREE.InstancedMesh(signalGeometry, magenta, 2);
    magentaSignals.name = 'AtmosphereMagentaSignals';
    const signalIndices = [0, 0];
    points.forEach((point, index) => {
      this.atmosphereInstanceMatrix.compose(point, this.atmosphereInstanceQuaternion, this.atmosphereInstanceScale);
      mastMesh.setMatrixAt(index, this.atmosphereInstanceMatrix);
      const signalMesh = index % 2 === 0 ? cyanSignals : magentaSignals;
      const signalIndex = signalIndices[index % 2];
      signalIndices[index % 2] += 1;
      const signalPosition = point.clone().add(new THREE.Vector3(0, 5, 0));
      this.atmosphereInstanceMatrix.compose(signalPosition, this.atmosphereInstanceQuaternion, this.atmosphereInstanceScale);
      signalMesh.setMatrixAt(signalIndex, this.atmosphereInstanceMatrix);
      this.atmosphereSignalInstances.push({ mesh: signalMesh, index: signalIndex, position: signalPosition, phase: index });
    });
    mastMesh.instanceMatrix.needsUpdate = true;
    cyanSignals.instanceMatrix.needsUpdate = true;
    magentaSignals.instanceMatrix.needsUpdate = true;
    this.group.add(mastMesh, cyanSignals, magentaSignals);
  }

  private createArchitecturalLighting(): void {
    const fixtures: Array<[[number, number, number], number, number, number]> = [
      [[-768, -1904, 280], 0x58e8ff, 4.2, 16],
      [[-784, -1360, 640], 0xff416f, 3.6, 15],
      [[-736, -320, 520], 0x5aeaff, 5.2, 17],
      [[-800, 832, 840], 0xff4c78, 4.1, 16],
      [[-1088, 1600, 440], 0x55dfff, 3.8, 17],
      [[-1088, 1600, 960], 0x54cfff, 4.2, 18],
      [[832, 1184, 340], 0xff476f, 4, 17],
      [[832, 1184, 900], 0x5ee8ff, 4.2, 18],
      [[-2048, -640, 450], 0x59dcff, 3.8, 15],
      [[-768, -2016, 930], 0xff4b83, 4, 16],
    ];
    for (const [source, color, intensity, distance] of fixtures) {
      const light = new THREE.PointLight(color, intensity, distance, 1.7);
      light.position.copy(sourcePoint(...source));
      this.group.add(light);
    }
  }
}
