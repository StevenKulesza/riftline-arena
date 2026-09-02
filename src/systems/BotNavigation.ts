import * as THREE from 'three';
import type { ArenaRuntime } from '../game/Arena';
import { MOVEMENT } from '../game/config';

/**
 * Layered 2 m navigation grid with Warfork-style typed links and an
 * allocation-free A* used by the arena bots.
 *
 * Every X/Z column stores up to `maxLayers` floor surfaces (top surface first),
 * so multi-storey structures produce separate nodes per storey. Links are
 * classified on the fly from cell heights and surface slope so no adjacency
 * table is stored: WALK (step or continuous slope), JUMP (up to one jump of
 * height, up to two cells of gap), FALL (down to 6 m, cost x3) and PAD (jump
 * pad ballistic launch to its landing cell, cost x1).
 */

export const NAV_LINK_WALK = 0;
export const NAV_LINK_JUMP = 1;
export const NAV_LINK_FALL = 2;
export const NAV_LINK_PAD = 3;
export type NavLinkKind = typeof NAV_LINK_WALK | typeof NAV_LINK_JUMP | typeof NAV_LINK_FALL | typeof NAV_LINK_PAD;

export type NavLinkName = 'walk' | 'jump' | 'fall' | 'pad';

export function navLinkName(kind: NavLinkKind): NavLinkName {
  switch (kind) {
    case NAV_LINK_WALK: return 'walk';
    case NAV_LINK_JUMP: return 'jump';
    case NAV_LINK_FALL: return 'fall';
    case NAV_LINK_PAD: return 'pad';
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown nav link kind ${String(exhaustive)}`);
    }
  }
}

export type BotNavigationDiagnostics = {
  buildMs: number;
  cellSize: number;
  cols: number;
  rows: number;
  layers: number;
  totalColumns: number;
  sampledColumns: number;
  walkableCells: number;
  padLinks: number;
  pathsPlanned: number;
  pathFailures: number;
  lastPathMs: number;
  eagerBuildComplete: boolean;
};

export type BotNavigationOptions = {
  cellSize?: number;
  maxLayers?: number;
  capsuleRadius?: number;
  capsuleHeight?: number;
  /** Eager sampling stops after this many milliseconds; the rest samples lazily. */
  buildBudgetMs?: number;
  maxExpansions?: number;
};

const FLAG_WALKABLE = 1;
const JUMP_LINK_COST = 2.5;
const FALL_LINK_COST = 3;
const PAD_LINK_COST = 1;
const MAX_FALL_HEIGHT = 6;
const DEFAULT_MAX_EXPANSIONS = 9000;
const SAMPLE_FROM_Y = 400;
const HEAP_CAPACITY = 1 << 16;
const NEAREST_SEARCH_RADIUS = 6;
const PATH_CAPACITY = 256;

// Ring-one neighbours (8) followed by ring-two neighbours (8) used for JUMP links.
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 0], [-2, 0], [0, 2], [0, -2],
  [2, 2], [2, -2], [-2, 2], [-2, -2],
];
const RING_ONE_COUNT = 8;

/** Fixed-capacity path buffer reused by each bot between plans. */
export class NavPath {
  readonly points = new Float32Array(PATH_CAPACITY * 3);
  readonly kinds = new Uint8Array(PATH_CAPACITY);
  readonly nodes = new Int32Array(PATH_CAPACITY);
  readonly goal = new THREE.Vector3();
  length = 0;
  cursor = 0;
  plannedAt = Number.NEGATIVE_INFINITY;
  valid = false;
  totalCost = 0;

  clear(): void {
    this.length = 0;
    this.cursor = 0;
    this.valid = false;
    this.totalCost = 0;
  }

  point(index: number, out: THREE.Vector3): THREE.Vector3 {
    const offset = index * 3;
    return out.set(this.points[offset], this.points[offset + 1], this.points[offset + 2]);
  }

  kind(index: number): NavLinkKind {
    return this.kinds[index] as NavLinkKind;
  }
}

export class BotNavigationGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly layers: number;
  readonly columnCount: number;
  readonly nodeCount: number;
  buildMs = 0;
  sampledColumns = 0;
  walkableCells = 0;
  pathsPlanned = 0;
  pathFailures = 0;
  lastPathMs = 0;
  eagerBuildComplete = false;

  private readonly originX: number;
  private readonly originZ: number;
  private readonly capsuleRadius: number;
  private readonly capsuleHeight: number;
  private readonly buildBudgetMs: number;
  private readonly maxExpansions: number;
  private readonly heights: Float32Array;
  private readonly slopeTangent: Float32Array;
  private readonly flags: Uint8Array;
  private readonly columnSampled: Uint8Array;
  private readonly padLinkFrom: Int32Array;
  private readonly padLinkTo: Int32Array;
  private readonly padLinkOfNode: Int32Array;
  private padLinkCount = 0;
  private padLinksBuilt = false;

  // A* working memory (stamped so it never has to be cleared between searches).
  private readonly gScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly cameKind: Uint8Array;
  private readonly openStamp: Int32Array;
  private readonly closedStamp: Int32Array;
  private readonly heapKeys = new Float32Array(HEAP_CAPACITY);
  private readonly heapNodes = new Int32Array(HEAP_CAPACITY);
  private heapSize = 0;
  private searchStamp = 0;

  private readonly maxWalkRise = MOVEMENT.stepHeight + 0.05;
  private readonly maxJumpRise = (MOVEMENT.jumpImpulse * MOVEMENT.jumpImpulse) / (2 * MOVEMENT.gravity) - 0.2;

  private readonly scratchPoint = new THREE.Vector3();
  private readonly scratchCapsule = new THREE.Vector3();
  private readonly scratchVelocity = new THREE.Vector3();
  private readonly scratchNormalFallback = new THREE.Vector3(0, 1, 0);
  private readonly scratchLaunch = new THREE.Vector3();
  private readonly scratchLaunchVelocity = new THREE.Vector3();

  constructor(private readonly arena: ArenaRuntime, options: BotNavigationOptions = {}) {
    this.cellSize = options.cellSize ?? 2;
    this.layers = options.maxLayers ?? 3;
    this.capsuleRadius = options.capsuleRadius ?? 0.43;
    this.capsuleHeight = options.capsuleHeight ?? 1.82;
    this.buildBudgetMs = options.buildBudgetMs ?? 240;
    this.maxExpansions = options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS;
    const { width, depth } = arena.mapInfo.bounds;
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(depth / this.cellSize));
    this.originX = -this.cols * this.cellSize * 0.5;
    this.originZ = -this.rows * this.cellSize * 0.5;
    this.columnCount = this.cols * this.rows;
    this.nodeCount = this.columnCount * this.layers;
    this.heights = new Float32Array(this.nodeCount).fill(Number.NaN);
    this.slopeTangent = new Float32Array(this.nodeCount);
    this.flags = new Uint8Array(this.nodeCount);
    this.columnSampled = new Uint8Array(this.columnCount);
    this.gScore = new Float32Array(this.nodeCount);
    this.cameFrom = new Int32Array(this.nodeCount);
    this.cameKind = new Uint8Array(this.nodeCount);
    this.openStamp = new Int32Array(this.nodeCount);
    this.closedStamp = new Int32Array(this.nodeCount);
    const padCapacity = Math.max(1, arena.jumpPads.length);
    this.padLinkFrom = new Int32Array(padCapacity);
    this.padLinkTo = new Int32Array(padCapacity);
    this.padLinkOfNode = new Int32Array(this.nodeCount).fill(-1);
  }

  /**
   * Sample as much of the grid as the time budget allows. Columns that were
   * not reached are sampled lazily the first time a search touches them, so
   * the grid is always complete from the caller's point of view.
   */
  build(): void {
    const started = performance.now();
    let column = 0;
    for (; column < this.columnCount; column += 1) {
      if ((column & 255) === 0 && performance.now() - started > this.buildBudgetMs) break;
      this.ensureColumn(column);
    }
    this.eagerBuildComplete = column >= this.columnCount;
    this.buildPadLinks();
    this.buildMs = performance.now() - started;
  }

  diagnostics(): BotNavigationDiagnostics {
    return {
      buildMs: this.buildMs,
      cellSize: this.cellSize,
      cols: this.cols,
      rows: this.rows,
      layers: this.layers,
      totalColumns: this.columnCount,
      sampledColumns: this.sampledColumns,
      walkableCells: this.walkableCells,
      padLinks: this.padLinkCount,
      pathsPlanned: this.pathsPlanned,
      pathFailures: this.pathFailures,
      lastPathMs: this.lastPathMs,
      eagerBuildComplete: this.eagerBuildComplete,
    };
  }

  get padLinks(): number {
    return this.padLinkCount;
  }

  nodeCenter(node: number, out: THREE.Vector3): THREE.Vector3 {
    const column = node % this.columnCount;
    const col = column % this.cols;
    const row = Math.floor(column / this.cols);
    return out.set(
      this.originX + (col + 0.5) * this.cellSize,
      this.heights[node],
      this.originZ + (row + 0.5) * this.cellSize,
    );
  }

  isWalkableNode(node: number): boolean {
    return node >= 0 && node < this.nodeCount && (this.flags[node] & FLAG_WALKABLE) !== 0;
  }

  nodeHeight(node: number): number {
    return this.heights[node];
  }

  /**
   * Walkable node covering `point`, preferring the layer whose floor is at or
   * just below the point. Returns -1 when the column has no walkable layer.
   */
  nodeAt(point: THREE.Vector3): number {
    const column = this.columnAt(point.x, point.z);
    if (column < 0) return -1;
    this.ensureColumn(column);
    return this.bestLayerNode(column, point.y);
  }

  /** Whether a point is on (or within step height of) a walkable cell. */
  isWalkablePoint(point: THREE.Vector3, tolerance = 1.6): boolean {
    const node = this.nodeAt(point);
    if (node < 0) return false;
    return Math.abs(this.heights[node] - point.y) <= tolerance;
  }

  /** Nearest walkable node by 3D distance within a small search radius. */
  nearestWalkableNode(point: THREE.Vector3): number {
    const direct = this.nodeAt(point);
    if (direct >= 0 && Math.abs(this.heights[direct] - point.y) <= 2.5) return direct;
    const col = Math.floor((point.x - this.originX) / this.cellSize);
    const row = Math.floor((point.z - this.originZ) / this.cellSize);
    let best = -1;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    for (let radius = 0; radius <= NEAREST_SEARCH_RADIUS; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const c = col + dx;
          const r = row + dz;
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
          const column = r * this.cols + c;
          this.ensureColumn(column);
          for (let layer = 0; layer < this.layers; layer += 1) {
            const node = layer * this.columnCount + column;
            if ((this.flags[node] & FLAG_WALKABLE) === 0) continue;
            const x = this.originX + (c + 0.5) * this.cellSize - point.x;
            const y = this.heights[node] - point.y;
            const z = this.originZ + (r + 0.5) * this.cellSize - point.z;
            const distanceSq = x * x + y * y * 1.5 + z * z;
            if (distanceSq < bestDistanceSq) {
              bestDistanceSq = distanceSq;
              best = node;
            }
          }
        }
      }
      if (best >= 0 && radius >= 1) break;
    }
    return best;
  }

  nearestWalkable(point: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 | null {
    const node = this.nearestWalkableNode(point);
    if (node < 0) return null;
    return this.nodeCenter(node, out);
  }

  /** Allocating convenience wrapper used by tests and diagnostics. */
  findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
    const path = new NavPath();
    if (!this.planPath(from, to, path)) return null;
    const result: THREE.Vector3[] = [];
    for (let index = 0; index < path.length; index += 1) result.push(path.point(index, new THREE.Vector3()));
    return result;
  }

  /** Allocation-free A* into a reusable path buffer. */
  planPath(from: THREE.Vector3, to: THREE.Vector3, out: NavPath): boolean {
    const started = performance.now();
    out.clear();
    out.goal.copy(to);
    const startNode = this.nearestWalkableNode(from);
    const goalNode = this.nearestWalkableNode(to);
    this.pathsPlanned += 1;
    if (startNode < 0 || goalNode < 0) {
      this.pathFailures += 1;
      this.lastPathMs = performance.now() - started;
      return false;
    }
    const reached = this.search(startNode, goalNode, Number.POSITIVE_INFINITY);
    if (reached < 0) {
      this.pathFailures += 1;
      this.lastPathMs = performance.now() - started;
      return false;
    }
    // Walk the parent chain to count nodes, then fill the buffer in order.
    let length = 0;
    for (let node = reached; node >= 0; node = node === startNode ? -1 : this.cameFrom[node]) length += 1;
    const skipped = Math.max(0, length - PATH_CAPACITY);
    let write = Math.min(length, PATH_CAPACITY) - 1;
    let remaining = length;
    for (let node = reached; node >= 0; node = node === startNode ? -1 : this.cameFrom[node]) {
      remaining -= 1;
      if (remaining < skipped) break;
      const offset = write * 3;
      this.nodeCenter(node, this.scratchPoint);
      out.points[offset] = this.scratchPoint.x;
      out.points[offset + 1] = this.scratchPoint.y;
      out.points[offset + 2] = this.scratchPoint.z;
      out.nodes[write] = node;
      out.kinds[write] = node === startNode ? NAV_LINK_WALK : this.cameKind[node];
      write -= 1;
    }
    out.length = Math.min(length, PATH_CAPACITY);
    out.cursor = out.length > 1 ? 1 : 0;
    out.totalCost = this.gScore[reached];
    out.valid = true;
    this.lastPathMs = performance.now() - started;
    return true;
  }

  /** A* path cost between two points, or +Infinity when unreachable. */
  pathCost(from: THREE.Vector3, to: THREE.Vector3, maxCost = Number.POSITIVE_INFINITY): number {
    const startNode = this.nearestWalkableNode(from);
    const goalNode = this.nearestWalkableNode(to);
    if (startNode < 0 || goalNode < 0) return Number.POSITIVE_INFINITY;
    const reached = this.search(startNode, goalNode, maxCost);
    return reached < 0 ? Number.POSITIVE_INFINITY : this.gScore[reached];
  }

  /** Link classification between two walkable nodes (or -1 when unlinked). */
  linkKindBetween(fromNode: number, toNode: number): NavLinkKind | -1 {
    if (!this.isWalkableNode(fromNode) || !this.isWalkableNode(toNode)) return -1;
    if (this.padLinkOfNode[fromNode] >= 0 && this.padLinkTo[this.padLinkOfNode[fromNode]] === toNode) return NAV_LINK_PAD;
    const fromColumn = fromNode % this.columnCount;
    const toColumn = toNode % this.columnCount;
    const dc = (toColumn % this.cols) - (fromColumn % this.cols);
    const dr = Math.floor(toColumn / this.cols) - Math.floor(fromColumn / this.cols);
    if (Math.max(Math.abs(dc), Math.abs(dr)) > 2) return -1;
    const horizontal = Math.hypot(dc, dr) * this.cellSize;
    const ringTwo = Math.max(Math.abs(dc), Math.abs(dr)) === 2;
    return this.classifyLink(fromNode, toNode, horizontal, ringTwo);
  }

  /**
   * Whether every column between two points has a walkable layer close to the
   * interpolated height. Used for path lookahead so bots can cut corners
   * without steering across a gap or a ledge.
   */
  segmentWalkable(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (this.cellSize * 0.5)));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      this.scratchPoint.set(from.x + dx * t, from.y + (to.y - from.y) * t, from.z + dz * t);
      const node = this.nodeAt(this.scratchPoint);
      if (node < 0 || Math.abs(this.heights[node] - this.scratchPoint.y) > this.maxWalkRise * 2.2) return false;
    }
    return true;
  }

  private columnAt(x: number, z: number): number {
    const col = Math.floor((x - this.originX) / this.cellSize);
    const row = Math.floor((z - this.originZ) / this.cellSize);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }

  private bestLayerNode(column: number, y: number): number {
    let best = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let layer = 0; layer < this.layers; layer += 1) {
      const node = layer * this.columnCount + column;
      if ((this.flags[node] & FLAG_WALKABLE) === 0) continue;
      const height = this.heights[node];
      // Prefer floors at or under the point; floors well above it are a
      // different storey and only chosen when nothing else exists.
      const delta = height <= y + this.maxWalkRise ? y - height : (height - y) * 4 + 8;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = node;
      }
    }
    return best;
  }

  private ensureColumn(column: number): void {
    if (this.columnSampled[column]) return;
    this.columnSampled[column] = 1;
    this.sampledColumns += 1;
    const col = column % this.cols;
    const row = Math.floor(column / this.cols);
    const x = this.originX + (col + 0.5) * this.cellSize;
    const z = this.originZ + (row + 0.5) * this.cellSize;
    let fromY = SAMPLE_FROM_Y;
    for (let layer = 0; layer < this.layers; layer += 1) {
      const node = layer * this.columnCount + column;
      const height = this.arena.floorHeightAt(x, z, fromY);
      if (height === null || !Number.isFinite(height)) break;
      this.heights[node] = height;
      const normal = this.arena.surfaceNormalAt?.(x, z, height + 0.5) ?? this.scratchNormalFallback;
      const normalY = THREE.MathUtils.clamp(normal.y, 0.05, 1);
      this.slopeTangent[node] = Math.sqrt(Math.max(0, 1 - normalY * normalY)) / normalY;
      if (this.isWalkableSurface(x, height, z)) {
        this.flags[node] = FLAG_WALKABLE;
        this.walkableCells += 1;
      }
      fromY = height - 0.8;
    }
  }

  private isWalkableSurface(x: number, height: number, z: number): boolean {
    if (height <= this.arena.killY + 1) return false;
    this.scratchPoint.set(x, height, z);
    if (!this.arena.isTraversablePoint(this.scratchPoint, height + 0.5)) return false;
    // Capsule placement check: a standing bot must be supported without any
    // wall contact and must not be pushed sideways out of the cell.
    const capsule = this.scratchCapsule.set(x, height + 0.01, z);
    const velocity = this.scratchVelocity.set(0, -0.1, 0);
    const contact = this.arena.resolveCapsule(capsule, velocity, this.capsuleRadius, this.capsuleHeight);
    if (!contact.grounded || contact.wallContact) return false;
    return Math.abs(capsule.x - x) < 0.05 && Math.abs(capsule.z - z) < 0.05;
  }

  private classifyLink(fromNode: number, toNode: number, horizontal: number, ringTwo: boolean): NavLinkKind | -1 {
    const rise = this.heights[toNode] - this.heights[fromNode];
    if (!ringTwo) {
      if (Math.abs(rise) <= this.maxWalkRise) return NAV_LINK_WALK;
      const slope = Math.max(this.slopeTangent[fromNode], this.slopeTangent[toNode]);
      if (Math.abs(rise) <= horizontal * slope * 1.15 + this.maxWalkRise * 0.5) return NAV_LINK_WALK;
      if (rise > 0 && rise <= this.maxJumpRise) return NAV_LINK_JUMP;
      if (rise < 0 && -rise <= MAX_FALL_HEIGHT) return NAV_LINK_FALL;
      return -1;
    }
    if (rise <= this.maxJumpRise && rise >= -this.maxJumpRise) return NAV_LINK_JUMP;
    return -1;
  }

  private linkCost(kind: NavLinkKind, fromNode: number, toNode: number, horizontal: number): number {
    const rise = this.heights[toNode] - this.heights[fromNode];
    const distance = Math.sqrt(horizontal * horizontal + rise * rise);
    switch (kind) {
      case NAV_LINK_WALK: return distance;
      case NAV_LINK_JUMP: return distance * JUMP_LINK_COST;
      case NAV_LINK_FALL: return distance * FALL_LINK_COST;
      case NAV_LINK_PAD: return distance * PAD_LINK_COST;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unknown nav link kind ${String(exhaustive)}`);
      }
    }
  }

  private buildPadLinks(): void {
    if (this.padLinksBuilt) return;
    this.padLinksBuilt = true;
    for (const pad of this.arena.jumpPads) {
      const fromNode = this.nearestWalkableNode(pad.position);
      if (fromNode < 0 || this.padLinkOfNode[fromNode] >= 0) continue;
      const position = this.scratchLaunch.copy(pad.position);
      position.y += 0.1;
      const velocity = this.scratchLaunchVelocity.copy(pad.direction).multiplyScalar(pad.launchSpeed);
      const step = 1 / 30;
      let landed = false;
      for (let tick = 0; tick < 240; tick += 1) {
        velocity.y -= MOVEMENT.gravity * step;
        position.addScaledVector(velocity, step);
        if (velocity.y >= 0) continue;
        const floor = this.arena.floorHeightAt(position.x, position.z, position.y + 0.5);
        if (floor === null) {
          if (position.y < this.arena.killY) break;
          continue;
        }
        if (position.y <= floor) {
          position.y = floor;
          landed = true;
          break;
        }
      }
      if (!landed) continue;
      const toNode = this.nearestWalkableNode(position);
      if (toNode < 0 || toNode === fromNode) continue;
      const link = this.padLinkCount;
      this.padLinkFrom[link] = fromNode;
      this.padLinkTo[link] = toNode;
      this.padLinkOfNode[fromNode] = link;
      this.padLinkCount += 1;
    }
  }

  private heuristic(node: number, goalNode: number): number {
    const columnA = node % this.columnCount;
    const columnB = goalNode % this.columnCount;
    const dc = (columnB % this.cols) - (columnA % this.cols);
    const dr = Math.floor(columnB / this.cols) - Math.floor(columnA / this.cols);
    const dy = this.heights[goalNode] - this.heights[node];
    return Math.sqrt((dc * dc + dr * dr) * this.cellSize * this.cellSize + dy * dy);
  }

  /** Returns the goal node when reached, otherwise -1. */
  private search(startNode: number, goalNode: number, maxCost: number): number {
    this.searchStamp += 1;
    if (this.searchStamp >= 0x7fffffff) {
      this.searchStamp = 1;
      this.openStamp.fill(0);
      this.closedStamp.fill(0);
    }
    const stamp = this.searchStamp;
    this.heapSize = 0;
    this.gScore[startNode] = 0;
    this.cameFrom[startNode] = -1;
    this.cameKind[startNode] = NAV_LINK_WALK;
    this.openStamp[startNode] = stamp;
    this.heapPush(this.heuristic(startNode, goalNode), startNode);
    let expansions = 0;
    while (this.heapSize > 0) {
      const current = this.heapPop();
      if (this.closedStamp[current] === stamp) continue;
      this.closedStamp[current] = stamp;
      if (current === goalNode) return current;
      expansions += 1;
      if (expansions > this.maxExpansions) return -1;
      const currentCost = this.gScore[current];
      if (currentCost > maxCost) return -1;
      const column = current % this.columnCount;
      const col = column % this.cols;
      const row = Math.floor(column / this.cols);

      for (let offsetIndex = 0; offsetIndex < NEIGHBOUR_OFFSETS.length; offsetIndex += 1) {
        const [dc, dr] = NEIGHBOUR_OFFSETS[offsetIndex];
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        const ringTwo = offsetIndex >= RING_ONE_COUNT;
        const neighbourColumn = nr * this.cols + nc;
        this.ensureColumn(neighbourColumn);
        const horizontal = Math.hypot(dc, dr) * this.cellSize;
        for (let layer = 0; layer < this.layers; layer += 1) {
          const neighbour = layer * this.columnCount + neighbourColumn;
          if ((this.flags[neighbour] & FLAG_WALKABLE) === 0 || this.closedStamp[neighbour] === stamp) continue;
          const kind = this.classifyLink(current, neighbour, horizontal, ringTwo);
          if (kind === -1) continue;
          this.relax(current, neighbour, kind, currentCost + this.linkCost(kind, current, neighbour, horizontal), goalNode, stamp);
        }
      }

      const padLink = this.padLinkOfNode[current];
      if (padLink >= 0) {
        const landing = this.padLinkTo[padLink];
        if (this.closedStamp[landing] !== stamp) {
          const distance = this.heuristic(current, landing);
          this.relax(current, landing, NAV_LINK_PAD, currentCost + distance * PAD_LINK_COST, goalNode, stamp);
        }
      }
    }
    return -1;
  }

  private relax(from: number, to: number, kind: NavLinkKind, tentative: number, goalNode: number, stamp: number): void {
    if (this.openStamp[to] === stamp && tentative >= this.gScore[to]) return;
    this.openStamp[to] = stamp;
    this.gScore[to] = tentative;
    this.cameFrom[to] = from;
    this.cameKind[to] = kind;
    this.heapPush(tentative + this.heuristic(to, goalNode), to);
  }

  private heapPush(key: number, node: number): void {
    if (this.heapSize >= HEAP_CAPACITY) return;
    let index = this.heapSize;
    this.heapSize += 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.heapKeys[parent] <= key) break;
      this.heapKeys[index] = this.heapKeys[parent];
      this.heapNodes[index] = this.heapNodes[parent];
      index = parent;
    }
    this.heapKeys[index] = key;
    this.heapNodes[index] = node;
  }

  private heapPop(): number {
    const top = this.heapNodes[0];
    this.heapSize -= 1;
    if (this.heapSize > 0) {
      const key = this.heapKeys[this.heapSize];
      const node = this.heapNodes[this.heapSize];
      let index = 0;
      for (;;) {
        let child = index * 2 + 1;
        if (child >= this.heapSize) break;
        if (child + 1 < this.heapSize && this.heapKeys[child + 1] < this.heapKeys[child]) child += 1;
        if (this.heapKeys[child] >= key) break;
        this.heapKeys[index] = this.heapKeys[child];
        this.heapNodes[index] = this.heapNodes[child];
        index = child;
      }
      this.heapKeys[index] = key;
      this.heapNodes[index] = node;
    }
    return top;
  }
}
