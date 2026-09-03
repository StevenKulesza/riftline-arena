import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type MonsoonRewardKind =
  | 'health'
  | 'armor'
  | 'damage'
  | 'speed'
  | 'machine'
  | 'shotgun'
  | 'rocket'
  | 'plasma'
  | 'laser'
  | 'sniper'
  | 'rail'
  | 'disc';

export type MonsoonRewardSilhouette =
  | 'triage-cross'
  | 'aegis-shield'
  | 'ordnance-chevron'
  | 'overdrive-reactor';

export type MonsoonRewardVisualState = 'idle' | 'attract' | 'collect' | 'cooldown' | 'respawn';

export const MONSOON_REWARD_VISUAL_BUDGET = Object.freeze({
  steadyDrawCallsPerPickup: 3,
  transientCollectDrawCallsPerPickup: 4,
  collectSeconds: 0.36,
  respawnSeconds: 0.46,
  attractDistance: 9,
});

type RewardProfile = Readonly<{
  silhouette: MonsoonRewardSilhouette;
  rotorHeight: number;
  rotorTilt: number;
  rotorSpeed: number;
}>;

const REWARD_PROFILES: Readonly<Record<MonsoonRewardSilhouette, RewardProfile>> = Object.freeze({
  'triage-cross': Object.freeze({
    silhouette: 'triage-cross',
    rotorHeight: 1.08,
    rotorTilt: Math.PI * 0.5,
    rotorSpeed: 0.72,
  }),
  'aegis-shield': Object.freeze({
    silhouette: 'aegis-shield',
    rotorHeight: 0.94,
    rotorTilt: Math.PI * 0.36,
    rotorSpeed: -0.62,
  }),
  'ordnance-chevron': Object.freeze({
    silhouette: 'ordnance-chevron',
    rotorHeight: 1.12,
    rotorTilt: Math.PI * 0.5,
    rotorSpeed: 0.84,
  }),
  'overdrive-reactor': Object.freeze({
    silhouette: 'overdrive-reactor',
    rotorHeight: 0.92,
    rotorTilt: 0,
    rotorSpeed: 1.05,
  }),
});

const BODY_COLORS = Object.freeze({
  contact: new THREE.Color(0x071019),
  graphite: new THREE.Color(0x172633),
  alloy: new THREE.Color(0x758c99),
  ceramic: new THREE.Color(0xc3d2d4),
});

type Part = Readonly<{
  geometry: THREE.BufferGeometry;
  color?: THREE.Color;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: readonly [number, number, number];
}>;

export type MonsoonRewardVisual = {
  readonly root: THREE.Group;
  readonly form: THREE.Group;
  readonly body: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly signal: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly rotor: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly echo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly silhouette: MonsoonRewardSilhouette;
  state: MonsoonRewardVisualState;
  stateElapsed: number;
};

function rewardSilhouette(kind: MonsoonRewardKind): MonsoonRewardSilhouette {
  if (kind === 'health') return 'triage-cross';
  if (kind === 'armor') return 'aegis-shield';
  if (kind === 'damage' || kind === 'speed') return 'overdrive-reactor';
  return 'ordnance-chevron';
}

function normalizedGeometry(part: Part, withColor: boolean): THREE.BufferGeometry {
  const source = part.geometry;
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  source.dispose();
  const position = part.position ?? [0, 0, 0];
  const rotation = part.rotation ?? [0, 0, 0];
  const scale = part.scale ?? [1, 1, 1];
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  );
  geometry.applyMatrix4(matrix);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(geometry.getAttribute('position').count * 2, 2),
    );
  }
  if (withColor) {
    const color = part.color ?? BODY_COLORS.ceramic;
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let index = 0; index < colors.length; index += 3) {
      colors[index] = color.r;
      colors[index + 1] = color.g;
      colors[index + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  for (const attribute of Object.keys(geometry.attributes)) {
    if (!['position', 'normal', 'uv', ...(withColor ? ['color'] : [])].includes(attribute)) {
      geometry.deleteAttribute(attribute);
    }
  }
  return geometry;
}

function mergeParts(parts: readonly Part[], withColor = true): THREE.BufferGeometry {
  const normalized = parts.map((part) => normalizedGeometry(part, withColor));
  const merged = mergeGeometries(normalized, false);
  for (const geometry of normalized) geometry.dispose();
  if (!merged) throw new Error('Unable to merge Monsoon reward geometry.');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData.sharedMonsoonReward = true;
  return merged;
}

function foundationParts(): Part[] {
  return [
    {
      geometry: new THREE.CylinderGeometry(0.78, 0.84, 0.14, 12),
      color: BODY_COLORS.contact,
      position: [0, 0.07, 0],
    },
    {
      geometry: new THREE.CylinderGeometry(0.63, 0.71, 0.1, 12),
      color: BODY_COLORS.alloy,
      position: [0, 0.17, 0],
    },
    {
      geometry: new THREE.BoxGeometry(1.16, 0.1, 0.18),
      color: BODY_COLORS.graphite,
      position: [0, 0.24, 0],
    },
  ];
}

function createTriageBody(): THREE.BufferGeometry {
  return mergeParts([
    ...foundationParts(),
    {
      geometry: new THREE.BoxGeometry(1.02, 0.62, 0.5),
      color: BODY_COLORS.ceramic,
      position: [0, 0.65, 0],
    },
    {
      geometry: new THREE.BoxGeometry(1.1, 0.12, 0.56),
      color: BODY_COLORS.graphite,
      position: [0, 0.66, 0],
    },
    ...[-1, 1].map((side): Part => ({
      geometry: new THREE.CylinderGeometry(0.11, 0.11, 0.62, 10),
      color: BODY_COLORS.alloy,
      position: [side * 0.55, 0.64, 0],
    })),
    ...[-1, 1].map((side): Part => ({
      geometry: new THREE.BoxGeometry(0.13, 0.32, 0.16),
      color: BODY_COLORS.graphite,
      position: [side * 0.31, 1.08, 0],
    })),
    {
      geometry: new THREE.BoxGeometry(0.74, 0.13, 0.16),
      color: BODY_COLORS.graphite,
      position: [0, 1.23, 0],
    },
  ]);
}

function createAegisBody(): THREE.BufferGeometry {
  const shield = new THREE.Shape();
  shield.moveTo(-0.56, 0.5);
  shield.lineTo(-0.48, -0.2);
  shield.lineTo(0, -0.62);
  shield.lineTo(0.48, -0.2);
  shield.lineTo(0.56, 0.5);
  shield.lineTo(0, 0.7);
  shield.closePath();
  const shieldGeometry = new THREE.ExtrudeGeometry(shield, {
    depth: 0.22,
    bevelEnabled: true,
    bevelSize: 0.045,
    bevelThickness: 0.045,
    bevelSegments: 1,
  });
  shieldGeometry.center();
  return mergeParts([
    ...foundationParts(),
    {
      geometry: shieldGeometry,
      color: BODY_COLORS.ceramic,
      position: [0, 0.94, 0],
      scale: [1, 1, 1],
    },
    ...[-1, 1].map((side): Part => ({
      geometry: new THREE.BoxGeometry(0.38, 0.38, 0.4),
      color: BODY_COLORS.graphite,
      position: [side * 0.58, 0.82, 0],
      rotation: [0, 0, side * -0.18],
    })),
    ...[-1, 1].map((side): Part => ({
      geometry: new THREE.BoxGeometry(0.16, 0.6, 0.16),
      color: BODY_COLORS.alloy,
      position: [side * 0.42, 0.82, -0.18],
      rotation: [0, 0, side * 0.2],
    })),
  ]);
}

function createOrdnanceBody(): THREE.BufferGeometry {
  return mergeParts([
    ...foundationParts(),
    {
      geometry: new THREE.BoxGeometry(1.48, 0.4, 0.54),
      color: BODY_COLORS.graphite,
      position: [0, 0.68, 0],
    },
    {
      geometry: new THREE.BoxGeometry(1.02, 0.2, 0.62),
      color: BODY_COLORS.ceramic,
      position: [-0.08, 0.87, 0],
    },
    ...[-1, 0, 1].map((lane): Part => ({
      geometry: new THREE.CylinderGeometry(0.085, 0.085, 1.3, 8),
      color: lane === 0 ? BODY_COLORS.alloy : BODY_COLORS.ceramic,
      position: [0.06, 0.67, lane * 0.18],
      rotation: [0, 0, Math.PI * 0.5],
    })),
    ...[-1, 1].map((side): Part => ({
      geometry: new THREE.BoxGeometry(0.22, 0.58, 0.18),
      color: BODY_COLORS.alloy,
      position: [side * 0.73, 0.73, 0],
      rotation: [0, 0, side * 0.22],
    })),
  ]);
}

function createReactorBody(): THREE.BufferGeometry {
  return mergeParts([
    ...foundationParts(),
    {
      geometry: new THREE.CylinderGeometry(0.34, 0.42, 0.82, 10),
      color: BODY_COLORS.graphite,
      position: [0, 0.7, 0],
    },
    {
      geometry: new THREE.OctahedronGeometry(0.48, 0),
      color: BODY_COLORS.ceramic,
      position: [0, 1.08, 0],
      scale: [0.78, 1.45, 0.78],
    },
    ...[0, 1, 2, 3].map((index): Part => {
      const angle = index * Math.PI * 0.5;
      return {
        geometry: new THREE.BoxGeometry(0.16, 0.62, 0.28),
        color: index % 2 ? BODY_COLORS.alloy : BODY_COLORS.graphite,
        position: [Math.cos(angle) * 0.48, 0.72, Math.sin(angle) * 0.48],
        rotation: [0, -angle, 0],
      };
    }),
  ]);
}

function createSignalGeometry(silhouette: MonsoonRewardSilhouette): THREE.BufferGeometry {
  const floorRing: Part = {
    geometry: new THREE.TorusGeometry(0.69, 0.045, 6, 28),
    position: [0, 0.235, 0],
    rotation: [Math.PI * 0.5, 0, 0],
  };
  if (silhouette === 'triage-cross') {
    return mergeParts([
      floorRing,
      { geometry: new THREE.BoxGeometry(0.18, 0.58, 0.08), position: [0, 0.69, 0.285] },
      { geometry: new THREE.BoxGeometry(0.58, 0.18, 0.08), position: [0, 0.69, 0.288] },
      { geometry: new THREE.OctahedronGeometry(0.12, 0), position: [0, 1.45, 0] },
    ], false);
  }
  if (silhouette === 'aegis-shield') {
    return mergeParts([
      floorRing,
      { geometry: new THREE.BoxGeometry(0.12, 0.92, 0.08), position: [0, 0.96, 0.155] },
      { geometry: new THREE.OctahedronGeometry(0.16, 0), position: [0, 1.62, 0], scale: [1, 0.72, 1] },
    ], false);
  }
  if (silhouette === 'ordnance-chevron') {
    return mergeParts([
      floorRing,
      { geometry: new THREE.BoxGeometry(0.1, 0.62, 0.1), position: [-0.22, 1.18, 0], rotation: [0, 0, -0.62] },
      { geometry: new THREE.BoxGeometry(0.1, 0.62, 0.1), position: [0.22, 1.18, 0], rotation: [0, 0, 0.62] },
      { geometry: new THREE.BoxGeometry(0.52, 0.1, 0.62), position: [0, 0.91, 0] },
    ], false);
  }
  return mergeParts([
    floorRing,
    { geometry: new THREE.TorusGeometry(0.48, 0.055, 6, 22), position: [0, 1.02, 0], rotation: [Math.PI * 0.5, 0, 0] },
    { geometry: new THREE.OctahedronGeometry(0.18, 0), position: [0, 1.78, 0], scale: [0.75, 1.15, 0.75] },
  ], false);
}

function buildBodyGeometry(silhouette: MonsoonRewardSilhouette): THREE.BufferGeometry {
  if (silhouette === 'triage-cross') return createTriageBody();
  if (silhouette === 'aegis-shield') return createAegisBody();
  if (silhouette === 'ordnance-chevron') return createOrdnanceBody();
  return createReactorBody();
}

function smootherStep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export class MonsoonRewardVisualKit {
  private readonly bodyMaterial = new THREE.MeshPhysicalMaterial({
    name: 'Monsoon rewards shared authored body',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.48,
    metalness: 0.56,
    clearcoat: 0.68,
    clearcoatRoughness: 0.24,
  });
  private readonly echoMaterial = new THREE.MeshBasicMaterial({
    name: 'Monsoon rewards shared collect echo',
    color: 0xe9ffff,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly bodyGeometries = new Map<MonsoonRewardSilhouette, THREE.BufferGeometry>();
  private readonly signalGeometries = new Map<MonsoonRewardSilhouette, THREE.BufferGeometry>();
  private readonly signalMaterials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly rotorGeometry = new THREE.TorusGeometry(0.69, 0.045, 6, 24);
  private readonly echoGeometry = new THREE.RingGeometry(0.7, 0.83, 28);

  constructor() {
    this.bodyMaterial.userData.sharedMonsoonReward = true;
    this.echoMaterial.userData.sharedMonsoonReward = true;
    this.rotorGeometry.userData.sharedMonsoonReward = true;
    this.echoGeometry.userData.sharedMonsoonReward = true;
    for (const silhouette of Object.keys(REWARD_PROFILES) as MonsoonRewardSilhouette[]) {
      this.bodyGeometries.set(silhouette, buildBodyGeometry(silhouette));
      this.signalGeometries.set(silhouette, createSignalGeometry(silhouette));
    }
  }

  create(kind: MonsoonRewardKind, color: number): MonsoonRewardVisual {
    const silhouette = rewardSilhouette(kind);
    const profile = REWARD_PROFILES[silhouette];
    const signalMaterial = this.signalMaterial(color);
    const root = new THREE.Group();
    root.name = `${kind}-grounded-pickup`;
    root.userData.rewardSilhouette = silhouette;
    root.userData.rewardState = 'idle';
    root.userData.rewardSteadyDrawCalls = MONSOON_REWARD_VISUAL_BUDGET.steadyDrawCallsPerPickup;
    root.userData.rewardCollectDrawCalls = MONSOON_REWARD_VISUAL_BUDGET.transientCollectDrawCallsPerPickup;
    root.userData.rewardSharedResources = true;

    const form = new THREE.Group();
    form.name = silhouette === 'ordnance-chevron'
      ? `${kind}-pickup-weapon-model`
      : `pickup-${silhouette}-form`;
    root.add(form);

    const body = new THREE.Mesh(this.bodyGeometries.get(silhouette)!, this.bodyMaterial);
    body.name = `pickup-${silhouette}-body`;
    body.receiveShadow = true;
    form.add(body);

    const signal = new THREE.Mesh(this.signalGeometries.get(silhouette)!, signalMaterial);
    signal.name = `pickup-${silhouette}-signal`;
    form.add(signal);

    const rotor = new THREE.Mesh(this.rotorGeometry, signalMaterial);
    rotor.name = 'pickup-id-rotor';
    rotor.position.y = profile.rotorHeight;
    rotor.rotation.x = profile.rotorTilt;
    form.add(rotor);

    const echo = new THREE.Mesh(this.echoGeometry, this.echoMaterial);
    echo.name = 'pickup-collect-echo';
    echo.position.y = 0.06;
    echo.rotation.x = -Math.PI * 0.5;
    echo.visible = false;
    root.add(echo);

    return {
      root,
      form,
      body,
      signal,
      rotor,
      echo,
      silhouette,
      state: 'idle',
      stateElapsed: 0,
    };
  }

  beginCollect(visual: MonsoonRewardVisual): void {
    this.setState(visual, 'collect');
    visual.root.visible = true;
    visual.form.scale.setScalar(1);
    visual.echo.visible = true;
    visual.echo.scale.setScalar(0.7);
  }

  beginRespawn(visual: MonsoonRewardVisual): void {
    this.setState(visual, 'respawn');
    visual.root.visible = true;
    visual.form.scale.setScalar(0.55);
    visual.echo.visible = true;
    visual.echo.scale.setScalar(1.4);
  }

  reset(visual: MonsoonRewardVisual): void {
    this.setState(visual, 'idle');
    visual.root.visible = true;
    visual.form.scale.setScalar(1);
    visual.signal.scale.setScalar(1);
    visual.echo.visible = false;
  }

  update(
    visual: MonsoonRewardVisual,
    options: Readonly<{
      delta: number;
      elapsed: number;
      active: boolean;
      distanceSq: number;
      renderable: boolean;
      reducedMotion: boolean;
    }>,
  ): void {
    const delta = Math.max(0, options.delta);
    visual.stateElapsed += delta;
    if (!options.active) {
      if (visual.state === 'collect') {
        const progress = smootherStep(visual.stateElapsed / MONSOON_REWARD_VISUAL_BUDGET.collectSeconds);
        visual.root.visible = options.renderable && progress < 1;
        visual.form.scale.setScalar(THREE.MathUtils.lerp(1, 0.16, progress));
        visual.echo.visible = visual.root.visible;
        visual.echo.scale.setScalar(THREE.MathUtils.lerp(0.7, 2.35, progress));
        if (progress >= 1) this.setState(visual, 'cooldown');
      } else {
        visual.root.visible = false;
        visual.echo.visible = false;
      }
      return;
    }

    visual.root.visible = options.renderable;
    if (!visual.root.visible) return;
    const attract = options.distanceSq <= MONSOON_REWARD_VISUAL_BUDGET.attractDistance ** 2;
    if (visual.state === 'respawn') {
      const progress = smootherStep(visual.stateElapsed / MONSOON_REWARD_VISUAL_BUDGET.respawnSeconds);
      visual.form.scale.setScalar(THREE.MathUtils.lerp(0.55, 1, progress));
      visual.echo.visible = progress < 1;
      visual.echo.scale.setScalar(THREE.MathUtils.lerp(1.4, 0.78, progress));
      if (progress >= 1) this.setState(visual, attract ? 'attract' : 'idle');
    } else {
      this.setState(visual, attract ? 'attract' : 'idle', false);
      visual.form.scale.setScalar(attract ? 1.055 : 1);
      visual.echo.visible = false;
    }

    const profile = REWARD_PROFILES[visual.silhouette];
    if (!options.reducedMotion) {
      visual.rotor.rotation.y += delta * profile.rotorSpeed * (attract ? 3.2 : 1);
      const pulse = 1 + Math.sin(options.elapsed * (attract ? 5.4 : 2.35)) * (attract ? 0.09 : 0.035);
      visual.signal.scale.setScalar(pulse);
    } else {
      visual.signal.scale.setScalar(attract ? 1.07 : 1);
    }
  }

  diagnostics(): Readonly<{
    silhouettes: readonly MonsoonRewardSilhouette[];
    geometries: number;
    materials: number;
    steadyDrawCallsPerPickup: number;
    transientCollectDrawCallsPerPickup: number;
  }> {
    return Object.freeze({
      silhouettes: Object.freeze([...this.bodyGeometries.keys()]),
      geometries: this.bodyGeometries.size + this.signalGeometries.size + 2,
      materials: 2 + this.signalMaterials.size,
      steadyDrawCallsPerPickup: MONSOON_REWARD_VISUAL_BUDGET.steadyDrawCallsPerPickup,
      transientCollectDrawCallsPerPickup: MONSOON_REWARD_VISUAL_BUDGET.transientCollectDrawCallsPerPickup,
    });
  }

  dispose(): void {
    for (const geometry of this.bodyGeometries.values()) geometry.dispose();
    for (const geometry of this.signalGeometries.values()) geometry.dispose();
    this.rotorGeometry.dispose();
    this.echoGeometry.dispose();
    this.bodyMaterial.dispose();
    this.echoMaterial.dispose();
    for (const material of this.signalMaterials.values()) material.dispose();
    this.bodyGeometries.clear();
    this.signalGeometries.clear();
    this.signalMaterials.clear();
  }

  private signalMaterial(color: number): THREE.MeshStandardMaterial {
    const existing = this.signalMaterials.get(color);
    if (existing) return existing;
    const material = new THREE.MeshStandardMaterial({
      name: `Monsoon reward signal ${color.toString(16).padStart(6, '0')}`,
      color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.2),
      emissive: color,
      emissiveIntensity: 0.58,
      roughness: 0.22,
      metalness: 0.38,
    });
    material.userData.sharedMonsoonReward = true;
    this.signalMaterials.set(color, material);
    return material;
  }

  private setState(
    visual: MonsoonRewardVisual,
    state: MonsoonRewardVisualState,
    resetElapsed = true,
  ): void {
    if (visual.state === state) return;
    visual.state = state;
    if (resetElapsed) visual.stateElapsed = 0;
    visual.root.userData.rewardState = state;
  }
}
