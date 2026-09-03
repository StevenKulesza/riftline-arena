import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  MONSOON_DIVIDE,
  MONSOON_INNER_LOOP_SAMPLES,
  MONSOON_WORLD_SCALE,
  sampleMonsoonMeshHeight,
  sampleMonsoonMeshNormal,
} from './MonsoonDivide';

export const MONSOON_ROUTE_INFRA_SOURCE = 'Riftline project-original procedural stormwater route kit';
export const MONSOON_ROUTE_INFRA_LICENSE = 'Riftline project original';

type DesignPoint = readonly [x: number, z: number];

type RouteDefinition = Readonly<{
  name: string;
  points: ReadonlyArray<DesignPoint>;
  closed?: boolean;
  width: number;
  sampleSpacing: number;
}>;

type RouteSample = Readonly<{
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  right: THREE.Vector3;
}>;

export type MonsoonRouteInfrastructureDiagnostics = Readonly<{
  source: typeof MONSOON_ROUTE_INFRA_SOURCE;
  license: typeof MONSOON_ROUTE_INFRA_LICENSE;
  seed: number;
  deterministic: true;
  collision: false;
  terrainSampler: 'sampleMonsoonMeshHeight/sampleMonsoonMeshNormal';
  routeCount: number;
  routeNames: readonly string[];
  routeSampleCount: number;
  curbInstanceCount: number;
  gatewayInstanceCount: number;
  signalInstanceCount: number;
  visibleMeshCount: number;
  instancedMeshCount: number;
  expectedVisibleDrawCalls: number;
  expectedShadowDrawCalls: number;
  geometryCount: number;
  materialCount: number;
  textureCount: 0;
  estimatedVisibleTriangles: number;
  addedTriangleBudget: 90_000;
}>;

export type MonsoonRouteInfrastructureBuild = {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  colliderBoxes: readonly [];
  diagnostics: MonsoonRouteInfrastructureDiagnostics;
};

const ROUTES: ReadonlyArray<RouteDefinition> = [
  {
    name: 'inner stormwater circuit',
    points: MONSOON_INNER_LOOP_SAMPLES,
    closed: true,
    width: 4.8,
    sampleSpacing: 9.5,
  },
  {
    name: 'northwest collector descent',
    points: [[-176, 96], [-145, 76], [-119, 58], [-88, 39], [-42, 20], [-34, 18]],
    width: 5.8,
    sampleSpacing: 10.5,
  },
  {
    name: 'northeast collector descent',
    points: [[174, 82], [145, 66], [116, 45], [88, 42], [42, 22], [34, 18]],
    width: 5.8,
    sampleSpacing: 10.5,
  },
  {
    name: 'southwest spillway climb',
    points: [[-169, -114], [-138, -94], [-112, -79], [-78, -58], [-38, -29], [-34, -22]],
    width: 5.8,
    sampleSpacing: 10.5,
  },
  {
    name: 'southeast spillway climb',
    points: [[160, -118], [132, -96], [103, -77], [76, -61], [37, -31], [34, -22]],
    width: 5.8,
    sampleSpacing: 10.5,
  },
  {
    name: 'north pressure equalizer',
    points: [[-112, 52], [-80, 69], [-36, 76], [8, 72], [48, 65], [88, 44]],
    width: 4.4,
    sampleSpacing: 10,
  },
  {
    name: 'south pressure equalizer',
    points: [[-110, -45], [-74, -62], [-34, -72], [8, -70], [48, -62], [88, -43]],
    width: 4.4,
    sampleSpacing: 10,
  },
] as const;

const GATEWAY_ROUTE_INDICES = [1, 2, 3, 4, 5, 6] as const;

function world(value: number): number {
  return value * MONSOON_WORLD_SCALE;
}

function deterministicUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value / 0x1_0000_0000;
}

function routeCurve(route: RouteDefinition): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    route.points.map(([x, z]) => new THREE.Vector3(world(x), 0, world(z))),
    route.closed ?? false,
    'centripetal',
    0.34,
  );
}

function sampleRoute(route: RouteDefinition, seed: number): RouteSample[] {
  const curve = routeCurve(route);
  const length = Math.max(1, curve.getLength());
  // Render ribbons conform more tightly than gameplay route probes. Longer
  // chords can bridge over a local saddle and read as a floating wall from a
  // first-person camera even though both endpoints touch the terrain.
  const conformingSpacing = Math.min(route.sampleSpacing, 3.8);
  const segmentCount = Math.max(route.closed ? 20 : 8, Math.ceil(length / world(conformingSpacing)));
  const samples: RouteSample[] = [];
  const count = route.closed ? segmentCount : segmentCount + 1;
  for (let index = 0; index < count; index += 1) {
    const t = route.closed ? index / segmentCount : index / segmentCount;
    const point = curve.getPointAt(t);
    const horizontalTangent = curve.getTangentAt(t).setY(0).normalize();
    const normal = sampleMonsoonMeshNormal(point.x, point.z, new THREE.Vector3(), seed);
    const tangent = horizontalTangent.addScaledVector(normal, -horizontalTangent.dot(normal)).normalize();
    const right = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    point.y = sampleMonsoonMeshHeight(point.x, point.z, seed);
    samples.push({ position: point, tangent, normal, right });
  }
  return samples;
}

function addVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  point: THREE.Vector3,
  normal: THREE.Vector3,
  color: THREE.Color,
): void {
  positions.push(point.x, point.y, point.z);
  normals.push(normal.x, normal.y, normal.z);
  colors.push(color.r, color.g, color.b);
}

function createChannelGeometry(routes: ReadonlyArray<{ route: RouteDefinition; samples: RouteSample[] }>): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const wetCenter = new THREE.Color(0x213d43);
  const stormEdge = new THREE.Color(0x426267);
  for (const { route, samples } of routes) {
    const segmentCount = route.closed ? samples.length : samples.length - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const nextIndex = (index + 1) % samples.length;
      const a = samples[index];
      const b = samples[nextIndex];
      const halfWidth = world(route.width) * 0.5;
      const aLeft = a.position.clone().addScaledVector(a.right, halfWidth).addScaledVector(a.normal, 0.09);
      const aMid = a.position.clone().addScaledVector(a.normal, 0.055);
      const aRight = a.position.clone().addScaledVector(a.right, -halfWidth).addScaledVector(a.normal, 0.09);
      const bLeft = b.position.clone().addScaledVector(b.right, halfWidth).addScaledVector(b.normal, 0.09);
      const bMid = b.position.clone().addScaledVector(b.normal, 0.055);
      const bRight = b.position.clone().addScaledVector(b.right, -halfWidth).addScaledVector(b.normal, 0.09);

      addVertex(positions, normals, colors, aLeft, a.normal, stormEdge);
      addVertex(positions, normals, colors, bLeft, b.normal, stormEdge);
      addVertex(positions, normals, colors, aMid, a.normal, wetCenter);
      addVertex(positions, normals, colors, aMid, a.normal, wetCenter);
      addVertex(positions, normals, colors, bLeft, b.normal, stormEdge);
      addVertex(positions, normals, colors, bMid, b.normal, wetCenter);
      addVertex(positions, normals, colors, aMid, a.normal, wetCenter);
      addVertex(positions, normals, colors, bMid, b.normal, wetCenter);
      addVertex(positions, normals, colors, aRight, a.normal, stormEdge);
      addVertex(positions, normals, colors, aRight, a.normal, stormEdge);
      addVertex(positions, normals, colors, bMid, b.normal, wetCenter);
      addVertex(positions, normals, colors, bRight, b.normal, stormEdge);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = { family: 'stormwater-route-channels', nonCollidable: true };
  return geometry;
}

function createCurbGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(-0.34, 0.3);
  shape.lineTo(0.18, 0.42);
  shape.lineTo(0.5, 0.08);
  shape.lineTo(0.5, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.06,
    bevelThickness: 0.05,
  });
  geometry.translate(0, 0, -0.5);
  geometry.computeVertexNormals();
  geometry.userData = { family: 'stormwater-route-curbs', nonCollidable: true };
  return geometry;
}

function createGatewayGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const arch = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.5, 0.1, 0),
    new THREE.Vector3(-0.46, 0.6, 0),
    new THREE.Vector3(-0.28, 0.95, 0),
    new THREE.Vector3(0, 1.08, 0),
    new THREE.Vector3(0.31, 0.92, 0),
    new THREE.Vector3(0.47, 0.56, 0),
    new THREE.Vector3(0.5, 0.08, 0),
  ], false, 'centripetal', 0.32);
  parts.push(new THREE.TubeGeometry(arch, 18, 0.035, 5, false));
  for (const side of [-1, 1]) {
    const foot = new THREE.CylinderGeometry(0.075, 0.12, 0.34, 5);
    foot.translate(side * 0.5, 0.12, 0);
    parts.push(foot);
    const vane = new THREE.BoxGeometry(0.025, 0.32, 0.18);
    vane.rotateZ(side * -0.34);
    vane.translate(side * 0.39, 0.56, 0.02);
    parts.push(vane);
  }
  const crown = new THREE.ConeGeometry(0.09, 0.22, 5);
  crown.rotateZ(Math.PI * 0.5);
  crown.translate(0, 1.08, 0);
  parts.push(crown);
  const normalized = parts.map((part) => part.index ? part.toNonIndexed() : part);
  const geometry = mergeGeometries(normalized, false);
  parts.forEach((part) => part.dispose());
  normalized.forEach((part) => {
    if (!parts.includes(part)) part.dispose();
  });
  if (!geometry) throw new Error('Failed to merge Monsoon route gateway geometry.');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = { family: 'storm-pressure-gateways', nonCollidable: true };
  return geometry;
}

function createSignalGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.12);
  shape.lineTo(0.08, -0.12);
  shape.lineTo(0.5, 0);
  shape.lineTo(0.08, 0.12);
  shape.lineTo(-0.5, 0.12);
  shape.lineTo(-0.2, 0);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.035,
    steps: 1,
    bevelEnabled: false,
  });
  geometry.center();
  geometry.userData = { family: 'storm-route-chevron', nonCollidable: true };
  return geometry;
}

function matrixForBasis(sample: RouteSample, position: THREE.Vector3, scale: THREE.Vector3): THREE.Matrix4 {
  const matrix = new THREE.Matrix4().makeBasis(sample.right, sample.normal, sample.tangent);
  matrix.scale(scale);
  matrix.setPosition(position);
  return matrix;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index
    ? geometry.index.count / 3
    : geometry.getAttribute('position').count / 3;
}

export function buildMonsoonRouteInfrastructure(
  seed: number = MONSOON_DIVIDE.seed,
): MonsoonRouteInfrastructureBuild {
  const normalizedSeed = seed >>> 0;
  const sampledRoutes = ROUTES.map((route) => ({ route, samples: sampleRoute(route, normalizedSeed) }));
  const group = new THREE.Group();
  group.name = 'MonsoonDivideStormwaterRouteInfrastructure';
  group.userData.nonCollidable = true;

  const channelGeometry = createChannelGeometry(sampledRoutes);
  const curbGeometry = createCurbGeometry();
  const gatewayGeometry = createGatewayGeometry();
  const signalGeometry = createSignalGeometry();
  const geometries = [channelGeometry, curbGeometry, gatewayGeometry, signalGeometry];

  const channelMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.34,
    metalness: 0.16,
    clearcoat: 0.62,
    clearcoatRoughness: 0.18,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  channelMaterial.name = 'MonsoonWetStormwaterChannels';
  const curbMaterial = new THREE.MeshStandardMaterial({
    color: 0x344952,
    roughness: 0.62,
    metalness: 0.4,
    flatShading: true,
  });
  curbMaterial.name = 'MonsoonStormAbradedRouteCurbs';
  const gatewayMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x6f858b,
    roughness: 0.45,
    metalness: 0.55,
    clearcoat: 0.48,
    clearcoatRoughness: 0.24,
  });
  gatewayMaterial.name = 'MonsoonPressureGatewayShell';
  const signalMaterial = new THREE.MeshBasicMaterial({
    color: 0x8de8e5,
    toneMapped: true,
  });
  signalMaterial.name = 'MonsoonRestrainedRouteSignals';
  const materials: THREE.Material[] = [channelMaterial, curbMaterial, gatewayMaterial, signalMaterial];

  const channels = new THREE.Mesh(channelGeometry, channelMaterial);
  channels.name = 'Connected stormwater ski route channels';
  channels.receiveShadow = true;
  channels.renderOrder = 1;
  channels.userData = { family: 'stormwater-route-channels', nonCollidable: true };
  group.add(channels);

  const curbMatrices: THREE.Matrix4[] = [];
  const signalMatrices: THREE.Matrix4[] = [];
  sampledRoutes.forEach(({ route, samples }, routeIndex) => {
    const segmentCount = route.closed ? samples.length : samples.length - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const next = samples[(index + 1) % samples.length];
      const current = samples[index];
      const midpoint = current.position.clone().lerp(next.position, 0.5);
      const halfWidth = world(route.width) * 0.5 + 0.22;
      if (index % 2 === 0) {
        const curbEndIndex = route.closed
          ? (index + 2) % samples.length
          : Math.min(samples.length - 1, index + 2);
        const curbEnd = samples[curbEndIndex];
        const curbMidpoint = current.position.clone().lerp(curbEnd.position, 0.5);
        const curbLength = current.position.distanceTo(curbEnd.position);
        for (const side of [-1, 1]) {
          const position = curbMidpoint.clone()
            .addScaledVector(current.right, side * halfWidth)
            .addScaledVector(current.normal, 0.04);
          curbMatrices.push(matrixForBasis(
            current,
            position,
            new THREE.Vector3(0.72 + deterministicUnit(normalizedSeed, curbMatrices.length) * 0.18, 0.85, curbLength * 0.9),
          ));
        }
      }
      if ((index + routeIndex) % 5 === 0) {
        const signalSide = (index + routeIndex) % 2 === 0 ? 1 : -1;
        const position = midpoint.clone()
          .addScaledVector(current.right, signalSide * (halfWidth + 0.55))
          .addScaledVector(current.normal, 0.68);
        signalMatrices.push(matrixForBasis(
          current,
          position,
          new THREE.Vector3(signalSide * 1.4, 1.4, 1.4),
        ));
      }
    }
  });
  const curbs = new THREE.InstancedMesh(curbGeometry, curbMaterial, curbMatrices.length);
  curbs.name = 'Connected ribbed route curbs';
  curbMatrices.forEach((matrix, index) => curbs.setMatrixAt(index, matrix));
  curbs.instanceMatrix.needsUpdate = true;
  curbs.castShadow = true;
  curbs.receiveShadow = true;
  curbs.userData = { family: 'stormwater-route-curbs', nonCollidable: true };
  curbs.computeBoundingBox();
  curbs.computeBoundingSphere();
  group.add(curbs);

  const gatewayMatrices: THREE.Matrix4[] = [];
  GATEWAY_ROUTE_INDICES.forEach((routeIndex, index) => {
    const route = sampledRoutes[routeIndex];
    const fractions = routeIndex < 5 ? [0.34, 0.68] : [0.5];
    fractions.forEach((fraction) => {
      const sample = route.samples[Math.min(route.samples.length - 1, Math.round((route.samples.length - 1) * fraction))];
      const jitter = 0.94 + deterministicUnit(normalizedSeed, 600 + index * 11 + Math.round(fraction * 10)) * 0.12;
      gatewayMatrices.push(matrixForBasis(
        sample,
        sample.position.clone().addScaledVector(sample.normal, 0.08),
        new THREE.Vector3(world(15) * jitter, world(10.5) * jitter, world(2.2)),
      ));
    });
  });
  const gateways = new THREE.InstancedMesh(gatewayGeometry, gatewayMaterial, gatewayMatrices.length);
  gateways.name = 'Arcing storm-pressure route gateways';
  gatewayMatrices.forEach((matrix, index) => gateways.setMatrixAt(index, matrix));
  gateways.instanceMatrix.needsUpdate = true;
  gateways.castShadow = true;
  gateways.receiveShadow = true;
  gateways.userData = { family: 'storm-pressure-gateways', nonCollidable: true };
  gateways.computeBoundingBox();
  gateways.computeBoundingSphere();
  group.add(gateways);

  const signals = new THREE.InstancedMesh(signalGeometry, signalMaterial, signalMatrices.length);
  signals.name = 'Alternating route-flow chevrons';
  signalMatrices.forEach((matrix, index) => signals.setMatrixAt(index, matrix));
  signals.instanceMatrix.needsUpdate = true;
  signals.renderOrder = 2;
  signals.userData = { family: 'storm-route-chevron', nonCollidable: true };
  signals.computeBoundingBox();
  signals.computeBoundingSphere();
  group.add(signals);

  const visibleMeshes = group.children.filter((child) => child instanceof THREE.Mesh);
  const expectedShadowDrawCalls = visibleMeshes.filter((child) => child.castShadow).length;
  const estimatedVisibleTriangles = triangleCount(channelGeometry)
    + triangleCount(curbGeometry) * curbMatrices.length
    + triangleCount(gatewayGeometry) * gatewayMatrices.length
    + triangleCount(signalGeometry) * signalMatrices.length;
  const diagnostics: MonsoonRouteInfrastructureDiagnostics = {
    source: MONSOON_ROUTE_INFRA_SOURCE,
    license: MONSOON_ROUTE_INFRA_LICENSE,
    seed: normalizedSeed,
    deterministic: true,
    collision: false,
    terrainSampler: 'sampleMonsoonMeshHeight/sampleMonsoonMeshNormal',
    routeCount: sampledRoutes.length,
    routeNames: sampledRoutes.map(({ route }) => route.name),
    routeSampleCount: sampledRoutes.reduce((total, { samples }) => total + samples.length, 0),
    curbInstanceCount: curbMatrices.length,
    gatewayInstanceCount: gatewayMatrices.length,
    signalInstanceCount: signalMatrices.length,
    visibleMeshCount: visibleMeshes.length,
    instancedMeshCount: visibleMeshes.filter((mesh) => mesh instanceof THREE.InstancedMesh).length,
    expectedVisibleDrawCalls: visibleMeshes.length,
    expectedShadowDrawCalls,
    geometryCount: geometries.length,
    materialCount: materials.length,
    textureCount: 0,
    estimatedVisibleTriangles,
    addedTriangleBudget: 90_000,
  };
  if (estimatedVisibleTriangles > diagnostics.addedTriangleBudget) {
    throw new Error(`Monsoon route infrastructure exceeded its ${diagnostics.addedTriangleBudget} triangle budget.`);
  }
  group.userData = {
    source: MONSOON_ROUTE_INFRA_SOURCE,
    license: MONSOON_ROUTE_INFRA_LICENSE,
    assetSourcing: 'Project-original deterministic geometry; no imported assets or sidecar files',
    artDirection: 'Connected wet spillways, storm-abrasion curbs, pressure arches, and restrained flow chevrons',
    nonCollidable: true,
    diagnostics,
  };

  return {
    group,
    geometries,
    materials,
    textures: [],
    colliderBoxes: [],
    diagnostics,
  };
}
