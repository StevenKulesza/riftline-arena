/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  state: string;
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
    alive: boolean;
    health: number;
    weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail';
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
    grenadesThrown: number;
    grapplesUsed: number;
    grenadesRemaining: number;
    grappleActive: boolean;
    collisionRecoveries: number;
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
    hasAuthoredWeapon: boolean;
  }>;
  coreProgress: number;
  player: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    speed: number;
    rocketJumpCount: number;
    grounded: boolean;
    skiing: boolean;
    dashCooldown: number;
    wallContact: boolean;
    yaw: number;
    pitch: number;
  };
  physics: {
    engine: string;
    timestep: number;
    bodies: number;
    colliders: number;
    ccdBodies: number;
    sensors: number;
    contacts: number;
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
  };
  combat: {
    continuousLaserActive: boolean;
    continuousLaserBend: number;
    lastPelletCount: number;
    lastPelletSpread: number;
    lastShotWeapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail' | null;
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
  setAmmo(weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail', amount: number): void;
  /** Equip a weapon and rebuild its deterministic first-person view model. */
  setWeapon(weapon: 'machine' | 'shotgun' | 'rocket' | 'plasma' | 'laser' | 'sniper' | 'rail'): void;
  /** Set deterministic camera aim for muzzle/beam tests. */
  setAim(yaw: number, pitch: number): void;
  /** Sample authored BSP/patch floor height for deterministic controller QA. */
  sampleFloorHeight(x: number, z: number, fromY?: number): number | null;
  /** Return the normalized authored arena spawn points. */
  getSpawnPoints(): Array<{ x: number; y: number; z: number }>;
  /** Test world-space BSP/patch visibility between two points. */
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
  /** Freeze ambient/idle animation time so screenshots are stable. */
  setReducedMotion(enabled: boolean): void;
  /** Advance the fixed 120 Hz simulation without relying on browser wall time. */
  stepSimulation(seconds: number): void;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
