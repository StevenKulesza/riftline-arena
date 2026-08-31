import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { WeaponId } from '../game/config';

type Effect = {
  root: THREE.Group;
  age: number;
  duration: number;
  materials: THREE.Material[];
  update: (progress: number, delta: number) => void;
  kind?: 'muzzle' | 'beam' | 'trail' | 'impact' | 'tracer' | 'burst';
  pooled?: boolean;
};

type MachineMuzzlePoolEntry = {
  root: THREE.Group;
  hot: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
  effect: Effect;
};

type MachineBeamPoolEntry = {
  root: THREE.Group;
  packet: THREE.Mesh;
  halo: THREE.Mesh;
  core: THREE.MeshBasicMaterial;
  glow: THREE.MeshBasicMaterial;
  direction: THREE.Vector3;
  speed: number;
  effect: Effect;
};

type ContinuousLaser = {
  root: THREE.Group;
  segments: Array<{ core: THREE.Mesh; halo: THREE.Mesh }>;
  coreGeometry: THREE.CylinderGeometry;
  haloGeometry: THREE.CylinderGeometry;
  coreMaterial: THREE.MeshBasicMaterial;
  haloMaterial: THREE.MeshBasicMaterial;
  emitter: THREE.Group;
  emitterCore: THREE.Mesh;
  emitterRing: THREE.Mesh;
  emitterMaterial: THREE.MeshBasicMaterial;
  flareGeometries: THREE.BufferGeometry[];
};

type ImpactMark = {
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  accentMaterial: THREE.MeshBasicMaterial;
  position: THREE.Vector3;
  weapon: WeaponId;
  age: number;
  duration: number;
};

const FORWARD = new THREE.Vector3(0, 0, -1);
const SURFACE_NORMAL = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const ORIENT_DIRECTION = new THREE.Vector3();
const MAX_TRANSIENT_EFFECTS = 48;
const MAX_TRAIL_EFFECTS = 6;
const MAX_STUCK_TRACERS = 12;
const MAX_IMPACT_MARKS = 12;
const MAX_EFFECTS_BY_KIND: Record<NonNullable<Effect['kind']>, number> = {
  muzzle: 2,
  beam: 12,
  trail: MAX_TRAIL_EFFECTS,
  impact: 8,
  tracer: MAX_STUCK_TRACERS,
  burst: 4,
};
const MAX_MARKS_BY_WEAPON: Record<WeaponId, number> = {
  machine: 4,
  shotgun: 8,
  rocket: 6,
  plasma: 8,
  laser: 8,
  sniper: 8,
  rail: 8,
  disc: 10,
};
// Persistent projectile silhouettes carry the shot; these short-lived trail
// wisps only need enough overlap to read as motion. Keeping the global token
// rate bounded avoids allocation/GC bursts when several bots fire together.
const TRAIL_SPAWNS_PER_SECOND = 20;
const TRAIL_BURST_ALLOWANCE = 3;
const GRAPPLE_CURVE_AMOUNTS = [0.12, 0.34, 0.58, 0.82] as const;

function additiveMaterial(color: number, opacity = 1, depthTest = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function createSmokeTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create weapon smoke texture.');
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size * 2 - 1;
      const ny = (y + 0.5) / size * 2 - 1;
      const radius = Math.hypot(nx * 0.94, ny);
      const broad = Math.max(0, 1 - radius);
      const billow = Math.sin(nx * 9.7 + Math.sin(ny * 5.3) * 1.7) * 0.5
        + Math.sin(ny * 13.1 - nx * 4.6) * 0.3
        + Math.sin((nx + ny) * 23.7) * 0.2;
      const density = THREE.MathUtils.clamp(
        Math.pow(broad, 1.55) * (0.76 + billow * 0.24) - Math.max(0, radius - 0.72) * 0.16,
        0,
        1,
      );
      const offset = (y * size + x) * 4;
      image.data[offset] = 255;
      image.data[offset + 1] = 255;
      image.data[offset + 2] = 255;
      image.data[offset + 3] = Math.round(density * 255);
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'weapon-soft-smoke-alpha';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.userData.source = 'procedural-soft-density';
  return texture;
}

function createTracerRampTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create weapon tracer ramp.');
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#000000');
  gradient.addColorStop(0.08, '#525252');
  gradient.addColorStop(0.24, '#f2f2f2');
  gradient.addColorStop(0.5, '#ffffff');
  gradient.addColorStop(0.76, '#f2f2f2');
  gradient.addColorStop(0.94, '#3b3b3b');
  gradient.addColorStop(1, '#000000');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'weapon-tracer-longitudinal-ramp';
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.userData.source = 'procedural-longitudinal-energy-ramp';
  return texture;
}

function smokeMaterial(
  map: THREE.Texture,
  color = 0x665e58,
  opacity = 0.14,
  depthTest = false,
): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map,
    color,
    transparent: true,
    opacity,
    blending: THREE.NormalBlending,
    depthWrite: false,
    depthTest,
    toneMapped: true,
  });
}

function suppressSawSlingLights(weapon: WeaponId): boolean {
  return weapon === 'disc';
}

function orientBetween(root: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3): number {
  const direction = ORIENT_DIRECTION.copy(end).sub(start);
  const length = direction.length();
  root.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) root.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length));
  return length;
}

export class WeaponVfxSystem {
  private readonly effects: Effect[] = [];
  private readonly marks: ImpactMark[] = [];
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly tempDirection = new THREE.Vector3();
  private readonly tempDirectionB = new THREE.Vector3();
  private readonly tempSide = new THREE.Vector3();
  private readonly laserLaggedEnd = new THREE.Vector3();
  private readonly laserLiveVector = new THREE.Vector3();
  private readonly laserLaggedVector = new THREE.Vector3();
  private readonly laserLivePoint = new THREE.Vector3();
  private readonly laserLaggedPoint = new THREE.Vector3();
  private readonly laserPoints = Array.from({ length: 11 }, () => new THREE.Vector3());
  private readonly sharedGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly sharedGeometrySet = new Set<THREE.BufferGeometry>();
  private readonly sharedProjectileMaterials = new Map<string, THREE.Material>();
  private readonly grappleCurvePoints = Array.from({ length: 6 }, () => new THREE.Vector3());
  private continuousLaser?: ContinuousLaser;
  private grappleRoot?: THREE.Group;
  private grappleCable?: THREE.Group;
  private readonly grappleCableSegments: THREE.Mesh[] = [];
  private grappleHook?: THREE.Mesh;
  private grappleHookCore?: THREE.Mesh;
  private readonly grappleMaterials: THREE.Material[] = [];
  private readonly machineMuzzlePool: MachineMuzzlePoolEntry[] = [];
  private readonly machineBeamPool: MachineBeamPoolEntry[] = [];
  private readonly smokeTexture = createSmokeTexture();
  private readonly tracerRampTexture = createTracerRampTexture();
  private machineMuzzleCursor = 0;
  private machineBeamCursor = 0;
  private laserPhase = 0;
  private laserBend = 0;
  private ropePhase = 0;
  private trailSpawnTokens = TRAIL_BURST_ALLOWANCE;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly random: () => number,
    private readonly grenadeModel: THREE.Group,
    private readonly reducedEffects = false,
  ) {
    // Imported geometry is shared by every thrown clone. Marking it as a VFX
    // resource keeps Game's per-entity cleanup from disposing the source mesh.
    this.grenadeModel.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.userData.sharedWeaponVfx = true;
    });
  }

  prewarm(renderer: THREE.WebGLRenderer): void {
    // Dynamic weapon effects otherwise compile/upload on the first trigger
    // pull. Precompile the actual shared ballistic/energy geometry while the
    // ready screen is visible so a cold plasma or rocket shot cannot stall a
    // live frame.
    this.ensureMachineEffectPools();
    const prewarmScene = new THREE.Scene();
    prewarmScene.fog = this.scene.fog;
    const hot = additiveMaterial(0xffffff, 1, false);
    const glow = additiveMaterial(0x79e8ff, 0.72, true);
    hot.alphaMap = this.tracerRampTexture;
    glow.alphaMap = this.tracerRampTexture;
    const smoke = smokeMaterial(this.smokeTexture, 0x776f68, 0.1, false);
    const standard = new THREE.MeshStandardMaterial({ color: 0xb9a7a0, roughness: 0.28, metalness: 0.88 });
    const physical = new THREE.MeshPhysicalMaterial({
      color: 0x5f1717,
      roughness: 0.3,
      metalness: 0.48,
      clearcoat: 0.62,
    });
    const anisotropicPhysical = new THREE.MeshPhysicalMaterial({
      color: 0x7d878b,
      roughness: 0.2,
      metalness: 1,
      envMapIntensity: 0.78,
      anisotropy: 1,
    });
    const geometries = [
      this.sharedGeometry('muzzle-machine-cone-7', () => new THREE.ConeGeometry(1, 1, 7, 1, true)),
      this.sharedGeometry('muzzle-shotgun-cone-12', () => new THREE.ConeGeometry(1, 1, 12, 1, true)),
      this.sharedGeometry('muzzle-laser-cone', () => new THREE.ConeGeometry(0.045, 0.44, 10, 1, true)),
      ...Array.from({ length: 3 }, (_, index) => this.sharedGeometry(
        `muzzle-laser-aperture-${index}`,
        () => new THREE.TorusGeometry(0.07 + index * 0.035, 0.007, 5, 24),
      )),
      this.sharedGeometry('muzzle-sniper-cone', () => new THREE.ConeGeometry(0.045, 0.82, 7, 1, true)),
      this.sharedGeometry('muzzle-rail-outer', () => new THREE.ConeGeometry(0.045, 1.05, 7, 1, true)),
      this.sharedGeometry('muzzle-rail-core', () => new THREE.ConeGeometry(0.035, 1.2, 8, 1, true)),
      ...Array.from({ length: 4 }, (_, index) => this.sharedGeometry(
        `muzzle-rail-arc-${index}`,
        () => this.createRailMuzzleArcGeometry(index),
      )),
      this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
      ...[5, 6, 7, 8, 10].map((sides) => this.sharedGeometry(
        `beam-cylinder-${sides}`,
        () => new THREE.CylinderGeometry(1, 0.72, 1, sides, 1, true),
      )),
      ...Array.from({ length: 3 }, (_, index) => this.sharedGeometry(
        `beam-shotgun-wave-${index}`,
        () => new THREE.TorusGeometry(0.055 + index * 0.022, 0.006, 5, 18),
      )),
      ...Array.from({ length: 2 }, (_, index) => this.sharedGeometry(
        `beam-sniper-wave-${index}`,
        () => new THREE.TorusGeometry(0.035 + index * 0.035, 0.005, 5, 18),
      )),
      ...Array.from({ length: 4 }, (_, index) => {
        const amount = (index + 1) / 5;
        return this.sharedGeometry(
          `beam-rail-wave-standard-${index}`,
          () => new THREE.TorusGeometry(0.11 * (0.88 + amount * 0.22), 0.008, 5, 20),
        );
      }),
      ...Array.from({ length: 7 }, (_, index) => {
        const amount = (index + 1) / 8;
        return this.sharedGeometry(
          `beam-rail-wave-overcharged-${index}`,
          () => new THREE.TorusGeometry(0.16 * (0.88 + amount * 0.22), 0.008, 5, 20),
        );
      }),
      this.sharedGeometry('impact-unit-circle-18', () => new THREE.CircleGeometry(1, 18)),
      this.sharedGeometry('impact-unit-ring-28', () => new THREE.RingGeometry(0.84, 1, 28)),
      this.sharedGeometry('impact-shard-cone', () => new THREE.ConeGeometry(1, 1, 4)),
      this.sharedGeometry('projectile-plasma-core', () => new THREE.IcosahedronGeometry(0.14, 2)),
      this.sharedGeometry('projectile-plasma-shell', () => new THREE.IcosahedronGeometry(0.27, 2)),
      this.sharedGeometry('projectile-plasma-ring', () => new THREE.TorusGeometry(0.3, 0.018, 6, 22)),
      this.sharedGeometry('projectile-plasma-tail', () => new THREE.ConeGeometry(0.16, 0.65, 10, 1, true)),
      this.sharedGeometry('trail-plasma-mote', () => new THREE.IcosahedronGeometry(0.075, 1)),
      this.sharedGeometry('trail-plasma-shell', () => new THREE.IcosahedronGeometry(0.14, 1)),
      this.sharedGeometry('muzzle-plasma-chamber', () => new THREE.IcosahedronGeometry(0.18, 2)),
      this.sharedGeometry('muzzle-plasma-core', () => new THREE.IcosahedronGeometry(0.075, 1)),
      this.sharedGeometry('muzzle-plasma-ring', () => new THREE.TorusGeometry(0.21, 0.014, 6, 24)),
      ...Array.from({ length: 3 }, (_, index) => this.sharedGeometry(
        `muzzle-disc-field-ring-${index}`,
        () => new THREE.TorusGeometry(0.19 + index * 0.055, 0.014 - index * 0.002, 7, 32),
      )),
      this.sharedGeometry('muzzle-disc-induction-ring', () => new THREE.RingGeometry(0.055, 0.115, 24)),
      this.sharedGeometry('muzzle-rocket-outer-plume', () => new THREE.ConeGeometry(0.17, 0.82, 12, 1, true)),
      this.sharedGeometry('muzzle-rocket-inner-plume', () => new THREE.ConeGeometry(0.065, 0.68, 10, 1, true)),
      this.sharedGeometry(
        'muzzle-rocket-heat-shell',
        () => new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0.15, Math.PI * 0.7),
      ),
      this.sharedGeometry('muzzle-rocket-pressure', () => new THREE.TorusGeometry(0.2, 0.016, 6, 28)),
      this.sharedGeometry('projectile-rocket-fuselage', () => new THREE.CylinderGeometry(0.075, 0.09, 0.34, 12)),
      this.sharedGeometry('projectile-rocket-nose', () => new THREE.ConeGeometry(0.075, 0.15, 12)),
      this.sharedGeometry('projectile-rocket-band', () => new THREE.TorusGeometry(0.082, 0.012, 7, 18)),
      this.sharedGeometry('projectile-rocket-fin', () => new THREE.BoxGeometry(0.022, 0.15, 0.12)),
      this.sharedGeometry('projectile-rocket-exhaust', () => new THREE.ConeGeometry(0.085, 0.32, 10, 1, true)),
      this.sharedGeometry('projectile-rocket-exhaust-core', () => new THREE.ConeGeometry(0.028, 0.22, 8, 1, true)),
      this.sharedGeometry('projectile-rocket-heat', () => new THREE.SphereGeometry(0.1, 10, 7)),
      this.sharedGeometry('projectile-rocket-pressure', () => new THREE.TorusGeometry(0.1, 0.009, 5, 18)),
      this.sharedGeometry('trail-rocket-ember', () => new THREE.IcosahedronGeometry(0.052, 1)),
      this.sharedGeometry('trail-rocket-heat', () => new THREE.SphereGeometry(0.11, 8, 6)),
      this.sharedGeometry('trail-disc-ring-0', () => new THREE.TorusGeometry(0.19, 0.006, 5, 24)),
      this.sharedGeometry('trail-disc-ring-1', () => new THREE.TorusGeometry(0.155, 0.006, 5, 24)),
      this.sharedGeometry('grenade-fuse-indicator', () => new THREE.TorusGeometry(0.15, 0.008, 6, 24)),
      this.sharedGeometry('explosion-rocket-core', () => new THREE.SphereGeometry(0.24, 14, 10)),
      this.sharedGeometry('explosion-rocket-wave', () => new THREE.RingGeometry(0.22, 0.3, 32)),
      this.sharedGeometry('grapple-segment', () => new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true)),
      this.sharedGeometry('grapple-hook', () => new THREE.TorusGeometry(0.19, 0.04, 8, 18)),
      this.sharedGeometry('grapple-hook-core', () => new THREE.IcosahedronGeometry(0.095, 1)),
      this.sharedGeometry('mark-unit-circle-18', () => new THREE.CircleGeometry(1, 18)),
      this.sharedGeometry('mark-unit-circle-12', () => new THREE.CircleGeometry(1, 12)),
      this.sharedGeometry('mark-unit-circle-6', () => new THREE.CircleGeometry(1, 6)),
      this.sharedGeometry('mark-rocket-unit-ring', () => new THREE.RingGeometry(0.83, 1, 22)),
      this.sharedGeometry('mark-plasma-unit-ring', () => new THREE.RingGeometry(0.46, 1, 20)),
      this.sharedGeometry('mark-unit-plane', () => new THREE.PlaneGeometry(1, 1)),
      this.sharedGeometry('mark-rail-unit-ring-0', () => new THREE.RingGeometry(0.75, 1, 26)),
      this.sharedGeometry('mark-rail-unit-ring-1', () => new THREE.RingGeometry(0.38 / 0.44, 1, 26)),
      this.sharedGeometry('mark-rail-unit-ring-2', () => new THREE.RingGeometry(0.58 / 0.64, 1, 26)),
      this.sharedGeometry('mark-puncture-unit-ring-7', () => new THREE.RingGeometry(0.44, 1, 7)),
      this.sharedGeometry('mark-puncture-unit-ring-12', () => new THREE.RingGeometry(0.44, 1, 12)),
      this.sharedGeometry('mark-disc-unit-ring', () => new THREE.RingGeometry(0.36, 0.76, 20)),
      this.sharedGeometry('tracer-needle', () => new THREE.CylinderGeometry(0.018, 0.012, 0.2, 6)),
      this.sharedGeometry('tracer-tip', () => new THREE.ConeGeometry(0.035, 0.08, 6)),
      this.sharedGeometry('tracer-ring', () => new THREE.TorusGeometry(0.05, 0.008, 5, 12)),
    ];
    geometries.forEach((geometry, index) => {
      const material = index % 2 ? glow : hot;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((index % 4) * 0.02, Math.floor(index / 4) * 0.02, -1);
      mesh.frustumCulled = false;
      prewarmScene.add(mesh);
    });
    const smokeSprite = new THREE.Sprite(smoke);
    smokeSprite.position.set(0, 0, -1);
    smokeSprite.scale.setScalar(0.2);
    smokeSprite.frustumCulled = false;
    prewarmScene.add(smokeSprite);
    const sniperLineGeometry = new LineGeometry();
    sniperLineGeometry.setPositions([0, 0, -1, 0.25, 0, -4]);
    const sniperLineMaterial = new LineMaterial({
      color: 0xfff4df,
      linewidth: 3.4,
      worldUnits: false,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    sniperLineMaterial.resolution.set(
      Math.max(1, window.innerWidth * window.devicePixelRatio),
      Math.max(1, window.innerHeight * window.devicePixelRatio),
    );
    const sniperLine = new Line2(sniperLineGeometry, sniperLineMaterial);
    sniperLine.frustumCulled = false;
    prewarmScene.add(sniperLine);
    const unitBox = this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1));
    const standardMesh = new THREE.Mesh(unitBox, standard);
    const physicalMesh = new THREE.Mesh(unitBox, physical);
    standardMesh.frustumCulled = false;
    physicalMesh.frustumCulled = false;
    prewarmScene.add(standardMesh, physicalMesh);
    const discCutter = new THREE.Mesh(
      this.sharedGeometry('projectile-disc-cutter', () => this.createDiscCutterGeometry()),
      anisotropicPhysical,
    );
    const discHub = new THREE.Mesh(
      this.sharedGeometry('projectile-disc-hub', () => new THREE.CylinderGeometry(0.125, 0.125, 0.085, 18, 1)),
      anisotropicPhysical,
    );
    discCutter.frustumCulled = false;
    discHub.frustumCulled = false;
    prewarmScene.add(discCutter, discHub);
    const burstGeometry = this.sharedGeometry(
      'burst-spark-cylinder',
      () => new THREE.CylinderGeometry(0.009, 0.022, 1, 5),
    );
    const burst = new THREE.InstancedMesh(burstGeometry, hot, 2);
    burst.setColorAt(0, new THREE.Color(0xffffff));
    burst.setColorAt(1, new THREE.Color(0xff6b2e));
    burst.frustumCulled = false;
    prewarmScene.add(burst);
    this.continuousLaser ??= this.createContinuousLaser(0x76ffb0);
    const laserRoot = this.continuousLaser.root;
    this.scene.remove(laserRoot);
    laserRoot.visible = true;
    prewarmScene.add(laserRoot);
    prewarmScene.add(this.grenadeModel);
    renderer.compile(prewarmScene, this.camera);
    // compile() prepares shader programs but does not force every vertex/index
    // buffer through the driver. One hidden startup render uploads the shared
    // projectile and impact geometry now instead of blocking the first rocket
    // or plasma volley in the middle of a match.
    renderer.render(prewarmScene, this.camera);
    prewarmScene.remove(this.grenadeModel);
    prewarmScene.remove(laserRoot);
    laserRoot.visible = false;
    this.scene.add(laserRoot);
    hot.dispose();
    glow.dispose();
    smoke.dispose();
    sniperLineGeometry.dispose();
    sniperLineMaterial.dispose();
    standard.dispose();
    physical.dispose();
    anisotropicPhysical.dispose();
    prewarmScene.clear();
  }

  private ensureMachineEffectPools(): void {
    if (!this.machineMuzzlePool.length) {
      const geometry = this.sharedGeometry(
        'muzzle-machine-cone-7',
        () => new THREE.ConeGeometry(1, 1, 7, 1, true),
      );
      for (let index = 0; index < 3; index += 1) {
        const root = new THREE.Group();
        root.name = `machine-muzzle-pool-${index}`;
        root.visible = false;
        const hot = additiveMaterial(0xfff4c2, 0.92, false);
        const glow = additiveMaterial(0xffbe55, 0.66, false);
        const core = new THREE.Mesh(geometry, hot);
        core.name = 'machine-muzzle-hot-core';
        core.rotation.x = -Math.PI * 0.5;
        core.position.set(-0.035, 0.028, -0.27);
        core.scale.set(0.045, 0.5, 0.045);
        const envelope = new THREE.Mesh(geometry, glow);
        envelope.name = 'machine-muzzle-heat-envelope';
        envelope.rotation.x = -Math.PI * 0.5;
        envelope.position.copy(core.position);
        envelope.scale.set(0.07, 0.39, 0.07);
        root.add(envelope, core);
        root.traverse((object) => { object.frustumCulled = false; });
        const effect: Effect = {
          root,
          age: 0,
          duration: 0.085,
          materials: [hot, glow],
          kind: 'muzzle',
          pooled: true,
          update: (progress) => {
            const fade = Math.pow(1 - progress, 1.7);
            hot.opacity = fade * 0.92;
            glow.opacity = fade * 0.66;
            root.scale.z = 0.72 + Math.sin(progress * Math.PI) * 0.42;
            root.scale.x = root.scale.y = 0.9 + progress * 0.28;
          },
        };
        this.machineMuzzlePool.push({ root, hot, glow, effect });
        this.scene.add(root);
      }
    }

    if (!this.machineBeamPool.length) {
      const packetGeometry = this.sharedGeometry(
        'beam-cylinder-6',
        () => new THREE.CylinderGeometry(1, 0.72, 1, 6, 1, true),
      );
      const haloGeometry = this.sharedGeometry(
        'beam-cylinder-7',
        () => new THREE.CylinderGeometry(1, 0.72, 1, 7, 1, true),
      );
      for (let index = 0; index < 8; index += 1) {
        const root = new THREE.Group();
        root.name = `machine-beam-pool-${index}`;
        root.visible = false;
        const core = additiveMaterial(0xfff4c2, 0.92);
        const glow = additiveMaterial(0xffbe55, 0.22);
        core.alphaMap = this.tracerRampTexture;
        glow.alphaMap = this.tracerRampTexture;
        const packet = new THREE.Mesh(packetGeometry, core);
        packet.name = 'machine-hot-tracer';
        const halo = new THREE.Mesh(haloGeometry, glow);
        halo.name = 'machine-tracer-heat-envelope';
        root.add(packet, halo);
        root.traverse((object) => { object.frustumCulled = false; });
        const direction = new THREE.Vector3();
        let entry!: MachineBeamPoolEntry;
        const effect: Effect = {
          root,
          age: 0,
          duration: 0.06,
          materials: [core, glow],
          kind: 'beam',
          pooled: true,
          update: (progress, delta) => {
            const fade = Math.pow(1 - progress, 1.8);
            core.opacity = fade * 0.92;
            glow.opacity = fade * 0.22;
            root.position.addScaledVector(direction, delta * entry.speed);
          },
        };
        entry = { root, packet, halo, core, glow, direction, speed: 22, effect };
        this.machineBeamPool.push(entry);
        this.scene.add(root);
      }
    }
  }

  private activateMachineMuzzle(socket: THREE.Object3D, color: number): void {
    this.ensureMachineEffectPools();
    const entry = this.machineMuzzlePool[this.machineMuzzleCursor];
    this.machineMuzzleCursor = (this.machineMuzzleCursor + 1) % this.machineMuzzlePool.length;
    const activeIndex = this.effects.indexOf(entry.effect);
    if (activeIndex >= 0) this.removeEffect(activeIndex);
    socket.updateWorldMatrix(true, false);
    socket.getWorldPosition(entry.root.position);
    socket.getWorldQuaternion(entry.root.quaternion);
    entry.root.scale.set(1, 1, 1);
    entry.root.visible = true;
    entry.hot.color.setHex(0xfff4c2);
    entry.glow.color.setHex(color);
    entry.hot.opacity = 0.92;
    entry.glow.opacity = 0.66;
    entry.effect.age = 0;
    this.addEffect(entry.effect);
  }

  private activateMachineBeam(
    start: THREE.Vector3,
    end: THREE.Vector3,
    color: number,
    duration: number,
  ): void {
    this.ensureMachineEffectPools();
    const entry = this.machineBeamPool[this.machineBeamCursor];
    this.machineBeamCursor = (this.machineBeamCursor + 1) % this.machineBeamPool.length;
    const activeIndex = this.effects.indexOf(entry.effect);
    if (activeIndex >= 0) this.removeEffect(activeIndex);
    const visibleStart = this.tempPosition.copy(start).lerp(end, 0.11);
    const length = orientBetween(entry.root, visibleStart, end);
    if (length <= 0.001) return;
    const packetLength = Math.min(3.8, Math.max(0.48, length * 0.12));
    const positionY = -length * 0.24;
    entry.packet.position.y = positionY;
    entry.packet.scale.set(0.012, packetLength, 0.012);
    entry.halo.position.y = positionY;
    entry.halo.scale.set(0.032, packetLength * 1.18, 0.032);
    entry.root.scale.set(1, 1, 1);
    entry.root.visible = true;
    entry.core.color.setHex(0xfff4c2);
    entry.glow.color.setHex(color);
    entry.core.opacity = 0.92;
    entry.glow.opacity = 0.22;
    entry.direction.copy(end).sub(visibleStart).normalize();
    entry.speed = Math.max(22, length / Math.max(duration, 0.03));
    entry.effect.age = 0;
    entry.effect.duration = duration;
    this.addEffect(entry.effect);
  }

  muzzle(weapon: WeaponId, color: number, socket: THREE.Object3D): void {
    // The exposed saw already supplies the firing silhouette. Extra collapse
    // rings and sparks caused the flashing/shimmering report and multiplied
    // draw calls during ricochet volleys.
    if (suppressSawSlingLights(weapon)) return;
    if (!this.hasTransientCapacity()) return;
    if (weapon === 'machine') {
      this.activateMachineMuzzle(socket, color);
      return;
    }
    socket.updateWorldMatrix(true, false);
    socket.getWorldPosition(this.tempPosition);
    socket.getWorldQuaternion(this.tempQuaternion);

    const root = new THREE.Group();
    root.name = `${weapon}-muzzle-vfx`;
    root.position.copy(this.tempPosition);
    root.quaternion.copy(this.tempQuaternion);

    const hotColors: Record<WeaponId, number> = {
      machine: 0xfff4c2,
      shotgun: 0xfff0cf,
      rocket: 0xfff2b0,
      plasma: 0xffeeff,
      laser: 0xebfff1,
      sniper: 0xfff7de,
      rail: 0xf9ffca,
      disc: 0xffd37a,
    };
    const hotOpacity = weapon === 'disc' ? 0.42 : 0.92;
    const glowOpacity = weapon === 'disc' ? 0.26 : 0.66;
    const softOpacity = weapon === 'disc' ? 0.08 : 0.22;
    const hot = additiveMaterial(hotColors[weapon], hotOpacity, false);
    const glow = additiveMaterial(color, glowOpacity, false);
    const soft = additiveMaterial(color, softOpacity, false);
    const materials: THREE.Material[] = [hot, glow, soft];

    // Each weapon owns a different silhouette and time profile. This keeps the
    // muzzle event readable in a frozen frame without falling back to a shared
    // white cone or a large camera-facing disc.
    if (weapon === 'shotgun') {
      const coneGeometry = this.sharedGeometry(
        'muzzle-shotgun-cone-12',
        () => new THREE.ConeGeometry(1, 1, 12, 1, true),
      );
      for (let index = 0; index < (this.reducedEffects ? 1 : 2); index += 1) {
        const blast = new THREE.Mesh(coneGeometry, index === 0 ? hot : glow);
        blast.name = `shotgun-volumetric-blast-${index}`;
        blast.rotation.x = -Math.PI * 0.5;
        blast.position.z = -0.3 - index * 0.12;
        blast.rotation.z = index * 0.43;
        blast.scale.set(0.14 + index * 0.09, 0.7 + index * 0.17, 0.14 + index * 0.09);
        root.add(blast);
      }
      const smoke = smokeMaterial(this.smokeTexture, 0x8c8377, 0.13, false);
      materials.push(smoke);
      const wisp = new THREE.Sprite(smoke);
      wisp.name = 'shotgun-smoke-wisp';
      wisp.position.set(0.04, 0.06, -0.24);
      wisp.scale.setScalar(0.22);
      root.add(wisp);
      root.userData.softSmoke = true;
      for (let index = 0; index < (this.reducedEffects ? 1 : 2); index += 1) {
        const spark = new THREE.Mesh(
          this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
          index === 0 ? hot : glow,
        );
        spark.name = `shotgun-spark-${index}`;
        spark.scale.set(0.012, 0.012, 0.28 + index * 0.1);
        spark.userData.baseScaleZ = spark.scale.z;
        spark.position.set((this.random() - 0.5) * 0.38, (this.random() - 0.5) * 0.28, -0.38 - this.random() * 0.22);
        spark.rotation.z = this.random() * Math.PI;
        root.add(spark);
      }
    } else if (weapon === 'rocket') {
      const outerPlume = new THREE.Mesh(
        this.sharedGeometry('muzzle-rocket-outer-plume', () => new THREE.ConeGeometry(0.17, 0.82, 12, 1, true)),
        glow,
      );
      outerPlume.name = 'rocket-luminous-plume';
      outerPlume.rotation.x = -Math.PI * 0.5;
      outerPlume.position.z = -0.34;
      const innerPlume = new THREE.Mesh(
        this.sharedGeometry('muzzle-rocket-inner-plume', () => new THREE.ConeGeometry(0.065, 0.68, 10, 1, true)),
        hot,
      );
      innerPlume.name = 'rocket-hot-exhaust-core';
      innerPlume.rotation.x = -Math.PI * 0.5;
      innerPlume.position.z = -0.29;
      const heatShell = new THREE.Mesh(
        this.sharedGeometry(
          'muzzle-rocket-heat-shell',
          () => new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, 0.15, Math.PI * 0.7),
        ),
        soft,
      );
      heatShell.name = 'rocket-heat-shimmer';
      heatShell.scale.z = 1.7;
      heatShell.position.z = -0.18;
      const pressure = new THREE.Mesh(
        this.sharedGeometry('muzzle-rocket-pressure', () => new THREE.TorusGeometry(0.2, 0.016, 6, 28)),
        glow,
      );
      pressure.name = 'rocket-pressure-ring';
      pressure.position.z = -0.12;
      root.add(outerPlume, innerPlume, heatShell, pressure);
    } else if (weapon === 'plasma') {
      const chamberOrb = new THREE.Mesh(
        this.sharedGeometry('muzzle-plasma-chamber', () => new THREE.IcosahedronGeometry(0.18, 2)),
        glow,
      );
      chamberOrb.name = 'plasma-chamber-discharge';
      chamberOrb.position.z = -0.18;
      const orbCore = new THREE.Mesh(
        this.sharedGeometry('muzzle-plasma-core', () => new THREE.IcosahedronGeometry(0.075, 1)),
        hot,
      );
      orbCore.position.z = -0.18;
      root.add(chamberOrb, orbCore);
      const torus = new THREE.Mesh(
        this.sharedGeometry('muzzle-plasma-ring', () => new THREE.TorusGeometry(0.21, 0.014, 6, 24)),
        glow,
      );
      torus.name = 'plasma-discharge-ring';
      torus.position.z = -0.22;
      root.add(torus);
    } else if (weapon === 'laser') {
      const emitterCore = new THREE.Mesh(
        this.sharedGeometry('muzzle-laser-cone', () => new THREE.ConeGeometry(0.045, 0.44, 10, 1, true)),
        hot,
      );
      emitterCore.name = 'laser-emitter-core-flare';
      emitterCore.rotation.x = -Math.PI * 0.5;
      emitterCore.position.z = -0.22;
      root.add(emitterCore);
      for (let index = 0; index < (this.reducedEffects ? 2 : 3); index += 1) {
        const aperture = new THREE.Mesh(
          this.sharedGeometry(
            `muzzle-laser-aperture-${index}`,
            () => new THREE.TorusGeometry(0.07 + index * 0.035, 0.007, 5, 24),
          ),
          index === 0 ? hot : glow,
        );
        aperture.name = `laser-aperture-flare-${index}`;
        aperture.position.z = -0.025 - index * 0.028;
        root.add(aperture);
      }
      for (let index = 0; index < (this.reducedEffects ? 2 : 4); index += 1) {
        const blade = new THREE.Mesh(
          this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
          glow,
        );
        blade.scale.set(0.012, 0.16, 0.012);
        blade.position.z = -0.06;
        blade.rotation.z = index * Math.PI * 0.5;
        root.add(blade);
      }
    } else if (weapon === 'sniper') {
      const needle = new THREE.Mesh(
        this.sharedGeometry('muzzle-sniper-cone', () => new THREE.ConeGeometry(0.045, 0.82, 7, 1, true)),
        hot,
      );
      needle.name = 'sniper-directional-needle';
      needle.rotation.x = -Math.PI * 0.5;
      needle.position.z = -0.4;
      root.add(needle);
      for (let index = 0; index < (this.reducedEffects ? 3 : 6); index += 1) {
        const blade = new THREE.Mesh(
          this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
          index % 2 ? glow : hot,
        );
        blade.name = `sniper-star-blade-${index}`;
        blade.scale.set(0.012, 0.28 + (index % 2) * 0.13, 0.025);
        blade.position.z = -0.06;
        blade.rotation.z = index * Math.PI / 3;
        root.add(blade);
      }
      for (let index = 0; index < (this.reducedEffects ? 1 : 3); index += 1) {
        const smoke = smokeMaterial(this.smokeTexture, 0x7d7870, 0.09 - index * 0.012, false);
        materials.push(smoke);
        const wisp = new THREE.Sprite(smoke);
        wisp.name = `sniper-smoke-${index}`;
        wisp.scale.setScalar(0.14 + index * 0.035);
        wisp.position.set((this.random() - 0.5) * 0.13, 0.04 + this.random() * 0.12, -0.1 - index * 0.11);
        root.add(wisp);
      }
      root.userData.softSmoke = true;
    } else if (weapon === 'disc') {
      // The launcher pinches a wide magnetic aperture down around the disc.
      // Teal field lines and amber induction sparks keep this distinct from
      // the railgun's white longitudinal discharge.
      for (let index = 0; index < (this.reducedEffects ? 2 : 3); index += 1) {
        const fieldRing = new THREE.Mesh(
          this.sharedGeometry(
            `muzzle-disc-field-ring-${index}`,
            () => new THREE.TorusGeometry(0.19 + index * 0.055, 0.014 - index * 0.002, 7, 32),
          ),
          index === 1 ? hot : glow,
        );
        fieldRing.name = `disc-magnetic-collapse-ring-${index}`;
        fieldRing.position.z = -0.08 - index * 0.065;
        fieldRing.rotation.z = index * 0.52;
        fieldRing.userData.spin = index % 2 ? -1 : 1;
        root.add(fieldRing);
      }
      const inductionCore = new THREE.Mesh(
        this.sharedGeometry('muzzle-disc-induction-ring', () => new THREE.RingGeometry(0.055, 0.115, 24)),
        glow,
      );
      inductionCore.name = 'disc-induction-aperture';
      inductionCore.position.z = -0.24;
      root.add(inductionCore);
      for (let index = 0; index < (this.reducedEffects ? 2 : 4); index += 1) {
        const spark = new THREE.Mesh(
          this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
          index % 3 === 0 ? hot : glow,
        );
        spark.scale.set(0.009, 0.009, 0.16 + this.random() * 0.22);
        spark.userData.baseScaleZ = spark.scale.z;
        const angle = index * Math.PI * 2 / 4 + (this.random() - 0.5) * 0.18;
        spark.name = `disc-induction-spark-${index}`;
        spark.position.set(Math.cos(angle) * (0.1 + this.random() * 0.14), Math.sin(angle) * (0.1 + this.random() * 0.14), -0.15);
        spark.rotation.set((this.random() - 0.5) * 0.42, (this.random() - 0.5) * 0.42, angle);
        spark.userData.radial = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
        root.add(spark);
      }
    } else {
      const leftRail = new THREE.Mesh(
        this.sharedGeometry('muzzle-rail-outer', () => new THREE.ConeGeometry(0.045, 1.05, 7, 1, true)),
        glow,
      );
      leftRail.name = 'rail-discharge-left';
      leftRail.rotation.x = -Math.PI * 0.5;
      leftRail.position.set(-0.075, 0, -0.5);
      const rightRail = leftRail.clone();
      rightRail.name = 'rail-discharge-right';
      rightRail.position.x = 0.075;
      const core = new THREE.Mesh(
        this.sharedGeometry('muzzle-rail-core', () => new THREE.ConeGeometry(0.035, 1.2, 8, 1, true)),
        hot,
      );
      core.name = 'rail-collapse-core';
      core.rotation.x = -Math.PI * 0.5;
      core.position.z = -0.57;
      root.add(leftRail, rightRail, core);
      for (let index = 0; index < (this.reducedEffects ? 2 : 4); index += 1) {
        const arc = new THREE.Mesh(
          this.sharedGeometry(`muzzle-rail-arc-${index}`, () => this.createRailMuzzleArcGeometry(index)),
          index === 0 ? hot : glow,
        );
        arc.name = `rail-collapse-arc-${index}`;
        root.add(arc);
      }
    }

    root.traverse((object) => { object.frustumCulled = false; });
    this.scene.add(root);
    const duration = weapon === 'rail' ? 0.2
      : weapon === 'disc' ? 0.18
      : weapon === 'rocket' || weapon === 'shotgun' ? 0.16
        : weapon === 'plasma' || weapon === 'sniper' ? 0.12 : 0.085;
    this.addEffect({
      root,
      age: 0,
      duration,
      materials,
      kind: 'muzzle',
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, weapon === 'shotgun' ? 1.15 : 1.7);
        hot.opacity = envelope * hotOpacity;
        glow.opacity = envelope * glowOpacity;
        if (soft) soft.opacity = envelope * softOpacity;
        root.scale.z = 0.72 + Math.sin(progress * Math.PI) * (weapon === 'rail' ? 0.7 : 0.42);
        root.scale.x = root.scale.y = weapon === 'disc' ? 1 : 0.9 + progress * (weapon === 'shotgun' ? 0.65 : 0.28);
        for (const child of root.children) {
          if (child.name.startsWith('disc-magnetic-collapse-ring')) {
            const collapse = Math.max(0.12, 1 - THREE.MathUtils.smoothstep(progress, 0, 0.82) * 0.82);
            child.scale.setScalar(collapse);
            child.rotation.z += delta * 16 * (child.userData.spin as number);
            child.position.z -= delta * 1.4;
          } else if (child.name.startsWith('disc-induction-spark')) {
            const radial = child.userData.radial as THREE.Vector2;
            child.position.x += radial.x * delta * 1.8;
            child.position.y += radial.y * delta * 1.8;
            child.position.z -= delta * 3.6;
            child.scale.z = Math.max(0.08, envelope);
          } else if (child.name.includes('smoke')) {
            child.position.y += 0.008;
            child.scale.multiplyScalar(1.045);
          } else if (child.name.includes('ring')) {
            child.rotation.z += weapon === 'plasma' ? 0.28 : 0.11;
            child.scale.multiplyScalar(1.035);
          } else if (child.name.includes('spark')) {
            child.position.z -= 0.035;
            child.scale.z = ((child.userData.baseScaleZ as number | undefined) ?? 1) * Math.max(0.08, envelope);
          }
        }
      },
    });
  }

  beam(start: THREE.Vector3, end: THREE.Vector3, weapon: WeaponId, color: number, duration: number): void {
    if (!this.hasTransientCapacity()) return;
    if (weapon === 'machine') {
      this.activateMachineBeam(start, end, color, duration);
      return;
    }
    const visibleStart = start.clone();
    if (weapon === 'shotgun') visibleStart.lerp(end, 0.06);
    const root = new THREE.Group();
    root.name = `${weapon}-beam-vfx`;
    const length = orientBetween(root, visibleStart, end);
    if (length <= 0.001) return;
    const coreMaterial = additiveMaterial(weapon === 'rail' ? 0xfaffd8 : weapon === 'sniper' ? 0xfff4d6 : color, 1);
    const glowMaterial = additiveMaterial(color, 0.34);
    const accentMaterial = additiveMaterial(weapon === 'rail' ? 0x96fbff : 0xffffff, 0.58);
    coreMaterial.alphaMap = this.tracerRampTexture;
    glowMaterial.alphaMap = this.tracerRampTexture;
    accentMaterial.alphaMap = this.tracerRampTexture;
    const materials: THREE.Material[] = [coreMaterial, glowMaterial, accentMaterial];
    const coreOpacity = weapon === 'shotgun' ? duration > 0.1 ? 0.92 : 0.18
      : weapon === 'sniper' ? 0.96 : 1;
    const glowOpacity = weapon === 'shotgun' ? duration > 0.1 ? 0.24 : 0.035
      : weapon === 'sniper' ? 0.18 : weapon === 'rail' ? 0.4 : 0.26;
    coreMaterial.opacity = coreOpacity;
    glowMaterial.opacity = glowOpacity;
    accentMaterial.opacity = weapon === 'rail' ? 0.7 : 0.45;
    let sniperLineCore: LineMaterial | undefined;
    let sniperLineHalo: LineMaterial | undefined;

    const addCylinder = (
      name: string,
      radius: number,
      beamLength: number,
      positionY: number,
      material: THREE.Material,
      sides = 7,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(
        this.sharedGeometry(
          `beam-cylinder-${sides}`,
          () => new THREE.CylinderGeometry(1, 0.72, 1, sides, 1, true),
        ),
        material,
      );
      mesh.name = name;
      mesh.position.y = positionY;
      mesh.scale.set(radius, beamLength, radius);
      root.add(mesh);
      return mesh;
    };

    if (weapon === 'shotgun') {
      const sabot = duration > 0.1;
      const streakLength = sabot ? Math.min(length, 7.5) : Math.min(1.1, length * 0.08);
      const positionY = sabot ? -length * 0.16 : -length * (0.16 + this.random() * 0.32);
      addCylinder(sabot ? 'shotgun-sabot-core' : 'shotgun-pellet-streak', sabot ? 0.016 : 0.0045, streakLength, positionY, coreMaterial, sabot ? 7 : 5);
      addCylinder(sabot ? 'shotgun-sabot-pressure-sleeve' : 'shotgun-pellet-haze', sabot ? 0.055 : 0.012, streakLength * 1.08, positionY, glowMaterial, 7);
      if (sabot) {
        for (let index = 0; index < (this.reducedEffects ? 1 : 3); index += 1) {
          const ring = new THREE.Mesh(
            this.sharedGeometry(
              `beam-shotgun-wave-${index}`,
              () => new THREE.TorusGeometry(0.055 + index * 0.022, 0.006, 5, 18),
            ),
            glowMaterial,
          );
          ring.name = `shotgun-sabot-wave-${index}`;
          ring.rotation.x = Math.PI * 0.5;
          ring.position.y = positionY - streakLength * 0.35 + index * streakLength * 0.28;
          root.add(ring);
        }
      }
    } else if (weapon === 'sniper') {
      // A sniper shot is hitscan, but the visual has to describe the complete
      // muzzle-to-impact relationship in a single glance. One continuous,
      // tapered path is clearer and cheaper than several detached packets and
      // pressure rings, which read as ambient glints on long bright lanes.
      // A fixed-pixel ballistic line stays continuous across 100m+ lanes.
      // World-space tubes become a dotted one-pixel staircase at that range,
      // while simply widening them makes the near end look like a laser wall.
      const lineGeometry = new LineGeometry();
      lineGeometry.setPositions([0, -length * 0.5, 0, 0, length * 0.5, 0]);
      sniperLineHalo = new LineMaterial({
        color,
        linewidth: this.reducedEffects ? 4.2 : 6.2,
        worldUnits: false,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The trace endpoint already comes from the authoritative world ray.
        // Disabling depth test prevents shallow grazing shots from stippling
        // against terrain triangles without ever drawing beyond cover.
        depthTest: false,
      });
      sniperLineCore = new LineMaterial({
        color: 0xfff4df,
        linewidth: this.reducedEffects ? 2.4 : 3.4,
        worldUnits: false,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });
      const lineResolutionWidth = Math.max(1, window.innerWidth * window.devicePixelRatio);
      const lineResolutionHeight = Math.max(1, window.innerHeight * window.devicePixelRatio);
      sniperLineHalo.resolution.set(lineResolutionWidth, lineResolutionHeight);
      sniperLineCore.resolution.set(lineResolutionWidth, lineResolutionHeight);
      materials.push(sniperLineHalo, sniperLineCore);
      const haloLine = new Line2(lineGeometry, sniperLineHalo);
      haloLine.name = 'sniper-screen-space-haze';
      haloLine.frustumCulled = false;
      const coreLine = new Line2(lineGeometry, sniperLineCore);
      coreLine.name = 'sniper-screen-space-core';
      coreLine.frustumCulled = false;
      root.add(haloLine, coreLine);
    } else if (weapon === 'rail') {
      const overcharged = duration > 0.25;
      addCylinder('rail-collapse-core', overcharged ? 0.034 : 0.026, length, 0, coreMaterial, 8);
      addCylinder('rail-magnetic-envelope', overcharged ? 0.13 : 0.09, length, 0, glowMaterial, 10);
      // Twin longitudinal rails make the event feel connected to the weapon's
      // physical bores instead of a detached rune laid over the screen.
      for (const side of [-1, 1]) {
        const rail = addCylinder(`rail-field-line-${side}`, 0.008, length * 0.92, 0, accentMaterial, 5);
        rail.position.x = side * (overcharged ? 0.12 : 0.085);
      }
      const ringCount = this.reducedEffects ? (overcharged ? 3 : 2) : (overcharged ? 7 : 4);
      for (let index = 0; index < ringCount; index += 1) {
        const amount = (index + 1) / (ringCount + 1);
        const ring = new THREE.Mesh(
          this.sharedGeometry(
            `beam-rail-wave-${overcharged ? 'overcharged' : 'standard'}-${index}`,
            () => new THREE.TorusGeometry((overcharged ? 0.16 : 0.11) * (0.88 + amount * 0.22), 0.008, 5, 20),
          ),
          index % 2 ? accentMaterial : glowMaterial,
        );
        ring.name = `rail-collapse-wave-${index}`;
        ring.rotation.x = Math.PI * 0.5;
        ring.position.y = -length * 0.5 + length * amount;
        ring.userData.phase = amount;
        root.add(ring);
      }
    } else {
      // Bot laser traces use a narrow coherent core; the player's held laser
      // uses the richer persistent path below.
      addCylinder('coherent-beam-core', weapon === 'laser' ? 0.014 : 0.018, length, 0, coreMaterial, 8);
      addCylinder('coherent-beam-halo', weapon === 'laser' ? 0.052 : 0.07, length, 0, glowMaterial, 10);
    }

    root.traverse((object) => { object.frustumCulled = false; });
    this.scene.add(root);
    const direction = end.clone().sub(visibleStart).normalize();
    if (weapon === 'sniper') {
      // The Longshot's shot is a fast hitscan event, so the beam itself has no
      // lifetime in which to leave a physical wake. Keep the smoke in its own
      // world-space group so the moving tracer can clear it and the wisps can
      // rise, spread, and fade in place behind the round.
      const smokeRoot = new THREE.Group();
      smokeRoot.name = 'sniper-smoke-trace';
      smokeRoot.userData.softSmoke = true;
      const smokePuffs: Array<{
        mesh: THREE.Sprite;
        material: THREE.SpriteMaterial;
        velocity: THREE.Vector3;
        baseScale: number;
        baseOpacity: number;
        spin: number;
      }> = [];
      const smokeSide = new THREE.Vector3().crossVectors(direction, UP);
      if (smokeSide.lengthSq() < 0.0001) smokeSide.set(1, 0, 0);
      else smokeSide.normalize();
      const smokeUp = new THREE.Vector3().crossVectors(smokeSide, direction).normalize();
      // Real rifle smoke blooms at the muzzle; it does not form evenly spaced
      // clouds all the way to the target. Keeping the envelope within the first
      // few metres also stops distant puffs reading as a dotted second tracer.
      const smokeLength = Math.min(3.2, Math.max(0.9, length * 0.06));

      const puffCount = this.reducedEffects ? 3 : 6;
      for (let index = 0; index < puffCount; index += 1) {
        const material = smokeMaterial(
          this.smokeTexture,
          index % 2 === 0 ? 0xa8a19a : 0xc1b9b0,
          0.32 - index * 0.015,
          false,
        );
        const mesh = new THREE.Sprite(material);
        const amount = 0.08 + index * (0.68 / Math.max(1, puffCount - 1));
        const lateralOffset = (this.random() - 0.5) * 0.18;
        const verticalOffset = (this.random() - 0.5) * 0.14;
        mesh.position.copy(visibleStart)
          .addScaledVector(direction, smokeLength * amount)
          .addScaledVector(smokeSide, lateralOffset)
          .addScaledVector(smokeUp, verticalOffset);
        // Adjacent puffs deliberately overlap into one soft turbulent envelope;
        // gaps between small sprites made the previous trail look cel-shaded.
        const baseScale = 0.9 + this.random() * 0.28 + index * 0.055;
        mesh.scale.setScalar(baseScale);
        mesh.rotation.set(this.random() * Math.PI, this.random() * Math.PI, this.random() * Math.PI);
        mesh.frustumCulled = false;
        smokeRoot.add(mesh);
        smokePuffs.push({
          mesh,
          material,
          velocity: smokeSide.clone().multiplyScalar((this.random() - 0.5) * 0.55)
            .addScaledVector(smokeUp, 0.28 + this.random() * 0.28)
            .addScaledVector(direction, -0.1 - this.random() * 0.18),
          baseScale,
          baseOpacity: material.opacity,
          spin: (this.random() - 0.5) * 1.8,
        });
      }

      this.scene.add(smokeRoot);
      this.addEffect({
        root: smokeRoot,
        age: 0,
        duration: 0.54,
        materials: smokePuffs.map((puff) => puff.material),
        kind: 'trail',
        update: (progress, delta) => {
          const fade = 1 - THREE.MathUtils.smoothstep(progress, 0.08, 1);
          for (const puff of smokePuffs) {
            puff.mesh.position.addScaledVector(puff.velocity, delta);
            puff.mesh.rotation.x += delta * puff.spin;
            puff.mesh.rotation.z += delta * puff.spin * 0.72;
            puff.mesh.scale.setScalar(puff.baseScale * (1 + progress * 1.45));
            puff.material.opacity = puff.baseOpacity * fade;
          }
        },
      });
    }
    this.addEffect({
      root,
      age: 0,
      duration,
      materials,
      kind: 'beam',
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, weapon === 'rail' ? 1.35 : 1.8);
        coreMaterial.opacity = envelope * coreOpacity;
        glowMaterial.opacity = envelope * glowOpacity;
        accentMaterial.opacity = envelope * (weapon === 'rail' ? 0.7 : 0.45);
        if (sniperLineCore) sniperLineCore.opacity = envelope * 0.92;
        if (sniperLineHalo) sniperLineHalo.opacity = envelope * 0.16;
        if (weapon === 'rail') {
          root.scale.x = root.scale.z = 0.5 + envelope * 0.72;
          for (const child of root.children) {
            if (!child.name.startsWith('rail-collapse-wave')) continue;
            const phase = child.userData.phase as number;
            child.scale.setScalar(0.45 + envelope * (0.55 + phase * 0.28));
            child.rotation.z += delta * (child.id % 2 ? 8 : -8);
          }
        }
      },
    });
  }

  projectileTrail(position: THREE.Vector3, weapon: 'rocket' | 'plasma' | 'disc', color: number): void {
    if (suppressSawSlingLights(weapon)) return;
    if (!this.consumeTrailBudget()) return;
    const root = new THREE.Group();
    root.name = `${weapon}-projectile-trail`;
    root.position.copy(position);
    const glow = additiveMaterial(color, weapon === 'rocket' ? 0.62 : weapon === 'disc' ? 0.2 : 0.48);
    const hot = additiveMaterial(weapon === 'rocket' ? 0xffefb2 : weapon === 'disc' ? 0xffcb64 : 0xfff0ff, weapon === 'disc' ? 0.34 : 0.82);
    const materials: THREE.Material[] = [glow, hot];
    let smokeWisp: THREE.Sprite | undefined;
    let plasmaShell: THREE.Mesh | undefined;
    const discAfterRings: THREE.Object3D[] = [];

    if (weapon === 'rocket') {
      const ember = new THREE.Mesh(
        this.sharedGeometry('trail-rocket-ember', () => new THREE.IcosahedronGeometry(0.052, 1)),
        hot,
      );
      ember.position.set((this.random() - 0.5) * 0.05, (this.random() - 0.5) * 0.05, 0);
      const heat = new THREE.Mesh(
        this.sharedGeometry('trail-rocket-heat', () => new THREE.SphereGeometry(0.11, 8, 6)),
        glow,
      );
      heat.name = 'rocket-trail-heat-glow';
      heat.scale.z = 1.7;
      root.add(heat);
      if (!this.reducedEffects) root.add(ember);
      // Warm, translucent vapour avoids the opaque charcoal discs that were
      // reading as black holes in the player's firing screenshots.
      const smokeMat = smokeMaterial(this.smokeTexture, 0x8b796a, 0.13, true);
      materials.push(smokeMat);
      smokeWisp = new THREE.Sprite(smokeMat);
      smokeWisp.name = 'rocket-smoke-wisp';
      smokeWisp.position.set((this.random() - 0.5) * 0.1, (this.random() - 0.5) * 0.1, 0.08);
      smokeWisp.scale.setScalar(0.24);
      root.add(smokeWisp);
      root.userData.softSmoke = true;
    } else if (weapon === 'plasma') {
      const mote = new THREE.Mesh(
        this.sharedGeometry('trail-plasma-mote', () => new THREE.IcosahedronGeometry(0.075, 1)),
        hot,
      );
      plasmaShell = new THREE.Mesh(
        this.sharedGeometry('trail-plasma-shell', () => new THREE.IcosahedronGeometry(0.14, 1)),
        glow,
      );
      plasmaShell.name = 'plasma-trail-shell';
      root.add(plasmaShell);
      if (!this.reducedEffects) root.add(mote);
    } else {
      // A pair of thin after-rings reads as a spinning cutting plane without
      // leaving a bright opaque blob behind every bouncing projectile.
      for (let index = 0; index < (this.reducedEffects ? 1 : 2); index += 1) {
        const afterRing = new THREE.Mesh(
          this.sharedGeometry(
            `trail-disc-ring-${index}`,
            () => new THREE.TorusGeometry(0.19 - index * 0.035, 0.006, 5, 24),
          ),
          index === 0 ? glow : hot,
        );
        afterRing.name = `disc-trail-after-ring-${index}`;
        afterRing.rotation.set((this.random() - 0.5) * 0.22, (this.random() - 0.5) * 0.22, this.random() * Math.PI);
        afterRing.scale.y = 0.76;
        root.add(afterRing);
        discAfterRings.push(afterRing);
      }
      for (let index = 0; index < (this.reducedEffects ? 1 : 3); index += 1) {
        const emberLength = 0.13 + this.random() * 0.12;
        const ember = new THREE.Mesh(
          this.sharedGeometry('unit-box', () => new THREE.BoxGeometry(1, 1, 1)),
          index === 0 ? hot : glow,
        );
        ember.name = `disc-trail-ember-${index}`;
        ember.scale.set(0.008, 0.008, emberLength);
        ember.position.set((this.random() - 0.5) * 0.2, (this.random() - 0.5) * 0.14, 0.05 + this.random() * 0.1);
        ember.rotation.set((this.random() - 0.5) * 0.4, (this.random() - 0.5) * 0.4, this.random() * Math.PI);
        root.add(ember);
      }
    }

    this.scene.add(root);
    const duration = weapon === 'rocket' ? 0.34 : weapon === 'disc' ? 0.14 : 0.22;
    this.addEffect({
      root,
      age: 0,
      duration,
      materials,
      kind: 'trail',
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.4);
        glow.opacity = envelope * (weapon === 'rocket' ? 0.62 : weapon === 'disc' ? 0.2 : 0.48);
        hot.opacity = envelope * (weapon === 'disc' ? 0.34 : 0.82);
        root.scale.multiplyScalar(1 + delta * (weapon === 'rocket' ? 1.9 : weapon === 'disc' ? 0.55 : 1.25));
        if (smokeWisp) (smokeWisp.material as THREE.SpriteMaterial).opacity = envelope * 0.13;
        if (plasmaShell) plasmaShell.rotation.z += delta * 9;
        for (const ring of discAfterRings) ring.rotation.z += delta * (ring.id % 2 ? 24 : -24);
      },
    });
  }

  updateContinuousLaser(start: THREE.Vector3, end: THREE.Vector3, color: number, delta: number): void {
    if (!this.continuousLaser) this.continuousLaser = this.createContinuousLaser(color);
    const laser = this.continuousLaser;
    const resuming = !laser.root.visible;
    laser.root.visible = true;
    if (resuming) this.laserLaggedEnd.copy(end);

    const lagFactor = 1 - Math.exp(-Math.max(delta, 1 / 120) * 8.5);
    this.laserLaggedEnd.lerp(end, lagFactor);
    const liveVector = this.laserLiveVector.copy(end).sub(start);
    const laggedVector = this.laserLaggedVector.copy(this.laserLaggedEnd).sub(start);
    this.laserBend = 0;
    for (let index = 0; index < this.laserPoints.length; index += 1) {
      const amount = index / (this.laserPoints.length - 1);
      const bend = Math.sin(amount * Math.PI) * 0.72;
      const livePoint = this.laserLivePoint.copy(start).addScaledVector(liveVector, amount);
      const laggedPoint = this.laserLaggedPoint.copy(start).addScaledVector(laggedVector, amount);
      this.laserPoints[index].copy(livePoint).lerp(laggedPoint, bend);
      this.laserBend = Math.max(this.laserBend, this.laserPoints[index].distanceTo(livePoint));
    }

    this.laserPhase += delta * 18;
    laser.coreMaterial.opacity = 0.88 + Math.sin(this.laserPhase) * 0.1;
    laser.haloMaterial.opacity = 0.26 + Math.sin(this.laserPhase * 0.73) * 0.07;
    laser.emitterMaterial.opacity = 0.72 + Math.sin(this.laserPhase * 1.7) * 0.18;
    laser.emitter.position.copy(start);
    if (liveVector.lengthSq() > 0.0001) {
      laser.emitter.quaternion.setFromUnitVectors(FORWARD, this.tempDirection.copy(liveVector).normalize());
    }
    const emitterPulse = 0.88 + Math.sin(this.laserPhase * 1.45) * 0.16;
    laser.emitterCore.scale.setScalar(emitterPulse);
    laser.emitterRing.scale.setScalar(0.9 + Math.sin(this.laserPhase * 0.82) * 0.1);
    laser.emitterRing.rotation.z += delta * 5.5;
    laser.segments.forEach((segment, index) => {
      const segmentStart = this.laserPoints[index];
      const segmentEnd = this.laserPoints[index + 1];
      const coreLength = orientBetween(segment.core, segmentStart, segmentEnd);
      const haloLength = orientBetween(segment.halo, segmentStart, segmentEnd);
      segment.core.scale.set(1, coreLength, 1);
      segment.halo.scale.set(1, haloLength, 1);
    });
  }

  stopContinuousLaser(): void {
    if (this.continuousLaser) this.continuousLaser.root.visible = false;
  }

  impact(position: THREE.Vector3, color: number, weapon: WeaponId, surfaceNormal?: THREE.Vector3): void {
    if (suppressSawSlingLights(weapon)) return;
    if (!this.hasTransientCapacity()) return;
    const root = new THREE.Group();
    root.name = `${weapon}-impact-vfx`;
    root.position.copy(position);
    if (surfaceNormal && surfaceNormal.lengthSq() > 0.5) {
      const normal = surfaceNormal.clone().normalize();
      root.quaternion.setFromUnitVectors(SURFACE_NORMAL, normal);
      root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, this.random() * Math.PI * 2));
    } else {
      root.lookAt(this.camera.position);
    }
    const glow = additiveMaterial(color, 0.95);
    const hot = additiveMaterial(
      weapon === 'rocket' ? 0xffc06a : weapon === 'disc' ? 0xffcf6a : 0xffffff,
      weapon === 'rocket' ? 0.72 : weapon === 'disc' ? 0.9 : 1,
    );
    const materials: THREE.Material[] = [glow, hot];
    const heavy = weapon === 'rocket' || weapon === 'rail';
    const rapidImpact = weapon === 'machine' || weapon === 'shotgun' || weapon === 'plasma' || weapon === 'laser';
    const radius = weapon === 'rocket' ? 1.8 : weapon === 'rail' ? 1.15 : weapon === 'plasma' ? 0.72 : weapon === 'disc' ? 0.58 : 0.46;

    const flash = new THREE.Mesh(
      this.sharedGeometry('impact-unit-circle-18', () => new THREE.CircleGeometry(1, 18)),
      hot,
    );
    flash.name = 'impact-flash';
    const flashBaseScale = radius * (weapon === 'rocket' ? 0.25 : 0.34);
    flash.scale.setScalar(flashBaseScale);
    root.add(flash);
    const ringCount = this.reducedEffects ? 1 : rapidImpact ? 1 : heavy ? 3 : 2;
    for (let index = 0; index < ringCount; index += 1) {
      const ring = new THREE.Mesh(
        this.sharedGeometry('impact-unit-ring-28', () => new THREE.RingGeometry(0.84, 1, 28)),
        glow,
      );
      ring.name = `impact-ring-${index}`;
      ring.position.z = -0.01 * index;
      ring.userData.phase = index * 0.16;
      ring.userData.baseScale = radius * (0.38 + index * 0.18);
      ring.scale.setScalar(ring.userData.baseScale as number);
      root.add(ring);
    }

    const shardCount = rapidImpact
      ? 0
      : this.reducedEffects
        ? heavy ? 4 : weapon === 'disc' ? 3 : 2
        : heavy ? 14 : weapon === 'disc' ? 11 : 6;
    for (let index = 0; index < shardCount; index += 1) {
      const shardRadius = 0.025 + this.random() * 0.02;
      const shardLength = 0.35 + this.random() * 0.48;
      const shard = new THREE.Mesh(
        this.sharedGeometry('impact-shard-cone', () => new THREE.ConeGeometry(1, 1, 4)),
        index % 3 === 0 ? hot : glow,
      );
      shard.name = `impact-shard-${index}`;
      shard.scale.set(shardRadius, shardLength, shardRadius);
      shard.userData.baseScaleY = shardLength;
      const angle = (index / shardCount) * Math.PI * 2 + this.random() * 0.25;
      shard.rotation.z = angle;
      shard.position.set(Math.cos(angle) * 0.12, Math.sin(angle) * 0.12, 0.02);
      shard.userData.velocity = new THREE.Vector3(Math.cos(angle), Math.sin(angle), this.random() * 0.25).multiplyScalar(radius * (1.3 + this.random()));
      root.add(shard);
    }

    this.scene.add(root);
    const duration = heavy ? 0.52 : weapon === 'disc' ? 0.38 : weapon === 'machine' ? 0.2 : 0.3;
    this.addEffect({
      root,
      age: 0,
      duration,
      materials,
      kind: 'impact',
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.35);
        hot.opacity = envelope * (weapon === 'rocket' ? 0.72 : weapon === 'disc' ? 0.9 : 1);
        glow.opacity = envelope * 0.9;
        flash.scale.setScalar(flashBaseScale * (0.5 + progress * 2.4));
        for (const child of root.children) {
          if (child.name.startsWith('impact-ring')) {
            const phase = child.userData.phase as number;
            const baseScale = (child.userData.baseScale as number | undefined) ?? 1;
            child.scale.setScalar(baseScale * (0.45 + Math.max(0, progress - phase) * 2.8));
            child.rotation.z += delta * (child.id % 2 ? 4 : -4);
          } else if (child.name.startsWith('impact-shard')) {
            child.position.addScaledVector(child.userData.velocity as THREE.Vector3, delta);
            child.scale.y = (child.userData.baseScaleY as number) * Math.max(0.08, envelope);
          }
        }
      },
    });
  }

  mark(position: THREE.Vector3, surfaceNormal: THREE.Vector3, weapon: WeaponId, color: number): void {
    if (suppressSawSlingLights(weapon)) return;
    const duplicate = this.marks.find((entry) => entry.weapon === weapon && entry.position.distanceToSquared(position) < 0.012);
    if (duplicate) {
      duplicate.age = 0;
      return;
    }
    const normal = surfaceNormal.clone().normalize();
    if (normal.lengthSq() < 0.5) normal.set(0, 0, 1);
    const root = new THREE.Group();
    root.name = `${weapon}-surface-mark`;
    root.position.copy(position).addScaledVector(normal, 0.018);
    root.quaternion.setFromUnitVectors(SURFACE_NORMAL, normal);
    root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, this.random() * Math.PI * 2));

    const radii: Record<WeaponId, number> = {
      machine: 0.085,
      shotgun: 0.105,
      rocket: 0.78,
      plasma: 0.3,
      laser: 0.12,
      sniper: 0.16,
      rail: 0.36,
      disc: 0.24,
    };
    const radius = radii[weapon];
    const dark = new THREE.MeshBasicMaterial({
      color: weapon === 'rocket' ? 0x050302 : 0x04070b,
      transparent: true,
      opacity: weapon === 'rocket' ? 0.78 : 0.68,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const accent = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: weapon === 'machine' || weapon === 'shotgun' ? 0.42 : 0.76,
      blending: weapon === 'rocket' ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
    });
    const crater = new THREE.Mesh(
      this.sharedGeometry(
        weapon === 'rocket' ? 'mark-unit-circle-18' : 'mark-unit-circle-12',
        () => new THREE.CircleGeometry(1, weapon === 'rocket' ? 18 : 12),
      ),
      dark,
    );
    crater.scale.set(radius, radius * (0.82 + this.random() * 0.22), 1);
    root.add(crater);

    if (weapon === 'rocket') {
      for (let index = 0; index < 2; index += 1) {
        const ring = new THREE.Mesh(
          this.sharedGeometry('mark-rocket-unit-ring', () => new THREE.RingGeometry(0.83, 1, 22)),
          index === 0 ? accent : dark,
        );
        ring.scale.setScalar(radius * (0.34 + index * 0.21));
        ring.position.z = 0.002 + index * 0.001;
        ring.rotation.z = index * 0.73;
        root.add(ring);
      }
      for (let index = 0; index < 3; index += 1) {
        const chip = new THREE.Mesh(
          this.sharedGeometry('mark-unit-circle-6', () => new THREE.CircleGeometry(1, 6)),
          dark,
        );
        chip.scale.setScalar(0.045 + this.random() * 0.055);
        const angle = (index / 3) * Math.PI * 2 + this.random() * 0.22;
        chip.position.set(Math.cos(angle) * radius * (0.68 + this.random() * 0.34), Math.sin(angle) * radius * (0.68 + this.random() * 0.34), 0.001);
        root.add(chip);
      }
    } else if (weapon === 'plasma') {
      const residue = new THREE.Mesh(
        this.sharedGeometry('mark-plasma-unit-ring', () => new THREE.RingGeometry(0.46, 1, 20)),
        accent,
      );
      residue.scale.setScalar(radius * 0.74);
      const core = new THREE.Mesh(
        this.sharedGeometry('mark-unit-circle-12', () => new THREE.CircleGeometry(1, 12)),
        accent,
      );
      core.scale.setScalar(radius * 0.18);
      residue.position.z = core.position.z = 0.002;
      root.add(residue, core);
    } else if (weapon === 'laser') {
      const burn = new THREE.Mesh(
        this.sharedGeometry('mark-unit-plane', () => new THREE.PlaneGeometry(1, 1)),
        accent,
      );
      burn.scale.set(radius * 0.34, radius * 1.8, 1);
      burn.position.z = 0.002;
      root.add(burn);
    } else if (weapon === 'rail') {
      for (let index = 0; index < 3; index += 1) {
        const outer = radius * (0.24 + index * 0.2);
        const innerRatio = (0.18 + index * 0.2) / (0.24 + index * 0.2);
        const ring = new THREE.Mesh(
          this.sharedGeometry(`mark-rail-unit-ring-${index}`, () => new THREE.RingGeometry(innerRatio, 1, 26)),
          accent,
        );
        ring.scale.setScalar(outer);
        ring.position.z = 0.002 + index * 0.001;
        root.add(ring);
      }
    } else if (weapon === 'disc') {
      const cut = new THREE.Mesh(
        this.sharedGeometry('mark-disc-unit-ring', () => new THREE.RingGeometry(0.36, 0.76, 20)),
        accent,
      );
      cut.name = 'disc-gouge-ring';
      cut.position.z = 0.002;
      cut.scale.set(radius, radius * 0.68, 1);
      root.add(cut);
      for (let index = 0; index < 4; index += 1) {
        const slash = new THREE.Mesh(
          this.sharedGeometry('mark-unit-plane', () => new THREE.PlaneGeometry(1, 1)),
          index === 0 ? accent : dark,
        );
        slash.name = `disc-gouge-slash-${index}`;
        slash.scale.set(radius * 0.08, radius * (0.75 + index * 0.12), 1);
        slash.position.set((index - 1.5) * radius * 0.12, 0, 0.003 + index * 0.0005);
        slash.rotation.z = Math.PI * 0.5 + (index - 1.5) * 0.11;
        root.add(slash);
      }
    } else {
      const segments = weapon === 'shotgun' ? 7 : 12;
      const puncture = new THREE.Mesh(
        this.sharedGeometry(`mark-puncture-unit-ring-${segments}`, () => new THREE.RingGeometry(0.44, 1, segments)),
        accent,
      );
      puncture.scale.setScalar(radius * 0.5);
      puncture.position.z = 0.002;
      root.add(puncture);
    }

    this.scene.add(root);
    this.marks.push({ root, material: dark, accentMaterial: accent, position: position.clone(), weapon, age: 0, duration: weapon === 'rocket' ? 42 : weapon === 'disc' ? 22 : 30 });
    const weaponMarkLimit = this.reducedEffects
      ? Math.min(3, MAX_MARKS_BY_WEAPON[weapon])
      : MAX_MARKS_BY_WEAPON[weapon];
    while (this.marks.filter((entry) => entry.weapon === weapon).length > weaponMarkLimit) {
      const sameWeaponIndex = this.marks.findIndex((entry) => entry.weapon === weapon);
      this.removeMark(sameWeaponIndex);
    }
    while (this.marks.length > (this.reducedEffects ? 8 : MAX_IMPACT_MARKS)) this.removeMark(0);
  }

  stickTracer(target: THREE.Object3D, worldPosition: THREE.Vector3, incomingDirection: THREE.Vector3, color: number): void {
    if (!this.hasTransientCapacity() || this.countEffects('tracer') >= MAX_STUCK_TRACERS) return;
    const direction = incomingDirection.clone().normalize();
    if (direction.lengthSq() < 0.5) return;
    target.updateWorldMatrix(true, true);
    const targetWorldQuaternion = new THREE.Quaternion();
    target.getWorldQuaternion(targetWorldQuaternion);
    const worldQuaternion = new THREE.Quaternion().setFromUnitVectors(FORWARD, direction);
    const localPosition = target.worldToLocal(worldPosition.clone());
    const root = new THREE.Group();
    root.name = 'stuck-tracer';
    root.position.copy(localPosition);
    root.quaternion.copy(targetWorldQuaternion.invert().multiply(worldQuaternion));

    const tracerMaterial = additiveMaterial(color, 0.92, false);
    const hotMaterial = additiveMaterial(0xffffff, 0.96, false);
    const materials = [tracerMaterial, hotMaterial];
    const tracer = new THREE.Mesh(
      this.sharedGeometry('tracer-needle', () => new THREE.CylinderGeometry(0.018, 0.012, 0.2, 6)),
      tracerMaterial,
    );
    tracer.name = 'tracer-needle';
    tracer.rotation.x = Math.PI * 0.5;
    tracer.position.z = 0.04;
    const tip = new THREE.Mesh(
      this.sharedGeometry('tracer-tip', () => new THREE.ConeGeometry(0.035, 0.08, 6)),
      hotMaterial,
    );
    tip.name = 'tracer-tip';
    tip.rotation.x = -Math.PI * 0.5;
    tip.position.z = -0.08;
    const ring = new THREE.Mesh(
      this.sharedGeometry('tracer-ring', () => new THREE.TorusGeometry(0.05, 0.008, 5, 12)),
      tracerMaterial,
    );
    ring.name = 'tracer-ring';
    ring.position.z = 0.03;
    ring.rotation.x = Math.PI * 0.5;
    root.add(tracer, tip, ring);
    target.add(root);
    this.addEffect({
      root,
      age: 0,
      duration: 1.8,
      materials,
      kind: 'tracer',
      update: (progress) => {
        const envelope = 1 - THREE.MathUtils.smoothstep(progress, 0.72, 1);
        tracerMaterial.opacity = envelope * 0.92;
        hotMaterial.opacity = envelope * 0.96;
        ring.scale.setScalar(0.92 + Math.sin(progress * Math.PI * 8) * 0.16);
      },
    });
  }

  burst(position: THREE.Vector3, color: number, count: number): void {
    if (!this.hasTransientCapacity()) return;
    const root = new THREE.Group();
    root.name = 'spark-burst-vfx';
    root.position.copy(position);
    const material = additiveMaterial(0xffffff, 0.9);
    const limitedCount = Math.min(18, Math.max(3, count));
    const sparks = new THREE.InstancedMesh(
      this.sharedGeometry('burst-spark-cylinder', () => new THREE.CylinderGeometry(0.009, 0.022, 1, 5)),
      material,
      limitedCount,
    );
    sparks.name = 'instanced-spark-burst';
    sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sparks.frustumCulled = false;
    const positions: THREE.Vector3[] = [];
    const velocities: THREE.Vector3[] = [];
    const orientations: THREE.Quaternion[] = [];
    const baseScales: number[] = [];
    const dummy = new THREE.Object3D();
    for (let index = 0; index < limitedCount; index += 1) {
      const length = 0.18 + this.random() * 0.72;
      const velocity = new THREE.Vector3(this.random() - 0.5, this.random() * 0.75 + 0.08, this.random() - 0.5).normalize().multiplyScalar(2.6 + this.random() * 5.5);
      const orientation = new THREE.Quaternion().setFromUnitVectors(UP, velocity.clone().normalize());
      positions.push(new THREE.Vector3());
      velocities.push(velocity);
      orientations.push(orientation);
      baseScales.push(length);
      dummy.position.set(0, 0, 0);
      dummy.quaternion.copy(orientation);
      dummy.scale.set(1, length, 1);
      dummy.updateMatrix();
      sparks.setMatrixAt(index, dummy.matrix);
      sparks.setColorAt(index, new THREE.Color(index % 4 === 0 ? 0xffffff : color));
    }
    sparks.instanceMatrix.needsUpdate = true;
    if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
    root.add(sparks);
    this.scene.add(root);
    this.addEffect({
      root,
      age: 0,
      duration: 0.3,
      materials: [material],
      kind: 'burst',
      update: (progress, delta) => {
        const envelope = 1 - progress;
        material.opacity = envelope * 0.9;
        for (let index = 0; index < limitedCount; index += 1) {
          const velocity = velocities[index];
          positions[index].addScaledVector(velocity, delta);
          velocity.y -= delta * 6.5;
          dummy.position.copy(positions[index]);
          dummy.quaternion.copy(orientations[index]);
          dummy.scale.set(1, baseScales[index] * envelope, 1);
          dummy.updateMatrix();
          sparks.setMatrixAt(index, dummy.matrix);
        }
        sparks.instanceMatrix.needsUpdate = true;
      },
    });
  }

  createProjectile(
    weapon: 'rocket' | 'plasma' | 'disc',
    color: number,
    streamlined = false,
  ): THREE.Group {
    const root = new THREE.Group();
    root.name = `${weapon}-projectile`;
    if (weapon === 'rocket') {
      const body = this.sharedProjectileMaterial('rocket-body', () => new THREE.MeshStandardMaterial({
        color: 0xb9a7a0,
        roughness: 0.28,
        metalness: 0.88,
      }));
      const shell = this.sharedProjectileMaterial('rocket-shell', () => new THREE.MeshPhysicalMaterial({
        color: 0x5f1717,
        roughness: 0.3,
        metalness: 0.48,
        clearcoat: 0.62,
      }));
      const glow = this.sharedProjectileMaterial('rocket-glow', () => additiveMaterial(0xff5b20, 0.82));
      const hot = this.sharedProjectileMaterial('rocket-hot', () => additiveMaterial(0xfff0bd, 0.96));
      const fuselage = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-fuselage', () => new THREE.CylinderGeometry(0.075, 0.09, 0.34, 12)),
        shell,
      );
      fuselage.name = 'rocket-fuselage';
      fuselage.rotation.x = Math.PI * 0.5;
      root.add(fuselage);
      if (streamlined) {
        // Bot volleys can leave many rockets alive at once. At combat distance
        // the readable information is the red body plus hot exhaust; fins,
        // bands, heat shells, and pressure rings only multiply draw calls.
        // Player-fired hero projectiles retain the complete presentation.
        const exhaust = new THREE.Mesh(
          this.sharedGeometry('projectile-rocket-exhaust', () => new THREE.ConeGeometry(0.085, 0.32, 10, 1, true)),
          hot,
        );
        exhaust.name = 'rocket-exhaust-plume';
        exhaust.rotation.x = Math.PI * 0.5;
        exhaust.position.z = 0.32;
        root.add(exhaust);
        root.userData.vfxParts = { fins: [], plume: exhaust };
        root.traverse((object) => { object.frustumCulled = false; });
        return root;
      }
      const nose = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-nose', () => new THREE.ConeGeometry(0.075, 0.15, 12)),
        body,
      );
      nose.rotation.x = -Math.PI * 0.5;
      nose.position.z = -0.245;
      root.add(nose);
      const warheadBand = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-band', () => new THREE.TorusGeometry(0.082, 0.012, 7, 18)),
        glow,
      );
      warheadBand.name = 'rocket-spin-ring';
      warheadBand.rotation.x = Math.PI * 0.5;
      warheadBand.position.z = -0.13;
      root.add(warheadBand);
      const fins: THREE.Object3D[] = [];
      for (let index = 0; index < 3; index += 1) {
        const fin = new THREE.Mesh(
          this.sharedGeometry('projectile-rocket-fin', () => new THREE.BoxGeometry(0.022, 0.15, 0.12)),
          index === 0 ? shell : body,
        );
        fin.name = `rocket-fin-${index}`;
        fin.position.z = 0.16;
        fin.rotation.z = index * Math.PI * 2 / 3;
        root.add(fin);
        fins.push(fin);
      }
      const exhaust = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-exhaust', () => new THREE.ConeGeometry(0.085, 0.32, 10, 1, true)),
        glow,
      );
      exhaust.name = 'rocket-exhaust-plume';
      exhaust.rotation.x = Math.PI * 0.5;
      exhaust.position.z = 0.34;
      root.add(exhaust);
      const exhaustCore = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-exhaust-core', () => new THREE.ConeGeometry(0.028, 0.22, 8, 1, true)),
        hot,
      );
      exhaustCore.name = 'rocket-exhaust-hot-core';
      exhaustCore.rotation.x = Math.PI * 0.5;
      exhaustCore.position.z = 0.29;
      root.add(exhaustCore);
      const heatGlow = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-heat', () => new THREE.SphereGeometry(0.1, 10, 7)),
        glow,
      );
      heatGlow.name = 'rocket-exhaust-heat-glow';
      heatGlow.position.z = 0.25;
      heatGlow.scale.z = 1.85;
      const pressureRing = new THREE.Mesh(
        this.sharedGeometry('projectile-rocket-pressure', () => new THREE.TorusGeometry(0.1, 0.009, 5, 18)),
        glow,
      );
      pressureRing.name = 'rocket-exhaust-pressure-ring';
      pressureRing.position.z = 0.28;
      root.add(heatGlow, pressureRing);
      root.userData.vfxParts = { spinRing: warheadBand, fins, plume: exhaust, heatGlow, pressureRing };
    } else if (weapon === 'plasma') {
      const glow = this.sharedProjectileMaterial(`plasma-glow-${color}`, () => additiveMaterial(color, 0.82));
      const hot = this.sharedProjectileMaterial('plasma-hot', () => additiveMaterial(0xffffff, 1));
      root.add(new THREE.Mesh(
        this.sharedGeometry('projectile-plasma-core', () => new THREE.IcosahedronGeometry(0.14, 2)),
        hot,
      ));
      const shell = new THREE.Mesh(
        this.sharedGeometry('projectile-plasma-shell', () => new THREE.IcosahedronGeometry(0.27, 2)),
        glow,
      );
      shell.name = 'plasma-shell';
      root.add(shell);
      if (streamlined) {
        // The emissive core/shell pair already gives an incoming plasma round
        // a crisp silhouette. Its pooled motion trail supplies direction, so
        // per-round rings and a separate tail are redundant in bot volleys.
        root.scale.setScalar(0.62);
        root.userData.vfxParts = { shell, rings: [], arcs: [] };
        root.traverse((object) => { object.frustumCulled = false; });
        return root;
      }
      const rings: THREE.Object3D[] = [];
      for (let index = 0; index < 2; index += 1) {
        const ring = new THREE.Mesh(
          this.sharedGeometry('projectile-plasma-ring', () => new THREE.TorusGeometry(0.3, 0.018, 6, 22)),
          glow,
        );
        ring.name = `plasma-ring-${index}`;
        ring.rotation.set(index * 1.05, index * 0.7, index * 0.4);
        root.add(ring);
        rings.push(ring);
      }
      const tail = new THREE.Mesh(
        this.sharedGeometry('projectile-plasma-tail', () => new THREE.ConeGeometry(0.16, 0.65, 10, 1, true)),
        glow,
      );
      tail.rotation.x = Math.PI * 0.5;
      tail.position.z = 0.37;
      root.add(tail);
      root.scale.setScalar(0.62);
      root.userData.vfxParts = { shell, rings, arcs: [] };
    } else {
      const rotor = new THREE.Group();
      rotor.name = 'disc-projectile-rotor';
      const carbide = this.sharedProjectileMaterial('disc-carbide', () => new THREE.MeshPhysicalMaterial({
          color: 0x7d878b,
          roughness: 0.2,
          metalness: 1,
          envMapIntensity: 0.78,
          anisotropy: 1,
        }));

      const cutterGeometry = this.sharedGeometry('projectile-disc-cutter', () => this.createDiscCutterGeometry());
      const cutterBody = new THREE.Mesh(cutterGeometry, carbide);
      cutterBody.name = 'disc-projectile-body';
      rotor.add(cutterBody);
      if (!streamlined) {
        const armoredHub = new THREE.Mesh(
          this.sharedGeometry('projectile-disc-hub', () => new THREE.CylinderGeometry(0.125, 0.125, 0.085, 18, 1)),
          carbide,
        );
        armoredHub.name = 'disc-projectile-hub';
        armoredHub.rotation.x = Math.PI * 0.5;
        rotor.add(armoredHub);
      }
      // The saw flies flat like the exposed blade in the launcher instead of
      // turning face-on to the camera. Its local Z spin axis becomes world-up.
      rotor.rotation.x = -Math.PI * 0.5;
      root.add(rotor);
      root.userData.vfxParts = { rotor };
    }
    root.traverse((object) => { object.frustumCulled = false; });
    return root;
  }

  createGrenade(color: number): THREE.Group {
    const root = new THREE.Group();
    root.name = 'grenade';
    const model = this.grenadeModel.clone(true);
    model.name = 'a-star-wars-grenade';
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => material.clone())
        : object.material.clone();
    });

    const glow = additiveMaterial(color, 0.8);
    const indicator = new THREE.Mesh(
      this.sharedGeometry('grenade-fuse-indicator', () => new THREE.TorusGeometry(0.15, 0.008, 6, 24)),
      glow,
    );
    indicator.name = 'grenade-fuse-indicator';
    indicator.rotation.x = Math.PI * 0.5;
    root.add(model, indicator);
    root.userData.vfxParts = { indicator };
    root.traverse((object) => { object.frustumCulled = false; });
    return root;
  }

  orientGrenade(root: THREE.Group, velocity: THREE.Vector3, elapsed: number): void {
    if (velocity.lengthSq() > 0.04) {
      root.quaternion.setFromUnitVectors(FORWARD, this.tempDirection.copy(velocity).normalize());
    }
    root.rotateZ(elapsed * 9.5);
    const parts = root.userData.vfxParts as { indicator?: THREE.Mesh } | undefined;
    if (parts?.indicator) {
      const pulse = 0.9 + Math.sin(elapsed * 14) * 0.12;
      parts.indicator.scale.setScalar(pulse);
      const material = parts.indicator.material as THREE.MeshBasicMaterial;
      material.opacity = 0.62 + Math.sin(elapsed * 14) * 0.18;
    }
  }

  grenadeExplosion(position: THREE.Vector3, color: number): void {
    this.impact(position, color, 'rocket');
    this.burst(position, color, 18);
  }

  rocketExplosion(position: THREE.Vector3, color: number): void {
    this.impact(position, color, 'rocket');
    if (!this.hasTransientCapacity()) return;
    const root = new THREE.Group();
    root.name = 'rocket-blast-wave';
    root.userData.softSmoke = true;
    root.position.copy(position);
    root.lookAt(this.camera.position);
    const glow = additiveMaterial(0xff5b20, 0.82);
    const hot = additiveMaterial(0xfff4c1, 0.96);
    const materials: THREE.Material[] = [glow, hot];
    const smokePuffs: Array<{
      sprite: THREE.Sprite;
      material: THREE.SpriteMaterial;
      velocity: THREE.Vector3;
      baseScale: number;
      baseOpacity: number;
    }> = [];
    const core = new THREE.Mesh(
      this.sharedGeometry('explosion-rocket-core', () => new THREE.SphereGeometry(0.24, 14, 10)),
      hot,
    );
    const wave = new THREE.Mesh(
      this.sharedGeometry('explosion-rocket-wave', () => new THREE.RingGeometry(0.22, 0.3, 32)),
      glow,
    );
    wave.position.z = -0.02;
    root.add(core, wave);
    for (let index = 0; index < (this.reducedEffects ? 2 : 5); index += 1) {
      const smoke = smokeMaterial(
        this.smokeTexture,
        index % 2 ? 0x655d56 : 0x756a60,
        0.16 - index * 0.012,
        true,
      );
      const sprite = new THREE.Sprite(smoke);
      const angle = index / 5 * Math.PI * 2 + this.random() * 0.45;
      const baseScale = 0.48 + this.random() * 0.24;
      sprite.position.set(Math.cos(angle) * 0.12, Math.sin(angle) * 0.08, 0.03 + index * 0.006);
      sprite.scale.setScalar(baseScale);
      sprite.name = `rocket-smoke-billow-${index}`;
      root.add(sprite);
      materials.push(smoke);
      smokePuffs.push({
        sprite,
        material: smoke,
        velocity: new THREE.Vector3(Math.cos(angle) * 0.5, 0.35 + this.random() * 0.42, Math.sin(angle) * 0.35),
        baseScale,
        baseOpacity: smoke.opacity,
      });
    }
    this.scene.add(root);
    this.addEffect({
      root,
      age: 0,
      duration: 0.62,
      materials,
      kind: 'impact',
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.25);
        hot.opacity = envelope;
        glow.opacity = envelope * 0.86;
        core.scale.setScalar(0.8 + progress * 3.4);
        wave.scale.setScalar(0.6 + progress * 4.6);
        wave.rotation.z += 0.08;
        for (const puff of smokePuffs) {
          puff.sprite.position.addScaledVector(puff.velocity, delta);
          puff.sprite.scale.setScalar(puff.baseScale * (1 + progress * 2.9));
          puff.material.opacity = puff.baseOpacity * (1 - THREE.MathUtils.smoothstep(progress, 0.08, 1));
        }
      },
    });
    this.burst(position, color, 24);
  }

  updateGrapple(start: THREE.Vector3, end: THREE.Vector3, active: boolean): void {
    if (!active) {
      this.clearGrapple();
      return;
    }
    if (!this.grappleRoot) {
      this.grappleRoot = new THREE.Group();
      this.grappleRoot.name = 'grapple-vfx';
      this.grappleRoot.renderOrder = 1000;
      const cableMaterial = additiveMaterial(0x6df4ff, 0.98, false);
      this.grappleMaterials.push(cableMaterial);
      for (let index = 0; index < this.grappleCurvePoints.length; index += 1) {
        this.grappleCurvePoints[index].set(0, index / (this.grappleCurvePoints.length - 1), 0);
      }
      this.grappleCable = new THREE.Group();
      this.grappleCable.name = 'grapple-cable';
      this.grappleCable.renderOrder = 1000;
      const cableGeometry = this.sharedGeometry(
        'grapple-segment',
        () => new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true),
      );
      for (let index = 0; index < this.grappleCurvePoints.length - 1; index += 1) {
        const segment = new THREE.Mesh(cableGeometry, cableMaterial);
        segment.name = `grapple-cable-segment-${index}`;
        segment.frustumCulled = false;
        segment.renderOrder = 1000;
        this.grappleCable.add(segment);
        this.grappleCableSegments.push(segment);
      }
      this.grappleHook = new THREE.Mesh(
        this.sharedGeometry('grapple-hook', () => new THREE.TorusGeometry(0.19, 0.04, 8, 18)),
        additiveMaterial(0xffffff, 1, false),
      );
      this.grappleMaterials.push(this.grappleHook.material as THREE.Material);
      this.grappleHook.frustumCulled = false;
      this.grappleHook.renderOrder = 1001;
      this.grappleHook.rotation.x = Math.PI * 0.5;
      this.grappleHookCore = new THREE.Mesh(
        this.sharedGeometry('grapple-hook-core', () => new THREE.IcosahedronGeometry(0.095, 1)),
        additiveMaterial(0x6df4ff, 1, false),
      );
      this.grappleHookCore.frustumCulled = false;
      this.grappleHookCore.renderOrder = 1001;
      this.grappleMaterials.push(this.grappleHookCore.material as THREE.Material);
      this.grappleRoot.add(this.grappleCable, this.grappleHook, this.grappleHookCore);
      this.scene.add(this.grappleRoot);
    }
    this.grappleRoot.visible = true;
    const cable = this.grappleCable;
    const hook = this.grappleHook;
    if (!cable || !hook) return;
    // Starting exactly at the camera near plane makes even a thin cable's
    // cross-section balloon across the view. Pull it a short distance forward
    // so the cable visibly leaves the lower-left launcher without occluding the screen.
    const cableStart = this.grappleCurvePoints[0].copy(start);
    const cableDirection = this.tempDirection.copy(end).sub(start);
    if (cableDirection.lengthSq() > 0.01) cableStart.addScaledVector(cableDirection.normalize(), 0.38);
    const ropeDirection = this.tempDirectionB.copy(end).sub(cableStart);
    const distance = ropeDirection.length();
    const side = this.tempSide.crossVectors(ropeDirection, UP);
    if (side.lengthSq() < 0.001) side.set(1, 0, 0);
    else side.normalize();
    const sag = Math.min(0.7, distance * 0.055);
    const flex = Math.sin(this.ropePhase) * Math.min(0.24, distance * 0.018);
    for (let index = 0; index < GRAPPLE_CURVE_AMOUNTS.length; index += 1) {
      const t = GRAPPLE_CURVE_AMOUNTS[index];
      const point = this.grappleCurvePoints[index + 1].copy(cableStart).lerp(end, t);
      point.y -= Math.sin(t * Math.PI) * sag;
      point.addScaledVector(side, Math.sin(t * Math.PI) * flex);
    }
    this.grappleCurvePoints[this.grappleCurvePoints.length - 1].copy(end);
    for (let index = 0; index < this.grappleCableSegments.length; index += 1) {
      const segment = this.grappleCableSegments[index];
      const length = orientBetween(segment, this.grappleCurvePoints[index], this.grappleCurvePoints[index + 1]);
      segment.scale.set(1, length, 1);
    }
    this.ropePhase += 0.055;
    hook.position.copy(end);
    if (this.grappleHookCore) this.grappleHookCore.position.copy(end);
  }

  clearGrapple(): void {
    if (this.grappleRoot) this.grappleRoot.visible = false;
  }

  orientProjectile(root: THREE.Group, direction: THREE.Vector3, elapsed: number, weapon: WeaponId): void {
    if (weapon === 'disc') {
      const planarDirection = this.tempDirection.copy(direction).setY(0);
      if (planarDirection.lengthSq() > 0.0001) {
        planarDirection.normalize();
        root.rotation.set(0, Math.atan2(-planarDirection.x, -planarDirection.z), 0);
      }
    } else {
      root.quaternion.setFromUnitVectors(FORWARD, this.tempDirection.copy(direction).normalize());
    }
    if (weapon === 'rocket') {
      const parts = root.userData.vfxParts as {
        spinRing?: THREE.Object3D;
        fins?: THREE.Object3D[];
        plume?: THREE.Object3D;
        heatGlow?: THREE.Object3D;
        pressureRing?: THREE.Object3D;
      } | undefined;
      const spinRing = parts?.spinRing ?? root.getObjectByName('rocket-spin-ring');
      if (spinRing) spinRing.rotation.z = elapsed * 9;
      if (parts?.fins) {
        for (let index = 0; index < parts.fins.length; index += 1) {
          parts.fins[index].rotation.z = index * Math.PI * 2 / 3 + elapsed * 0.8;
        }
      } else {
        for (const child of root.children) {
          if (child.name.startsWith('rocket-fin-')) {
            const index = Number.parseInt(child.name.slice('rocket-fin-'.length), 10) || 0;
            child.rotation.z = index * Math.PI * 2 / 3 + elapsed * 0.8;
          }
        }
      }
      const plume = parts?.plume ?? root.getObjectByName('rocket-exhaust-plume');
      if (plume) plume.scale.set(0.9 + Math.sin(elapsed * 34) * 0.12, 0.9 + Math.sin(elapsed * 34) * 0.12, 0.82 + Math.sin(elapsed * 41) * 0.16);
      const heatGlow = parts?.heatGlow ?? root.getObjectByName('rocket-exhaust-heat-glow');
      if (heatGlow) heatGlow.scale.set(0.9 + Math.sin(elapsed * 28) * 0.1, 0.9 + Math.sin(elapsed * 28) * 0.1, 1.7 + Math.sin(elapsed * 35) * 0.22);
      const pressureRing = parts?.pressureRing ?? root.getObjectByName('rocket-exhaust-pressure-ring');
      if (pressureRing) pressureRing.scale.setScalar(0.88 + Math.sin(elapsed * 30) * 0.1);
    } else if (weapon === 'plasma') {
      const parts = root.userData.vfxParts as {
        shell?: THREE.Object3D;
        rings?: THREE.Object3D[];
        arcs?: THREE.Object3D[];
      } | undefined;
      for (const ring of parts?.rings ?? []) {
        ring.rotation.x += 0.08 + (ring.id % 3) * 0.02;
        ring.rotation.z = elapsed * (1.8 + (ring.id % 4) * 0.3);
      }
      const pulse = 0.92 + Math.sin(elapsed * 22) * 0.12;
      parts?.shell?.scale.setScalar(pulse);
      for (const arc of parts?.arcs ?? []) arc.rotation.z = elapsed * (2.2 + (arc.id % 3) * 0.55);
    }
  }

  update(delta: number): void {
    const trailAllowance = this.reducedEffects ? 2 : TRAIL_BURST_ALLOWANCE;
    this.trailSpawnTokens = Math.min(
      trailAllowance,
      this.trailSpawnTokens + Math.max(0, delta) * (this.reducedEffects ? 20 : TRAIL_SPAWNS_PER_SECOND),
    );
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.age += delta;
      const progress = THREE.MathUtils.clamp(effect.age / effect.duration, 0, 1);
      effect.update(progress, delta);
      if (progress < 1) continue;
      this.removeEffect(index);
    }
    for (let index = this.marks.length - 1; index >= 0; index -= 1) {
      const mark = this.marks[index];
      mark.age += delta;
      const fade = 1 - THREE.MathUtils.smoothstep(mark.age, mark.duration - 5, mark.duration);
      mark.material.opacity = (mark.weapon === 'rocket' ? 0.78 : 0.68) * fade;
      mark.accentMaterial.opacity *= fade > 0.98 ? 1 : fade;
      if (mark.age >= mark.duration) this.removeMark(index);
    }
  }

  clearTransientEffects(): void {
    while (this.effects.length) this.removeEffect(this.effects.length - 1);
    while (this.marks.length) this.removeMark(this.marks.length - 1);
    this.trailSpawnTokens = this.reducedEffects ? 2 : TRAIL_BURST_ALLOWANCE;
    this.stopContinuousLaser();
  }

  dispose(): void {
    this.clearTransientEffects();
    if (this.continuousLaser) {
      this.scene.remove(this.continuousLaser.root);
      this.continuousLaser.coreGeometry.dispose();
      this.continuousLaser.haloGeometry.dispose();
      for (const geometry of this.continuousLaser.flareGeometries) geometry.dispose();
      this.continuousLaser.coreMaterial.dispose();
      this.continuousLaser.haloMaterial.dispose();
      this.continuousLaser.emitterMaterial.dispose();
      this.continuousLaser = undefined;
    }
    if (this.grappleRoot) {
      this.grappleRoot.parent?.remove(this.grappleRoot);
      this.disposeRoot(this.grappleRoot, this.grappleMaterials);
      this.grappleRoot = undefined;
      this.grappleCable = undefined;
      this.grappleCableSegments.length = 0;
      this.grappleHook = undefined;
      this.grappleHookCore = undefined;
      this.grappleMaterials.length = 0;
    }
    for (const entry of this.machineMuzzlePool) {
      entry.root.parent?.remove(entry.root);
      entry.hot.dispose();
      entry.glow.dispose();
    }
    for (const entry of this.machineBeamPool) {
      entry.root.parent?.remove(entry.root);
      entry.core.dispose();
      entry.glow.dispose();
    }
    this.machineMuzzlePool.length = 0;
    this.machineBeamPool.length = 0;
    for (const material of this.sharedProjectileMaterials.values()) material.dispose();
    this.sharedProjectileMaterials.clear();
    this.smokeTexture.dispose();
    this.tracerRampTexture.dispose();
    for (const geometry of this.sharedGeometries.values()) geometry.dispose();
    this.sharedGeometries.clear();
    this.sharedGeometrySet.clear();
    this.disposeImportedGrenade();
  }

  get activeEffects(): number {
    return this.effects.length + (this.continuousLaser?.root.visible ? 1 : 0);
  }

  get activeMarks(): number {
    return this.marks.length;
  }

  get activeTracers(): number {
    return this.countEffects('tracer');
  }

  get activeSoftSmoke(): number {
    let count = 0;
    for (const effect of this.effects) {
      if (effect.root.userData.softSmoke) count += 1;
    }
    return count;
  }

  get smokeTextureSource(): string {
    return String(this.smokeTexture.userData.source ?? 'unknown');
  }

  get tracerTextureSource(): string {
    return String(this.tracerRampTexture.userData.source ?? 'unknown');
  }

  get continuousLaserActive(): boolean {
    return this.continuousLaser?.root.visible ?? false;
  }

  private disposeImportedGrenade(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.grenadeModel.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of meshMaterials) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  }

  get continuousLaserBend(): number {
    return this.continuousLaserActive ? this.laserBend : 0;
  }

  private hasTransientCapacity(): boolean {
    return this.effects.length < (this.reducedEffects ? 24 : MAX_TRANSIENT_EFFECTS);
  }

  private consumeTrailBudget(): boolean {
    if (!this.hasTransientCapacity() || this.trailSpawnTokens < 1) return false;
    if (this.countEffects('trail') >= (this.reducedEffects ? 4 : MAX_TRAIL_EFFECTS)) return false;
    this.trailSpawnTokens -= 1;
    return true;
  }

  private addEffect(effect: Effect): void {
    if (effect.kind) {
      const kindLimit = this.reducedEffects
        ? ({ muzzle: 1, beam: 6, trail: 4, impact: 4, tracer: 6, burst: 2 } as const)[effect.kind]
        : MAX_EFFECTS_BY_KIND[effect.kind];
      while (this.countEffects(effect.kind) >= kindLimit) {
        const sameKindIndex = this.effects.findIndex((entry) => entry.kind === effect.kind);
        if (sameKindIndex < 0) break;
        this.removeEffect(sameKindIndex);
      }
    }
    while (this.effects.length >= (this.reducedEffects ? 24 : MAX_TRANSIENT_EFFECTS)) {
      const trailIndex = this.effects.findIndex((entry) => entry.kind === 'trail');
      this.removeEffect(trailIndex >= 0 ? trailIndex : 0);
    }
    this.effects.push(effect);
  }

  private countEffects(kind: NonNullable<Effect['kind']>): number {
    let count = 0;
    for (const effect of this.effects) {
      if (effect.kind === kind) count += 1;
    }
    return count;
  }

  private removeEffect(index: number): void {
    const effect = this.effects[index];
    if (!effect) return;
    if (effect.pooled) {
      effect.root.visible = false;
      this.effects.splice(index, 1);
      return;
    }
    effect.root.parent?.remove(effect.root);
    this.disposeRoot(effect.root, effect.materials);
    this.effects.splice(index, 1);
  }

  private sharedGeometry<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
    const cached = this.sharedGeometries.get(key);
    if (cached) return cached as T;
    const geometry = create();
    geometry.userData.sharedWeaponVfx = true;
    this.sharedGeometries.set(key, geometry);
    this.sharedGeometrySet.add(geometry);
    return geometry;
  }

  private sharedProjectileMaterial<T extends THREE.Material>(key: string, create: () => T): T {
    const cached = this.sharedProjectileMaterials.get(key);
    if (cached) return cached as T;
    const material = create();
    material.userData.sharedWeaponVfx = true;
    this.sharedProjectileMaterials.set(key, material);
    return material;
  }

  private createRailMuzzleArcGeometry(index: number): THREE.TubeGeometry {
    const side = index % 2 ? 1 : -1;
    const verticalOffset = (index - 1.5) * 0.04;
    const curve = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(side * 0.17, verticalOffset, 0.05),
      new THREE.Vector3(side * 0.3, verticalOffset * -0.8, -0.38),
      new THREE.Vector3(side * 0.04, verticalOffset * 0.45, -0.82),
    );
    return new THREE.TubeGeometry(curve, 8, index === 0 ? 0.014 : 0.009, 4, false);
  }

  private createDiscCutterGeometry(): THREE.ExtrudeGeometry {
    const cutterShape = new THREE.Shape();
    const cutterTeeth = 40;
    const step = Math.PI * 2 / cutterTeeth;
    for (let index = 0; index < cutterTeeth; index += 1) {
      const points: Array<[number, number]> = [
        [index * step, 0.325],
        [(index + 0.2) * step, 0.38],
        [(index + 0.44) * step, 0.374],
        [(index + 0.78) * step, 0.325],
      ];
      for (const [angle, radius] of points) {
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (index === 0 && angle === 0) cutterShape.moveTo(x, y);
        else cutterShape.lineTo(x, y);
      }
    }
    cutterShape.closePath();
    const geometry = new THREE.ExtrudeGeometry(cutterShape, {
      depth: 0.022,
      steps: 1,
      bevelEnabled: true,
      bevelSize: 0.0015,
      bevelThickness: 0.0015,
      bevelSegments: 1,
    });
    geometry.translate(0, 0, -0.011);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createContinuousLaser(color: number): ContinuousLaser {
    const root = new THREE.Group();
    root.name = 'laser-continuous-beam';
    root.visible = false;
    const coreMaterial = additiveMaterial(0xf0fff5, 0.96);
    const haloMaterial = additiveMaterial(color, 0.3);
    const coreGeometry = new THREE.CylinderGeometry(0.014, 0.01, 1, 8, 1, true);
    const haloGeometry = new THREE.CylinderGeometry(0.068, 0.042, 1, 10, 1, true);
    const segments: ContinuousLaser['segments'] = [];
    for (let index = 0; index < this.laserPoints.length - 1; index += 1) {
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      const core = new THREE.Mesh(coreGeometry, coreMaterial);
      halo.name = `laser-halo-segment-${index}`;
      core.name = `laser-core-segment-${index}`;
      halo.frustumCulled = false;
      core.frustumCulled = false;
      root.add(halo, core);
      segments.push({ core, halo });
    }
    const emitter = new THREE.Group();
    emitter.name = 'laser-emitter-flare';
    const emitterMaterial = additiveMaterial(color, 0.8, false);
    const emitterCoreGeometry = new THREE.IcosahedronGeometry(0.075, 1);
    const emitterRingGeometry = new THREE.TorusGeometry(0.105, 0.012, 6, 24);
    const emitterBladeGeometry = new THREE.BoxGeometry(0.008, 0.22, 0.008);
    const emitterCore = new THREE.Mesh(emitterCoreGeometry, coreMaterial);
    emitterCore.name = 'laser-emitter-hot-core';
    const emitterRing = new THREE.Mesh(emitterRingGeometry, emitterMaterial);
    emitterRing.name = 'laser-emitter-bloom-ring';
    emitter.add(emitterCore, emitterRing);
    for (let index = 0; index < 4; index += 1) {
      const blade = new THREE.Mesh(emitterBladeGeometry, emitterMaterial);
      blade.name = `laser-emitter-blade-${index}`;
      blade.rotation.z = index * Math.PI * 0.5;
      emitter.add(blade);
    }
    root.add(emitter);
    root.traverse((object) => { object.frustumCulled = false; });
    this.scene.add(root);
    return {
      root,
      segments,
      coreGeometry,
      haloGeometry,
      coreMaterial,
      haloMaterial,
      emitter,
      emitterCore,
      emitterRing,
      emitterMaterial,
      flareGeometries: [emitterCoreGeometry, emitterRingGeometry, emitterBladeGeometry],
    };
  }

  private disposeRoot(root: THREE.Object3D, materials: THREE.Material[]): void {
    const geometries = new Set<THREE.BufferGeometry>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
    });
    for (const geometry of geometries) {
      if (!this.sharedGeometrySet.has(geometry)) geometry.dispose();
    }
    for (const material of new Set(materials)) material.dispose();
  }

  private removeMark(index: number): void {
    const mark = this.marks[index];
    mark.root.parent?.remove(mark.root);
    this.disposeRoot(mark.root, [mark.material, mark.accentMaterial]);
    this.marks.splice(index, 1);
  }
}
