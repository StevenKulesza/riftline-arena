import * as THREE from 'three';

/** Authored layout lives in this design space; public sampling is world metres. */
export const MONSOON_WORLD_SCALE = 8;
const MONSOON_DESIGN_WIDTH = 480;
const MONSOON_DESIGN_DEPTH = 400;
const MONSOON_DESIGN_WATER_Y = -9.5;
const MONSOON_DESIGN_KILL_Y = -13.5;

export const MONSOON_DIVIDE = {
  id: 'monsoon-divide',
  name: 'Monsoon Divide',
  generationVersion: 13,
  seed: 0x4d4f4e53,
  width: MONSOON_DESIGN_WIDTH * MONSOON_WORLD_SCALE,
  depth: MONSOON_DESIGN_DEPTH * MONSOON_WORLD_SCALE,
  segmentsX: 240,
  segmentsZ: 200,
  waterY: MONSOON_DESIGN_WATER_Y * MONSOON_WORLD_SCALE,
  killY: MONSOON_DESIGN_KILL_Y * MONSOON_WORLD_SCALE,
} as const;

export function toMonsoonWorld(x: number, z: number): { x: number; z: number } {
  return { x: x * MONSOON_WORLD_SCALE, z: z * MONSOON_WORLD_SCALE };
}

function toMonsoonDesign(x: number, z: number): { x: number; z: number } {
  return { x: x / MONSOON_WORLD_SCALE, z: z / MONSOON_WORLD_SCALE };
}

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
    const signedSide = (abx * dz - abz * dx) / Math.sqrt(lengthSquared);
    const faceWidth = signedSide >= 0 ? 1.52 : 0.92;
    const normalizedDistance = Math.hypot(dx, dz) / (halfWidth * faceWidth);
    const foothill = (1 - smoothstep(1.28, 2.15, normalizedDistance)) * 0.24;
    const lowerBench = (1 - smoothstep(0.76, 1.34, normalizedDistance)) * 0.28;
    const upperBench = (1 - smoothstep(0.32, 0.84, normalizedDistance)) * 0.28;
    const crown = Math.exp(-Math.pow(normalizedDistance / 0.48, 2) * 0.5) * 0.2;
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

function orientedEllipseRadius(
  x: number,
  z: number,
  cx: number,
  cz: number,
  radiusX: number,
  radiusZ: number,
  angle: number,
): number {
  const dx = x - cx;
  const dz = z - cz;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const localX = dx * cosine + dz * sine;
  const localZ = -dx * sine + dz * cosine;
  return Math.hypot(localX / radiusX, localZ / radiusZ);
}

function islandRadius(x: number, z: number): number {
  // A union of offset geological lobes makes Monsoon a broken continent,
  // rather than a scaled-up circular arena. The two broad opposing shoulders
  // hold the CTF bases; the long central shelf keeps the ski network connected.
  const continentalRadius = Math.min(
    orientedEllipseRadius(x, z, 0, -5, 232, 178, -0.05),
    orientedEllipseRadius(x, z, -120, 55, 112, 125, -0.28),
    orientedEllipseRadius(x, z, 122, -45, 110, 130, -0.19),
    orientedEllipseRadius(x, z, -91, 128, 120, 68, 0.16),
    orientedEllipseRadius(x, z, 104, -126, 124, 68, -0.14),
    orientedEllipseRadius(x, z, 178, 86, 56, 72, 0.42),
    orientedEllipseRadius(x, z, -178, -111, 55, 77, -0.38),
    orientedEllipseRadius(x, z, 11, 164, 82, 29, 0.08),
    orientedEllipseRadius(x, z, -25, -165, 94, 30, -0.06),
  );
  const angle = Math.atan2(z + 6, x - 8);
  const shorelineVariation = 1
    + Math.sin(angle * 3 + 0.4) * 0.048
    + Math.cos(angle * 5 - 0.8) * 0.035
    + Math.sin(angle * 9 + 1.3) * 0.018;
  // Deep unequal bays oppose long headlands so the coastline has memorable
  // attack-side shapes without severing the land between the two bases.
  const baysAndHeadlands = (
    0.31 * gaussian(x, z, -22, 194, 54, 22)
    + 0.28 * gaussian(x, z, 213, -73, 24, 58)
    + 0.24 * gaussian(x, z, -226, -15, 22, 54)
    + 0.2 * gaussian(x, z, 38, -199, 69, 19)
    - 0.16 * gaussian(x, z, -118, 160, 55, 33)
    - 0.14 * gaussian(x, z, 128, -157, 58, 32)
    - 0.13 * gaussian(x, z, 224, 69, 33, 46)
    - 0.12 * gaussian(x, z, -214, -124, 39, 35)
  );
  return continentalRadius * shorelineVariation * (1 + baysAndHeadlands);
}

function sampleMonsoonMasksDesign(x: number, z: number): MonsoonTerrainMasks {
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
  // "Crater" remains the legacy gameplay/material mask name, but the actual
  // landform is now a broken diagonal rift rather than a circular bowl.
  const crater = clamp01(
    orientedGaussian(x, z, -32, 13, -0.46, 118, 37) * 0.78
    + orientedGaussian(x, z, 83, 30, -0.72, 72, 29) * 0.48,
  ) * island;
  const coast = smoothstep(0.77, 1.01, radius);
  return { island, route: route * island, crater, coast };
}

export function sampleMonsoonMasks(x: number, z: number): MonsoonTerrainMasks {
  const design = toMonsoonDesign(x, z);
  return sampleMonsoonMasksDesign(design.x, design.z);
}

function sampleMonsoonHeightDesign(
  x: number,
  z: number,
  seed: number = MONSOON_DIVIDE.seed,
): number {
  const radius = islandRadius(x, z);
  const masks = sampleMonsoonMasksDesign(x, z);
  const land = masks.island;

  let height = -19 + land * (39 - radius * 2.2);

  // Open, offset chains replace the old perimeter ring. Their long downhill
  // faces aim into the rift and the opposing CTF territories, producing real
  // ski lines while keeping the map silhouette legible from above.
  const northwestMassif: Ridgeline = [
    [-226, 62, 47, 42], [-191, 91, 75, 34], [-151, 122, 98, 28],
    [-107, 151, 61, 43], [-55, 164, 84, 29], [-18, 132, 38, 48],
  ];
  const southwestSpur: Ridgeline = [
    [-224, -130, 52, 38], [-179, -111, 81, 30], [-137, -76, 56, 42],
    [-104, -34, 73, 31], [-62, 4, 35, 48],
  ];
  const centralDivide: Ridgeline = [
    [-171, 58, 43, 48], [-126, 44, 68, 35], [-78, 28, 46, 49],
    [-29, 8, 78, 32], [21, -18, 51, 47], [71, -38, 83, 31],
    [123, -62, 53, 44], [171, -93, 91, 28], [218, -128, 57, 40],
  ];
  const northeastMassif: Ridgeline = [
    [36, 167, 43, 46], [82, 145, 72, 35], [126, 117, 96, 27],
    [171, 86, 63, 39], [215, 43, 82, 29],
  ];
  const southernRange: Ridgeline = [
    [-72, -172, 44, 43], [-24, -158, 69, 34], [29, -145, 48, 46],
    [76, -132, 78, 31], [123, -112, 54, 41], [174, -94, 73, 30],
  ];
  const westernRelief = Math.max(
    sampleRidgeline(x, z, northwestMassif),
    sampleRidgeline(x, z, southwestSpur),
  );
  const easternRelief = sampleRidgeline(x, z, northeastMassif);
  const southernRelief = sampleRidgeline(x, z, southernRange);
  const divideRelief = sampleRidgeline(x, z, centralDivide);
  const dominantRelief = Math.max(westernRelief, easternRelief, southernRelief, divideRelief);
  const connectedRelief = dominantRelief
    + Math.min(westernRelief, southernRelief) * 0.18
    + Math.min(easternRelief, southernRelief) * 0.18
    + Math.min(westernRelief + easternRelief, divideRelief) * 0.12;
  const rangeScale = 0.82 + clamp01(fbm(x * 0.009, z * 0.009, seed ^ 0x2c71a56d) * 0.5 + 0.5) * 0.34;
  const mountainRelief = terraceRelief(connectedRelief * rangeScale * 0.78, 8.8, 0.16);
  const routeMountainBlend = THREE.MathUtils.lerp(1, 0.43, clamp01(masks.route));
  height += land * routeMountainBlend * mountainRelief;

  // Offset escarpments sharpen only selected stretches of the skyline. Their
  // irregular spacing and unequal scale avoid the repeated peak cadence of the
  // previous six-ridge composition while preserving wide traversable shelves.
  const escarpments = (
    27 * orientedGaussian(x, z, -164, 113, -0.68, 57, 10)
    + 18 * orientedGaussian(x, z, -181, -101, 0.72, 64, 13)
    + 24 * orientedGaussian(x, z, -25, 7, -0.5, 69, 11)
    + 31 * orientedGaussian(x, z, 132, 111, 0.92, 49, 10)
    + 25 * orientedGaussian(x, z, 168, -91, -0.96, 66, 12)
    + 17 * orientedGaussian(x, z, 18, -154, 0.16, 78, 15)
  );
  height += land * THREE.MathUtils.lerp(1, 0.12, masks.route) * escarpments * 0.72;

  // Low-frequency ridged folds add depth to the mountain faces while leaving
  // the broad race lines calm enough for skiing and capsule contact.
  const mountainMask = smoothstep(7, 30, mountainRelief + escarpments);
  const ridgeNoise = 1 - Math.abs(fbm(x * 0.012, z * 0.012, seed ^ 0x43a1c92d));
  const alpineFold = Math.pow(clamp01(ridgeNoise), 3) * 7.1
    + fbm(x * 0.018, z * 0.018, seed ^ 0x71b94f2a) * 2.15;
  height += land * mountainMask * THREE.MathUtils.lerp(1, 0.18, masks.route) * alpineFold;

  // Broad negative landforms cut branching glacial valleys between the open
  // chains. No radial term is used here: the center is a long playable divide,
  // not the bottom of a circular crater.
  const macroRelief = (
    9.2 * orientedGaussian(x, z, -119, 84, -0.34, 91, 51)
    + 7.4 * orientedGaussian(x, z, 111, -79, -0.42, 88, 55)
    + 6.8 * orientedGaussian(x, z, 78, 126, 0.5, 73, 42)
    - 16.5 * orientedGaussian(x, z, -48, -56, -0.58, 112, 25)
    - 14.8 * orientedGaussian(x, z, 58, 69, -0.74, 105, 24)
    - 11.7 * orientedGaussian(x, z, -151, -2, 0.46, 58, 23)
    - 10.9 * orientedGaussian(x, z, 161, 10, 0.62, 61, 22)
    - 9.3 * orientedGaussian(x, z, 3, 137, 0.12, 67, 18)
  );
  const rollingRelief = (
    Math.sin(x * 0.018 + z * 0.006) * 3.2
    + Math.cos(z * 0.021 - x * 0.004) * 2.6
    + Math.sin((x + z) * 0.012) * 1.8
  );
  height += land * (1 - masks.route * 0.58) * (macroRelief + rollingRelief);

  height -= land * (
    12.5 * orientedGaussian(x, z, -24, 12, -0.48, 126, 35)
    + 6.2 * orientedGaussian(x, z, 91, 22, -0.7, 71, 24)
  );
  height -= land * 7.2 * masks.route;
  // Keep only discontinuous coastal benches; a complete contour would make
  // the playable continent read as another circular arena wall.
  const coastalShelf = Math.exp(-Math.pow((radius - 0.7) / 0.07, 2))
    * clamp01(
      orientedGaussian(x, z, -198, -18, -0.2, 58, 42)
      + orientedGaussian(x, z, 201, -62, 0.5, 51, 38)
      + orientedGaussian(x, z, 12, 184, 0.1, 69, 31),
    );
  height -= land * 2.4 * coastalShelf;

  const routeCalm = THREE.MathUtils.lerp(1, 0.18, clamp01(masks.route * 1.25));
  const craterCalm = THREE.MathUtils.lerp(1, 0.42, masks.crater);
  height += land * routeCalm * craterCalm * (
    fbm(x * 0.021, z * 0.021, seed) * 1.28
    + valueNoise(x * 0.075, z * 0.075, seed ^ 0x6ac690c5) * 0.34
  );

  // Two large, naturally shouldered base mesas establish unmistakable CTF
  // territories. The inner pads are calm enough for structures and spawns;
  // the outer blend preserves the surrounding skiable geology.
  for (const [baseX, baseZ, baseY, tiltX, tiltZ] of [
    [-85, 130, 42.5, 0.008, -0.006],
    [95, -120, 38.5, -0.007, 0.007],
  ] as const) {
    const plateauRadius = Math.hypot((x - baseX) / 60, (z - baseZ) / 51);
    const plateauBlend = 1 - smoothstep(0.46, 1.12, plateauRadius);
    const plateauHeight = baseY + (x - baseX) * tiltX + (z - baseZ) * tiltZ;
    height = THREE.MathUtils.lerp(height, plateauHeight, plateauBlend * 0.94 * land);
  }

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

export function sampleMonsoonHeight(
  x: number,
  z: number,
  seed: number = MONSOON_DIVIDE.seed,
): number {
  const design = toMonsoonDesign(x, z);
  return sampleMonsoonHeightDesign(design.x, design.z, seed) * MONSOON_WORLD_SCALE;
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

/**
 * Samples the exact upward normal of the same piecewise-linear terrain
 * triangle used by {@link sampleMonsoonMeshHeight}. Gameplay support and
 * rendered/projectile collision therefore agree even between grid vertices.
 */
export function sampleMonsoonMeshNormal(
  x: number,
  z: number,
  target = new THREE.Vector3(),
  seed: number = MONSOON_DIVIDE.seed,
): THREE.Vector3 {
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

  let slopeX: number;
  let slopeZ: number;
  if ((ix + iz) % 2 === 0) {
    if (tx + tz <= 1) {
      slopeX = (b - a) / stepX;
      slopeZ = (d - a) / stepZ;
    } else {
      slopeX = (c - d) / stepX;
      slopeZ = (c - b) / stepZ;
    }
  } else if (tz >= tx) {
    slopeX = (c - d) / stepX;
    slopeZ = (d - a) / stepZ;
  } else {
    slopeX = (b - a) / stepX;
    slopeZ = (c - b) / stepZ;
  }
  return target.set(-slopeX, 1, -slopeZ).normalize();
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
  const design = toMonsoonDesign(x, z);
  const designY = y / MONSOON_WORLD_SCALE;
  const masks = sampleMonsoonMasksDesign(design.x, design.z);
  // Key the ground to the authored Monsoon panoramas: wet blue-slate cliffs,
  // mossy highland greens, pale storm-washed stone, and warm compacted soil.
  // The tiled PBR detail map supplies the small scale breakup; vertex color
  // owns the large, readable terrain regions.
  const color = new THREE.Color(0x345149).lerp(
    new THREE.Color(0x71805f),
    smoothstep(24, 43, designY),
  );
  // Large-scale biome color is authored independently from the repeating PBR
  // grain. Deep, humid saddles carry blue-green jungle soil; broad combat
  // shelves stay warmer and drier so they read immediately as open plains.
  // The slope pass below still wins on steep/high ground, preserving exposed
  // mountain stone instead of tinting the whole island uniformly green.
  const jungleBasin = Math.max(
    gaussian(design.x, design.z, -132, 62, 58, 34),
    gaussian(design.x, design.z, -58, -108, 66, 34),
    gaussian(design.x, design.z, 90, 70, 60, 36),
    gaussian(design.x, design.z, 126, -60, 53, 37),
    gaussian(design.x, design.z, -164, -20, 42, 46),
  );
  const openPlain = Math.max(
    gaussian(design.x, design.z, -25, 91, 66, 31),
    gaussian(design.x, design.z, 55, -82, 68, 34),
    gaussian(design.x, design.z, 2, 8, 92, 55),
  );
  const flatGround = smoothstep(0.7, 0.94, normalY);
  const lowlandSurvival = 1 - smoothstep(46, 72, designY);
  const jungleStrength = jungleBasin * flatGround * lowlandSurvival * (1 - masks.route * 0.72);
  const plainStrength = openPlain * flatGround * (1 - jungleStrength * 0.88);
  color.lerp(new THREE.Color(0x27513b), jungleStrength * 0.72);
  color.lerp(new THREE.Color(0x71815b), plainStrength * 0.55);
  // Route masks are intentionally broad for terrain shaping and ski flow;
  // expose soil gradually only near their centers so the surrounding shoulders
  // remain mossy like the green plateaus in the source panorama.
  color.lerp(new THREE.Color(0x765b43), smoothstep(0.5, 0.88, masks.route) * 0.8);
  color.lerp(new THREE.Color(0x385d6c), smoothstep(0.28, 0.8, masks.crater) * 0.74);
  const slopeRock = 1 - smoothstep(0.46, 0.73, normalY);
  const alpineRock = smoothstep(48, 74, designY) * (1 - smoothstep(0.72, 0.94, normalY));
  const coastRock = smoothstep(0.7, 0.96, masks.coast) * 0.88;
  color.lerp(new THREE.Color(0x405766), Math.max(slopeRock, coastRock, alpineRock * 0.82));
  const shoreSoil = 1 - smoothstep(MONSOON_DESIGN_WATER_Y + 0.5, MONSOON_DESIGN_WATER_Y + 3.4, designY);
  color.lerp(new THREE.Color(0x685c49), shoreSoil * 0.76);

  const variation = 0.9 + hash2(Math.round(design.x * 0.5), Math.round(design.z * 0.5), seed) * 0.16;
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
