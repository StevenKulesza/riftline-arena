import * as THREE from 'three';
import type { ArenaRuntime } from '../game/Arena';
import type {
  FighterCollisionHit,
  FighterCollisionQuery,
  FighterCollisionQueryCallback,
} from '../game/FighterFlightPhysics';

/**
 * Bridges the fighter's swept-sphere contract to the arena's authored BVH.
 * Seven retained offset rays approximate a sphere sweep while preserving the
 * map's existing movement-only collider filtering and avoiding hot-path GC.
 */
export class FighterArenaCollisionAdapter {
  readonly query: FighterCollisionQueryCallback;

  private readonly offsets = Array.from({ length: 7 }, () => new THREE.Vector3());
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly centerAtHit = new THREE.Vector3();
  private readonly terrainSample = new THREE.Vector3();
  private readonly zeroVelocity = new THREE.Vector3();

  constructor(private readonly arena: ArenaRuntime) {
    this.query = (query, outHit) => this.cast(query, outHit);
  }

  private cast(query: FighterCollisionQuery, outHit: FighterCollisionHit): boolean {
    const radius = Math.max(0.01, query.radius);
    const offsets = this.offsets;
    offsets[0].set(0, 0, 0);
    offsets[1].set(radius, 0, 0);
    offsets[2].set(-radius, 0, 0);
    offsets[3].set(0, radius, 0);
    offsets[4].set(0, -radius, 0);
    offsets[5].set(0, 0, radius);
    offsets[6].set(0, 0, -radius);

    let bestFraction = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;
    let found = false;
    const sweepDistance = Math.max(query.maxDistance, query.start.distanceTo(query.end));
    const rayCount = query.kind === 'support' ? 1 : offsets.length;

    for (let index = 0; index < rayCount; index += 1) {
      const offset = offsets[index];
      this.start.copy(query.start).add(offset);
      this.end.copy(query.end).add(offset);
      const hit = this.arena.movementSegmentHitDetails(this.start, this.end);
      if (!hit) continue;
      const effectiveDistance = query.kind === 'support'
        ? Math.max(0, hit.distance - radius)
        : hit.distance;
      const fraction = sweepDistance > 1e-7
        ? THREE.MathUtils.clamp(effectiveDistance / sweepDistance, 0, 1)
        : 0;
      if (fraction >= bestFraction) continue;
      found = true;
      bestFraction = fraction;
      bestDistance = effectiveDistance;
      this.centerAtHit.lerpVectors(query.start, query.end, fraction);
      outHit.point.copy(this.centerAtHit).addScaledVector(hit.normal, -radius);
      outHit.normal.copy(hit.normal);
    }

    // `movementSegmentHitDetails` owns authored blockers and the tower BVH,
    // but QuickSense's broad terrain is a heightfield rather than triangle
    // collision. Include it in body sweeps as well as support probes so a
    // boosted nose/wing cannot tunnel through the canyon floor. At 120 Hz a
    // short binary TOI refinement is both conservative and inexpensive.
    if (query.kind === 'body') {
      const startFloor = this.arena.floorHeightAt(
        query.start.x,
        query.start.z,
        query.start.y + radius + 0.08,
      );
      const endFloor = this.arena.floorHeightAt(
        query.end.x,
        query.end.z,
        query.end.y + radius + 0.08,
      );
      if (startFloor !== null && endFloor !== null) {
        const startClearance = query.start.y - radius - startFloor;
        const endClearance = query.end.y - radius - endFloor;
        const crossesSurface = startClearance > -0.03 && endClearance <= 0;
        if (crossesSurface) {
          let low = 0;
          let high = 1;
          for (let iteration = 0; iteration < 7; iteration += 1) {
            const mid = (low + high) * 0.5;
            this.terrainSample.lerpVectors(query.start, query.end, mid);
            const floor = this.arena.floorHeightAt(
              this.terrainSample.x,
              this.terrainSample.z,
              this.terrainSample.y + radius + 0.08,
            );
            const clearance = floor === null
              ? Number.POSITIVE_INFINITY
              : this.terrainSample.y - radius - floor;
            if (clearance > 0) low = mid;
            else high = mid;
          }
          if (high < bestFraction) {
            found = true;
            bestFraction = high;
            bestDistance = sweepDistance * high;
            this.centerAtHit.lerpVectors(query.start, query.end, high);
            const floor = this.arena.floorHeightAt(
              this.centerAtHit.x,
              this.centerAtHit.z,
              this.centerAtHit.y + radius + 0.08,
            ) ?? this.centerAtHit.y - radius;
            const normal = this.arena.surfaceNormalAt?.(
              this.centerAtHit.x,
              this.centerAtHit.z,
              this.centerAtHit.y + radius + 0.08,
            );
            if (normal) outHit.normal.copy(normal).normalize();
            else outHit.normal.set(0, 1, 0);
            outHit.point.set(this.centerAtHit.x, floor, this.centerAtHit.z);
          }
        }
      }
    }

    // A downward support query can begin almost flush with a landing surface;
    // the BVH ray then occasionally starts inside its skin. The heightfield
    // fallback keeps parked fighters seated on authored decks and ramps.
    if (query.kind === 'support') {
      const floorY = this.arena.floorHeightAt(query.start.x, query.start.z, query.start.y + 0.08);
      if (floorY !== null) {
        const surfaceDistance = query.start.y - radius - floorY;
        if (surfaceDistance >= -0.12 && surfaceDistance <= query.maxDistance + 0.12) {
          const fraction = query.maxDistance > 1e-7
            ? THREE.MathUtils.clamp(surfaceDistance / query.maxDistance, 0, 1)
            : 0;
          if (fraction < bestFraction) {
            found = true;
            bestFraction = fraction;
            bestDistance = Math.max(0, surfaceDistance);
            outHit.point.set(query.start.x, floorY, query.start.z);
            const normal = this.arena.surfaceNormalAt?.(query.start.x, query.start.z, query.start.y + 0.08);
            if (normal) outHit.normal.copy(normal).normalize();
            else outHit.normal.set(0, 1, 0);
          }
        }
      }
    }

    if (!found) return false;
    outHit.fraction = bestFraction;
    outHit.distance = bestDistance;
    outHit.surfaceVelocity.copy(this.zeroVelocity);
    outHit.colliderId = -1;
    return true;
  }
}
