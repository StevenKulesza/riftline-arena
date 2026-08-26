import * as THREE from 'three';

export const MONSOON_DIVIDE = {
  id: 'monsoon-divide',
  name: 'Monsoon Divide',
  generationVersion: 5,
  seed: 0x4d4f4e53,
  width: 480,
  depth: 400,
  segmentsX: 120,
  segmentsZ: 100,
  waterY: -9.5,
  killY: -13.5,
} as const;

export type MonsoonTerrainMasks = {
  island: number;
  route: number;
  crater: number;
  coast: number;
};

export type MonsoonTerrainBuild = {
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  altitudeRange: { min: number; max: number };
  topologyHash: string;
};

export const MONSOON_ROUTE_SEGMENTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-198, 105, -119, 58], [-88, 39, -18, 10],
  [198, 78, 88, 42], [88, 42, 18, 8],
  [-190, -118, -78, -58], [-78, -58, -17, -10],
  [184, -128, 76, -61], [76, -61, 17, -10],
];

type MountainSkiCorridor = {
  halfWidth: number;
  points: ReadonlyArray<readonly [number, number, number]>;
};

type RidgeNode = readonly [x: number, z: number, relief: number, halfWidth: number];
type Ridgeline = ReadonlyArray<RidgeNode>;

// These two long grades cross the whole island rather than terminating at the
// center. A clean descent therefore becomes stored momentum for the opposing
// climb: players can carve down one massif, skim the recovery bowl, and climb
// the next shoulder without the terrain pushing them sideways off the line.
const MOUNTAIN_SKI_CORRIDORS: ReadonlyArray<MountainSkiCorridor> = [
  {
    halfWidth: 20,
    points: [
      [-176, 96, 78], [-160, 82, 67], [-132, 66, 48], [-119, 58, 35],
      [-88, 39, 27], [-18, 10, 13], [0, 0, 10], [17, -10, 13], [76, -61, 29],
      [103, -77, 41], [125, -91, 54], [150, -108, 72], [160, -118, 82],
    ],
  },
  {
    halfWidth: 20,
    points: [
      [174, 82, 76], [158, 70, 68], [138, 61, 55], [116, 45, 40], [88, 42, 29],
      [18, 8, 13], [0, 0, 10], [-17, -10, 13], [-78, -58, 22], [-118, -82, 34],
      [-132, -90, 50], [-150, -100, 65], [-169, -114, 74],
    ],
  },
];

export const MONSOON_OUTER_LOOP_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-158, 78], [-112, 126], [-48, 146], [24, 148], [94, 126], [154, 76], [174, 8],
  [158, -72], [118, -118], [46, -146], [-28, -148], [-100, -128], [-156, -82], [-178, -18],
];

export const MONSOON_INNER_LOOP_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-78, -50], [-88, -28], [-88, 28], [-70, 54], [-34, 68], [34, 68], [70, 54],
  [88, 28], [88, -28], [70, -54], [34, -68], [-34, -68], [-70, -54],
];

function sampleClosedLoop(
  points: ReadonlyArray<readonly [number, number]>,
  samples: number,
): ReadonlyArray<readonly [number, number]> {
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    true,
    'centripetal',
    0.38,
  );
  return curve.getSpacedPoints(samples - 1).map((point) => [point.x, point.z] as const);
}

export const MONSOON_OUTER_LOOP_SAMPLES = sampleClosedLoop(MONSOON_OUTER_LOOP_POINTS, 84);
export const MONSOON_INNER_LOOP_SAMPLES = sampleClosedLoop(MONSOON_INNER_LOOP_POINTS, 56);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function gaussian(x: number, z: number, cx: number, cz: number, sx: number, sz: number): number {
  const dx = (x - cx) / sx;
  const dz = (z - cz) / sz;
  return Math.exp(-(dx * dx + dz * dz) * 0.5);
}

function orientedGaussian(
  x: number,
  z: number,
  cx: number,
  cz: number,
  angle: number,
  along: number,
  across: number,
): number {
  const dx = x - cx;
  const dz = z - cz;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const localAlong = (dx * cosine + dz * sine) / along;
  const localAcross = (-dx * sine + dz * cosine) / across;
  return Math.exp(-(localAlong * localAlong + localAcross * localAcross) * 0.5);
}

/**
 * Samples a connected, authored mountain spine. The compound cross-section is
 * deliberately shelf-like rather than a single bell curve: a broad foothill,
 * an upper bench, and a compact crown make each range read as layered geology
 * instead of a row of procedural cones.
 */
function sampleRidgeline(x: number, z: number, nodes: Ridgeline): number {
  let strongestRelief = 0;
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const [ax, az, aRelief, aWidth] = nodes[index];
    const [bx, bz, bRelief, bWidth] = nodes[index + 1];
    const abx = bx - ax;
    const abz = bz - az;
    const lengthSquared = abx * abx + abz * abz || 1;
    const t = clamp01(((x - ax) * abx + (z - az) * abz) / lengthSquared);
    const dx = x - THREE.MathUtils.lerp(ax, bx, t);
    const dz = z - THREE.MathUtils.lerp(az, bz, t);
    const halfWidth = THREE.MathUtils.lerp(aWidth, bWidth, t);
    const normalizedDistance = Math.hypot(dx, dz) / halfWidth;
    const foothill = (1 - smoothstep(1.28, 2.05, normalizedDistance)) * 0.2;
    const lowerBench = (1 - smoothstep(0.76, 1.3, normalizedDistance)) * 0.25;
    const upperBench = (1 - smoothstep(0.32, 0.82, normalizedDistance)) * 0.31;
    const crown = Math.exp(-Math.pow(normalizedDistance / 0.43, 2) * 0.5) * 0.24;
    strongestRelief = Math.max(
      strongestRelief,
      THREE.MathUtils.lerp(aRelief, bRelief, t) * (foothill + lowerBench + upperBench + crown),
    );
  }
  return strongestRelief;
}

function terraceRelief(relief: number, spacing: number, influence: number): number {
  if (relief <= 0) return 0;
  const scaled = relief / spacing;
  const tier = Math.floor(scaled);
  const transition = smoothstep(0.24, 0.78, scaled - tier);
  const terraced = (tier + transition) * spacing;
  return THREE.MathUtils.lerp(relief, terraced, influence);
}

function distanceToSegmentSquared(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz || 1;
  const t = clamp01(((x - ax) * abx + (z - az) * abz) / lengthSq);
  const dx = x - (ax + abx * t);
  const dz = z - (az + abz * t);
  return dx * dx + dz * dz;
}

function sampleMountainSkiGrade(x: number, z: number): { height: number; strength: number } | null {
  let weightedHeight = 0;
  let totalWeight = 0;
  let strongestWeight = 0;

  for (const corridor of MOUNTAIN_SKI_CORRIDORS) {
    let corridorDistanceSquared = Number.POSITIVE_INFINITY;
    let corridorHeight = 0;
    for (let index = 0; index < corridor.points.length - 1; index += 1) {
      const [ax, az, ay] = corridor.points[index];
      const [bx, bz, by] = corridor.points[index + 1];
      const abx = bx - ax;
      const abz = bz - az;
      const lengthSquared = abx * abx + abz * abz || 1;
      const t = clamp01(((x - ax) * abx + (z - az) * abz) / lengthSquared);
      const dx = x - (ax + abx * t);
      const dz = z - (az + abz * t);
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared >= corridorDistanceSquared) continue;
      corridorDistanceSquared = distanceSquared;
      corridorHeight = THREE.MathUtils.lerp(ay, by, t);
    }

    const weight = Math.exp(-corridorDistanceSquared / (corridor.halfWidth * corridor.halfWidth));
    weightedHeight += corridorHeight * weight;
    totalWeight += weight;
    strongestWeight = Math.max(strongestWeight, weight);
  }

  if (strongestWeight < 0.035 || totalWeight <= 0) return null;
  return {
    height: weightedHeight / totalWeight,
    strength: smoothstep(0.08, 0.95, strongestWeight) * 0.86,
  };
}

function loopMaskAt(
  x: number,
  z: number,
  samples: ReadonlyArray<readonly [number, number]>,
  halfWidth: number,
): number {
  let minimumDistanceSquared = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const [ax, az] = samples[index];
    const [bx, bz] = samples[(index + 1) % samples.length];
    minimumDistanceSquared = Math.min(
      minimumDistanceSquared,
      distanceToSegmentSquared(x, z, ax, az, bx, bz),
    );
  }
  return Math.exp(-minimumDistanceSquared / (halfWidth * halfWidth));
}

function hash2(x: number, z: number, seed: number): number {
  let value = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed;
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
  return ((value ^ (value >>> 15)) >>> 0) / 0xffffffff;
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoothstep(0, 1, x - ix);
  const fz = smoothstep(0, 1, z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const top = THREE.MathUtils.lerp(a, b, fx);
  const bottom = THREE.MathUtils.lerp(c, d, fx);
  return THREE.MathUtils.lerp(top, bottom, fz) * 2 - 1;
}

function fbm(x: number, z: number, seed: number): number {
  let value = 0;
  let amplitude = 0.58;
  let frequency = 1;
  for (let octave = 0; octave < 4; octave += 1) {
    value += valueNoise(x * frequency, z * frequency, seed + octave * 0x9e37) * amplitude;
    frequency *= 2.03;
    amplitude *= 0.48;
  }
  return value;
}

function islandRadius(x: number, z: number): number {
  const base = Math.hypot(x / 226, z / 186);
  const angle = Math.atan2(z, x);
  const shorelineVariation = 1
    + Math.sin(angle * 2 - 0.2) * 0.035
    + Math.sin(angle * 3 + 0.45) * 0.082
    + Math.cos(angle * 5 - 0.8) * 0.047
    + Math.sin(angle * 7 + 1.1) * 0.026;
  // Local bays and headlands keep the playable land contiguous while breaking
  // the unmistakable oval footprint. Positive terms cut inward; negative
  // terms push a headland outward.
  const baysAndHeadlands = (
    0.105 * gaussian(x, z, -205, -30, 31, 45)
    + 0.075 * gaussian(x, z, 34, 177, 46, 25)
    + 0.09 * gaussian(x, z, 187, -107, 34, 36)
    - 0.08 * gaussian(x, z, -174, 110, 42, 34)
    - 0.06 * gaussian(x, z, 204, 27, 30, 48)
    - 0.055 * gaussian(x, z, -30, -181, 54, 24)
  );
  return base * shorelineVariation * (1 + baysAndHeadlands);
}

export function sampleMonsoonMasks(x: number, z: number): MonsoonTerrainMasks {
  const radius = islandRadius(x, z);
  const island = 1 - smoothstep(0.82, 1.035, radius);
  let routeDistanceSquared = Number.POSITIVE_INFINITY;
  for (const segment of MONSOON_ROUTE_SEGMENTS) {
    routeDistanceSquared = Math.min(routeDistanceSquared, distanceToSegmentSquared(x, z, ...segment));
  }
  let route = Math.exp(-routeDistanceSquared / (20 * 20));
  route = Math.max(
    route,
    loopMaskAt(x, z, MONSOON_OUTER_LOOP_POINTS, 24),
    loopMaskAt(x, z, MONSOON_INNER_LOOP_POINTS, 18),
  );
  const craterRadius = Math.hypot(x / 75, z / 61);
  const crater = 1 - smoothstep(0.72, 1.18, craterRadius);
  const coast = smoothstep(0.77, 1.01, radius);
  return { island, route: route * island, crater: crater * island, coast };
}

export function sampleMonsoonHeight(
  x: number,
  z: number,
  seed: number = MONSOON_DIVIDE.seed,
): number {
  const radius = islandRadius(x, z);
  const masks = sampleMonsoonMasks(x, z);
  const land = masks.island;

  let height = -19 + land * (39 - radius * 2.2);

  // Three connected, asymmetric mountain systems replace the former ring of
  // isolated massifs. The western and eastern ranges arc around the arena and
  // join a lower southern spine, leaving legible passes rather than a crater
  // encircled by repeated cones.
  const westernRange: Ridgeline = [
    [-188, -112, 41, 28], [-160, -78, 53, 31], [-145, -28, 37, 36],
    [-153, 32, 48, 32], [-178, 99, 59, 27], [-121, 126, 45, 32], [-55, 149, 52, 27],
  ];
  const easternRange: Ridgeline = [
    [48, 151, 38, 33], [103, 125, 51, 29], [171, 78, 58, 27],
    [145, 19, 41, 35], [153, -43, 48, 31], [181, -110, 62, 26],
    [124, -139, 47, 30], [64, -155, 43, 28],
  ];
  const southernSpine: Ridgeline = [
    [-174, -104, 39, 33], [-126, -124, 47, 36], [-72, -135, 43, 39],
    [-18, -141, 47, 38], [39, -132, 50, 40], [91, -137, 45, 36], [151, -118, 47, 32],
  ];
  const westernRelief = sampleRidgeline(x, z, westernRange);
  const easternRelief = sampleRidgeline(x, z, easternRange);
  const southernRelief = sampleRidgeline(x, z, southernSpine);
  const dominantRelief = Math.max(westernRelief, easternRelief, southernRelief);
  const connectedRelief = dominantRelief
    + Math.min(westernRelief, southernRelief) * 0.18
    + Math.min(easternRelief, southernRelief) * 0.18;
  const mountainRelief = terraceRelief(connectedRelief, 7.2, 0.32);
  const routeMountainBlend = THREE.MathUtils.lerp(1, 0.43, clamp01(masks.route));
  height += land * routeMountainBlend * mountainRelief;

  // Offset escarpments sharpen only selected stretches of the skyline. Their
  // irregular spacing and unequal scale avoid the repeated peak cadence of the
  // previous six-ridge composition while preserving wide traversable shelves.
  const escarpments = (
    17 * orientedGaussian(x, z, -174, 87, -0.9, 58, 13)
    + 11 * orientedGaussian(x, z, -91, 137, 0.18, 49, 14)
    + 20 * orientedGaussian(x, z, 166, 72, 0.74, 61, 14)
    + 18 * orientedGaussian(x, z, 166, -92, -1.02, 54, 13)
    + 12 * orientedGaussian(x, z, -78, -151, 0.03, 68, 15)
  );
  height += land * THREE.MathUtils.lerp(1, 0.12, masks.route) * escarpments;

  // Low-frequency ridged folds add depth to the mountain faces while leaving
  // the broad race lines calm enough for skiing and capsule contact.
  const mountainMask = smoothstep(7, 30, mountainRelief + escarpments);
  const ridgeNoise = 1 - Math.abs(fbm(x * 0.012, z * 0.012, seed ^ 0x43a1c92d));
  const alpineFold = Math.pow(clamp01(ridgeNoise), 3) * 3.4
    + fbm(x * 0.018, z * 0.018, seed ^ 0x71b94f2a) * 1.15;
  height += land * mountainMask * THREE.MathUtils.lerp(1, 0.18, masks.route) * alpineFold;

  // Broad negative landforms cut deep valleys and saddles between the three
  // spines. Positive shelves are deliberately off-axis, breaking radial
  // symmetry without adding noisy high-frequency bumps.
  const macroRelief = (
    7.2 * orientedGaussian(x, z, -104, 32, -0.42, 82, 54)
    + 5.8 * orientedGaussian(x, z, 103, -28, 0.5, 78, 57)
    + 6.4 * orientedGaussian(x, z, 9, 132, 0.04, 94, 39)
    - 9.4 * orientedGaussian(x, z, -58, -73, -0.58, 91, 34)
    - 8.2 * orientedGaussian(x, z, 67, 83, -0.65, 83, 31)
    - 7.8 * gaussian(x, z, -148, -2, 39, 35)
    - 7.2 * gaussian(x, z, 148, -13, 41, 38)
  );
  const rollingRelief = (
    Math.sin(x * 0.018 + z * 0.006) * 3.2
    + Math.cos(z * 0.021 - x * 0.004) * 2.6
    + Math.sin((x + z) * 0.012) * 1.8
  );
  height += land * (1 - masks.route * 0.58) * (macroRelief + rollingRelief);

  const craterRadius = Math.hypot(x / 76, z / 62);
  height += land * (
    5.5 * Math.exp(-Math.pow((craterRadius - 1) / 0.23, 2))
    - 18 * gaussian(x, z, 0, 0, 73, 59)
  );
  height -= land * 7.2 * masks.route;
  // A subdued, irregular coastal shelf echoes the larger geological steps
  // without drawing a perfect ring around the island.
  const coastalShelf = (
    Math.exp(-Math.pow((radius - 0.68) / 0.075, 2))
    * (0.58 + 0.42 * Math.sin(Math.atan2(z, x) * 3 + 0.7))
  );
  height -= land * 3.2 * coastalShelf;

  const routeCalm = THREE.MathUtils.lerp(1, 0.18, clamp01(masks.route * 1.25));
  const craterCalm = THREE.MathUtils.lerp(1, 0.42, masks.crater);
  height += land * routeCalm * craterCalm * (
    fbm(x * 0.021, z * 0.021, seed) * 1.28
    + valueNoise(x * 0.075, z * 0.075, seed ^ 0x6ac690c5) * 0.34
  );

  // Bank the primary mountain lines toward authored longitudinal grades. The
  // partial blend keeps natural shoulders and rock folds at their edges while
  // preventing local crossfall from stealing speed or redirecting a skier
  // just before a launch ramp.
  const skiGrade = sampleMountainSkiGrade(x, z);
  if (skiGrade) {
    height = THREE.MathUtils.lerp(height, skiGrade.height, skiGrade.strength * land);
  }
  return height;
}

/**
 * Samples the exact piecewise-linear surface drawn by the low-poly terrain
 * mesh. Decorative ribbons use this instead of the analytic height function,
 * whose sub-grid curvature can otherwise cross the rendered triangles and
 * expose a patchwork of z-fighting wedges.
 */
export function sampleMonsoonMeshHeight(
  x: number,
  z: number,
  seed: number = MONSOON_DIVIDE.seed,
): number {
  const stepX = MONSOON_DIVIDE.width / MONSOON_DIVIDE.segmentsX;
  const stepZ = MONSOON_DIVIDE.depth / MONSOON_DIVIDE.segmentsZ;
  const gridX = THREE.MathUtils.clamp(
    (x + MONSOON_DIVIDE.width * 0.5) / stepX,
    0,
    MONSOON_DIVIDE.segmentsX,
  );
  const gridZ = THREE.MathUtils.clamp(
    (z + MONSOON_DIVIDE.depth * 0.5) / stepZ,
    0,
    MONSOON_DIVIDE.segmentsZ,
  );
  const ix = Math.min(MONSOON_DIVIDE.segmentsX - 1, Math.floor(gridX));
  const iz = Math.min(MONSOON_DIVIDE.segmentsZ - 1, Math.floor(gridZ));
  const tx = gridX - ix;
  const tz = gridZ - iz;
  const x0 = ix * stepX - MONSOON_DIVIDE.width * 0.5;
  const z0 = iz * stepZ - MONSOON_DIVIDE.depth * 0.5;
  const a = sampleMonsoonHeight(x0, z0, seed);
  const b = sampleMonsoonHeight(x0 + stepX, z0, seed);
  const d = sampleMonsoonHeight(x0, z0 + stepZ, seed);
  const c = sampleMonsoonHeight(x0 + stepX, z0 + stepZ, seed);

  if ((ix + iz) % 2 === 0) {
    return tx + tz <= 1
      ? a * (1 - tx - tz) + b * tx + d * tz
      : c * (tx + tz - 1) + b * (1 - tz) + d * (1 - tx);
  }
  return tz >= tx
    ? a * (1 - tz) + d * (tz - tx) + c * tx
    : a * (1 - tx) + c * tz + b * (tx - tz);
}

export function sampleMonsoonNormal(
  x: number,
  z: number,
  target = new THREE.Vector3(),
  seed: number = MONSOON_DIVIDE.seed,
): THREE.Vector3 {
  const epsilon = 0.72;
  const left = sampleMonsoonHeight(x - epsilon, z, seed);
  const right = sampleMonsoonHeight(x + epsilon, z, seed);
  const back = sampleMonsoonHeight(x, z - epsilon, seed);
  const front = sampleMonsoonHeight(x, z + epsilon, seed);
  return target.set(left - right, epsilon * 2, back - front).normalize();
}

function paletteColor(x: number, z: number, y: number, normalY: number, seed: number): THREE.Color {
  const masks = sampleMonsoonMasks(x, z);
  // Key the ground to the authored Monsoon panoramas: wet blue-slate cliffs,
  // mossy highland greens, pale storm-washed stone, and warm compacted soil.
  // The tiled PBR detail map supplies the small scale breakup; vertex color
  // owns the large, readable terrain regions.
  const color = new THREE.Color(0x233832).lerp(
    new THREE.Color(0x46573f),
    smoothstep(24, 43, y),
  );
  // Route masks are intentionally broad for terrain shaping and ski flow;
  // expose soil gradually only near their centers so the surrounding shoulders
  // remain mossy like the green plateaus in the source panorama.
  color.lerp(new THREE.Color(0x493f34), smoothstep(0.5, 0.88, masks.route) * 0.76);
  color.lerp(new THREE.Color(0x304754), smoothstep(0.28, 0.8, masks.crater) * 0.74);
  const slopeRock = 1 - smoothstep(0.46, 0.73, normalY);
  const coastRock = smoothstep(0.7, 0.96, masks.coast) * 0.88;
  color.lerp(new THREE.Color(0x2c424f), Math.max(slopeRock, coastRock));
  const shoreSoil = 1 - smoothstep(MONSOON_DIVIDE.waterY + 0.5, MONSOON_DIVIDE.waterY + 3.4, y);
  color.lerp(new THREE.Color(0x484337), shoreSoil * 0.76);

  const variation = 0.84 + hash2(Math.round(x * 0.5), Math.round(z * 0.5), seed) * 0.18;
  color.multiplyScalar(variation);
  return color;
}

function hashHeights(heights: number[], seed: number): string {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (const height of heights) {
    const quantized = Math.round(height * 1000);
    hash ^= quantized & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (quantized >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildMonsoonTerrainGeometry(seed: number = MONSOON_DIVIDE.seed): MonsoonTerrainBuild {
  const { width, depth, segmentsX, segmentsZ } = MONSOON_DIVIDE;
  const stepX = width / segmentsX;
  const stepZ = depth / segmentsZ;
  const heights: number[] = [];
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;

  for (let iz = 0; iz <= segmentsZ; iz += 1) {
    const z = -depth * 0.5 + iz * stepZ;
    for (let ix = 0; ix <= segmentsX; ix += 1) {
      const x = -width * 0.5 + ix * stepX;
      const height = sampleMonsoonHeight(x, z, seed);
      heights.push(height);
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const surfaceNormals: THREE.Vector3[] = heights.map((_, index) => {
    const ix = index % (segmentsX + 1);
    const iz = Math.floor(index / (segmentsX + 1));
    const left = heights[iz * (segmentsX + 1) + Math.max(0, ix - 1)];
    const right = heights[iz * (segmentsX + 1) + Math.min(segmentsX, ix + 1)];
    const back = heights[Math.max(0, iz - 1) * (segmentsX + 1) + ix];
    const front = heights[Math.min(segmentsZ, iz + 1) * (segmentsX + 1) + ix];
    const spanX = ix === 0 || ix === segmentsX ? stepX : stepX * 2;
    const spanZ = iz === 0 || iz === segmentsZ ? stepZ : stepZ * 2;
    return new THREE.Vector3((left - right) / spanX, 1, (back - front) / spanZ).normalize();
  });
  const pushTriangle = (a: number, b: number, c: number): void => {
    const indices = [a, b, c];
    for (const index of indices) {
      const ix = index % (segmentsX + 1);
      const iz = Math.floor(index / (segmentsX + 1));
      const x = ix * stepX - width * 0.5;
      const z = iz * stepZ - depth * 0.5;
      const normal = surfaceNormals[index];
      const color = paletteColor(x, z, heights[index], normal.y, seed);
      positions.push(x, heights[index], z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(color.r, color.g, color.b);
      uvs.push(ix / segmentsX, iz / segmentsZ);
    }
  };

  for (let iz = 0; iz < segmentsZ; iz += 1) {
    for (let ix = 0; ix < segmentsX; ix += 1) {
      const a = iz * (segmentsX + 1) + ix;
      const b = a + 1;
      const d = (iz + 1) * (segmentsX + 1) + ix;
      const c = d + 1;
      if ((ix + iz) % 2 === 0) {
        pushTriangle(a, d, b);
        pushTriangle(b, d, c);
      } else {
        pushTriangle(a, d, c);
        pushTriangle(a, c, b);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    triangleCount: positions.length / 9,
    altitudeRange: { min: minimum, max: maximum },
    topologyHash: hashHeights(heights, seed),
  };
}

export function mapSeedFromLocation(search = typeof window === 'undefined' ? '' : window.location.search): number {
  const raw = new URLSearchParams(search).get('mapSeed');
  if (!raw) return MONSOON_DIVIDE.seed;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value >>> 0 : MONSOON_DIVIDE.seed;
}
