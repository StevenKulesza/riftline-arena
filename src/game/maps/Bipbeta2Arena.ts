import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MeshBVH } from 'three-mesh-bvh';
import type {
  ArenaMapInfo,
  ArenaRuntime,
  ArenaSurface,
  ArenaWeatherVisualDiagnostics,
  CapsuleContact,
  JumpPad,
  SurfaceHit,
} from '../Arena';
import { MOVEMENT } from '../config';
import type { WeatherGameplaySnapshot, WeatherPhase } from '../../systems/WeatherGameplaySystem';
import {
  buildLaunchRamp,
  type FlowSurfaceBuild,
  type LaunchRampSpec,
} from './FlowGeometry';

type BipbetaBox = {
  name: string;
  box: THREE.Box3;
};

type BipbetaFloor = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
  normal: THREE.Vector3;
};

type BipbetaRamp = {
  name: string;
  spec: LaunchRampSpec;
  flow: FlowSurfaceBuild;
};

type BipbetaFlowNode = {
  id: string;
  kind: 'deck' | 'tube' | 'jumper' | 'return';
  entry: { x: number; y: number; z: number };
  exit: { x: number; y: number; z: number };
  links: string[];
  speedTarget?: number;
};

const BIPBETA2 = Object.freeze({
  name: 'Bipbeta2',
  width: 240,
  depth: 192,
  killY: -18,
  generationVersion: 8,
});

const EPSILON = 1e-6;

/**
 * Original procedural CA movement arena.
 *
 * Bipbeta2 is authored as a sealed hard-surface movement laboratory. The
 * reference target is the architectural language of Bipbeta2: pale cement,
 * charcoal service panels, purple tech trim, fluorescent wall bays, stacked
 * galleries, and a long central shaft. No source map geometry is used here;
 * every surface is project-owned and generated from reusable primitives.
 */
export class Bipbeta2Arena implements ArenaRuntime {
  readonly group = new THREE.Group();
  readonly seed: number;
  readonly killY = BIPBETA2.killY;
  readonly jumpPads: JumpPad[] = [];
  readonly collisionTriangles: number;
  readonly corePosition: THREE.Vector3;
  readonly spawnPoints: THREE.Vector3[];
  readonly itemPoints: Record<string, THREE.Vector3>;
  readonly mapInfo: ArenaMapInfo;

  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly collisionParts: THREE.BufferGeometry[] = [];
  private readonly colliders: BipbetaBox[] = [];
  private readonly floors: BipbetaFloor[] = [];
  private readonly ramps: BipbetaRamp[] = [];
  private readonly pulseMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly animatedFans: Array<{ object: THREE.Object3D; speed: number }> = [];
  private readonly collisionGeometry: THREE.BufferGeometry;
  private readonly boundsTree: MeshBVH;
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly correction = new THREE.Vector3();
  private readonly wallNormal = new THREE.Vector3();
  private readonly rampNormal = new THREE.Vector3();
  private readonly rampContact = { normal: this.rampNormal, depth: 0 };
  private readonly floorNormal = new THREE.Vector3(0, 1, 0);
  private readonly floorResult = { height: 0, normal: this.floorNormal };
  private readonly rayDirection = new THREE.Vector3();
  private readonly collisionRay = new THREE.Ray();
  private readonly rayHitNormal = new THREE.Vector3();
  private readonly surfaceHit: SurfaceHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: 0,
    surface: 'concrete',
  };
  private readonly capsuleContacts: CapsuleContact[] = Array.from({ length: 8 }, () => ({
    grounded: false,
    contactNormal: new THREE.Vector3(0, 1, 0),
    wallContact: false,
    wallNormal: new THREE.Vector3(),
    correction: new THREE.Vector3(),
    contacts: 0,
  }));
  private capsuleContactCursor = 0;
  private weatherGameplaySnapshot: WeatherGameplaySnapshot | null = null;
  private readonly weatherVisualDiagnostics: {
    source: 'autonomous' | 'gameplay';
    phase: WeatherPhase | 'autonomous';
    label: string;
    severity: number;
    rainIntensity: number;
    visualWindStrength: number;
    windDirection: { x: number; z: number };
    visibilityMultiplier: number;
  } = {
    source: 'autonomous',
    phase: 'autonomous',
    label: 'BIPBETA2 AIRFLOW',
    severity: 0,
    rainIntensity: 0,
    visualWindStrength: 0.18,
    windDirection: { x: 0.82, z: 0.24 },
    visibilityMultiplier: 1,
  };

  static async load(seed: number): Promise<Bipbeta2Arena> {
    return new Bipbeta2Arena(seed);
  }

  constructor(seed: number) {
    this.seed = seed;
    this.group.name = 'Bipbeta2ProceduralArena';
    this.group.userData.source = 'Riftline project-original procedural layout, bipbeta2 movement reference';
    this.group.userData.license = 'Riftline project original';
    this.group.userData.mapSeed = seed;
    this.group.userData.layout = 'sealed bipolar tube course / two rear-wall accelerators / stacked gallery return / lower shaft crossings';
    this.group.userData.movementFlow = {
      sourceEvidence: 'Bipbeta2 gameplay reference plus public map notes; procedural recreation, no imported BSP',
      primaryRule: 'enter either tube, build speed, use the rear wall, then return through the opposite gallery',
      primaryJumpers: 2,
      nodes: [
        {
          id: 'west-accelerator-tube',
          kind: 'tube',
          entry: { x: -38, y: 0, z: -68 },
          exit: { x: -38, y: 0, z: 66 },
          links: ['south-lower-deck', 'north-lower-deck', 'west-jumper'],
          speedTarget: 1800,
        },
        {
          id: 'east-accelerator-tube',
          kind: 'tube',
          entry: { x: 38, y: 0, z: 68 },
          exit: { x: 38, y: 0, z: -66 },
          links: ['north-lower-deck', 'south-lower-deck', 'east-jumper'],
          speedTarget: 1800,
        },
        {
          id: 'west-jumper',
          kind: 'jumper',
          entry: { x: -38, y: 0, z: -63 },
          exit: { x: -38, y: 10, z: -48 },
          links: ['west-accelerator-tube', 'north-gallery-return'],
        },
        {
          id: 'east-jumper',
          kind: 'jumper',
          entry: { x: 38, y: 0, z: 63 },
          exit: { x: 38, y: 10, z: 48 },
          links: ['east-accelerator-tube', 'south-gallery-return'],
        },
        {
          id: 'north-gallery-return',
          kind: 'return',
          entry: { x: -84, y: 6, z: -57 },
          exit: { x: 84, y: 6, z: -57 },
          links: ['west-accelerator-tube', 'east-accelerator-tube', 'high-cross-bridge'],
        },
        {
          id: 'south-gallery-return',
          kind: 'return',
          entry: { x: 84, y: 6, z: 57 },
          exit: { x: -84, y: 6, z: 57 },
          links: ['west-accelerator-tube', 'east-accelerator-tube', 'high-cross-bridge'],
        },
        {
          id: 'south-lower-deck',
          kind: 'deck',
          entry: { x: -76, y: 0, z: 61 },
          exit: { x: 76, y: 0, z: 61 },
          links: ['west-accelerator-tube', 'east-accelerator-tube'],
        },
        {
          id: 'north-lower-deck',
          kind: 'deck',
          entry: { x: 76, y: 0, z: -61 },
          exit: { x: -76, y: 0, z: -61 },
          links: ['west-accelerator-tube', 'east-accelerator-tube'],
        },
      ] satisfies BipbetaFlowNode[],
    };

    const concrete = this.material('Bipbeta2 ivory concrete', 0xd5d2cc, 0.08, 0.72);
    const concreteEdge = this.material('Bipbeta2 concrete bevels', 0xd8d5cf, 0.28, 0.58);
    // The source room's ceiling is a continuous, softly lit shell. Reusing
    // the tiled wall material here made the capture read like a suspended
    // checkerboard and overwhelmed the sparse purple crown structure.
    const ceiling = concreteEdge.clone();
    ceiling.name = 'Bipbeta2 smooth concrete shell ceiling';
    ceiling.map = null;
    ceiling.color.setHex(0xd0ccd2);
    ceiling.metalness = 0.04;
    ceiling.roughness = 0.94;
    ceiling.emissive.setHex(0x24212a);
    ceiling.emissiveIntensity = 0.22;
    this.materials.push(ceiling);
    const charcoal = this.material('Bipbeta2 charcoal structural shell', 0x171b22, 0.86, 0.28);
    const graphite = this.material('Bipbeta2 graphite inset panels', 0x303640, 0.7, 0.4);
    const steel = this.material('Bipbeta2 brushed service steel', 0x65707a, 0.8, 0.32);
    const purple = this.material('Bipbeta2 purple tech trim', 0x74339a, 0.58, 0.3);
    const purpleGlow = this.emissiveMaterial('Bipbeta2 violet route energy', 0xc447ff, 0x711b9e);
    const cyan = this.emissiveMaterial('Bipbeta2 cyan route lights', 0x4ae9ff, 0x0b829b);
    const red = this.emissiveMaterial('Bipbeta2 magenta route lights', 0xff527b, 0x9d1f4b);
    const amber = this.emissiveMaterial('Bipbeta2 amber launch lights', 0xffc86a, 0x9c5316);
    const white = this.emissiveMaterial('Bipbeta2 fluorescent wall panels', 0xf4f1e9, 0xbcc4ca);
    const black = this.material('Bipbeta2 light bay recess', 0x090c11, 0.62, 0.36);
    const concreteTiles = this.createConcreteTileTexture();
    concrete.map = concreteTiles;
    concrete.map.colorSpace = THREE.SRGBColorSpace;
    concrete.map.wrapS = THREE.RepeatWrapping;
    concrete.map.wrapT = THREE.RepeatWrapping;
    concrete.map.repeat.set(8, 6);
    concrete.needsUpdate = true;
    const concreteEdgeTiles = concreteTiles.clone();
    concreteEdgeTiles.name = 'Bipbeta2 procedural concrete bevel texture';
    concreteEdgeTiles.repeat.set(4, 3);
    this.textures.push(concreteEdgeTiles);
    concreteEdge.map = concreteEdgeTiles;
    concreteEdge.map.colorSpace = THREE.SRGBColorSpace;
    concreteEdge.needsUpdate = true;

    // Ground level is a ring around a real recessed shaft. The shaft is the
    // visual and gameplay centre: it gives the map the stacked, vertical
    // reading of Bipbeta2 instead of presenting as a flat outdoor pad.
    this.addPlatform('Bipbeta2 lower west hall', [88, 2, 148], new THREE.Vector3(-59, -1, 0), concrete);
    this.addPlatform('Bipbeta2 lower east hall', [88, 2, 148], new THREE.Vector3(59, -1, 0), concrete);
    this.addPlatform('Bipbeta2 lower north threshold', [30, 2, 26], new THREE.Vector3(0, -1, -61), concrete);
    this.addPlatform('Bipbeta2 lower south threshold', [30, 2, 26], new THREE.Vector3(0, -1, 61), concrete);
    this.addPlatform('Bipbeta2 shaft floor', [28, 2, 92], new THREE.Vector3(0, -7, 0), charcoal);
    // Keep the shaft's collision edge low like the source's combat cover;
    // tall retaining walls turned the hero view into a pair of black pillars
    // and hid the lower route from the player.
    this.addBox('Bipbeta2 shaft west retaining wall', [2, 7, 92], new THREE.Vector3(-15, -2.5, 0), graphite);
    this.addBox('Bipbeta2 shaft east retaining wall', [2, 7, 92], new THREE.Vector3(15, -2.5, 0), graphite);

    // Sealed shell: the ceiling and four walls are deliberate. The reference
    // reads as an indoor tech facility, so no sky is allowed to dilute it.
    this.addBox('Bipbeta2 west shell wall', [4, 27, 184], new THREE.Vector3(-110, 13.5, 0), concreteEdge);
    this.addBox('Bipbeta2 east shell wall', [4, 27, 184], new THREE.Vector3(110, 13.5, 0), concreteEdge);
    this.addBox('Bipbeta2 north shell wall', [216, 27, 4], new THREE.Vector3(0, 13.5, -86), concreteEdge);
    this.addBox('Bipbeta2 south shell wall', [216, 27, 4], new THREE.Vector3(0, 13.5, 86), concreteEdge);
    this.addBox('Bipbeta2 recessed ceiling', [216, 2, 168], new THREE.Vector3(0, 27, 0), ceiling);

    // Perimeter galleries form the fast, high route. They are narrow enough
    // to feel like catwalks and broad enough for air-control fights.
    this.addPlatform('Bipbeta2 north gallery', [176, 2, 14], new THREE.Vector3(0, 6, -57), graphite);
    this.addPlatform('Bipbeta2 south gallery', [176, 2, 14], new THREE.Vector3(0, 6, 57), graphite);
    this.addPlatform('Bipbeta2 west gallery', [14, 2, 72], new THREE.Vector3(-91, 6, 0), graphite);
    this.addPlatform('Bipbeta2 east gallery', [14, 2, 72], new THREE.Vector3(91, 6, 0), graphite);
    this.addPlatform('Bipbeta2 high cross bridge', [170, 1.5, 8], new THREE.Vector3(0, 12.2, 0), charcoal);
    this.addPlatform('Bipbeta2 high north bridge', [8, 1.5, 76], new THREE.Vector3(-43, 12.2, 0), charcoal);
    this.addPlatform('Bipbeta2 high south bridge', [8, 1.5, 76], new THREE.Vector3(43, 12.2, 0), charcoal);

    const rampOptions = {
      profile: 'smootherstep' as const,
      troughDepth: 0.2,
      longitudinalSegments: 18,
      lateralSegments: 5,
      solid: true,
      skirtDepth: 1,
      collisionSkirtDepth: 1,
      followSurfaceUnderside: true,
      edgeChamfer: 0.28,
    };
    this.addRamp('Bipbeta2 northwest gallery transfer', { ...rampOptions, origin: { x: -43, y: 0.02, z: -39 }, heading: Math.PI, length: 18, width: 11, rise: 5.98 }, concreteEdge);
    this.addRamp('Bipbeta2 southeast gallery transfer', { ...rampOptions, origin: { x: 43, y: 0.02, z: 39 }, heading: 0, length: 18, width: 11, rise: 5.98 }, concreteEdge);
    this.addRamp('Bipbeta2 southwest gallery transfer', { ...rampOptions, origin: { x: -43, y: 0.02, z: 39 }, heading: 0, length: 18, width: 11, rise: 5.98 }, concreteEdge);
    this.addRamp('Bipbeta2 northeast gallery transfer', { ...rampOptions, origin: { x: 43, y: 0.02, z: -39 }, heading: Math.PI, length: 18, width: 11, rise: 5.98 }, concreteEdge);
    this.addRamp('Bipbeta2 west high transfer', { ...rampOptions, origin: { x: -83, y: 7.02, z: 0 }, heading: Math.PI * 0.5, length: 28, width: 7, rise: 5.18 }, steel);
    this.addRamp('Bipbeta2 east high transfer', { ...rampOptions, origin: { x: 83, y: 7.02, z: 0 }, heading: -Math.PI * 0.5, length: 28, width: 7, rise: 5.18 }, steel);

    // Architecture kit: panel bays, structural columns, purple fascia and
    // fluorescent verticals are repeated with variation around the shell.
    this.createWallBays('west', -107.8, [-68, -36, 0, 36, 68], concrete, black, purple, white, steel);
    this.createWallBays('east', 107.8, [-68, -36, 0, 36, 68], concrete, black, purple, white, steel);
    this.createSideWallBraces(purple);
    this.createEndBays('north', -83.8, [-78, -44, 0, 44, 78], concrete, black, purple, white, steel);
    this.createEndBays('south', 83.8, [-78, -44, 0, 44, 78], concrete, black, purple, white, steel);
    for (const y of [8.2, 16.4]) {
      this.addBox(`Bipbeta2 west inner horizontal purple band ${y}`, [0.5, 0.62, 164], new THREE.Vector3(-107.0, y, 0), purple, { collision: false });
      this.addBox(`Bipbeta2 east inner horizontal purple band ${y}`, [0.5, 0.62, 164], new THREE.Vector3(107.0, y, 0), purple, { collision: false });
    }
    // The reference's most legible landmark is the compact layered facade:
    // energy gate at left, stacked transfer opening in the middle, tall
    // vertical luminaires, and the oversized right wall glyph. It is kept as
    // a visual-only kit so collision remains governed by the authored floor
    // and movement ramps below.
    this.createReferenceFacade('north', -83.8, concreteEdge, charcoal, graphite, purple, purpleGlow, cyan, red, white, black);
    this.createReferenceFacade('south', 83.8, concreteEdge, charcoal, graphite, purple, purpleGlow, cyan, red, white, black);
    this.addBox('Bipbeta2 west continuous purple cornice', [0.8, 1, 164], new THREE.Vector3(-107.35, 22.4, 0), purple, { collision: false });
    this.addBox('Bipbeta2 east continuous purple cornice', [0.8, 1, 164], new THREE.Vector3(107.35, 22.4, 0), purple, { collision: false });
    this.addBox('Bipbeta2 north continuous purple cornice', [208, 1, 0.8], new THREE.Vector3(0, 22.4, -83.35), purple, { collision: false });
    this.addBox('Bipbeta2 south continuous purple cornice', [208, 1, 0.8], new THREE.Vector3(0, 22.4, 83.35), purple, { collision: false });
    this.addBox('Bipbeta2 west lower service trim', [0.5, 0.7, 164], new THREE.Vector3(-107.3, 2.6, 0), purple, { collision: false });
    this.addBox('Bipbeta2 east lower service trim', [0.5, 0.7, 164], new THREE.Vector3(107.3, 2.6, 0), purple, { collision: false });

    this.createCeilingCrown(purple);
    this.createCeilingLights(white, black);

    // The central shaft gets a dark spine, service pillars, and a purple
    // route line that keeps the next transfer leg obvious at speed.
    for (const z of [-42, -21, 21, 42]) {
      this.addBox(`Bipbeta2 shaft service pillar west ${z}`, [3, 8, 3], new THREE.Vector3(-18.5, 1.5, z), charcoal);
      this.addBox(`Bipbeta2 shaft service pillar east ${z}`, [3, 8, 3], new THREE.Vector3(18.5, 1.5, z), charcoal);
      this.addBox(`Bipbeta2 shaft purple spine west ${z}`, [0.32, 7, 0.32], new THREE.Vector3(-20.2, 1.5, z), purpleGlow, { collision: false });
      this.addBox(`Bipbeta2 shaft purple spine east ${z}`, [0.32, 7, 0.32], new THREE.Vector3(20.2, 1.5, z), purpleGlow, { collision: false });
    }
    this.addFloorGrid(concreteEdge, purpleGlow, amber);
    this.addGalleryFascia(graphite, charcoal, purple, cyan, red);
    this.createTwinLaunchTubes(concreteEdge, charcoal, purple, white);
    this.createLowerRouteDressing(concreteEdge, charcoal, purpleGlow, purple, white);
    this.createPortal('north', -82.8, 0, 38, 15, concreteEdge, charcoal, purple, white);
    this.createPortal('south', 82.8, 0, 38, 15, concreteEdge, charcoal, purple, white);

    this.corePosition = new THREE.Vector3(0, 13.65, 0);
    this.createCore(this.corePosition, cyan, red, amber);

    // Bipbeta2's two primary jumpers feed the two rear-wall acceleration
    // tubes. Keeping this count at two is intentional: these are the map's
    // defining high-speed decisions, not generic arena bounce pads.
    this.createJumpPad(new THREE.Vector3(-38, 0.34, -63), new THREE.Vector3(0, 0.86, 0.5), cyan);
    this.createJumpPad(new THREE.Vector3(38, 0.34, 63), new THREE.Vector3(0, 0.86, -0.5), red);

    this.collisionGeometry = this.buildCollisionGeometry();
    this.boundsTree = new MeshBVH(this.collisionGeometry, { maxLeafSize: 12 });
    this.collisionTriangles = this.collisionGeometry.getAttribute('position').count / 3;

    this.spawnPoints = [
      this.pointOnFloor(-76, -52),
      this.pointOnFloor(-76, 52),
      this.pointOnFloor(76, -52),
      this.pointOnFloor(76, 52),
      this.pointOnFloor(-91, -22),
      this.pointOnFloor(-91, 22),
      this.pointOnFloor(91, -22),
      this.pointOnFloor(91, 22),
      this.pointOnFloor(-52, 0),
      this.pointOnFloor(52, 0),
      this.pointOnFloor(-7, -35),
      this.pointOnFloor(7, 35),
    ];
    this.itemPoints = {
      'health-a': this.pointOnFloor(-76, -52, 0.8),
      'health-b': this.pointOnFloor(76, 52, 0.8),
      armor: this.pointOnFloor(-94, 0, 0.8),
      damage: this.corePosition.clone(),
      speed: this.pointOnFloor(0, -57, 0.8),
      rail: this.pointOnFloor(0, 57, 0.8),
      rocket: this.pointOnFloor(-52, 0, 0.8),
      plasma: this.pointOnFloor(52, 0, 0.8),
      shotgun: this.pointOnFloor(-7, -25, 0.8),
      sniper: this.pointOnFloor(7, 25, 0.8),
      laser: this.corePosition.clone(),
    };

    let renderTriangles = 0;
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const position = mesh.geometry.getAttribute('position');
      if (!position) return;
      renderTriangles += (mesh.geometry.index?.count ?? position.count) / 3;
    });
    this.mapInfo = {
      name: BIPBETA2.name,
      seed,
      generationVersion: BIPBETA2.generationVersion,
      ready: true,
      topologyHash: 'bipbeta2-procedural-bip-flow-two-tubes-two-jumpers-v8',
      bounds: { width: BIPBETA2.width, depth: BIPBETA2.depth },
      altitudeRange: { min: -8, max: 28 },
      renderTriangles: Math.round(renderTriangles),
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 10,
    };
  }

  update(elapsed: number, reducedMotion: boolean): void {
    const time = reducedMotion ? 0 : elapsed;
    for (const fan of this.animatedFans) fan.object.rotation.y = time * fan.speed;
    const pulse = reducedMotion ? 0.42 : 0.52 + Math.sin(time * 2.7) * 0.12;
    for (const material of this.pulseMaterials) material.emissiveIntensity = pulse;
    const weather = this.weatherGameplaySnapshot;
    if (weather) {
      this.weatherVisualDiagnostics.source = 'gameplay';
      this.weatherVisualDiagnostics.phase = weather.phase;
      this.weatherVisualDiagnostics.label = weather.label;
      this.weatherVisualDiagnostics.severity = THREE.MathUtils.clamp(weather.severity, 0, 1);
      this.weatherVisualDiagnostics.visibilityMultiplier = THREE.MathUtils.clamp(
        weather.multipliers.visibilityMultiplier,
        0,
        1,
      );
      this.weatherVisualDiagnostics.rainIntensity = weather.severity * 0.05;
      this.weatherVisualDiagnostics.visualWindStrength = weather.windStrength * 0.24;
      this.weatherVisualDiagnostics.windDirection.x = weather.windDirection.x;
      this.weatherVisualDiagnostics.windDirection.z = weather.windDirection.z;
    }
  }

  setWeatherGameplaySnapshot(snapshot: WeatherGameplaySnapshot | null): void {
    this.weatherGameplaySnapshot = snapshot;
  }

  getWeatherVisualDiagnostics(): ArenaWeatherVisualDiagnostics {
    return {
      ...this.weatherVisualDiagnostics,
      windDirection: { ...this.weatherVisualDiagnostics.windDirection },
    };
  }

  setPlayerInfluence(_position: THREE.Vector3): void {
    // The original arena has no foliage or terrain deformation layer.
  }

  resolvePlayerCapsule(position: THREE.Vector3, velocity: THREE.Vector3): CapsuleContact {
    return this.resolveCapsule(position, velocity, MOVEMENT.playerRadius, MOVEMENT.playerHeight);
  }

  resolveCapsule(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): CapsuleContact {
    this.correction.set(0, 0, 0);
    this.wallNormal.set(0, 0, 0);
    let contacts = 0;
    let grounded = false;
    let wallContact = false;
    const recoveryReach = Math.max(
      MOVEMENT.groundSnapDistance + 0.08,
      Math.min(
        Math.max(0, height - MOVEMENT.collisionSkin),
        MOVEMENT.groundSnapDistance + MOVEMENT.stepHeight + MOVEMENT.maxSubstepDistance + 0.08,
      ),
    );
    let floorFlags = this.resolveFloorContact(position, velocity, recoveryReach);
    if ((floorFlags & 1) !== 0) contacts += 1;
    grounded = (floorFlags & 2) !== 0;

    let solidCorrected = false;
    for (let pass = 0; pass < 2; pass += 1) {
      let passCorrected = false;
      const capsuleMinimumY = position.y;
      const capsuleMaximumY = position.y + height;
      for (const collider of this.colliders) {
        const box = collider.box;
        if (capsuleMaximumY <= box.min.y || capsuleMinimumY >= box.max.y) continue;
        const minX = box.min.x - radius;
        const maxX = box.max.x + radius;
        const minZ = box.min.z - radius;
        const maxZ = box.max.z + radius;
        if (position.x <= minX || position.x >= maxX || position.z <= minZ || position.z >= maxZ) continue;
        let depth = position.x - minX;
        let normalX = -1;
        let normalZ = 0;
        if (maxX - position.x < depth) {
          depth = maxX - position.x;
          normalX = 1;
        }
        if (position.z - minZ < depth) {
          depth = position.z - minZ;
          normalX = 0;
          normalZ = -1;
        }
        if (maxZ - position.z < depth) {
          depth = maxZ - position.z;
          normalX = 0;
          normalZ = 1;
        }
        const correction = depth + 0.001;
        position.x += normalX * correction;
        position.z += normalZ * correction;
        this.correction.x += normalX * correction;
        this.correction.z += normalZ * correction;
        const intoSurface = velocity.x * normalX + velocity.z * normalZ;
        if (intoSurface < 0) {
          velocity.x -= normalX * intoSurface;
          velocity.z -= normalZ * intoSurface;
        }
        this.wallNormal.set(normalX, 0, normalZ);
        wallContact = true;
        passCorrected = true;
        contacts += 1;
      }
      for (const ramp of this.ramps) {
        const rampHit = this.rampSolidContact(ramp, position, radius, height);
        if (!rampHit) continue;
        position.addScaledVector(rampHit.normal, rampHit.depth + 0.001);
        this.correction.addScaledVector(rampHit.normal, rampHit.depth + 0.001);
        const intoSurface = velocity.dot(rampHit.normal);
        if (intoSurface < 0) velocity.addScaledVector(rampHit.normal, -intoSurface);
        this.wallNormal.copy(rampHit.normal);
        wallContact = true;
        passCorrected = true;
        contacts += 1;
      }
      if (!passCorrected) break;
      solidCorrected = true;
    }
    if (solidCorrected) {
      floorFlags = this.resolveFloorContact(position, velocity, recoveryReach);
      grounded = (floorFlags & 2) !== 0;
      if ((floorFlags & 1) !== 0) contacts += 1;
    }

    const result = this.capsuleContacts[this.capsuleContactCursor];
    this.capsuleContactCursor = (this.capsuleContactCursor + 1) % this.capsuleContacts.length;
    result.grounded = grounded;
    result.contactNormal.copy(this.contactNormal);
    result.wallContact = wallContact;
    result.wallNormal.copy(this.wallNormal);
    result.correction.copy(this.correction);
    result.contacts = contacts;
    return result;
  }

  private resolveFloorContact(position: THREE.Vector3, velocity: THREE.Vector3, recoveryReach: number): number {
    const floor = this.floorSurfaceAt(position.x, position.z, position.y + recoveryReach);
    if (!floor) return 0;
    this.contactNormal.copy(floor.normal);
    const gap = position.y - floor.height;
    const snap = velocity.y <= 0.5 && gap <= MOVEMENT.groundSnapDistance + 0.025;
    if (gap > 0.015 && !snap) return 0;
    const correctionY = floor.height - position.y;
    position.y = floor.height;
    this.correction.y += correctionY;
    const intoSurface = velocity.dot(this.contactNormal);
    if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
    const grounded = this.contactNormal.y >= MOVEMENT.maxSlopeCosine && intoSurface <= 1.2;
    return grounded ? 3 : 1;
  }

  private rampSolidContact(
    ramp: BipbetaRamp,
    position: THREE.Vector3,
    radius: number,
    height: number,
  ): { normal: THREE.Vector3; depth: number } | null {
    const spec = ramp.spec;
    const dx = position.x - spec.origin.x;
    const dz = position.z - spec.origin.z;
    const sine = Math.sin(spec.heading);
    const cosine = Math.cos(spec.heading);
    const longitudinal = dx * sine + dz * cosine;
    const lateral = dx * cosine - dz * sine;
    const halfWidth = spec.width * 0.5;
    if (
      longitudinal <= -radius
      || longitudinal >= spec.length + radius
      || lateral <= -halfWidth - radius
      || lateral >= halfWidth + radius
    ) return null;
    const surfaceY = spec.origin.y + spec.rise * Math.pow(
      THREE.MathUtils.clamp(longitudinal / spec.length, 0, 1),
      spec.curveExponent ?? 1.8,
    );
    const bottomY = spec.origin.y - (spec.collisionSkirtDepth ?? spec.skirtDepth ?? 0.8);
    if (position.y + height <= bottomY + 0.01 || position.y >= surfaceY - 0.015) return null;
    const entryDepth = Math.max(radius + 0.35, spec.length * 0.08);
    if (
      longitudinal <= entryDepth
      && Math.abs(lateral) <= halfWidth
      && surfaceY - position.y <= Math.max(MOVEMENT.stepHeight + 0.04, MOVEMENT.groundSnapDistance + 0.14)
    ) return null;
    let depth = longitudinal + radius;
    let normalX = -sine;
    let normalZ = -cosine;
    const exitDepth = spec.length + radius - longitudinal;
    if (exitDepth < depth) {
      depth = exitDepth;
      normalX = sine;
      normalZ = cosine;
    }
    const leftDepth = lateral + halfWidth + radius;
    if (leftDepth < depth) {
      depth = leftDepth;
      normalX = -cosine;
      normalZ = sine;
    }
    const rightDepth = halfWidth + radius - lateral;
    if (rightDepth < depth) {
      depth = rightDepth;
      normalX = cosine;
      normalZ = -sine;
    }
    this.rampNormal.set(normalX, 0, normalZ);
    this.rampContact.depth = depth;
    return this.rampContact;
  }

  floorHeightAt(x: number, z: number, fromY = 96): number | null {
    return this.floorSurfaceAt(x, z, fromY)?.height ?? null;
  }

  surfaceNormalAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): THREE.Vector3 | null {
    return this.floorSurfaceAt(x, z, fromY)?.normal ?? null;
  }

  private floorSurfaceAt(x: number, z: number, fromY: number): { height: number; normal: THREE.Vector3 } | null {
    let hasSurface = false;
    let highest = Number.NEGATIVE_INFINITY;
    for (const floor of this.floors) {
      if (x < floor.minX || x > floor.maxX || z < floor.minZ || z > floor.maxZ) continue;
      if (floor.y <= fromY + 0.04 && floor.y > highest) {
        hasSurface = true;
        highest = floor.y;
        this.floorNormal.copy(floor.normal);
      }
    }
    for (const ramp of this.ramps) {
      const height = ramp.flow.heightAt(x, z);
      if (height !== null && height <= fromY + 0.04 && height > highest) {
        hasSurface = true;
        highest = height;
        ramp.flow.normalAt(x, z, this.floorNormal);
      }
    }
    if (!hasSurface) return null;
    this.floorResult.height = highest;
    return this.floorResult;
  }

  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    const direction = this.rayDirection.copy(end).sub(start);
    const distance = direction.length();
    if (distance < EPSILON) return null;
    direction.multiplyScalar(1 / distance);
    const hit = this.boundsTree.raycastFirst(this.collisionRay.set(start, direction), THREE.DoubleSide, 0, distance);
    if (!hit) return null;
    const normal = hit.face?.normal
      ? this.rayHitNormal.copy(hit.face.normal)
      : this.rayHitNormal.set(0, 1, 0);
    if (normal.dot(direction) > 0) normal.negate();
    const result = this.surfaceHit;
    result.point.copy(hit.point);
    result.normal.copy(normal);
    result.distance = hit.distance;
    result.surface = normal.y < 0.62 ? 'metal' : 'concrete';
    return result;
  }

  movementSegmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    return this.segmentHitDetails(start, end);
  }

  surfaceAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): ArenaSurface {
    return this.floorSurfaceAt(x, z, fromY) ? 'concrete' : 'water';
  }

  addFootTrack(_position: THREE.Vector3, _movement: THREE.Vector3, _elapsed: number): void {
    // The authored metal/concrete surfaces do not receive footprint decals.
  }

  registerSurfaceImpact(_position: THREE.Vector3, _normal: THREE.Vector3, _energy: number, _elapsed: number): void {
    // Combat impact decals are intentionally omitted from the movement map.
  }

  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null {
    return this.segmentHitDetails(start, end)?.point ?? null;
  }

  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance = 0.12): boolean {
    const hit = this.segmentHitDetails(start, end);
    return hit === null || hit.point.distanceToSquared(end) <= endTolerance * endTolerance;
  }

  safeSpawnPoint(candidate: THREE.Vector3, radius = MOVEMENT.playerRadius, height = MOVEMENT.playerHeight): THREE.Vector3 | null {
    const floor = this.floorSurfaceAt(candidate.x, candidate.z, Number.POSITIVE_INFINITY);
    if (!floor || floor.normal.y < MOVEMENT.maxSlopeCosine) return null;
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2;
      const sample = this.floorSurfaceAt(
        candidate.x + Math.cos(angle) * (radius + 0.12),
        candidate.z + Math.sin(angle) * (radius + 0.12),
        Number.POSITIVE_INFINITY,
      );
      if (!sample || Math.abs(sample.height - floor.height) > 0.72) return null;
    }
    const seated = new THREE.Vector3(candidate.x, floor.height, candidate.z);
    const capsuleBox = new THREE.Box3(
      new THREE.Vector3(seated.x - radius, seated.y + 0.02, seated.z - radius),
      new THREE.Vector3(seated.x + radius, seated.y + height, seated.z + radius),
    );
    if (this.colliders.some((collider) => collider.box.intersectsBox(capsuleBox))) return null;
    const contact = this.resolveCapsule(seated, new THREE.Vector3(0, -0.1, 0), radius, height);
    return contact.grounded && !contact.wallContact ? seated : null;
  }

  isTraversablePoint(candidate: THREE.Vector3, fromY = candidate.y + 4): boolean {
    const floor = this.floorSurfaceAt(candidate.x, candidate.z, fromY);
    return Boolean(floor && floor.normal.y >= MOVEMENT.maxSlopeCosine);
  }

  dispose(): void {
    for (const geometry of new Set(this.geometries)) geometry.dispose();
    this.collisionGeometry.dispose();
    for (const material of new Set(this.materials)) material.dispose();
    for (const texture of new Set(this.textures)) texture.dispose();
  }

  private material(name: string, color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      name,
      color,
      metalness,
      roughness,
      flatShading: false,
    });
    this.materials.push(material);
    return material;
  }

  private createConcreteTileTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create Bipbeta2 concrete tile texture.');
    context.fillStyle = '#d1d0cc';
    context.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const grain = ((x * 17 + y * 31 + (x ^ y) * 7) % 19) - 9;
        const stain = Math.sin(x * 0.07) * 2 + Math.cos(y * 0.11) * 2 + Math.sin((x + y) * 0.025) * 3;
        const value = Math.max(0, Math.min(255, 209 + grain + stain));
        context.fillStyle = `rgb(${value},${value},${value + 2})`;
        context.fillRect(x, y, 1, 1);
      }
    }
    context.fillStyle = 'rgba(102,108,112,0.07)';
    for (const patch of [
      [28, 34, 88, 42], [154, 20, 70, 66], [78, 148, 112, 50], [194, 176, 46, 56],
    ]) {
      context.beginPath();
      context.ellipse(patch[0], patch[1], patch[2], patch[3], 0.15, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = 'rgba(55,59,62,0.34)';
    context.lineWidth = 3;
    for (const line of [0, 64, 128, 192, 256]) {
      context.beginPath();
      context.moveTo(line, 0);
      context.lineTo(line, 256);
      context.stroke();
      context.beginPath();
      context.moveTo(0, line);
      context.lineTo(256, line);
      context.stroke();
    }
    context.strokeStyle = 'rgba(231,232,230,0.34)';
    context.lineWidth = 1;
    for (const line of [4, 68, 132, 196, 252]) {
      context.beginPath();
      context.moveTo(line, 0);
      context.lineTo(line, 256);
      context.stroke();
      context.beginPath();
      context.moveTo(0, line);
      context.lineTo(256, line);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'Bipbeta2 procedural concrete tiles';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.textures.push(texture);
    return texture;
  }

  private createEnergyWaterfallTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create Bipbeta2 energy waterfall texture.');
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const ripple = Math.sin(x * 0.24) * 14 + Math.sin(x * 0.07 + y * 0.012) * 7 + Math.sin(y * 0.16) * 3;
        const pixel = ((x * 37 + y * 17 + (x ^ (y * 3))) % 31) - 15;
        const value = Math.max(158, Math.min(255, Math.round(226 + ripple + pixel)));
        const blue = Math.max(198, Math.min(255, value + 18));
        context.fillStyle = `rgb(${value},${Math.min(255, value + 8)},${blue})`;
        context.fillRect(x, y, 1, 1);
      }
    }
    // The source landmark is not a blank emissive rectangle: it is a noisy
    // white/cyan curtain with enough vertical breakup to read while moving
    // past it. Keep the texture deterministic so screenshots and replays are
    // stable, but layer the streaks over the base noise at a stronger value.
    context.globalAlpha = 0.64;
    context.strokeStyle = '#62dff4';
    context.lineWidth = 2.1;
    for (let x = 4; x < canvas.width; x += 9) {
      context.beginPath();
      context.moveTo(x, 0);
      for (let y = 16; y <= canvas.height; y += 16) {
        context.lineTo(x + Math.sin(y * 0.035 + x * 0.31) * 1.8, y);
      }
      context.stroke();
    }
    context.globalAlpha = 0.34;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.2;
    for (let x = 1; x < canvas.width; x += 13) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + Math.sin(x * 0.3) * 3, canvas.height);
      context.stroke();
    }
    context.globalAlpha = 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'Bipbeta2 procedural energy waterfall';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.textures.push(texture);
    return texture;
  }

  private emissiveMaterial(name: string, color: number, emissive: number): THREE.MeshStandardMaterial {
    const material = this.material(name, color, 0.42, 0.34);
    material.emissive.setHex(emissive);
    material.emissiveIntensity = 0.52;
    this.pulseMaterials.push(material);
    return material;
  }

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
    position = new THREE.Vector3(),
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private addBox(
    name: string,
    size: [number, number, number],
    position: THREE.Vector3,
    material: THREE.Material,
    options: { collision?: boolean; floor?: boolean } = {},
  ): THREE.Mesh {
    const mesh = this.addMesh(new THREE.BoxGeometry(...size), material, name, position);
    const box = new THREE.Box3(
      new THREE.Vector3(position.x - size[0] * 0.5, position.y - size[1] * 0.5, position.z - size[2] * 0.5),
      new THREE.Vector3(position.x + size[0] * 0.5, position.y + size[1] * 0.5, position.z + size[2] * 0.5),
    );
    if (options.collision !== false) {
      this.colliders.push({ name, box });
      this.collisionParts.push(this.positionOnlyBox(box));
    }
    if (options.floor) {
      this.floors.push({
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
        y: box.max.y,
        normal: new THREE.Vector3(0, 1, 0),
      });
    }
    return mesh;
  }

  private addPlatform(name: string, size: [number, number, number], position: THREE.Vector3, material: THREE.Material): void {
    this.addBox(name, size, position, material, { floor: true });
  }

  private addInvisibleCollisionBox(name: string, size: [number, number, number], position: THREE.Vector3): void {
    const box = new THREE.Box3(
      new THREE.Vector3(position.x - size[0] * 0.5, position.y - size[1] * 0.5, position.z - size[2] * 0.5),
      new THREE.Vector3(position.x + size[0] * 0.5, position.y + size[1] * 0.5, position.z + size[2] * 0.5),
    );
    this.colliders.push({ name, box });
    this.collisionParts.push(this.positionOnlyBox(box));
  }

  private addRamp(name: string, spec: LaunchRampSpec, material: THREE.Material): void {
    const flow = buildLaunchRamp(spec);
    this.addMesh(flow.geometry, material, name);
    this.ramps.push({ name, spec, flow });
    this.collisionParts.push(this.positionOnlyGeometry(flow.geometry));
  }

  private addRail(name: string, start: THREE.Vector3, end: THREE.Vector3, material: THREE.Material): void {
    const midpoint = start.clone().add(end).multiplyScalar(0.5);
    const length = start.distanceTo(end);
    const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.z - start.z);
    this.addBox(
      name,
      horizontal ? [length, 0.28, 0.32] : [0.32, 0.28, length],
      midpoint,
      material,
      { collision: false },
    );
  }

  private addInstancedBox(
    name: string,
    size: [number, number, number],
    positions: readonly THREE.Vector3[],
    material: THREE.Material,
  ): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(...size);
    this.geometries.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    positions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  private addInstancedRoundedBox(
    name: string,
    size: [number, number, number],
    positions: readonly THREE.Vector3[],
    material: THREE.Material,
    bevel = 0.12,
  ): THREE.InstancedMesh {
    const geometry = new RoundedBoxGeometry(size[0], size[1], size[2], 1, bevel);
    this.geometries.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    positions.forEach((position, index) => {
      matrix.makeTranslation(position.x, position.y, position.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  private createSideWallBraces(trim: THREE.Material): void {
    // The reference side halls use occasional diagonal purple braces to
    // break the long light-bay rhythm. They are intentionally sparse: the
    // wall should still read as a continuous curved service shell at speed.
    for (const [sideIndex, x] of [-107.02, 107.02].entries()) {
      for (const [braceIndex, z] of [-54, -18, 18, 54].entries()) {
        const direction = (sideIndex + braceIndex) % 2 === 0 ? 1 : -1;
        const path = new THREE.LineCurve3(
          new THREE.Vector3(x, 6.0, z - direction * 10.5),
          new THREE.Vector3(x, 20.2, z + direction * 10.5),
        );
        this.addMesh(
          new THREE.TubeGeometry(path, 8, 0.42, 6, false),
          trim,
          `Bipbeta2 side wall diagonal brace ${sideIndex + 1}-${braceIndex + 1}`,
        );
      }
    }
  }

  private createWallBays(
    side: 'west' | 'east',
    x: number,
    zPositions: readonly number[],
    panel: THREE.Material,
    recess: THREE.Material,
    trim: THREE.Material,
    light: THREE.Material,
    steel: THREE.Material,
  ): void {
    const inward = side === 'west' ? 1 : -1;
    const panelX = x + inward * 0.28;
    const lightX = x + inward * 0.48;
    for (const z of zPositions) {
      this.addBox(`Bipbeta2 ${side} wall bay backing ${z}`, [0.32, 12.5, 17], new THREE.Vector3(panelX, 13.5, z), panel, { collision: false });
      this.addBox(`Bipbeta2 ${side} wall bay recess ${z}`, [0.12, 10.5, 10.8], new THREE.Vector3(panelX + inward * 0.2, 13.5, z), recess, { collision: false });
    }
    const lightPositions = zPositions.map((z) => new THREE.Vector3(lightX, 13.5, z));
    const panelPositions = zPositions.map((z) => new THREE.Vector3(lightX + inward * 0.12, 13.5, z));
    this.addInstancedRoundedBox(`Bipbeta2 ${side} tall light housings`, [0.72, 10.2, 2.6], lightPositions, recess, 0.14);
    this.addInstancedRoundedBox(`Bipbeta2 ${side} tall light panels`, [0.78, 7.4, 1.28], panelPositions, light, 0.18);
    this.addInstancedRoundedBox(
      `Bipbeta2 ${side} segmented wall luminaire cells`,
      [0.82, 3.35, 1.34],
      lightPositions.flatMap((position) => [
        new THREE.Vector3(position.x + inward * 0.16, 16.55, position.z),
        new THREE.Vector3(position.x + inward * 0.16, 11.35, position.z),
      ]),
      light,
      0.14,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} segmented wall luminaire dividers`,
      [0.9, 0.7, 1.42],
      lightPositions.map((position) => new THREE.Vector3(position.x + inward * 0.18, 13.95, position.z)),
      recess,
    );
    const capPositions = zPositions.map((z) => new THREE.Vector3(lightX, 19.2, z));
    const sillPositions = zPositions.map((z) => new THREE.Vector3(lightX, 7.8, z));
    this.addInstancedBox(`Bipbeta2 ${side} light purple caps`, [0.22, 0.3, 12.2], capPositions, trim);
    this.addInstancedBox(`Bipbeta2 ${side} light steel sills`, [0.22, 0.3, 12.2], sillPositions, steel);
    const columnPositions = zPositions.slice(0, -1).map((z, index) => {
      const next = zPositions[index + 1];
      return new THREE.Vector3(x + inward * 0.36, 13.5, (z + next) * 0.5);
    });
    this.addInstancedBox(`Bipbeta2 ${side} wall vertical mullions`, [0.6, 23, 0.8], columnPositions, steel);
  }

  private createEndBays(
    side: 'north' | 'south',
    z: number,
    xPositions: readonly number[],
    panel: THREE.Material,
    recess: THREE.Material,
    trim: THREE.Material,
    light: THREE.Material,
    steel: THREE.Material,
  ): void {
    const inward = side === 'north' ? 1 : -1;
    const panelZ = z + inward * 0.28;
    const lightZ = z + inward * 0.48;
    for (const x of xPositions) {
      this.addBox(`Bipbeta2 ${side} wall bay backing ${x}`, [17, 12.5, 0.32], new THREE.Vector3(x, 13.5, panelZ), panel, { collision: false });
      this.addBox(`Bipbeta2 ${side} wall bay recess ${x}`, [10.8, 10.5, 0.12], new THREE.Vector3(x, 13.5, panelZ + inward * 0.2), recess, { collision: false });
    }
    const lightPositions = xPositions.map((x) => new THREE.Vector3(x, 13.5, lightZ));
    const panelPositions = xPositions.map((x) => new THREE.Vector3(x, 13.5, lightZ + inward * 0.12));
    this.addInstancedRoundedBox(`Bipbeta2 ${side} tall light housings`, [2.6, 10.2, 0.72], lightPositions, recess, 0.14);
    this.addInstancedRoundedBox(`Bipbeta2 ${side} tall light panels`, [1.28, 7.4, 0.78], panelPositions, light, 0.18);
    this.addInstancedRoundedBox(
      `Bipbeta2 ${side} segmented wall luminaire cells`,
      [1.34, 3.35, 0.82],
      lightPositions.flatMap((position) => [
        new THREE.Vector3(position.x, 16.55, position.z + inward * 0.16),
        new THREE.Vector3(position.x, 11.35, position.z + inward * 0.16),
      ]),
      light,
      0.14,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} segmented wall luminaire dividers`,
      [1.42, 0.7, 0.9],
      lightPositions.map((position) => new THREE.Vector3(position.x, 13.95, position.z + inward * 0.18)),
      recess,
    );
    const capPositions = xPositions.map((x) => new THREE.Vector3(x, 19.2, lightZ));
    const sillPositions = xPositions.map((x) => new THREE.Vector3(x, 7.8, lightZ));
    this.addInstancedBox(`Bipbeta2 ${side} light purple caps`, [12.2, 0.3, 0.22], capPositions, trim);
    this.addInstancedBox(`Bipbeta2 ${side} light steel sills`, [12.2, 0.3, 0.22], sillPositions, steel);
    const columnPositions = xPositions.slice(0, -1).map((x, index) => {
      const next = xPositions[index + 1];
      return new THREE.Vector3((x + next) * 0.5, 13.5, z + inward * 0.36);
    });
    this.addInstancedBox(`Bipbeta2 ${side} wall horizontal mullions`, [0.8, 23, 0.6], columnPositions, steel);
  }

  private createCeilingLights(light: THREE.Material, recess: THREE.Material): void {
    const panels: THREE.Vector3[] = [];
    const recesses: THREE.Vector3[] = [];
    for (const x of [-76, -38, 0, 38, 76]) {
      for (const z of [-58, -19, 19, 58]) {
        panels.push(new THREE.Vector3(x, 25.92, z));
        recesses.push(new THREE.Vector3(x, 26.12, z));
      }
    }
    this.addInstancedBox('Bipbeta2 repeated ceiling light panels', [18, 0.14, 3.2], panels, light);
    this.addInstancedBox('Bipbeta2 repeated ceiling light recesses', [20, 0.28, 5], recesses, recess);
  }

  private createCeilingCrown(trim: THREE.Material): void {
    // Three shallow transverse bows preserve the purple structural language
    // visible in the footage without turning the whole roof into a perfect
    // orthogonal grid. The low-poly tube profile keeps the silhouette crisp
    // at movement speed and is render-only by design.
    for (const z of [-58, 0, 58]) {
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-103, 24.0, z),
        new THREE.Vector3(-82, 25.0, z),
        new THREE.Vector3(-48, 25.9, z),
        new THREE.Vector3(0, 26.35, z),
        new THREE.Vector3(48, 25.9, z),
        new THREE.Vector3(82, 25.0, z),
        new THREE.Vector3(103, 24.0, z),
      ]);
      this.addMesh(
        new THREE.TubeGeometry(path, 24, 0.34, 6, false),
        trim,
        `Bipbeta2 curved ceiling crown ${z}`,
      );
    }
  }

  private addFloorGrid(concreteEdge: THREE.Material, route: THREE.Material, launch: THREE.Material): void {
    const seams: THREE.Vector3[] = [];
    for (const x of [-96, -76, -56, -36, 36, 56, 76, 96]) {
      for (const z of [-68, -48, -28, -8, 12, 32, 52, 72]) seams.push(new THREE.Vector3(x, 0.045, z));
    }
    this.addInstancedBox('Bipbeta2 lower floor longitudinal seam grid', [0.12, 0.06, 18.2], seams, concreteEdge);
    const crossSeams = [-94, -72, -50, -28, 28, 50, 72, 94].map((x) => new THREE.Vector3(x, 0.05, 0));
    this.addInstancedBox('Bipbeta2 lower floor cross seam grid', [18.2, 0.065, 0.12], crossSeams, concreteEdge);
    const routeMarkers: THREE.Vector3[] = [];
    for (const z of [-42, -21, 0, 21, 42]) {
      routeMarkers.push(new THREE.Vector3(-11, 0.055, z), new THREE.Vector3(11, 0.055, z));
    }
    this.addInstancedBox('Bipbeta2 shaft purple route markers', [0.22, 0.08, 8], routeMarkers, route);
    this.addBox('Bipbeta2 north launch lane marker', [4, 0.08, 0.26], new THREE.Vector3(0, 0.06, -45.5), launch, { collision: false });
    this.addBox('Bipbeta2 south launch lane marker', [4, 0.08, 0.26], new THREE.Vector3(0, 0.06, 45.5), launch, { collision: false });
  }

  private addGalleryFascia(
    gallery: THREE.Material,
    charcoal: THREE.Material,
    trim: THREE.Material,
    cyan: THREE.Material,
    red: THREE.Material,
  ): void {
    const parapet = (name: string, size: [number, number, number], position: THREE.Vector3, accent: THREE.Material) => {
      this.addBox(`${name} dark parapet`, size, position, charcoal);
      this.addBox(`${name} purple handrail`, [size[0], 0.18, size[2]], new THREE.Vector3(position.x, position.y + size[1] * 0.52, position.z), trim, { collision: false });
      this.addBox(`${name} route light`, [size[0] * 0.76, 0.12, size[2] * 0.18], new THREE.Vector3(position.x, position.y - size[1] * 0.42, position.z), accent, { collision: false });
    };
    parapet('Bipbeta2 north gallery outer edge', [172, 1.1, 0.7], new THREE.Vector3(0, 7.55, -64), cyan);
    parapet('Bipbeta2 south gallery outer edge', [172, 1.1, 0.7], new THREE.Vector3(0, 7.55, 64), red);
    parapet('Bipbeta2 west gallery outer edge', [0.7, 1.1, 68], new THREE.Vector3(-98, 7.55, 0), cyan);
    parapet('Bipbeta2 east gallery outer edge', [0.7, 1.1, 68], new THREE.Vector3(98, 7.55, 0), red);
    parapet('Bipbeta2 high cross bridge north rail', [164, 1.05, 0.6], new THREE.Vector3(0, 13.75, -4), trim);
    parapet('Bipbeta2 high cross bridge south rail', [164, 1.05, 0.6], new THREE.Vector3(0, 13.75, 4), trim);
    this.addBox('Bipbeta2 west gallery underside fascia', [16, 0.8, 68], new THREE.Vector3(-91, 4.8, 0), gallery, { collision: false });
    this.addBox('Bipbeta2 east gallery underside fascia', [16, 0.8, 68], new THREE.Vector3(91, 4.8, 0), gallery, { collision: false });
    this.addRail('Bipbeta2 north gallery inner trim', new THREE.Vector3(-84, 7.18, -50), new THREE.Vector3(84, 7.18, -50), trim);
    this.addRail('Bipbeta2 south gallery inner trim', new THREE.Vector3(-84, 7.18, 50), new THREE.Vector3(84, 7.18, 50), trim);
  }

  private createTwinLaunchTubes(
    concrete: THREE.MeshStandardMaterial,
    shell: THREE.Material,
    trim: THREE.Material,
    light: THREE.Material,
  ): void {
    // Bipbeta2's signature movement space is not a single flat arena: two
    // parallel tubes create the long, enclosed acceleration lines. The tube
    // The riding floors sit on the existing side halls, but the tube flanks
    // and rear caps are real collision boundaries. This is what makes the
    // signature shot-the-back-wall line a repeatable route instead of a mesh
    // painted over an open room.
    const tubeCenters = [-38, 38];
    const tubeRadius = 7.2;
    const tubeLength = 144;
    const tubeZ = [-72, 72];
    for (const [index, centerX] of tubeCenters.entries()) {
      const tubeTrim = this.emissiveMaterial(
        `Bipbeta2 twin launch tube ${index + 1} violet interior trim`,
        0xc447ff,
        0x711b9e,
      );
      const tubeMaterial = concrete.clone();
      tubeMaterial.name = `Bipbeta2 twin launch tube ${index + 1} interior material`;
      tubeMaterial.color.setHex(0x77737c);
      tubeMaterial.roughness = 0.7;
      tubeMaterial.side = THREE.DoubleSide;
      this.materials.push(tubeMaterial);
      const path = new THREE.LineCurve3(
        new THREE.Vector3(centerX, 5.8, -tubeLength * 0.5),
        new THREE.Vector3(centerX, 5.8, tubeLength * 0.5),
      );
      const tube = this.addMesh(
        new THREE.TubeGeometry(path, 22, tubeRadius, 8, false),
        tubeMaterial,
        `Bipbeta2 twin launch tube ${index + 1} concrete shell`,
      );
      tube.castShadow = true;
      tube.receiveShadow = true;

      const ringGeometry = new THREE.TorusGeometry(tubeRadius + 0.18, 0.42, 5, 12);
      this.geometries.push(ringGeometry);
      for (const z of tubeZ) {
        const ring = new THREE.Mesh(ringGeometry, tubeTrim);
        ring.name = `Bipbeta2 twin launch tube ${index + 1} purple mouth ring ${z}`;
        ring.position.set(centerX, 5.8, z);
        ring.rotation.x = Math.PI * 0.5;
        ring.castShadow = true;
        ring.receiveShadow = true;
        this.group.add(ring);
      }

      const ribs = [-54, -27, 0, 27, 54].map((z) => new THREE.Vector3(centerX, 5.8, z));
      const ribGeometry = new THREE.TorusGeometry(tubeRadius + 0.03, 0.16, 4, 10);
      this.geometries.push(ribGeometry);
      const ribMesh = new THREE.InstancedMesh(ribGeometry, tubeTrim, ribs.length);
      ribMesh.name = `Bipbeta2 twin launch tube ${index + 1} structural ribs`;
      ribMesh.castShadow = true;
      ribMesh.receiveShadow = true;
      const matrix = new THREE.Matrix4();
      ribs.forEach((position, ribIndex) => {
        matrix.makeRotationX(Math.PI * 0.5);
        matrix.setPosition(position.x, position.y, position.z);
        ribMesh.setMatrixAt(ribIndex, matrix);
      });
      ribMesh.instanceMatrix.needsUpdate = true;
      this.group.add(ribMesh);

      // Longitudinal purple ribs are the interior read at speed. They give
      // the straight tube a visible ceiling/side curvature in first-person,
      // while the dark circumferential ribs keep the shell segmented.
      for (const angle of [Math.PI * 0.3, Math.PI * 0.5, Math.PI * 0.7]) {
        const interiorRailRadius = tubeRadius * 0.58;
        const railPath = new THREE.LineCurve3(
          new THREE.Vector3(centerX + Math.cos(angle) * interiorRailRadius, 5.8 + Math.sin(angle) * interiorRailRadius, -64),
          new THREE.Vector3(centerX + Math.cos(angle) * interiorRailRadius, 5.8 + Math.sin(angle) * interiorRailRadius, 64),
        );
        this.addMesh(
          new THREE.TubeGeometry(railPath, 18, 0.18, 5, false),
          tubeTrim,
          `Bipbeta2 twin launch tube ${index + 1} interior longitudinal rail ${angle}`,
        );
      }
      this.addInstancedBox(
        `Bipbeta2 twin launch tube ${index + 1} visible ceiling route rails`,
        [0.28, 0.24, 128],
        [
          new THREE.Vector3(centerX - 3.2, 9.2, 0),
          new THREE.Vector3(centerX, 10.1, 0),
          new THREE.Vector3(centerX + 3.2, 9.2, 0),
        ],
        tubeTrim,
      );

      const rearWallMaterial = shell.clone();
      rearWallMaterial.name = `Bipbeta2 twin launch tube ${index + 1} rear wall material`;
      rearWallMaterial.side = THREE.DoubleSide;
      this.materials.push(rearWallMaterial);
      const rearWall = this.addMesh(
        new THREE.CircleGeometry(tubeRadius * 0.94, 16),
        rearWallMaterial,
        `Bipbeta2 twin launch tube ${index + 1} visible rear wall`,
        new THREE.Vector3(centerX, 5.8, index === 0 ? 66.7 : -66.7),
      );
      rearWall.rotation.y = 0;
      const rearMark = this.addMesh(
        new THREE.TorusGeometry(tubeRadius * 0.54, 0.16, 5, 16),
        tubeTrim,
        `Bipbeta2 twin launch tube ${index + 1} rear wall target ring`,
        new THREE.Vector3(centerX, 5.8, index === 0 ? 66.35 : -66.35),
      );
      rearMark.rotation.x = Math.PI * 0.5;

      const lights = [-58, -29, 0, 29, 58].map((z) => new THREE.Vector3(centerX, 12.62, z));
      this.addInstancedBox(
        `Bipbeta2 twin launch tube ${index + 1} overhead light bands`,
        [1.1, 0.12, 5.2],
        lights,
        light,
      );
      this.addBox(
        `Bipbeta2 twin launch tube ${index + 1} floor route strip`,
        [0.32, 0.08, 126],
        new THREE.Vector3(centerX, 0.1, 0),
        trim,
        { collision: false },
      );
      // The exterior of each tube doubles as a long wall-run surface. Two
      // inset violet bands make that side readable from the lower apron and
      // match the reference's continuous purple wall language.
      const outward = index === 0 ? -1 : 1;
      for (const y of [4.15, 8.15]) {
        this.addBox(
          `Bipbeta2 twin launch tube ${index + 1} exterior purple wall band ${y}`,
          [0.34, 0.46, 128],
          new THREE.Vector3(centerX + outward * (tubeRadius + 0.08), y, 0),
          trim,
          { collision: false },
        );
      }

      // The real cylindrical mesh is intentionally kept render-only. These
      // low-cost axial blockers match its walkable envelope for the capsule
      // solver without pretending that the solver understands curved BSP.
      this.addInvisibleCollisionBox(
        `Bipbeta2 twin launch tube ${index + 1} left collision flank`,
        [0.75, 11.2, 134],
        new THREE.Vector3(centerX - 6.85, 5.6, 0),
      );
      this.addInvisibleCollisionBox(
        `Bipbeta2 twin launch tube ${index + 1} right collision flank`,
        [0.75, 11.2, 134],
        new THREE.Vector3(centerX + 6.85, 5.6, 0),
      );
      this.addInvisibleCollisionBox(
        `Bipbeta2 twin launch tube ${index + 1} rear wall`,
        [13.7, 11.2, 0.8],
        new THREE.Vector3(centerX, 5.6, index === 0 ? 67.2 : -67.2),
      );
    }
  }

  private createLowerRouteDressing(
    concrete: THREE.Material,
    charcoal: THREE.Material,
    route: THREE.Material,
    trim: THREE.Material,
    light: THREE.Material,
  ): void {
    // The reference's lower run is a readable sequence of open tiled apron,
    // one dark cover mass, a sloped transfer and a curved service brace. These
    // are deliberately offset so the room is not a mirrored collection of
    // empty boxes while preserving the two clear tube lanes.
    this.addBox(
      'Bipbeta2 west lower dark cover mass',
      [18, 4.4, 22],
      new THREE.Vector3(-68, 2.2, -22),
      charcoal,
    );
    this.addBox(
      'Bipbeta2 west lower cover purple edge',
      [18.4, 0.22, 0.5],
      new THREE.Vector3(-68, 4.48, -33.0),
      trim,
      { collision: false },
    );
    this.addBox(
      'Bipbeta2 east lower dark cover mass',
      [14, 3.2, 28],
      new THREE.Vector3(68, 1.6, 27),
      charcoal,
    );
    this.addRamp(
      'Bipbeta2 east lower sloped transfer',
      {
        profile: 'smootherstep',
        troughDepth: 0.16,
        longitudinalSegments: 14,
        lateralSegments: 5,
        solid: true,
        skirtDepth: 0.8,
        collisionSkirtDepth: 0.8,
        followSurfaceUnderside: true,
        edgeChamfer: 0.22,
        origin: { x: 51, y: 0.02, z: 4 },
        heading: 0,
        length: 24,
        width: 15,
        rise: 3.2,
      },
      concrete,
    );
    this.addBox(
      'Bipbeta2 west lower violet lane stripe',
      [0.72, 0.08, 112],
      new THREE.Vector3(-59, 0.08, 0),
      route,
      { collision: false },
    );
    this.addBox(
      'Bipbeta2 east lower violet lane stripe',
      [0.72, 0.08, 112],
      new THREE.Vector3(59, 0.08, 0),
      route,
      { collision: false },
    );

    const serviceBraceMaterial = this.emissiveMaterial(
      'Bipbeta2 curved lower service brace',
      0x8f43bf,
      0x43145e,
    );
    for (const [index, x] of [-84, 84].entries()) {
      const path = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 4.0, -29),
        new THREE.Vector3(x, 8.4, -24),
        new THREE.Vector3(x, 11.2, -12),
        new THREE.Vector3(x, 11.2, 12),
        new THREE.Vector3(x, 8.4, 24),
        new THREE.Vector3(x, 4.0, 29),
      ]);
      this.addMesh(
        new THREE.TubeGeometry(path, 18, 0.5, 6, false),
        serviceBraceMaterial,
        `Bipbeta2 lower curved service brace ${index + 1}`,
      );
    }
    this.addInstancedBox(
      'Bipbeta2 lower route service lights',
      [1.0, 0.16, 4.6],
      [-44, -22, 0, 22, 44].flatMap((z) => [
        new THREE.Vector3(-84, 12.0, z),
        new THREE.Vector3(84, 12.0, z),
      ]),
      light,
    );
  }

  private createPortal(
    side: 'north' | 'south',
    z: number,
    centerX: number,
    width: number,
    height: number,
    edge: THREE.Material,
    recess: THREE.Material,
    trim: THREE.Material,
    light: THREE.Material,
  ): void {
    const inward = side === 'north' ? 1 : -1;
    const panelZ = z + inward * 0.22;
    const trimZ = z + inward * 0.56;
    this.addBox(`Bipbeta2 ${side} portal recess`, [width + 5, height + 3, 0.2], new THREE.Vector3(centerX, 13.2, panelZ), recess, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal left concrete`, [1.6, height + 1, 1.1], new THREE.Vector3(centerX - width * 0.5, 13.2, trimZ), edge, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal right concrete`, [1.6, height + 1, 1.1], new THREE.Vector3(centerX + width * 0.5, 13.2, trimZ), edge, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal purple left`, [0.38, height + 2.2, 1.25], new THREE.Vector3(centerX - width * 0.5 + 1, 13.2, trimZ), trim, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal purple right`, [0.38, height + 2.2, 1.25], new THREE.Vector3(centerX + width * 0.5 - 1, 13.2, trimZ), trim, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal lintel`, [width + 2.2, 1.5, 1.25], new THREE.Vector3(centerX, 20.1, trimZ), trim, { collision: false });
    this.addBox(`Bipbeta2 ${side} portal fluorescent lintel`, [width * 0.64, 0.22, 1.35], new THREE.Vector3(centerX, 19.1, trimZ + inward * 0.06), light, { collision: false });
    const archZ = trimZ + inward * 0.22;
    const archPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(centerX - width * 0.5 + 1.2, 13.05, archZ),
      new THREE.Vector3(centerX - width * 0.5 + 1.2, 18.4, archZ),
      new THREE.Vector3(centerX, 21.0, archZ),
      new THREE.Vector3(centerX + width * 0.5 - 1.2, 18.4, archZ),
      new THREE.Vector3(centerX + width * 0.5 - 1.2, 13.05, archZ),
    ]);
    const arch = this.addMesh(
      new THREE.TubeGeometry(archPath, 28, 0.42, 7, false),
      trim,
      `Bipbeta2 ${side} portal rounded purple arch`,
    );
    arch.castShadow = true;
  }

  private createReferenceFacade(
    side: 'north' | 'south',
    wallZ: number,
    edge: THREE.Material,
    charcoal: THREE.Material,
    graphite: THREE.Material,
    trim: THREE.Material,
    route: THREE.MeshStandardMaterial,
    cyan: THREE.MeshStandardMaterial,
    red: THREE.MeshStandardMaterial,
    light: THREE.MeshStandardMaterial,
    recess: THREE.Material,
  ): void {
    const inward = side === 'north' ? 1 : -1;
    const facadeZ = wallZ + inward * 0.9;
    const frontZ = facadeZ + inward * 0.34;

    this.addBox(`Bipbeta2 ${side} reference facade backing`, [178, 18, 0.42], new THREE.Vector3(0, 13.7, facadeZ), edge, { collision: false });
    this.addBox(`Bipbeta2 ${side} reference facade upper purple band`, [178, 1.15, 0.9], new THREE.Vector3(0, 22.3, frontZ), trim, { collision: false });
    this.addBox(`Bipbeta2 ${side} reference facade lower purple band`, [178, 0.72, 0.9], new THREE.Vector3(0, 4.75, frontZ), trim, { collision: false });
    this.addInstancedBox(
      `Bipbeta2 ${side} reference facade end piers`,
      [1.25, 18, 0.95],
      [-88, 88].map((x) => new THREE.Vector3(x, 13.7, frontZ)),
      trim,
    );
    // Broad shoulder ribs are the large-scale silhouette cue in the source
    // room. They sit outside the energy/stack/lamp sequence and keep the end
    // wall reading as one continuous curved bay at jump distance.
    const shoulderXs = [-72, 72];
    this.addInstancedRoundedBox(
      `Bipbeta2 ${side} reference facade shoulder ribs`,
      [2.8, 20.0, 1.35],
      shoulderXs.map((x) => new THREE.Vector3(x, 13.7, frontZ + inward * 0.62)),
      trim,
      0.22,
    );
    const shoulderPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(72, 5.2, frontZ + inward * 0.68),
      new THREE.Vector3(72, 20.8, frontZ + inward * 0.68),
      new THREE.Vector3(62, 24.8, frontZ + inward * 0.68),
      new THREE.Vector3(45, 25.8, frontZ + inward * 0.68),
    ]);
    this.addMesh(
      new THREE.TubeGeometry(shoulderPath, 16, 0.72, 6, false),
      trim,
      `Bipbeta2 ${side} reference facade left shoulder curve`,
    );
    const mirroredShoulderPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-72, 5.2, frontZ + inward * 0.68),
      new THREE.Vector3(-72, 20.8, frontZ + inward * 0.68),
      new THREE.Vector3(-62, 24.8, frontZ + inward * 0.68),
      new THREE.Vector3(-45, 25.8, frontZ + inward * 0.68),
    ]);
    this.addMesh(
      new THREE.TubeGeometry(mirroredShoulderPath, 16, 0.72, 6, false),
      trim,
      `Bipbeta2 ${side} reference facade right shoulder curve`,
    );

    // The foreground balcony is the visual separator in the reference: the
    // upper facade is read above a broad charcoal parapet, with the lower
    // launch floor only visible beneath it.
    const balconyZ = frontZ + inward * 0.8;
    this.addBox(`Bipbeta2 ${side} reference charcoal balcony`, [178, 2.8, 4.8], new THREE.Vector3(0, 6.0, balconyZ), charcoal, { collision: false });
    this.addBox(`Bipbeta2 ${side} reference balcony purple lip`, [178, 0.22, 0.55], new THREE.Vector3(0, 7.48, frontZ), trim, { collision: false });

    this.createEnergyPortal(
      side,
      42,
      20,
      16,
      frontZ + inward * 0.1,
      trim,
      graphite,
      route,
      cyan,
      light,
    );
    this.createStackedOpening(side, 0, 15, 17, frontZ + inward * 0.08, trim, recess, light);

    // The reference's right wall reads as three evenly spaced tall bays before
    // the red-marked zero. Keep these on the same facade rail rather than
    // letting the general end-bay kit swallow them at hero distance.
    const facadeLightXs = [-12, -22, -32];
    const housingX = facadeLightXs.map((x) => new THREE.Vector3(x, 14.0, frontZ));
    const panelX = facadeLightXs.map((x) => new THREE.Vector3(x, 14.0, frontZ + inward * 0.13));
    this.addInstancedRoundedBox(`Bipbeta2 ${side} facade tall rounded light housings`, [2.9, 10.0, 0.7], housingX, recess, 0.18);
    this.addInstancedRoundedBox(`Bipbeta2 ${side} facade tall rounded light panels`, [1.52, 7.35, 0.34], panelX, light, 0.16);
    // Keep a slightly proud white face over the dark rounded housing so the
    // reference's tall luminaires remain readable at the wide hero FOV.
    this.addInstancedBox(
      `Bipbeta2 ${side} facade tall light faces`,
      [1.08, 6.5, 0.18],
      facadeLightXs.map((x) => new THREE.Vector3(x, 14.0, frontZ + inward * 0.42)),
      light,
    );
    const fixtureDetailZ = frontZ + inward * 0.56;
    const fixtureXs = facadeLightXs.flatMap((x) => [
      new THREE.Vector3(x, 16.65, fixtureDetailZ),
      new THREE.Vector3(x, 11.35, fixtureDetailZ),
    ]);
    this.addInstancedRoundedBox(
      `Bipbeta2 ${side} facade segmented luminaire white cells`,
      [1.28, 3.35, 0.2],
      fixtureXs,
      light,
      0.14,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} facade segmented luminaire black dividers`,
      [1.42, 0.72, 0.24],
      facadeLightXs.map((x) => new THREE.Vector3(x, 13.95, fixtureDetailZ)),
      recess,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} facade segmented luminaire lower switches`,
      [0.56, 0.34, 0.25],
      facadeLightXs.map((x) => new THREE.Vector3(x, 10.0, fixtureDetailZ + inward * 0.02)),
      graphite,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} facade light lower controls`,
      [0.72, 0.7, 0.22],
      facadeLightXs.map((x) => new THREE.Vector3(x, 9.9, frontZ + inward * 0.2)),
      charcoal,
    );

    // A low-poly torus gives the right-side "0" wall marking a readable
    // silhouette without text/font dependencies in the procedural map.
    // Keep the glyph beyond all three luminaires so the landmark sequence is
    // legible in the wide hero view: lights first, zero last.
    const glyphX = -46.0;
    this.addInstancedBox(
      `Bipbeta2 ${side} facade glyph red surrounds`,
      [1.05, 12.8, 0.5],
      [-51.0, -41.0].map((x) => new THREE.Vector3(x, 14.5, frontZ + inward * 0.14)),
      red,
    );
    const glyph = this.addMesh(
      new THREE.TorusGeometry(4.8, 0.72, 6, 18),
      light,
      `Bipbeta2 ${side} oversized zero wall glyph`,
      new THREE.Vector3(glyphX, 14.5, frontZ + inward * 0.24),
    );
    glyph.castShadow = false;
    glyph.receiveShadow = false;

    // One broad curved header makes the facade read as a room with rounded
    // structural ribs, not a row of detached boxes.
    const headerPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-86, 8.0, frontZ + inward * 0.3),
      new THREE.Vector3(-86, 19.8, frontZ + inward * 0.3),
      new THREE.Vector3(-64, 25.4, frontZ + inward * 0.3),
      new THREE.Vector3(0, 26.2, frontZ + inward * 0.3),
      new THREE.Vector3(64, 25.4, frontZ + inward * 0.3),
      new THREE.Vector3(86, 19.8, frontZ + inward * 0.3),
      new THREE.Vector3(86, 8.0, frontZ + inward * 0.3),
    ]);
    this.addMesh(
      new THREE.TubeGeometry(headerPath, 18, 0.48, 5, false),
      trim,
      `Bipbeta2 ${side} curved facade header rib`,
    );
  }

  private createEnergyPortal(
    side: 'north' | 'south',
    centerX: number,
    width: number,
    height: number,
    z: number,
    trim: THREE.Material,
    recess: THREE.Material,
    route: THREE.MeshStandardMaterial,
    cyan: THREE.MeshStandardMaterial,
    light: THREE.MeshStandardMaterial,
  ): void {
    const inward = side === 'north' ? 1 : -1;
    this.addBox(`Bipbeta2 ${side} energy gate black recess`, [width + 4, height + 2, 0.45], new THREE.Vector3(centerX, 13.7, z + inward * 0.13), recess, { collision: false });
    this.addInstancedBox(
      `Bipbeta2 ${side} energy gate purple jambs`,
      [1.25, height + 2.2, 0.9],
      [centerX - width * 0.5, centerX + width * 0.5].map((x) => new THREE.Vector3(x, 13.7, z)),
      trim,
    );
    this.addBox(`Bipbeta2 ${side} energy gate purple sill`, [width + 2.5, 0.65, 0.9], new THREE.Vector3(centerX, 6.1, z), trim, { collision: false });

    const energy = light.clone();
    energy.name = `Bipbeta2 ${side} energy waterfall material`;
    energy.map = this.createEnergyWaterfallTexture();
    energy.map.colorSpace = THREE.SRGBColorSpace;
    // Keep the core sheet opaque. The reference waterfall is a bright solid
    // white portal surface; transparency here made it disappear behind the
    // black recess on software/WebGL capture paths.
    energy.transparent = false;
    energy.opacity = 1;
    energy.depthWrite = true;
    energy.side = THREE.DoubleSide;
    this.materials.push(energy);
    this.pulseMaterials.push(energy);
    const sheet = this.addMesh(
      new RoundedBoxGeometry(width * 0.76, height * 0.82, 0.18, 1, 0.22),
      energy,
      `Bipbeta2 ${side} translucent vertical energy waterfall`,
      new THREE.Vector3(centerX, 13.7, z + inward * 0.58),
    );
    sheet.castShadow = false;
    sheet.receiveShadow = false;

    const streaks = [-0.30, -0.14, 0.02, 0.18, 0.34].map((offset, index) => (
      new THREE.Vector3(centerX + offset * width, 13.7 + (index % 2 === 0 ? 0.2 : -0.4), z + inward * 0.62)
    ));
    this.addInstancedBox(`Bipbeta2 ${side} energy waterfall cyan streaks`, [0.28, height * 0.7, 0.08], streaks, cyan);

    const archPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(centerX - width * 0.5 + 0.7, 6.2, z + inward * 0.62),
      new THREE.Vector3(centerX - width * 0.5 + 0.7, 19.0, z + inward * 0.62),
      new THREE.Vector3(centerX, 21.7, z + inward * 0.62),
      new THREE.Vector3(centerX + width * 0.5 - 0.7, 19.0, z + inward * 0.62),
      new THREE.Vector3(centerX + width * 0.5 - 0.7, 6.2, z + inward * 0.62),
    ]);
    this.addMesh(
      new THREE.TubeGeometry(archPath, 16, 0.52, 5, false),
      route,
      `Bipbeta2 ${side} rounded energy gate arch`,
    );
  }

  private createStackedOpening(
    side: 'north' | 'south',
    centerX: number,
    width: number,
    height: number,
    z: number,
    trim: THREE.Material,
    recess: THREE.Material,
    light: THREE.Material,
  ): void {
    const inward = side === 'north' ? 1 : -1;
    this.addBox(`Bipbeta2 ${side} stacked transfer black opening`, [width + 2.6, height + 2, 0.42], new THREE.Vector3(centerX, 13.7, z + inward * 0.1), recess, { collision: false });
    this.addInstancedRoundedBox(
      `Bipbeta2 ${side} stacked transfer rounded posts`,
      [1.0, height + 2.2, 0.8],
      [centerX - width * 0.5, centerX + width * 0.5].map((x) => new THREE.Vector3(x, 13.7, z)),
      trim,
      0.16,
    );
    this.addBox(`Bipbeta2 ${side} stacked transfer top lintel`, [width + 1.7, 0.7, 0.9], new THREE.Vector3(centerX, 22.0, z), trim, { collision: false });

    // The opening is a deep transfer gallery in the reference, not a decal
    // on the end wall. Give each visible level its own setback so the eye can
    // read the route continuing through the facade at speed.
    this.addBox(
      `Bipbeta2 ${side} stacked transfer deep back wall`,
      [width - 1.8, height - 1.0, 0.28],
      new THREE.Vector3(centerX, 14.0, z - inward * 3.25),
      recess,
      { collision: false },
    );
    const galleryDepths = [0.45, 1.1, 1.75, 2.4];
    const galleryYs = [8.8, 11.8, 14.8, 17.8];
    this.addInstancedBox(
      `Bipbeta2 ${side} stacked transfer receding gallery decks`,
      [width - 2.0, 0.26, 1.1],
      galleryDepths.map((depth, index) => new THREE.Vector3(centerX, galleryYs[index], z - inward * depth)),
      trim,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} stacked transfer gallery ceiling reveals`,
      [width - 2.8, 0.12, 0.68],
      galleryDepths.map((depth, index) => new THREE.Vector3(centerX, galleryYs[index] + 1.0, z - inward * (depth + 0.04))),
      light,
    );

    const shelfYs = [7.8, 10.8, 13.8, 16.8, 19.8];
    this.addInstancedBox(
      `Bipbeta2 ${side} stacked transfer purple shelf bands`,
      [width - 1.2, 0.34, 1.1],
      shelfYs.map((y) => new THREE.Vector3(centerX, y, z + inward * 0.25)),
      trim,
    );
    this.addInstancedBox(
      `Bipbeta2 ${side} stacked transfer white shelf lights`,
      [width * 0.66, 0.12, 0.72],
      [8.8, 11.8, 14.8, 17.8].map((y) => new THREE.Vector3(centerX, y, z + inward * 0.34)),
      light,
    );
    const windows: THREE.Vector3[] = [];
    for (const x of [-10, -5, 0, 5, 10]) windows.push(new THREE.Vector3(centerX + x, 13.15, z + inward * 0.38));
    this.addInstancedBox(`Bipbeta2 ${side} stacked transfer square service windows`, [1.8, 0.72, 0.12], windows, light);
  }

  private createCore(position: THREE.Vector3, cyan: THREE.Material, red: THREE.Material, amber: THREE.Material): void {
    const base = this.addMesh(new THREE.CylinderGeometry(5.2, 5.8, 1.4, 8), this.material('Bipbeta2 core base', 0x202e38, 0.78, 0.32), 'Bipbeta2 flux core base', new THREE.Vector3(position.x, position.y - 1.45, position.z));
    base.castShadow = true;
    const ring = this.addMesh(new THREE.TorusGeometry(4.25, 0.18, 8, 32), cyan, 'Bipbeta2 flux core cyan ring', new THREE.Vector3(position.x, position.y - 0.6, position.z));
    ring.rotation.x = Math.PI * 0.5;
    const redRing = this.addMesh(new THREE.TorusGeometry(3.2, 0.12, 8, 32), red, 'Bipbeta2 flux core red ring', new THREE.Vector3(position.x, position.y - 0.45, position.z));
    redRing.rotation.x = Math.PI * 0.5;
    const orb = this.addMesh(new THREE.IcosahedronGeometry(1.25, 1), amber, 'Bipbeta2 flux core', new THREE.Vector3(position.x, position.y, position.z));
    this.animatedFans.push({ object: ring, speed: 0.32 }, { object: redRing, speed: -0.44 }, { object: orb, speed: 0.18 });
  }

  private createJumpPad(position: THREE.Vector3, direction: THREE.Vector3, material: THREE.MeshStandardMaterial): void {
    const floor = this.floorHeightAt(position.x, position.z, Number.POSITIVE_INFINITY) ?? position.y;
    const base = this.addMesh(new THREE.CylinderGeometry(2.1, 2.35, 0.25, 10), this.material('Bipbeta2 jump pad housing', 0x1a252d, 0.72, 0.34), `Bipbeta2 jump pad housing ${this.jumpPads.length}`, new THREE.Vector3(position.x, floor + 0.12, position.z));
    base.receiveShadow = true;
    const ring = this.addMesh(new THREE.TorusGeometry(1.35, 0.1, 6, 24), material, `Bipbeta2 jump pad ring ${this.jumpPads.length}`, new THREE.Vector3(position.x, floor + 0.28, position.z));
    ring.rotation.x = Math.PI * 0.5;
    this.animatedFans.push({ object: ring, speed: direction.x >= 0 ? 1.1 : -1.1 });
    this.jumpPads.push({
      position: new THREE.Vector3(position.x, floor + 0.34, position.z),
      direction: direction.clone().normalize(),
      radius: 2.15,
      launchSpeed: 20,
    });
  }

  private pointOnFloor(x: number, z: number, lift = 0): THREE.Vector3 {
    const height = this.floorHeightAt(x, z, Number.POSITIVE_INFINITY) ?? 0;
    return new THREE.Vector3(x, height + lift, z);
  }

  private positionOnlyGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', source.getAttribute('position').clone());
    return geometry;
  }

  private positionOnlyBox(box: THREE.Box3): THREE.BufferGeometry {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const source = new THREE.BoxGeometry(size.x, size.y, size.z).toNonIndexed();
    source.translate(center.x, center.y, center.z);
    const geometry = this.positionOnlyGeometry(source);
    source.dispose();
    return geometry;
  }

  private buildCollisionGeometry(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.collisionParts, false);
    for (const part of this.collisionParts) part.dispose();
    this.collisionParts.length = 0;
    if (!merged) throw new Error('Failed to build Bipbeta2 procedural collision surface.');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }
}
