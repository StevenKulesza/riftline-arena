import * as THREE from 'three';

export const GROUND_COVER_CELL_SIZE = 128;
export const GROUND_COVER_RANGES = Object.freeze({
  grass: Object.freeze({ start: 120, end: 220 }),
  weed: Object.freeze({ start: 180, end: 320 }),
  fern: Object.freeze({ start: 240, end: 400 }),
  shrub: Object.freeze({ start: 480, end: 720 }),
});
export type GroundCoverProfile = keyof typeof GROUND_COVER_RANGES;

/** Repartition existing placements; never resample, thin, or move a plant. */
export function partitionGroundCover(buckets: readonly number[][]): number[][] {
  const cells = new Map<string, number[]>();
  for (const packed of buckets) {
    for (let offset = 0; offset < packed.length; offset += 8) {
      const key = `${Math.floor(packed[offset] / GROUND_COVER_CELL_SIZE)},${Math.floor(packed[offset + 2] / GROUND_COVER_CELL_SIZE)}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = [];
        cells.set(key, cell);
      }
      for (let field = 0; field < 8; field += 1) cell.push(packed[offset + field]);
    }
  }
  return [...cells.values()];
}

type Cell = { group: THREE.Group; bounds: THREE.Box3; profile: GroundCoverProfile };

/**
 * Static world-space instance batches, culled without uploads or allocations.
 * Only small understory uses this system: canopy trees and rock silhouettes
 * retain their original map-wide visibility. Cells contain whole plants and
 * disappear only after the per-plant shader fade has reached zero.
 */
export class GroundCoverCulling {
  private readonly cells = new Map<string, Cell>();
  private readonly distanceScale = { value: 1 };
  private readonly cameraPosition = new THREE.Vector3();
  private readonly rootPosition = new THREE.Vector3();
  private visibleCells = 0;

  configureMaterial(material: THREE.Material, profile: GroundCoverProfile): void {
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey();
    const range = GROUND_COVER_RANGES[profile];
    material.customProgramCacheKey = () => `${previousKey}|ground-cover-distance-v1:${profile}`;
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      shader.uniforms.uGroundCoverDistanceScale = this.distanceScale;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uGroundCoverDistanceScale;
          varying float vGroundCoverVisibility;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 groundCoverRoot = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            groundCoverRoot = instanceMatrix * groundCoverRoot;
          #endif
          groundCoverRoot = modelMatrix * groundCoverRoot;
          float groundCoverDistance = distance(cameraPosition, groundCoverRoot.xyz);
          vGroundCoverVisibility = 1.0 - smoothstep(
            ${range.start.toFixed(1)} * uGroundCoverDistanceScale,
            ${range.end.toFixed(1)} * uGroundCoverDistanceScale, groundCoverDistance);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vGroundCoverVisibility;`)
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
          ${material.transparent
            ? 'diffuseColor.a *= vGroundCoverVisibility;'
            : `float groundCoverDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
               if (vGroundCoverVisibility <= groundCoverDither) discard;`}`);
    };
  }

  add(mesh: THREE.InstancedMesh, parent: THREE.Group, profile: GroundCoverProfile): void {
    // Instance origins are authored in map/world coordinates. All instances
    // in this batch share one cell, even if their leaves overhang its edge.
    this.rootPosition.fromArray(mesh.instanceMatrix.array, 12);
    const key = `${parent.uuid}:${profile}:${Math.floor(this.rootPosition.x / GROUND_COVER_CELL_SIZE)},${Math.floor(this.rootPosition.z / GROUND_COVER_CELL_SIZE)}`;
    let cell = this.cells.get(key);
    if (!cell) {
      const group = new THREE.Group();
      group.name = `${parent.name}DistanceCell${this.cells.size}`;
      group.matrixAutoUpdate = false;
      cell = { group, bounds: new THREE.Box3(), profile };
      this.cells.set(key, cell);
      parent.add(group);
    }
    if (!mesh.boundingBox) mesh.computeBoundingBox();
    // Include roots as well as geometry and wind overshoot; a low fern's
    // origin must not be culled before its shader distance reaches fade-end.
    cell.bounds.union(mesh.boundingBox!);
    for (let index = 0; index < mesh.count; index += 1) {
      this.rootPosition.fromArray(mesh.instanceMatrix.array, index * 16 + 12);
      cell.bounds.expandByPoint(this.rootPosition);
    }
    mesh.boundingBox!.expandByScalar(2);
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 2;
    cell.group.add(mesh);
  }

  update(camera: THREE.PerspectiveCamera): void {
    camera.getWorldPosition(this.cameraPosition);
    // Scoped/narrow-FOV views retain the same apparent-size detail distance.
    this.distanceScale.value = Math.max(1, camera.zoom * Math.tan(THREE.MathUtils.degToRad(40))
      / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    this.visibleCells = 0;
    for (const { group, bounds, profile } of this.cells.values()) {
      const distance = GROUND_COVER_RANGES[profile].end * this.distanceScale.value + 2;
      group.visible = bounds.distanceToPoint(this.cameraPosition) <= distance;
      this.visibleCells += Number(group.visible);
    }
  }

  snapshot(): { cells: number; visibleCells: number; distanceScale: number } {
    return { cells: this.cells.size, visibleCells: this.visibleCells, distanceScale: this.distanceScale.value };
  }

  clear(): void {
    this.cells.clear();
    this.visibleCells = 0;
  }
}
