/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  state: string;
  viewMode: 'first-person' | 'third-person';
  countdown: {
    remaining: number;
    cue: 'READY' | '3' | '2' | '1' | null;
    armed: boolean;
    weaponsLocked: boolean;
  };
  health: number;
  armor: number;
  weapon: string;
  botsAlive: number;
  bots: Array<{
    id: number;
    displayName: string;
    archetype: 'hunter' | 'anchor' | 'runner';
    alive: boolean;
    health: number;
    armor: number;
    score: number;
    weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc';
    targetOwner: 'player' | number | null;
    targetVisible: boolean;
    wantsToFire: boolean;
    facingDot: number;
    grounded: boolean;
    stepSuccesses: number;
    shotsFired: number;
    navigationTarget: { x: number; y: number; z: number };
    modelReady: boolean;
    modelHeight: number;
    modelCenterY: number;
    modelWidth: number;
    modelDepth: number;
    modelCenterX: number;
    modelCenterZ: number;
    modelMeshCount: number;
    renderedMeshCount: number;
    weaponSwitches: number;
    bunnyHops: number;
    jetpackActive: boolean;
    jetpackBursts: number;
    grenadesThrown: number;
    grapplesUsed: number;
    grenadesRemaining: number;
    grappleActive: boolean;
    collisionRecoveries: number;
    stalledFor: number;
    wallContacts: number;
    ceilingContacts: number;
    position: { x: number; y: number; z: number };
  }>;
  projectiles: number;
  grenades: number;
  grapple: {
    active: boolean;
    anchor: { x: number; y: number; z: number };
    length: number;
    distance: number;
    maxLength: number;
  };
  tracers: number;
  pickups: Array<{
    kind: string;
    active: boolean;
    modelName: string;
    groundOffset: number;
    position: { x: number; y: number; z: number };
    supportY: number;
    hasAuthoredWeapon: boolean;
  }>;
  coreProgress: number;
  core: {
    phase: 'telegraph' | 'active' | 'cooldown';
    active: boolean;
    contested: boolean;
    owner: 'player' | number | null;
    location: string;
    nextLocation: string | null;
    secondsRemaining: number;
    cycle: number;
    captures: number;
  };
  style: {
    meter: number;
    comboCount: number;
    comboMultiplier: number;
    lastMedal: string | null;
  };
  weather: {
    phase: string;
    label: string;
    secondsRemaining: number;
    severity: number;
    windDirection: { x: number; z: number };
    windStrength: number;
    multipliers: {
      airControlMultiplier: number;
      groundFrictionMultiplier: number;
      groundTractionMultiplier: number;
      projectileDriftMultiplier: number;
      visibilityMultiplier: number;
    };
    visuals: {
      source: 'autonomous' | 'gameplay';
      phase: string;
      label: string;
      severity: number;
      rainIntensity: number;
      visualWindStrength: number;
      windDirection: { x: number; z: number };
      visibilityMultiplier: number;
    };
  };
  map: {
    name: string;
    seed: number;
    generationVersion: number;
    ready: boolean;
    topologyHash: string;
    bounds: { width: number; depth: number };
    altitudeRange: { min: number; max: number };
    renderTriangles: number;
    collisionTriangles: number;
    spawnCount: number;
    pickupCount: number;
    jumpPadCount: number;
    skiRoutes: number;
  };
  player: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    speed: number;
    rocketJumpCount: number;
    grounded: boolean;
    skiing: boolean;
    jetpacking: boolean;
    jetpackCharge: number;
    jetpackLocked: boolean;
    jetpackPhase: 'ready' | 'burning' | 'available' | 'cooldown' | 'recharging' | 'depleted';
    jetpackRechargeDelay: number;
    jetpackRestartIn: number;
    dashCooldown: number;
    wallContact: boolean;
    ceilingContact: boolean;
    yaw: number;
    pitch: number;
    modelReady: boolean;
    modelMeshCount: number;
    modelHeight: number;
    modelWidth: number;
    modelDepth: number;
    avatarVisible: boolean;
    firstPersonWeaponVisible: boolean;
  };
  camera: {
    distance: number;
    position: { x: number; y: number; z: number };
    thirdPersonObstructed: boolean;
  };
  speedEffects: {
    thresholdKmh: number;
    fullIntensityKmh: number;
    playerSpeedKmh: number;
    blurIntensity: number;
    activeTrailSources: number;
  };
  skiMomentum: {
    speedKmh: number;
    resistance: number;
    gravityDriveScale: number;
    dragAcceleration: number;
  };
  physics: {
    engine: string;
    timestep: number;
    bodies: number;
    colliders: number;
    ccdBodies: number;
    sensors: number;
    contacts: number;
    ccd: {
      sweeps: number;
      wallHits: number;
      ceilingHits: number;
      boundaryHits: number;
    };
    groundNormal: { x: number; y: number; z: number };
    stairs: {
      attempts: number;
      successes: number;
      lastReason: string;
      lastRise: number;
      blockedDistance: number;
      travelDistance: number;
      inputDistance: number;
      raisedSpeed: number;
      startSpeed: number;
      finalSpeed: number;
    };
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    activeWeaponVfx: number;
    activeSurfaceMarks: number;
    activeTracers: number;
    weaponWearMaterials: number;
    weaponWearTextures: number;
    weaponAssetSource: 'procedural';
    weaponModelMeshes: number;
    weaponRenderMeshes: number;
    weaponModelTriangles: number;
    weaponTuck: number;
    weaponObstructionDistance: number;
    weaponViewPosition: { x: number; y: number; z: number };
    weaponViewRotation: { x: number; y: number; z: number };
    weaponMuzzleDistance: number;
    weaponMuzzleForwardDistance: number;
    weaponMuzzleOccluded: boolean;
    weaponPulseIntensity: number;
  };
  combat: {
    secondaryAbility: string;
    altFireHeld: boolean;
    continuousLaserActive: boolean;
    continuousLaserBend: number;
    lastPelletCount: number;
    lastPelletSpread: number;
    discBounceCount: number;
    lastDiscBouncePosition: { x: number; y: number; z: number };
    lastShotWeapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc' | null;
    lastShotOrigin: { x: number; y: number; z: number };
    lastMuzzlePosition: { x: number; y: number; z: number };
    lastProjectileOrigin: { x: number; y: number; z: number };
    muzzleOffset: number;
    projectileMuzzleOffset: number | null;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
  pointerLocked: boolean;
  scope: {
    active: boolean;
    blend: number;
    range: number;
    zoom: number;
  };
  audio: {
    supported: boolean;
    contextState: string;
    unlocked: boolean;
    muted: boolean;
    paused: boolean;
    visibilitySuspended: boolean;
    loading: boolean;
    expectedAssets: number;
    loadedAssets: number;
    missingAssets: number;
    fallbackMode: boolean;
    activeVoices: number;
    activeVoicesByPool: Record<string, number>;
    laserBeamActive: boolean;
    lastEvent: string;
    playCounts: Record<string, number>;
    resets: number;
  };
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void;
  /** Jump to a named state for baselines (scaffold: 'active-play' | 'complete'). */
  setState(name: string): void;
  /** Set deterministic ammo for audio and combat lifecycle tests. */
  setAmmo(weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc', amount: number): void;
  /** Trigger the equipped weapon's secondary ability without synthetic pointer input. */
  fireSecondary(): void;
  /** Equip a weapon and rebuild its deterministic first-person view model. */
  setWeapon(weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc'): void;
  /** Set deterministic camera aim for muzzle/beam tests. */
  setAim(yaw: number, pitch: number): void;
  /** Toggle between the default first-person and over-shoulder views. */
  toggleViewMode(): void;
  /** Sample procedural terrain floor height for deterministic controller QA. */
  sampleFloorHeight(x: number, z: number, fromY?: number): number | null;
  /** Resolve a stationary player capsule for deterministic clearance/support QA. */
  sampleCapsulePlacement(position: { x: number; y: number; z: number }): {
    position: { x: number; y: number; z: number };
    grounded: boolean;
    wallContact: boolean;
    contacts: number;
    correction: { x: number; y: number; z: number };
  };
  /** Return the first movement-only surface intersected by a segment. */
  sampleMovementHit(
    start: { x: number; y: number; z: number },
    end: { x: number; y: number; z: number },
  ): {
    point: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    distance: number;
  } | null;
  /** Return the grounded procedural arena spawn points. */
  getSpawnPoints(): Array<{ x: number; y: number; z: number }>;
  /** Test world-space static terrain visibility between two points. */
  sampleLineOfSight(start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }): boolean;
  /** Place player/bot zero for deterministic FOV and occlusion checks. */
  setCombatants(
    player: { x: number; y: number; z: number },
    bot: { x: number; y: number; z: number },
    botFacesPlayer?: boolean,
    lockBot?: boolean,
  ): void;
  /** Fire the equipped weapon once for deterministic combat/VFX captures. */
  fireWeapon(): void;
  /** Throw one three-second fuse grenade. */
  throwGrenade(): void;
  /** Anchor/release the grapple against the current view ray. */
  toggleGrapple(): void;
  /** Freeze the simulation while continuing to render the current frame. */
  setPausedForScreenshot(paused: boolean): void;
  /** Render the equipped procedural weapon as a centered side profile for visual QA. */
  setWeaponInspectionMode(enabled: boolean): void;
  setWeaponHandsVisible(visible: boolean): void;
  parkBotsForScreenshot(): void;
  resetWeaponCaptureState(): void;
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Advance the fixed 120 Hz simulation without relying on browser wall time. */
  stepSimulation(seconds: number): void;
  /** Place the player with exact velocity for deterministic capsule/CCD QA. */
  setPlayerKinematics(
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
  ): void;
  /** Stage a fast player and bot for deterministic blur/trail screenshots. */
  setSpeedCapture(speedKmh: number): void;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void;
  /** Return visible scene objects beneath an NDC point for deterministic visual QA. */
  pickSceneObjects(ndcX: number, ndcY: number): Array<{ name: string; distance: number }>;
  /** Enumerate every authored QuickSense structure and its deterministic review state. */
  getStructureAudit(): Array<{
    id: string;
    name: string;
    category: string;
    profile: string;
    accent: string;
    state: string;
    connection: 'terrain-foundation' | 'terrain-tethers';
    position: { x: number; y: number; z: number };
  }>;
  /** Return the imported center tower bounds and authored walkable stair route. */
  getOutpostTowerAudit(): {
    center: { x: number; y: number; z: number };
    entrance: { x: number; y: number; z: number };
    core: { x: number; y: number; z: number };
    flights: Array<{
      name: string;
      start: { x: number; y: number; z: number };
      end: { x: number; y: number; z: number };
    }>;
    bounds: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    };
    height: number;
    habitableHeight: number;
    collision: {
      engine: 'hybrid-authored-bvh';
      triangles: number;
      bodyTriangles: number;
      walkableTriangles: number;
    };
    grounding: {
      foundationTop: { x: number; y: number; z: number };
      accessStairs: Array<{
        start: { x: number; y: number; z: number };
        end: { x: number; y: number; z: number };
        width: number;
      }>;
    };
  } | null;
  /** Deterministic player-eye screenshots covering every major tower section. */
  getOutpostTowerReviewStates(): string[];
  /** Visibility diagnostics for the imported tower hierarchy and mesh materials. */
  getOutpostTowerVisibilityAudit(): {
    hierarchy: Array<{ name: string; visible: boolean }>;
    meshCount: number;
    visibleMeshCount: number;
    visibleMaterialCount: number;
  } | null;
  /** Mesh-by-mesh role, geometry, UV, and world-bounds evidence for the tower. */
  getOutpostTowerPieceAudit(): Array<{
    name: string;
    role: string;
    triangles: number;
    uvVertices: number;
    bounds: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    };
  }>;
}

interface Window {
  __WEAPON_PREVIEW_READY__?: boolean;
  __WEAPON_PREVIEW_DIAGNOSTICS__?: {
    weapon: string;
    pulseIntensity: number;
    pulseMetalness: number[];
    texturedPulseMaterials: number;
  };
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
  __THREE_FRAME_TIMING__?: {
    frame: number;
    refreshHz: number;
    workStride: number;
    updateMs: number;
    renderMs: number;
    totalMs: number;
    worstFrame: {
      frame: number;
      updateMs: number;
      renderMs: number;
      totalMs: number;
    } | null;
    slowFrames: Array<{
      frame: number;
      updateMs: number;
      renderMs: number;
      totalMs: number;
    }>;
  };
}
