import * as THREE from 'three';

export const SPEED_EFFECT_START_KMH = 70;
export const SPEED_EFFECT_FULL_KMH = 132;

const TRAILS_PER_SOURCE = 4;
const VERTICES_PER_TRAIL = 6;

export type SpeedTrailSource = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  active: boolean;
};

export function speedEffectIntensity(velocity: THREE.Vector3): number {
  const speedKmh = Math.hypot(velocity.x, velocity.z) * 3.6;
  const linear = THREE.MathUtils.clamp(
    (speedKmh - SPEED_EFFECT_START_KMH) / (SPEED_EFFECT_FULL_KMH - SPEED_EFFECT_START_KMH),
    0,
    1,
  );
  return linear * linear * (3 - 2 * linear);
}

/**
 * One batched, texture-free draw for every high-speed actor. Each tracer is a
 * narrow translucent ribbon with a tapered alpha, producing a soft streak
 * without per-person meshes, particles, or allocations in the frame loop.
 */
export class SpeedTrailSystem {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  activeSourceCount = 0;

  private readonly positions: Float32Array;
  private readonly opacities: Float32Array;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly opacityAttribute: THREE.BufferAttribute;
  private readonly direction = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly maxSources: number) {
    const vertexCount = maxSources * TRAILS_PER_SOURCE * VERTICES_PER_TRAIL;
    this.positions = new Float32Array(vertexCount * 3);
    this.opacities = new Float32Array(vertexCount);
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.opacityAttribute = new THREE.BufferAttribute(this.opacities, 1).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('aOpacity', this.opacityAttribute);
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
      uniforms: {
        color: { value: new THREE.Color(0xa8d5df) },
      },
      vertexShader: `attribute float aOpacity;
        varying float vOpacity;
        void main() {
          vOpacity = aOpacity;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform vec3 color;
        varying float vOpacity;
        void main() {
          gl_FragColor = vec4(color, vOpacity);
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'BatchedHighSpeedWindTrails';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(sources: readonly SpeedTrailSource[], elapsed: number, reducedMotion: boolean): void {
    let cursor = 0;
    this.activeSourceCount = 0;
    const motionScale = reducedMotion ? 0.25 : 1;

    for (let sourceIndex = 0; sourceIndex < Math.min(sources.length, this.maxSources); sourceIndex += 1) {
      const source = sources[sourceIndex];
      const intensity = source.active ? speedEffectIntensity(source.velocity) * motionScale : 0;
      if (intensity <= 0.002) continue;
      this.activeSourceCount += 1;
      this.direction.set(source.velocity.x, 0, source.velocity.z);
      if (this.direction.lengthSq() < 0.001) continue;
      this.direction.normalize();
      this.side.set(-this.direction.z, 0, this.direction.x);

      const trailLength = THREE.MathUtils.lerp(1.8, 5.8, intensity);
      const baseAlpha = THREE.MathUtils.lerp(0.08, 0.235, intensity);
      for (let trailIndex = 0; trailIndex < TRAILS_PER_SOURCE; trailIndex += 1) {
        const normalizedLane = trailIndex / (TRAILS_PER_SOURCE - 1) - 0.5;
        const phase = elapsed * (2.4 + trailIndex * 0.17) + sourceIndex * 1.93 + trailIndex * 2.1;
        const lateral = normalizedLane * 0.7 + Math.sin(phase) * 0.045;
        // Hip-to-shoulder placement keeps the effect attached to the actor
        // and above sloped terrain. Four soft bands read as wind shear rather
        // than weapon projectiles or a single hard laser line.
        const height = 0.74 + trailIndex * 0.27 + Math.cos(phase * 0.73) * 0.035;
        const width = 0.04 + intensity * 0.055 + (trailIndex % 2) * 0.014;
        const startDistance = 0.42 + trailIndex * 0.13;
        const endDistance = startDistance + trailLength * (0.72 + trailIndex * 0.095);
        const startX = source.position.x - this.direction.x * startDistance + this.side.x * lateral;
        const startZ = source.position.z - this.direction.z * startDistance + this.side.z * lateral;
        const endX = source.position.x - this.direction.x * endDistance + this.side.x * (lateral + Math.sin(phase * 0.61) * 0.1);
        const endZ = source.position.z - this.direction.z * endDistance + this.side.z * (lateral + Math.sin(phase * 0.61) * 0.1);
        const y = source.position.y + height;
        const nearAlpha = baseAlpha * (1 - trailIndex * 0.09);

        cursor = this.writeRibbon(
          cursor,
          startX,
          y,
          startZ,
          endX,
          y + Math.sin(phase * 0.43) * 0.025,
          endZ,
          width,
          nearAlpha,
        );
      }
    }

    this.mesh.geometry.setDrawRange(0, cursor);
    this.mesh.visible = cursor > 0;
    if (cursor > 0) {
      this.positionAttribute.needsUpdate = true;
      this.opacityAttribute.needsUpdate = true;
    }
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private writeRibbon(
    cursor: number,
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
    halfWidth: number,
    alpha: number,
  ): number {
    const sideX = this.side.x * halfWidth;
    const sideZ = this.side.z * halfWidth;
    const vertices = [
      [startX - sideX, startY, startZ - sideZ, alpha],
      [startX + sideX, startY, startZ + sideZ, alpha],
      [endX - sideX, endY, endZ - sideZ, 0],
      [startX + sideX, startY, startZ + sideZ, alpha],
      [endX + sideX, endY, endZ + sideZ, 0],
      [endX - sideX, endY, endZ - sideZ, 0],
    ] as const;
    for (const vertex of vertices) {
      const positionOffset = cursor * 3;
      this.positions[positionOffset] = vertex[0];
      this.positions[positionOffset + 1] = vertex[1];
      this.positions[positionOffset + 2] = vertex[2];
      this.opacities[cursor] = vertex[3];
      cursor += 1;
    }
    return cursor;
  }
}
