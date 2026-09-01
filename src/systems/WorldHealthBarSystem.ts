import * as THREE from 'three';

export type WorldHealthBarKind = 'person' | 'drone' | 'craft';

export type WorldHealthBarTarget = Readonly<{
  id: string;
  kind: WorldHealthBarKind;
  position: THREE.Vector3;
  value: () => number;
  maximum: () => number;
  visible: () => boolean;
  anchorHeight: number | (() => number);
  maxDistance?: number;
}>;

export type WorldHealthBarSnapshot = Readonly<{
  targetCount: number;
  visibleCount: number;
  drawCalls: number;
  categories: Readonly<Record<WorldHealthBarKind, number>>;
  entries: ReadonlyArray<Readonly<{
    id: string;
    kind: WorldHealthBarKind;
    ratio: number;
    rendered: boolean;
  }>>;
}>;

type RegisteredTarget = {
  target: WorldHealthBarTarget;
  rendered: boolean;
};

const FULL_HEALTH_COLORS: Readonly<Record<WorldHealthBarKind, THREE.Color>> = Object.freeze({
  person: new THREE.Color(0x5ee6a7),
  drone: new THREE.Color(0x55d9f1),
  craft: new THREE.Color(0x8ee9c1),
});
const WOUNDED_COLOR = new THREE.Color(0xffbd4a);
const CRITICAL_COLOR = new THREE.Color(0xff4d62);
const WORLD_HEALTH_BAR_SCALE = 0.75;
const DEFAULT_MAX_DISTANCE: Readonly<Record<WorldHealthBarKind, number>> = Object.freeze({
  person: 130,
  drone: 190,
  craft: 290,
});
const SCREEN_WIDTH_FACTOR: Readonly<Record<WorldHealthBarKind, number>> = Object.freeze({
  person: 0.06,
  drone: 0.068,
  craft: 0.078,
});
const MAX_WORLD_WIDTH: Readonly<Record<WorldHealthBarKind, number>> = Object.freeze({
  person: 4.2,
  drone: 5.2,
  craft: 8,
});

/**
 * A single-draw-call billboard batch for every combatant health bar. The fill
 * and frame are drawn in one shader so thin bars retain their color through
 * the game's ink/grade pass. Depth testing keeps terrain and structures in
 * front instead of revealing enemies through the map.
 */
export class WorldHealthBarSystem {
  readonly root = new THREE.Group();

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly bars: THREE.InstancedMesh;
  private readonly ratioAttribute: THREE.InstancedBufferAttribute;
  private readonly colorAttribute: THREE.InstancedBufferAttribute;
  private readonly targets: RegisteredTarget[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly cameraForward = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly toAnchor = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly categories: Record<WorldHealthBarKind, number> = {
    person: 0,
    drone: 0,
    craft: 0,
  };
  private visibleCount = 0;

  constructor(scene: THREE.Scene, private readonly capacity = 32) {
    this.root.name = 'world-health-bars';
    this.root.visible = false;
    this.root.userData.worldHealthBars = true;

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.ratioAttribute = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.colorAttribute = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.ratioAttribute.setUsage(THREE.DynamicDrawUsage);
    this.colorAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('instanceHealthRatio', this.ratioAttribute);
    this.geometry.setAttribute('instanceHealthColor', this.colorAttribute);
    this.material = new THREE.ShaderMaterial({
      depthTest: true,
      depthWrite: false,
      transparent: false,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float instanceHealthRatio;
        attribute vec3 instanceHealthColor;
        varying vec2 vHealthUv;
        varying float vHealthRatio;
        varying vec3 vHealthColor;
        void main() {
          vHealthUv = uv;
          vHealthRatio = instanceHealthRatio;
          vHealthColor = instanceHealthColor;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vHealthUv;
        varying float vHealthRatio;
        varying vec3 vHealthColor;
        void main() {
          float insideX = step(0.035, vHealthUv.x) * step(vHealthUv.x, 0.965);
          float insideY = step(0.22, vHealthUv.y) * step(vHealthUv.y, 0.78);
          float trackMask = insideX * insideY;
          float fillEnd = 0.035 + clamp(vHealthRatio, 0.0, 1.0) * 0.93;
          float fillMask = trackMask * step(vHealthUv.x, fillEnd);
          vec3 frame = vec3(0.012, 0.027, 0.038);
          vec3 track = vec3(0.075, 0.105, 0.12);
          vec3 color = mix(frame, track, trackMask);
          color = mix(color, vHealthColor, fillMask);
          color += vHealthColor * fillMask * smoothstep(0.58, 0.78, vHealthUv.y) * 0.11;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    this.material.toneMapped = false;
    this.material.fog = false;
    this.bars = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    this.bars.name = 'world-health-bar-batch';
    this.bars.count = 0;
    this.bars.frustumCulled = false;
    this.bars.renderOrder = 600;
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.bars);
    scene.add(this.root);
  }

  register(target: WorldHealthBarTarget): void {
    if (this.targets.length >= this.capacity) {
      throw new Error(`World health bar capacity exceeded (${this.capacity}).`);
    }
    this.targets.push({ target, rendered: false });
    this.categories[target.kind] += 1;
  }

  update(camera: THREE.PerspectiveCamera, enabled = true): void {
    for (const state of this.targets) state.rendered = false;
    this.visibleCount = 0;
    if (!enabled) {
      this.setInstanceCount(0);
      this.root.visible = false;
      return;
    }

    camera.updateMatrixWorld(true);
    camera.getWorldDirection(this.cameraForward);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

    for (const state of this.targets) {
      const { target } = state;
      if (!target.visible()) continue;
      const maximum = target.maximum();
      if (!Number.isFinite(maximum) || maximum <= 0) continue;

      const ratio = THREE.MathUtils.clamp(target.value() / maximum, 0, 1);
      const anchorHeight = typeof target.anchorHeight === 'function'
        ? target.anchorHeight()
        : target.anchorHeight;
      this.anchor.copy(target.position);
      this.anchor.y += anchorHeight;
      this.toAnchor.subVectors(this.anchor, camera.position);
      const distance = this.toAnchor.length();
      if (distance <= camera.near || distance > (target.maxDistance ?? DEFAULT_MAX_DISTANCE[target.kind])) continue;
      if (this.toAnchor.dot(this.cameraForward) <= 0) continue;

      this.projected.copy(this.anchor).project(camera);
      if (this.projected.z < -1 || this.projected.z > 1
        || Math.abs(this.projected.x) > 1.08 || Math.abs(this.projected.y) > 1.08) continue;

      const index = this.visibleCount;
      const width = THREE.MathUtils.clamp(
        distance * tanHalfFov * SCREEN_WIDTH_FACTOR[target.kind],
        0.18,
        MAX_WORLD_WIDTH[target.kind],
      ) * WORLD_HEALTH_BAR_SCALE;
      const height = width * 0.15;
      this.scale.set(width, height, 1);
      this.matrix.compose(this.anchor, camera.quaternion, this.scale);
      this.bars.setMatrixAt(index, this.matrix);
      this.ratioAttribute.setX(index, ratio);
      const color = this.healthColor(target.kind, ratio);
      this.colorAttribute.setXYZ(index, color.r, color.g, color.b);

      state.rendered = true;
      this.visibleCount += 1;
    }

    this.setInstanceCount(this.visibleCount);
    this.root.visible = this.visibleCount > 0;
    if (this.visibleCount > 0) {
      this.bars.instanceMatrix.needsUpdate = true;
      this.ratioAttribute.needsUpdate = true;
      this.colorAttribute.needsUpdate = true;
    }
  }

  snapshot(): WorldHealthBarSnapshot {
    return {
      targetCount: this.targets.length,
      visibleCount: this.visibleCount,
      drawCalls: 1,
      categories: { ...this.categories },
      entries: this.targets.map(({ target, rendered }) => {
        const maximum = target.maximum();
        return {
          id: target.id,
          kind: target.kind,
          ratio: maximum > 0 ? THREE.MathUtils.clamp(target.value() / maximum, 0, 1) : 0,
          rendered,
        };
      }),
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private setInstanceCount(count: number): void {
    this.bars.count = count;
  }

  private healthColor(kind: WorldHealthBarKind, ratio: number): THREE.Color {
    if (ratio <= 0.25) return CRITICAL_COLOR;
    if (ratio <= 0.55) return WOUNDED_COLOR;
    return FULL_HEALTH_COLORS[kind];
  }
}
