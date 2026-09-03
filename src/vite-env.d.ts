/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  opponentScore: number;
  targetScore: number;
  matchMode: 'arena' | 'tdm' | 'ctf' | 'raid';
  teams: {
    player: 'azure' | 'crimson' | null;
    azure: number;
    crimson: number;
  };
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
  worldHealthBars: {
    targetCount: number;
    visibleCount: number;
    drawCalls: number;
    categories: {
      person: number;
      drone: number;
      craft: number;
    };
    entries: ReadonlyArray<{
      id: string;
      kind: 'person' | 'drone' | 'craft';
      ratio: number;
      rendered: boolean;
    }>;
  };
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
    team: 'azure' | 'crimson' | null;
    weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc';
    targetOwner: 'player' | number | null;
    targetVisible: boolean;
    wantsToFire: boolean;
    facingDot: number;
    grounded: boolean;
    velocity: { x: number; y: number; z: number };
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
    characterSource: 'combat-trooper';
    runtimeBoneCount: number;
    runtimeAnimationCount: number;
    sourceTriangleCount: number;
    sourceTextureCount: number;
    animationName: string;
    roleHardwareProfile: 'HUNTER' | 'ANCHOR' | 'RUNNER';
    roleHardwareMeshCount: number;
    weaponModel: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc' | null;
    weaponSupportGripError: number;
    weaponSwitches: number;
    bunnyHops: number;
    jetpackActive: boolean;
    jetpackBursts: number;
    jetpackCharge: number;
    jetpackLocked: boolean;
    dashCooldown: number;
    dashesUsed: number;
    aimErrorDegrees: number;
    aimTracking: number;
    reactionRemaining: number;
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
  fighters: Array<{
    id: string;
    pad: string;
    pilot: 'player' | number | null;
    reservedBy: number | null;
    destroyed: boolean;
    explosions: number;
    hull: number;
    shield: number;
    respawnSeconds: number;
    speed: number;
    grounded: boolean;
    landingReady: boolean;
    afterburnerEnergy: number;
    heat: number;
    modelReady: boolean;
    visible: boolean;
    loadError: string | null;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    physics: {
      ceilingY: number;
      steps: number;
      collisionQueries: number;
      collisionHits: number;
      impacts: number;
      boundsContacts: number;
      invalidCollisionHits: number;
    };
    ai: {
      state: string;
      transitionReason: string;
      targetId: string | number | null;
    } | null;
  }>;
  drones: Array<{
    id: string;
    alive: boolean;
    health: number;
    maxHealth: number;
    state: 'patrol' | 'engage' | 'search' | 'evade' | 'destroyed' | 'spool' | 'takeoff' | 'survey' | 'attack-run' | 'breakaway' | 'jink' | 'landing-approach' | 'landed';
    targetOwner: 'player' | number | null;
    respawnSeconds: number;
    shotsFired: number;
    beamActive: boolean;
    beamVisible: boolean;
    beamUptimeSeconds: number;
    beamDamageTicks: number;
    beamMissTicks: number;
    beamOnTarget: boolean;
    aimErrorDegrees: number;
    beamLayers: number;
    beamHalos: number;
    beamParticles: number;
    explosions: number;
    respawns: number;
    collisionRadius: number;
    collisionHits: number;
    targetLostSeconds: number;
    avoidanceSeconds: number;
    avoidanceActivations: number;
    lastCollisionNormal: { x: number; y: number; z: number };
    modelReady: boolean;
    modelMeshCount: number;
    modelWidth: number;
    modelHeight: number;
    modelDepth: number;
    loadError: string | null;
    targetedByBots: number;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  }>;
  flamethrowerDrones: Array<{
    id: string;
    kind: 'grenadier';
    alive: boolean;
    health: number;
    maxHealth: number;
    state: 'patrol' | 'stalk' | 'attack-windup' | 'attack-recover' | 'jump-anticipation' | 'airborne' | 'landing' | 'destroyed';
    targetOwner: 'player' | number | null;
    fireCooldown: number;
    jumpCooldown: number;
    respawnSeconds: number;
    shotsFired: number;
    jumps: number;
    landings: number;
    distanceWalked: number;
    collisionRadius: number;
    collisionHits: number;
    targetLostSeconds: number;
    avoidanceSeconds: number;
    avoidanceActivations: number;
    lastCollisionNormal: { x: number; y: number; z: number };
    modelReady: boolean;
    partCount: number;
    rigNodeCount: number;
    sourceTriangles: number;
    sourceAnimationCount: number;
    sourceSkinCount: number;
    animationSource: 'runtime-rigid';
    loadError: string | null;
    targetedByBots: number;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  }>;
  flamethrowerGrenade: {
    launched: number;
    explosions: number;
    botHits: number;
    lastBotHit: number | null;
    sourceId: string;
    targetOwner: 'player' | number | null;
    origin: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    lastExplosionPosition: { x: number; y: number; z: number };
  };
  busterDrones: Array<{
    id: string;
    kind: 'sentinel' | 'buster';
    alive: boolean;
    health: number;
    maxHealth: number;
    healthMultiplier: number;
    state: 'patrol' | 'engage' | 'search' | 'evade' | 'spool' | 'takeoff' | 'survey' | 'attack-run' | 'breakaway' | 'jink' | 'landing-approach' | 'landed' | 'destroyed';
    flightPattern: 'figure-eight' | 'vertical-sweep' | 'pincer' | 'sentinel-orbit';
    targetOwner: 'player' | number | null;
    respawnSeconds: number;
    collisionRadius: number;
    collisionHits: number;
    targetLostSeconds: number;
    avoidanceSeconds: number;
    avoidanceActivations: number;
    lastCollisionNormal: { x: number; y: number; z: number };
    shotsFired: number;
    shardsFired: number;
    shardHits: number;
    shardWorldImpacts: number;
    activeShards: number;
    gazeDot: number;
    gazeThreshold: number;
    lookingAtTarget: boolean;
    aimErrorDegrees: number;
    takeoffElapsed: number;
    takeoffs: number;
    landings: number;
    grounded: boolean;
    explosions: number;
    respawns: number;
    modelReady: boolean;
    modelMeshCount: number;
    modelWidth: number;
    modelHeight: number;
    modelDepth: number;
    rigNodeCount: number;
    animationClipName: string;
    animationClipDuration: number;
    animationTime: number;
    animationPlaying: boolean;
    loadError: string | null;
    targetedByBots: number;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
  }>;
  busterShardPool: {
    active: number;
    capacity: number;
    speed: number;
    damage: number;
    lastSourceId: string;
    lastTargetOwner: 'player' | number | null;
    lastWorldImpact: boolean;
    lastOrigin: { x: number; y: number; z: number };
    lastImpact: { x: number; y: number; z: number };
  };
  projectiles: number;
  grenades: number;
  grenadeStates: Array<{
    owner: 'player' | 'drone' | number;
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    bounces: number;
    modelName: string;
  }>;
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
  flags: Array<{
    team: 'azure' | 'crimson';
    carrier: 'player' | number | null;
    atBase: boolean;
    droppedSeconds: number;
    position: { x: number; y: number; z: number };
    modelId: 'riftline-ctf-standard-v2';
    geometrySignature: 'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2';
    physics: {
      engine: 'custom-verlet-cloth';
      modelId: 'riftline-ctf-standard-v2';
      geometrySignature: 'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2';
      objectTimestep: number;
      clothTimestep: number;
      bodyCount: 1;
      colliderCount: 1;
      clothVertices: number;
      clothConstraints: number;
      mode: 'base' | 'carried' | 'dropped';
      grounded: boolean;
      bounces: number;
      maxClothDeflection: number;
      velocity: { x: number; y: number; z: number };
    };
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
  raid: {
    uplinksSecured: number;
    uplinkTarget: number;
    activeUplink: number;
    progress: number;
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
  lighting: {
    profile: string;
    key: {
      color: string;
      intensity: number;
      position: { x: number; y: number; z: number };
      target: { x: number; y: number; z: number };
    };
    fillIntensity: number;
    rimIntensity: number;
    environmentIntensity: number;
    exposure: number;
    shadow: {
      type: 'PCFShadowMap';
      mapSize: number;
      extent: number;
      bias: number;
      normalBias: number;
      casters: number;
      receivers: number;
    };
    contactShadows: {
      sources: number;
      visible: number;
      drawCalls: 1;
    };
  };
  fog: {
    type: 'linear';
    color: string;
    near: number;
    far: number;
  } | null;
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
    /** A fresh airborne Space press has armed thrust for as long as Space stays held. */
    jetpackArmed: boolean;
    dashCooldown: number;
    jumpPadCooldown: number;
    wallJumpCount: number;
    wallJumpCooldown: number;
    /** PMF_WALLJUMPING: air accel/control disabled until the post-wall-jump rise ends. */
    wallJumpAirLockout: boolean;
    /** Jumps that stacked on top of an existing ramp/stair rise. */
    doubleJumpCount: number;
    /** PM_STAT_KNOCKBACK seconds remaining (no friction, dash, strafe accel, or air control). */
    knockbackLockout: number;
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
    thirdPersonWeaponVisible: boolean;
    thirdPersonWeapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc' | null;
    thirdPersonWeaponMeshes: number;
    characterSource: 'combat-trooper';
    runtimeBoneCount: number;
    runtimeAnimationCount: number;
    sourceTriangleCount: number;
    sourceTextureCount: number;
    animationName: string;
    weaponSupportGripError: number;
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
    activeSoftSmoke: number;
    smokeTextureSource: string;
    tracerTextureSource: string;
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
    lastDamageDirection: string;
    lastDamageBearing: number;
    lastHitDamage: number;
    weaponCooldown: number;
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
    droneBeamVoices: number;
    droneBeamAssetReady: boolean;
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
  /** Board the nearest available Star Sparrow, optionally selecting its id. */
  boardFighter(id?: string): boolean;
  /** Fire the active fighter's plasma or missile channel. */
  fireActiveFighterWeapon(missile?: boolean): boolean;
  /** Apply deterministic hull/shield damage to a Star Sparrow. */
  damageFighter(id: string, amount: number): boolean;
  /** Apply deterministic combat damage to a hostile drone. */
  damageDrone(id: string, amount: number): boolean;
  /** Equip a weapon and rebuild its deterministic first-person view model. */
  setWeapon(weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc'): void;
  /** Set deterministic camera aim for muzzle/beam tests. */
  setAim(yaw: number, pitch: number): void;
  /** Freeze the severe Monsoon wall without advancing unrelated match simulation. */
  stageMonsoonWeather(): void;
  /** Place a frozen QA spectator camera without changing the selected default view. */
  setSpectatorCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
    fov?: number,
  ): void;
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
  /** Return live jump-pad world positions so QA can stand on the trigger, not a roof. */
  getJumpPads(): Array<{
    x: number;
    y: number;
    z: number;
    radius: number;
    launchSpeed: number;
    direction: { x: number; y: number; z: number };
  }>;
  /** Return the authored Bipbeta2 movement graph used by route QA. */
  getMovementFlow(): unknown;
  /** Test world-space static terrain visibility between two points. */
  sampleLineOfSight(start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }): boolean;
  /** Place player/bot zero for deterministic FOV and occlusion checks. */
  setCombatants(
    player: { x: number; y: number; z: number },
    bot: { x: number; y: number; z: number },
    botFacesPlayer?: boolean,
    lockBot?: boolean,
  ): void;
  getLongSightline(): {
    player: { x: number; y: number; z: number };
    bot: { x: number; y: number; z: number };
    distance: number;
  } | null;
  fireBotWeapon(
    botIndex: number,
    weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc',
  ): void;
  /** Fire one bot weapon through the live drone targeting/damage path. */
  fireBotAtDrone(
    botIndex: number,
    droneId: string,
    weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | 'disc',
  ): void;
  /** Stage one Buster on a real clear sightline for deterministic shard QA. */
  stageBusterAttack(id: string, targetOwner: 'player' | number): boolean;
  /** Stage one walking grenadier on a real clear sightline for lob QA. */
  stageFlamethrowerAttack(id: string, targetOwner: 'player' | number): boolean;
  /** Fire the equipped weapon once for deterministic combat/VFX captures. */
  fireWeapon(): void;
  /** Trigger deterministic hit/kill reticle feedback for HUD verification. */
  triggerHitMarker(kill?: boolean): void;
  /** Throw one three-second fuse grenade. */
  throwGrenade(): void;
  /** Anchor/release the grapple against the current view ray. */
  toggleGrapple(): void;
  /** Freeze the simulation while continuing to render the current frame. */
  setPausedForScreenshot(paused: boolean): void;
  /** Render the equipped procedural weapon as a centered side profile for visual QA. */
  setWeaponInspectionMode(enabled: boolean): void;
  setWeaponHandsVisible(visible: boolean): void;
  /** Hide the entire first-person rig for unobstructed environment/reward captures. */
  setFirstPersonWeaponVisible(visible: boolean): void;
  /** Hide local character presentation for unobstructed objective marker captures. */
  setLocalPlayerVisualsVisible(visible: boolean): void;
  parkBotsForScreenshot(): void;
  resetWeaponCaptureState(): void;
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Advance the fixed 120 Hz simulation without relying on browser wall time. */
  stepSimulation(seconds: number): void;
  /** Queue a fresh jump press without going through the keyboard (QA isolation). */
  queueJumpPress(): void;
  /** Queue a dash the same way stepSimulation consumes KeyE (QA isolation). */
  queueDash(): void;
  /** Advance only hostile drone flight/lifecycle state with combat targets disabled. */
  stepDrones(seconds: number): void;
  /** Advance short-lived weapon presentation independently for deterministic VFX review. */
  stepVisualEffects(seconds: number): void;
  /** Place the player with exact velocity for deterministic capsule/CCD QA. */
  setPlayerKinematics(
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
  ): void;
  /** Place an unpiloted fighter for deterministic terrain/pair collision QA. */
  setFighterKinematics(
    id: string,
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
    yaw?: number,
  ): boolean;
  /** Stage the three tactical bot silhouettes and their real equipped weapons for visual QA. */
  stageCharacterLineup(): {
    camera: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  };
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
  /** Return Monsoon's two procedural traversal towers and authored review cameras. */
  getMonsoonOutpostTowerAudit(): {
    towerCount: 2;
    expectedVisibleDrawCalls: number;
    expectedShadowDrawCalls: number;
    estimatedVisibleTriangles: number;
    colliderBoxCount: number;
    platformSurfaceCount: number;
    stairRampCount: number;
    towers: Array<{
      name: string;
      center: { x: number; y: number; z: number };
      footprint: { width: number; depth: number };
      architecturalHeight: number;
      roofHeight: number;
      entranceSide: 'north' | 'south';
      doorwayWidth: number;
      doorwayHeight: number;
      stairWidth: number;
      stairFlightCount: number;
      intermediateLandingCount: number;
    }>;
    reviewViews: Array<{
      name: string;
      camera: { x: number; y: number; z: number };
      target: { x: number; y: number; z: number };
    }>;
    stairRamps: Array<{
      name: string;
      spec: {
        origin: { x: number; y: number; z: number };
        heading: number;
        length: number;
        width: number;
        rise: number;
      };
    }>;
    integrationClearanceConflicts: Array<{ stair: string; collider: string }>;
  } | null;
  /** Return deterministic biome-family, density-zone, scale, and gameplay-clearance diagnostics. */
  getMonsoonBiomeVegetationAudit(): {
    deterministic: boolean;
    vegetationConstruction: string;
    familyCounts: { boulder: number; fern: number; shrub: number; tree: number };
    rockField: import('./game/maps/MonsoonRockField').MonsoonRockFieldBuild['diagnostics'];
    requestedCounts: { rock: number; grass: number; weed: number; fern: number; shrub: number; tree: number };
    visualPlantEstimate: { fern: number; shrub: number; tree: number };
    placedCounts: { grass: number; weed: number; fern: number[]; shrub: number[]; tree: number[] };
    fernLodCounts: { hero: number; mass: number; scanned: number };
    shrubLodCounts: { hero: number; thicket: number };
    treeLodCounts: { hero: number; massCanopy: number };
    treeConstruction: string;
    treeVariantNames: string[];
    treeRepresentativePositions: Array<Array<{ x: number; y: number; z: number }>>;
    routeLimits: { grass: number; weed: number; fern: number; shrub: number; tree: number };
    baseClearance: { grass: number; weed: number; fern: number; shrub: number; tree: number };
    densityZoneCounts: { grass: number; weed: number; fern: number; shrub: number; tree: number };
    scaleRanges: { fern: number[]; shrub: number[]; tree: number[]; boulder: number[] };
    scannedFernSource: string;
    scannedFernLicense: string;
    scannedShrubSource: string;
    scannedShrubLicense: string;
    scannedTreeSource: string;
    scannedTreeLicense: string;
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
  /** Aggregate visible QuickSense render submissions by material for profiling. */
  getArenaRenderAudit(): Array<{
    material: string;
    draws: number;
    shadowDraws: number;
    triangles: number;
    instances: number;
  }>;
  pickSceneAtNdc(x: number, y: number): Array<{
    name: string;
    parents: string[];
    material: string | null;
    distance: number;
  }>;
  /** Authored spawn-cubby bunker kit: hull/trim/signal instance counts and collider names. */
  getSpawnCubbyBunkerAudit(): {
    count: number;
    hullInstances: number;
    trimInstances: number;
    signalInstances: number;
    names: string[];
  } | null;
  /** Scene-wide cast/receive coverage grouped by gameplay role. */
  getSceneShadowAudit(): Record<'characters' | 'drones' | 'fighters' | 'objects' | 'environment', {
    meshes: number;
    casters: number;
    receivers: number;
    contactProjectors: number;
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
    renderedAtMs: number;
    frameIntervalMs: number;
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
