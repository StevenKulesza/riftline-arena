import * as THREE from 'three';

/** A lightweight point type so map data does not need to allocate Vector3s. */
export type FlowPoint3 = Readonly<{ x: number; y: number; z: number }>;

export type FlowPieceKind = 'launch-ramp' | 'banked-turn' | 'quarter-pipe' | 'hip';

export interface FlowMeshOptions {
  /** Number of low-poly strips in the direction of travel. */
  longitudinalSegments?: number;
  /** Number of strips across the surface. */
  lateralSegments?: number;
  /** Build a closed concrete-ready solid rather than only its riding surface. */
  solid?: boolean;
  /** Distance from the lowest riding surface to the underside of a solid. */
  skirtDepth?: number;
}

export interface OrientedFlowSpec extends FlowMeshOptions {
  /** Center of the low/entry edge. */
  origin: FlowPoint3;
  /** Direction of travel in radians: 0 points toward world +Z. */
  heading: number;
}

export interface LaunchRampSpec extends OrientedFlowSpec {
  length: number;
  width: number;
  rise: number;
  /** 1 is linear; 1.5-2.2 produces a useful progressive launch transition. */
  curveExponent?: number;
}

export interface QuarterPipeSpec extends OrientedFlowSpec {
  radius: number;
  width: number;
  /** Riding-surface arc in radians. Values below PI / 2 remain a height field. */
  angle: number;
}

export interface HipSpec extends OrientedFlowSpec {
  length: number;
  /** Width of the low entry edge. */
  width: number;
  /** Optional narrower or wider lip. Defaults to 80% of entry width. */
  lipWidth?: number;
  rise: number;
  curveExponent?: number;
  /** 0 is a flat cross-section; larger values form a soft center ridge. */
  ridgeStrength?: number;
  ridgeExponent?: number;
}

export interface BankedTurnSpec extends FlowMeshOptions {
  center: FlowPoint3;
  /** Polar angle in radians: 0 is world +Z and positive turns toward +X. */
  startAngle: number;
  /** Signed arc in radians. Positive and negative turns are both supported. */
  sweepAngle: number;
  centerRadius: number;
  width: number;
  /** Positive values raise the outside edge. */
  bankAngle: number;
  /** Optional vertical change from entry to exit. */
  rise?: number;
  /** Controls how quickly banking blends in/out at the ends. */
  bankBlendExponent?: number;
}

export interface FlowSurfaceSample {
  height: number;
  normal: THREE.Vector3;
  /** Normalized distance along the piece. */
  u: number;
  /** Normalized distance across the piece, inner/left 0 to outer/right 1. */
  v: number;
}

export interface TerrainRibbonSpec {
  start: Readonly<{ x: number; z: number }>;
  end: Readonly<{ x: number; z: number }>;
  startWidth: number;
  endWidth?: number;
  longitudinalSegments?: number;
  lateralSegments?: number;
  /** Samples the existing collision terrain; the ribbon remains a visual overlay. */
  heightAt: (x: number, z: number) => number;
  /** Small lift that prevents z-fighting without creating a gameplay step. */
  lift?: number;
}

/**
 * Render geometry and its matching analytic collision surface. Queries avoid
 * mesh raycasts, and normalAt can reuse a caller-owned Vector3 target.
 */
export interface FlowSurfaceBuild {
  kind: FlowPieceKind;
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  footprint: THREE.Box2;
  contains(x: number, z: number): boolean;
  heightAt(x: number, z: number): number | null;
  normalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3 | null;
  sample(x: number, z: number, targetNormal?: THREE.Vector3): FlowSurfaceSample | null;
}

type SurfaceCoordinates = {
  u: number;
  v: number;
  longitudinal: number;
  lateral: number;
};

type ParametricSurface = (u: number, v: number, target: THREE.Vector3) => THREE.Vector3;

const TAU = Math.PI * 2;
const EPSILON = 1e-6;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  return value;
}

function positive(name: string, value: number): number {
  finite(name, value);
  if (value <= 0) throw new Error(`${name} must be greater than zero.`);
  return value;
}

function integerInRange(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function segmentCounts(options: FlowMeshOptions): { longitudinal: number; lateral: number } {
  return {
    longitudinal: integerInRange('longitudinalSegments', options.longitudinalSegments ?? 10, 1, 128),
    lateral: integerInRange('lateralSegments', options.lateralSegments ?? 4, 1, 64),
  };
}

function orientedCoordinates(
  spec: OrientedFlowSpec,
  x: number,
  z: number,
): { longitudinal: number; lateral: number } {
  const dx = x - spec.origin.x;
  const dz = z - spec.origin.z;
  const sin = Math.sin(spec.heading);
  const cos = Math.cos(spec.heading);
  return {
    longitudinal: dx * sin + dz * cos,
    lateral: dx * cos - dz * sin,
  };
}

function orientedPosition(
  spec: OrientedFlowSpec,
  longitudinal: number,
  lateral: number,
  height: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const sin = Math.sin(spec.heading);
  const cos = Math.cos(spec.heading);
  return target.set(
    spec.origin.x + sin * longitudinal + cos * lateral,
    height,
    spec.origin.z + cos * longitudinal - sin * lateral,
  );
}

function orientedGraphNormal(
  heading: number,
  longitudinalDerivative: number,
  lateralDerivative: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  // tangentAlong x tangentAcross, with an explicitly upward Y component.
  return target.set(
    -sin * longitudinalDerivative - cos * lateralDerivative,
    1,
    -cos * longitudinalDerivative + sin * lateralDerivative,
  ).normalize();
}

function rampProfile(u: number, exponent: number): number {
  return Math.pow(clamp01(u), exponent);
}

function rampProfileDerivative(u: number, exponent: number): number {
  if (u <= 0 && exponent > 1) return 0;
  return exponent * Math.pow(clamp01(u), exponent - 1);
}

function validateOriented(spec: OrientedFlowSpec): void {
  finite('origin.x', spec.origin.x);
  finite('origin.y', spec.origin.y);
  finite('origin.z', spec.origin.z);
  finite('heading', spec.heading);
  if ((spec.skirtDepth ?? 0.8) < 0) throw new Error('skirtDepth cannot be negative.');
}

function launchCoordinates(spec: LaunchRampSpec, x: number, z: number): SurfaceCoordinates | null {
  const local = orientedCoordinates(spec, x, z);
  if (
    local.longitudinal < -EPSILON
    || local.longitudinal > spec.length + EPSILON
    || Math.abs(local.lateral) > spec.width * 0.5 + EPSILON
  ) return null;
  return {
    u: clamp01(local.longitudinal / spec.length),
    v: clamp01(local.lateral / spec.width + 0.5),
    ...local,
  };
}

export function sampleLaunchRampHeight(spec: LaunchRampSpec, x: number, z: number): number | null {
  const coordinates = launchCoordinates(spec, x, z);
  if (!coordinates) return null;
  return spec.origin.y + spec.rise * rampProfile(coordinates.u, spec.curveExponent ?? 1.8);
}

export function sampleLaunchRampNormal(
  spec: LaunchRampSpec,
  x: number,
  z: number,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  const coordinates = launchCoordinates(spec, x, z);
  if (!coordinates) return null;
  const exponent = spec.curveExponent ?? 1.8;
  const derivative = spec.rise / spec.length * rampProfileDerivative(coordinates.u, exponent);
  return orientedGraphNormal(spec.heading, derivative, 0, target);
}

function validateLaunch(spec: LaunchRampSpec): void {
  validateOriented(spec);
  positive('length', spec.length);
  positive('width', spec.width);
  finite('rise', spec.rise);
  const exponent = spec.curveExponent ?? 1.8;
  if (exponent < 1 || exponent > 4) throw new Error('curveExponent must be from 1 to 4.');
  segmentCounts(spec);
}

function quarterPipeRun(spec: QuarterPipeSpec): number {
  return spec.radius * Math.sin(spec.angle);
}

function quarterPipeCoordinates(
  spec: QuarterPipeSpec,
  x: number,
  z: number,
): SurfaceCoordinates | null {
  const local = orientedCoordinates(spec, x, z);
  const run = quarterPipeRun(spec);
  if (
    local.longitudinal < -EPSILON
    || local.longitudinal > run + EPSILON
    || Math.abs(local.lateral) > spec.width * 0.5 + EPSILON
  ) return null;
  const theta = Math.asin(clamp01(local.longitudinal / spec.radius));
  return {
    u: clamp01(theta / spec.angle),
    v: clamp01(local.lateral / spec.width + 0.5),
    ...local,
  };
}

export function sampleQuarterPipeHeight(spec: QuarterPipeSpec, x: number, z: number): number | null {
  const coordinates = quarterPipeCoordinates(spec, x, z);
  if (!coordinates) return null;
  const ratio = clamp01(coordinates.longitudinal / spec.radius);
  return spec.origin.y + spec.radius * (1 - Math.sqrt(Math.max(EPSILON, 1 - ratio * ratio)));
}

export function sampleQuarterPipeNormal(
  spec: QuarterPipeSpec,
  x: number,
  z: number,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  const coordinates = quarterPipeCoordinates(spec, x, z);
  if (!coordinates) return null;
  const ratio = clamp01(coordinates.longitudinal / spec.radius);
  const derivative = ratio / Math.sqrt(Math.max(EPSILON, 1 - ratio * ratio));
  return orientedGraphNormal(spec.heading, derivative, 0, target);
}

function validateQuarterPipe(spec: QuarterPipeSpec): void {
  validateOriented(spec);
  positive('radius', spec.radius);
  positive('width', spec.width);
  if (spec.angle <= 0 || spec.angle >= Math.PI * 0.49) {
    throw new Error('angle must be greater than zero and below 0.49 * PI for height-field collision.');
  }
  segmentCounts(spec);
}

function hipWidth(spec: HipSpec, u: number): number {
  return THREE.MathUtils.lerp(spec.width, spec.lipWidth ?? spec.width * 0.8, clamp01(u));
}

function hipCoordinates(spec: HipSpec, x: number, z: number): SurfaceCoordinates | null {
  const local = orientedCoordinates(spec, x, z);
  if (local.longitudinal < -EPSILON || local.longitudinal > spec.length + EPSILON) return null;
  const u = clamp01(local.longitudinal / spec.length);
  const width = hipWidth(spec, u);
  if (Math.abs(local.lateral) > width * 0.5 + EPSILON) return null;
  return {
    u,
    v: clamp01(local.lateral / width + 0.5),
    ...local,
  };
}

function hipHeightAndDerivatives(
  spec: HipSpec,
  coordinates: SurfaceCoordinates,
): { height: number; longitudinalDerivative: number; lateralDerivative: number } {
  const curveExponent = spec.curveExponent ?? 1.65;
  const ridgeStrength = spec.ridgeStrength ?? 0.18;
  const ridgeExponent = spec.ridgeExponent ?? 1.8;
  const width = hipWidth(spec, coordinates.u);
  const normalizedLateral = 2 * coordinates.lateral / width;
  const lateralMagnitude = Math.abs(normalizedLateral);
  const lateralSign = Math.sign(normalizedLateral);
  const ridge = Math.max(0, 1 - ridgeStrength * Math.pow(lateralMagnitude, ridgeExponent));
  const profile = rampProfile(coordinates.u, curveExponent);
  const profileDerivative = rampProfileDerivative(coordinates.u, curveExponent) / spec.length;

  const widthDerivative = ((spec.lipWidth ?? spec.width * 0.8) - spec.width) / spec.length;
  const normalizedLateralDerivative = -normalizedLateral * widthDerivative / width;
  const ridgeDerivativeAlong = -ridgeStrength
    * ridgeExponent
    * Math.pow(lateralMagnitude, ridgeExponent - 1)
    * lateralSign
    * normalizedLateralDerivative;
  const ridgeDerivativeAcross = -ridgeStrength
    * ridgeExponent
    * Math.pow(lateralMagnitude, ridgeExponent - 1)
    * lateralSign
    * 2 / width;

  return {
    height: spec.origin.y + spec.rise * profile * ridge,
    longitudinalDerivative: spec.rise * (profileDerivative * ridge + profile * ridgeDerivativeAlong),
    lateralDerivative: spec.rise * profile * ridgeDerivativeAcross,
  };
}

export function sampleHipHeight(spec: HipSpec, x: number, z: number): number | null {
  const coordinates = hipCoordinates(spec, x, z);
  return coordinates ? hipHeightAndDerivatives(spec, coordinates).height : null;
}

export function sampleHipNormal(
  spec: HipSpec,
  x: number,
  z: number,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  const coordinates = hipCoordinates(spec, x, z);
  if (!coordinates) return null;
  const sample = hipHeightAndDerivatives(spec, coordinates);
  return orientedGraphNormal(
    spec.heading,
    sample.longitudinalDerivative,
    sample.lateralDerivative,
    target,
  );
}

function validateHip(spec: HipSpec): void {
  validateOriented(spec);
  positive('length', spec.length);
  positive('width', spec.width);
  positive('lipWidth', spec.lipWidth ?? spec.width * 0.8);
  finite('rise', spec.rise);
  const curveExponent = spec.curveExponent ?? 1.65;
  if (curveExponent < 1 || curveExponent > 4) throw new Error('curveExponent must be from 1 to 4.');
  const ridgeStrength = spec.ridgeStrength ?? 0.18;
  if (ridgeStrength < 0 || ridgeStrength >= 1) throw new Error('ridgeStrength must be from 0 up to 1.');
  const ridgeExponent = spec.ridgeExponent ?? 1.8;
  if (ridgeExponent < 1 || ridgeExponent > 6) throw new Error('ridgeExponent must be from 1 to 6.');
  segmentCounts(spec);
}

function bankedTurnCoordinates(
  spec: BankedTurnSpec,
  x: number,
  z: number,
): SurfaceCoordinates | null {
  const dx = x - spec.center.x;
  const dz = z - spec.center.z;
  const radialDistance = Math.hypot(dx, dz);
  const lateral = radialDistance - spec.centerRadius;
  if (Math.abs(lateral) > spec.width * 0.5 + EPSILON) return null;

  const angle = Math.atan2(dx, dz);
  const directedAngle = spec.sweepAngle > 0
    ? positiveModulo(angle - spec.startAngle, TAU)
    : -positiveModulo(spec.startAngle - angle, TAU);
  const u = directedAngle / spec.sweepAngle;
  if (u < -EPSILON || u > 1 + EPSILON) return null;
  return {
    u: clamp01(u),
    v: clamp01(lateral / spec.width + 0.5),
    longitudinal: directedAngle * spec.centerRadius,
    lateral,
  };
}

function bankEnvelope(u: number, exponent: number): number {
  return Math.pow(Math.max(0, Math.sin(Math.PI * clamp01(u))), exponent);
}

function bankEnvelopeDerivative(u: number, exponent: number): number {
  const sine = Math.max(0, Math.sin(Math.PI * clamp01(u)));
  if (sine <= EPSILON && exponent > 1) return 0;
  return exponent * Math.pow(sine, exponent - 1) * Math.cos(Math.PI * clamp01(u)) * Math.PI;
}

function bankedHeight(spec: BankedTurnSpec, coordinates: SurfaceCoordinates): number {
  const blendExponent = spec.bankBlendExponent ?? 1.5;
  return spec.center.y
    + (spec.rise ?? 0) * coordinates.u
    + Math.tan(spec.bankAngle) * coordinates.lateral * bankEnvelope(coordinates.u, blendExponent);
}

export function sampleBankedTurnHeight(spec: BankedTurnSpec, x: number, z: number): number | null {
  const coordinates = bankedTurnCoordinates(spec, x, z);
  return coordinates ? bankedHeight(spec, coordinates) : null;
}

export function sampleBankedTurnNormal(
  spec: BankedTurnSpec,
  x: number,
  z: number,
  target = new THREE.Vector3(),
): THREE.Vector3 | null {
  const coordinates = bankedTurnCoordinates(spec, x, z);
  if (!coordinates) return null;
  const theta = spec.startAngle + spec.sweepAngle * coordinates.u;
  const radius = spec.centerRadius + coordinates.lateral;
  const blendExponent = spec.bankBlendExponent ?? 1.5;
  const tangentBank = Math.tan(spec.bankAngle);
  const heightAlongU = (spec.rise ?? 0)
    + tangentBank * coordinates.lateral * bankEnvelopeDerivative(coordinates.u, blendExponent);
  const heightAcross = tangentBank * bankEnvelope(coordinates.u, blendExponent);

  const alongX = Math.cos(theta) * radius * spec.sweepAngle;
  const alongZ = -Math.sin(theta) * radius * spec.sweepAngle;
  const acrossX = Math.sin(theta);
  const acrossZ = Math.cos(theta);
  target.set(
    heightAlongU * acrossZ - alongZ * heightAcross,
    alongZ * acrossX - alongX * acrossZ,
    alongX * heightAcross - heightAlongU * acrossX,
  );
  if (target.y < 0) target.negate();
  return target.normalize();
}

function validateBankedTurn(spec: BankedTurnSpec): void {
  finite('center.x', spec.center.x);
  finite('center.y', spec.center.y);
  finite('center.z', spec.center.z);
  finite('startAngle', spec.startAngle);
  if (Math.abs(spec.sweepAngle) <= EPSILON || Math.abs(spec.sweepAngle) >= TAU - EPSILON) {
    throw new Error('sweepAngle must be non-zero and shorter than a full turn.');
  }
  positive('centerRadius', spec.centerRadius);
  positive('width', spec.width);
  if (spec.width >= spec.centerRadius * 2) throw new Error('width must be less than the turn diameter.');
  finite('bankAngle', spec.bankAngle);
  if (Math.abs(spec.bankAngle) >= Math.PI * 0.42) {
    throw new Error('bankAngle must remain below 0.42 * PI for height-field collision.');
  }
  finite('rise', spec.rise ?? 0);
  const blendExponent = spec.bankBlendExponent ?? 1.5;
  if (blendExponent < 1 || blendExponent > 6) {
    throw new Error('bankBlendExponent must be from 1 to 6.');
  }
  if ((spec.skirtDepth ?? 0.8) < 0) throw new Error('skirtDepth cannot be negative.');
  segmentCounts(spec);
}

type GeometryArrays = { positions: number[]; normals: number[]; uvs: number[] };

function appendTriangle(
  arrays: GeometryArrays,
  a: THREE.Vector3,
  uvA: THREE.Vector2,
  b: THREE.Vector3,
  uvB: THREE.Vector2,
  c: THREE.Vector3,
  uvC: THREE.Vector2,
  verticalDirection: -1 | 0 | 1,
): void {
  const edgeA = new THREE.Vector3().subVectors(b, a);
  const edgeB = new THREE.Vector3().subVectors(c, a);
  const normal = edgeA.cross(edgeB).normalize();
  const shouldFlip = verticalDirection !== 0 && normal.y * verticalDirection < 0;
  const second = shouldFlip ? c : b;
  const third = shouldFlip ? b : c;
  const secondUv = shouldFlip ? uvC : uvB;
  const thirdUv = shouldFlip ? uvB : uvC;
  if (shouldFlip) normal.negate();
  for (const vertex of [a, second, third]) {
    arrays.positions.push(vertex.x, vertex.y, vertex.z);
    arrays.normals.push(normal.x, normal.y, normal.z);
  }
  arrays.uvs.push(uvA.x, uvA.y, secondUv.x, secondUv.y, thirdUv.x, thirdUv.y);
}

function buildParametricGeometry(
  surface: ParametricSurface,
  options: FlowMeshOptions,
): THREE.BufferGeometry {
  const segments = segmentCounts(options);
  const grid: THREE.Vector3[][] = [];
  let minimumY = Number.POSITIVE_INFINITY;
  for (let iu = 0; iu <= segments.longitudinal; iu += 1) {
    const row: THREE.Vector3[] = [];
    for (let iv = 0; iv <= segments.lateral; iv += 1) {
      const point = surface(iu / segments.longitudinal, iv / segments.lateral, new THREE.Vector3());
      minimumY = Math.min(minimumY, point.y);
      row.push(point);
    }
    grid.push(row);
  }

  const arrays: GeometryArrays = { positions: [], normals: [], uvs: [] };
  for (let iu = 0; iu < segments.longitudinal; iu += 1) {
    for (let iv = 0; iv < segments.lateral; iv += 1) {
      const u0 = iu / segments.longitudinal;
      const u1 = (iu + 1) / segments.longitudinal;
      const v0 = iv / segments.lateral;
      const v1 = (iv + 1) / segments.lateral;
      const a = grid[iu][iv];
      const b = grid[iu + 1][iv];
      const c = grid[iu][iv + 1];
      const d = grid[iu + 1][iv + 1];
      appendTriangle(arrays, a, new THREE.Vector2(u0, v0), b, new THREE.Vector2(u1, v0), d, new THREE.Vector2(u1, v1), 1);
      appendTriangle(arrays, a, new THREE.Vector2(u0, v0), d, new THREE.Vector2(u1, v1), c, new THREE.Vector2(u0, v1), 1);
    }
  }

  if (options.solid ?? true) {
    const bottomY = minimumY - (options.skirtDepth ?? 0.8);
    for (let iu = 0; iu < segments.longitudinal; iu += 1) {
      for (let iv = 0; iv < segments.lateral; iv += 1) {
        const u0 = iu / segments.longitudinal;
        const u1 = (iu + 1) / segments.longitudinal;
        const v0 = iv / segments.lateral;
        const v1 = (iv + 1) / segments.lateral;
        const a = grid[iu][iv].clone(); a.y = bottomY;
        const b = grid[iu + 1][iv].clone(); b.y = bottomY;
        const c = grid[iu][iv + 1].clone(); c.y = bottomY;
        const d = grid[iu + 1][iv + 1].clone(); d.y = bottomY;
        appendTriangle(arrays, a, new THREE.Vector2(u0, v0), d, new THREE.Vector2(u1, v1), b, new THREE.Vector2(u1, v0), -1);
        appendTriangle(arrays, a, new THREE.Vector2(u0, v0), c, new THREE.Vector2(u0, v1), d, new THREE.Vector2(u1, v1), -1);
      }
    }

    const perimeter: THREE.Vector3[] = [];
    for (let iv = 0; iv <= segments.lateral; iv += 1) perimeter.push(grid[0][iv]);
    for (let iu = 1; iu <= segments.longitudinal; iu += 1) perimeter.push(grid[iu][segments.lateral]);
    for (let iv = segments.lateral - 1; iv >= 0; iv -= 1) perimeter.push(grid[segments.longitudinal][iv]);
    for (let iu = segments.longitudinal - 1; iu > 0; iu -= 1) perimeter.push(grid[iu][0]);

    let signedArea = 0;
    for (let index = 0; index < perimeter.length; index += 1) {
      const current = perimeter[index];
      const next = perimeter[(index + 1) % perimeter.length];
      signedArea += current.x * next.z - next.x * current.z;
    }
    if (signedArea < 0) perimeter.reverse();

    for (let index = 0; index < perimeter.length; index += 1) {
      const nextIndex = (index + 1) % perimeter.length;
      const topA = perimeter[index];
      const topB = perimeter[nextIndex];
      const bottomA = topA.clone(); bottomA.y = bottomY;
      const bottomB = topB.clone(); bottomB.y = bottomY;
      const u0 = index / perimeter.length;
      const u1 = (index + 1) / perimeter.length;
      appendTriangle(arrays, topA, new THREE.Vector2(u0, 1), topB, new THREE.Vector2(u1, 1), bottomB, new THREE.Vector2(u1, 0), 0);
      appendTriangle(arrays, topA, new THREE.Vector2(u0, 1), bottomB, new THREE.Vector2(u1, 0), bottomA, new THREE.Vector2(u0, 0), 0);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function footprintFromGeometry(geometry: THREE.BufferGeometry): THREE.Box2 {
  const position = geometry.getAttribute('position');
  const footprint = new THREE.Box2();
  for (let index = 0; index < position.count; index += 1) {
    footprint.expandByPoint(new THREE.Vector2(position.getX(index), position.getZ(index)));
  }
  return footprint;
}

/**
 * Builds a smooth, terrain-conforming route apron. It deliberately does not
 * replace terrain collision: keeping it within a few centimetres of the
 * heightfield makes the visual/collision contract exact enough for skiing.
 */
export function buildTerrainRibbonGeometry(spec: TerrainRibbonSpec): THREE.BufferGeometry {
  positive('startWidth', spec.startWidth);
  positive('endWidth', spec.endWidth ?? spec.startWidth);
  const longitudinalSegments = integerInRange(
    'longitudinalSegments',
    spec.longitudinalSegments ?? 10,
    1,
    128,
  );
  const lateralSegments = integerInRange('lateralSegments', spec.lateralSegments ?? 4, 1, 64);
  const dx = spec.end.x - spec.start.x;
  const dz = spec.end.z - spec.start.z;
  const length = Math.hypot(dx, dz);
  positive('ribbon length', length);
  const forwardX = dx / length;
  const forwardZ = dz / length;
  const crossX = forwardZ;
  const crossZ = -forwardX;
  const endWidth = spec.endWidth ?? spec.startWidth;
  const lift = spec.lift ?? 0.035;
  finite('lift', lift);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let iu = 0; iu <= longitudinalSegments; iu += 1) {
    const u = iu / longitudinalSegments;
    const width = THREE.MathUtils.lerp(spec.startWidth, endWidth, u);
    const centerX = THREE.MathUtils.lerp(spec.start.x, spec.end.x, u);
    const centerZ = THREE.MathUtils.lerp(spec.start.z, spec.end.z, u);
    for (let iv = 0; iv <= lateralSegments; iv += 1) {
      const v = iv / lateralSegments;
      const lateral = (v - 0.5) * width;
      const x = centerX + crossX * lateral;
      const z = centerZ + crossZ * lateral;
      positions.push(x, spec.heightAt(x, z) + lift, z);
      uvs.push(u * Math.max(1, length / 6), v * 2);
    }
  }
  const row = lateralSegments + 1;
  for (let iu = 0; iu < longitudinalSegments; iu += 1) {
    for (let iv = 0; iv < lateralSegments; iv += 1) {
      const a = iu * row + iv;
      const b = (iu + 1) * row + iv;
      const c = iu * row + iv + 1;
      const d = (iu + 1) * row + iv + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeBuild(
  kind: FlowPieceKind,
  geometry: THREE.BufferGeometry,
  coordinatesAt: (x: number, z: number) => SurfaceCoordinates | null,
  heightAt: (x: number, z: number) => number | null,
  normalAt: (x: number, z: number, target?: THREE.Vector3) => THREE.Vector3 | null,
): FlowSurfaceBuild {
  return {
    kind,
    geometry,
    triangleCount: geometry.getAttribute('position').count / 3,
    footprint: footprintFromGeometry(geometry),
    contains: (x, z) => coordinatesAt(x, z) !== null,
    heightAt,
    normalAt,
    sample: (x, z, targetNormal = new THREE.Vector3()) => {
      const coordinates = coordinatesAt(x, z);
      if (!coordinates) return null;
      const height = heightAt(x, z);
      const normal = normalAt(x, z, targetNormal);
      if (height === null || !normal) return null;
      return { height, normal, u: coordinates.u, v: coordinates.v };
    },
  };
}

export function buildLaunchRamp(spec: LaunchRampSpec): FlowSurfaceBuild {
  validateLaunch(spec);
  const exponent = spec.curveExponent ?? 1.8;
  const geometry = buildParametricGeometry((u, v, target) => orientedPosition(
    spec,
    spec.length * u,
    spec.width * (v - 0.5),
    spec.origin.y + spec.rise * rampProfile(u, exponent),
    target,
  ), spec);
  return makeBuild(
    'launch-ramp',
    geometry,
    (x, z) => launchCoordinates(spec, x, z),
    (x, z) => sampleLaunchRampHeight(spec, x, z),
    (x, z, target) => sampleLaunchRampNormal(spec, x, z, target),
  );
}

export function buildQuarterPipe(spec: QuarterPipeSpec): FlowSurfaceBuild {
  validateQuarterPipe(spec);
  const geometry = buildParametricGeometry((u, v, target) => {
    const theta = spec.angle * u;
    return orientedPosition(
      spec,
      spec.radius * Math.sin(theta),
      spec.width * (v - 0.5),
      spec.origin.y + spec.radius * (1 - Math.cos(theta)),
      target,
    );
  }, spec);
  return makeBuild(
    'quarter-pipe',
    geometry,
    (x, z) => quarterPipeCoordinates(spec, x, z),
    (x, z) => sampleQuarterPipeHeight(spec, x, z),
    (x, z, target) => sampleQuarterPipeNormal(spec, x, z, target),
  );
}

export function buildHip(spec: HipSpec): FlowSurfaceBuild {
  validateHip(spec);
  const geometry = buildParametricGeometry((u, v, target) => {
    const width = hipWidth(spec, u);
    const lateral = width * (v - 0.5);
    const coordinates: SurfaceCoordinates = { u, v, longitudinal: spec.length * u, lateral };
    return orientedPosition(
      spec,
      coordinates.longitudinal,
      lateral,
      hipHeightAndDerivatives(spec, coordinates).height,
      target,
    );
  }, spec);
  return makeBuild(
    'hip',
    geometry,
    (x, z) => hipCoordinates(spec, x, z),
    (x, z) => sampleHipHeight(spec, x, z),
    (x, z, target) => sampleHipNormal(spec, x, z, target),
  );
}

export function buildBankedTurn(spec: BankedTurnSpec): FlowSurfaceBuild {
  validateBankedTurn(spec);
  const geometry = buildParametricGeometry((u, v, target) => {
    const theta = spec.startAngle + spec.sweepAngle * u;
    const lateral = spec.width * (v - 0.5);
    const coordinates: SurfaceCoordinates = {
      u,
      v,
      longitudinal: spec.centerRadius * spec.sweepAngle * u,
      lateral,
    };
    const radius = spec.centerRadius + lateral;
    return target.set(
      spec.center.x + Math.sin(theta) * radius,
      bankedHeight(spec, coordinates),
      spec.center.z + Math.cos(theta) * radius,
    );
  }, spec);
  return makeBuild(
    'banked-turn',
    geometry,
    (x, z) => bankedTurnCoordinates(spec, x, z),
    (x, z) => sampleBankedTurnHeight(spec, x, z),
    (x, z, target) => sampleBankedTurnNormal(spec, x, z, target),
  );
}
