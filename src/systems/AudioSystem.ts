import type { WeaponId } from '../game/config';
import {
  AMBIENCE_AUDIO_POOLS,
  AUDIO_ASSET_URLS,
  CONFIRM_AUDIO_POOLS,
  COUNTDOWN_AUDIO_POOLS,
  EMPTY_TRIGGER_POOL,
  EQUIP_AUDIO_POOLS,
  IMPACT_AUDIO_POOLS,
  JETPACK_READY_AUDIO_POOL,
  MOVEMENT_AUDIO_POOLS,
  PICKUP_AUDIO_POOLS,
  PLAYER_AUDIO_POOLS,
  SURFACE_IMPACT_AUDIO_POOLS,
  TRACER_AUDIO_POOLS,
  WEAPON_AUDIO_POOLS,
  WORLD_PICKUP_AUDIO_POOLS,
  type AudioGroup,
  type AudioPool,
} from './audioManifest';

export type AudioVector = { x: number; y: number; z: number };

export type AudioDiagnostics = {
  supported: boolean;
  contextState: AudioContextState | 'uninitialized' | 'unavailable';
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
  jetpackActive: boolean;
  laserBeamActive: boolean;
  lastEvent: string;
  playCounts: Record<string, number>;
  resets: number;
};

type SpatialOptions = { position: AudioVector };

type ActiveVoice = {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  poolId: string;
};

const GROUP_VOLUMES: Record<AudioGroup, number> = {
  weapons: 0.9,
  impacts: 0.86,
  ui: 0.62,
  pickups: 0.7,
  movement: 0.48,
  voice: 0.76,
  music: 0.22,
  ambience: 0.5,
};

// decodeAudioData completion can occupy Chromium's main/render threads even
// though it returns a Promise. Loading the whole combat bank in parallel made
// the first held trigger hitch for several seconds. Keep background decoding
// serial and yield between assets so gameplay always gets a frame opportunity.
const BACKGROUND_AUDIO_DECODE_CONCURRENCY = 12;
const LASER_BEAM_ATTACK_SECONDS = 0.14;
const LASER_BEAM_RELEASE_SECONDS = 0.2;
const LASER_BEAM_VOLUME = 0.24;

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly groups = new Map<AudioGroup, GainNode>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly missingUrls = new Set<string>();
  private readonly voices = new Set<ActiveVoice>();
  private readonly voicesByPool = new Map<string, Set<ActiveVoice>>();
  private readonly lastPlayedAt = new Map<string, number>();
  private readonly lastVariant = new Map<string, number>();
  private readonly playCounts = new Map<string, number>();
  private readonly assetPromises = new Map<string, Promise<void>>();
  private loadPromise: Promise<void> | null = null;
  private resumePromise: Promise<void> | null = null;
  private settleTimer = 0;
  private muted = false;
  private paused = false;
  private visibilitySuspended = document.hidden;
  private unlocked = false;
  private disposed = false;
  private lastEvent = '';
  private resetCount = 0;
  private listenerPosition: AudioVector = { x: 0, y: 0, z: 0 };
  private listenerForward: AudioVector = { x: 0, y: 0, z: -1 };
  private dirtCrunchBuffer: AudioBuffer | null = null;
  private jetpackLoopVoice: ActiveVoice | null = null;
  private jetpackActive = false;
  private laserBeamBuffer: AudioBuffer | null = null;
  private laserBeamVoice: ActiveVoice | null = null;
  private laserBeamGain: GainNode | null = null;
  private laserBeamRequested = false;
  private laserBeamStopTimer = 0;

  constructor() {
    window.addEventListener('pointerdown', this.onUserGesture);
    window.addEventListener('keydown', this.onUserGesture);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  async unlock(): Promise<void> {
    if (this.disposed || document.hidden) return;
    const context = this.ensureContext();
    if (!context) return;
    if (context.state !== 'running') {
      this.resumePromise ??= context.resume()
        .catch(() => undefined)
        .finally(() => {
          this.resumePromise = null;
        });
      await this.resumePromise;
    }
    this.unlocked = context.state === 'running';
    if (this.unlocked && this.buffers.size + this.missingUrls.size === AUDIO_ASSET_URLS.length) {
      this.startAmbience();
    }
  }

  async prepareCountdown(): Promise<void> {
    await this.unlock();
    const context = this.context;
    if (!context) return;
    await Promise.all(
      [
        ...Object.values(COUNTDOWN_AUDIO_POOLS).flatMap((pool) => pool.urls),
        ...AMBIENCE_AUDIO_POOLS.flatMap((pool) => pool.urls),
      ].map(
        (url) => this.loadAsset(context, url),
      ),
    );
    // The menu track hands off as soon as the countdown starts. Prioritize the
    // arena bed so the player never enters a silent match while the combat bank
    // is still decoding in the background.
    if (this.unlocked) this.startAmbience();
    // The match countdown is the safe loading window. Starting the full bank
    // directly from the first fire key made combat and decoding contend for
    // the same browser task queue in direct-entry/test states.
    this.loadPromise ??= this.loadAssets(context).then(() => this.startAmbience());
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.72, this.context.currentTime, 0.02);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    window.clearTimeout(this.settleTimer);
    if (paused) {
      this.stopLaserBeamImmediately();
      void this.context?.suspend().catch(() => undefined);
    }
    else if (!document.hidden) void this.unlock();
  }

  updateListener(position: AudioVector, forward: AudioVector): void {
    this.listenerPosition = { x: position.x, y: position.y, z: position.z };
    this.listenerForward = { x: forward.x, y: forward.y, z: forward.z };
    this.applyListenerTransform();
  }

  weaponPlayer(id: WeaponId, variance: number): void {
    const pool = WEAPON_AUDIO_POOLS[id];
    this.playPool(pool, 'player', variance);
  }

  weaponWorld(id: WeaponId, position: AudioVector, emitterId: string, variance: number): void {
    const pool = WEAPON_AUDIO_POOLS[id];
    const spatial = { position };
    this.playPool(pool, `world:${emitterId}`, variance, spatial);
  }

  /** Keeps the player's continuous laser on one voice for the whole trigger hold. */
  setLaserBeamActive(active: boolean): void {
    const wasRequested = this.laserBeamRequested;
    this.laserBeamRequested = active;

    if (!active) {
      // The game reports the released state every fixed tick. Start one release
      // envelope on the true→false edge instead of perpetually restarting it.
      if (!wasRequested) return;
      this.fadeLaserBeamOut();
      return;
    }
    window.clearTimeout(this.laserBeamStopTimer);
    this.laserBeamStopTimer = 0;
    if (!this.canPlay()) return;
    const context = this.context;
    if (!context) return;
    if (this.laserBeamVoice && this.laserBeamGain) {
      const gain = this.laserBeamGain.gain;
      const now = context.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(Math.max(0.0001, gain.value), now);
      gain.exponentialRampToValueAtTime(LASER_BEAM_VOLUME, now + LASER_BEAM_ATTACK_SECONDS * 0.72);
      return;
    }
    this.startLaserBeam();
  }

  dryFire(id: WeaponId): void {
    this.playPool(EMPTY_TRIGGER_POOL, `player:${id}`, 0);
  }

  weaponSwitch(id: WeaponId): void {
    const pool = id === 'rocket' || id === 'shotgun' || id === 'disc'
      ? EQUIP_AUDIO_POOLS.heavy
      : id === 'sniper' || id === 'rail'
        ? EQUIP_AUDIO_POOLS.precision
        : EQUIP_AUDIO_POOLS.light;
    this.playPool(pool, 'player', 0);
  }

  ammoPickup(id: WeaponId, variance = 0): void {
    const pool = id === 'rail'
      ? PICKUP_AUDIO_POOLS.rail
      : id === 'rocket' || id === 'disc'
        ? PICKUP_AUDIO_POOLS.rocket
        : id === 'plasma' || id === 'laser'
          ? PICKUP_AUDIO_POOLS.energy
          : PICKUP_AUDIO_POOLS.ballistic;
    this.playPool(pool, 'player', variance);
  }

  projectileImpact(id: 'rocket' | 'plasma' | 'disc', position: AudioVector, variance = 0): void {
    const pool = IMPACT_AUDIO_POOLS[id];
    const spatial = { position };
    const cell = `${Math.round(position.x / 3)}:${Math.round(position.y / 3)}:${Math.round(position.z / 3)}`;
    this.playPool(pool, `world:${cell}`, variance, spatial);
  }

  hit(intensity = 1): void {
    const pool = intensity > 1 ? CONFIRM_AUDIO_POOLS.elimination : CONFIRM_AUDIO_POOLS.hit;
    this.playPool(pool, 'player', intensity);
  }

  announceCountdown(cue: keyof typeof COUNTDOWN_AUDIO_POOLS): void {
    this.playPool(COUNTDOWN_AUDIO_POOLS[cue], 'announcer', 0);
  }

  pickup(kind: string): void {
    const pool = kind === 'core'
      ? WORLD_PICKUP_AUDIO_POOLS.core
      : kind === 'health'
        ? WORLD_PICKUP_AUDIO_POOLS.health
        : kind === 'armor'
          ? WORLD_PICKUP_AUDIO_POOLS.armor
          : WORLD_PICKUP_AUDIO_POOLS.boost;
    this.playPool(pool, `pickup:${kind}`, kind === 'core' ? 0.35 : 0);
  }

  jump(): void {
    this.playPool(MOVEMENT_AUDIO_POOLS.jump, 'movement:jump', -0.32);
  }

  dash(): void {
    this.playPool(MOVEMENT_AUDIO_POOLS.dash, 'movement:dash', -0.15);
  }

  wallJump(): void {
    this.playPool(MOVEMENT_AUDIO_POOLS.wallJump, 'movement:wall-jump', 0.08);
  }

  land(impact: number): void {
    this.playPool(
      impact > 10 ? MOVEMENT_AUDIO_POOLS.landHeavy : MOVEMENT_AUDIO_POOLS.landLight,
      'movement:land',
      Math.min(0.5, impact / 28),
    );
  }

  jetpackDepleted(): void {
    if (this.jetpackLoopVoice) this.stopVoice(this.jetpackLoopVoice);
    this.jetpackActive = false;
    this.playPool(MOVEMENT_AUDIO_POOLS.jetpackCut, 'movement:jetpack-depleted', -0.18);
  }

  jetpackReady(): void {
    this.playPool(JETPACK_READY_AUDIO_POOL, 'movement:jetpack-ready', 0.42);
  }

  setJetpackActive(active: boolean): void {
    if (this.jetpackActive === active) {
      if (active) this.startLoopIfReady(MOVEMENT_AUDIO_POOLS.jetpackLoop);
      return;
    }
    this.jetpackActive = active;
    if (!active) {
      if (this.jetpackLoopVoice) this.stopVoice(this.jetpackLoopVoice);
      this.playPool(MOVEMENT_AUDIO_POOLS.jetpackCut, 'movement:jetpack', -0.1);
      return;
    }
    this.playPool(MOVEMENT_AUDIO_POOLS.jetpackIgnite, 'movement:jetpack', 0.05);
    this.startLoopIfReady(MOVEMENT_AUDIO_POOLS.jetpackLoop);
  }

  footstep(
    variance: number,
    surface: 'grass' | 'soil' | 'rock' | 'metal' | 'concrete' | 'water' = 'grass',
  ): void {
    const surfacePool = surface === 'grass'
      ? MOVEMENT_AUDIO_POOLS.footstepGrass
      : surface === 'soil'
        ? MOVEMENT_AUDIO_POOLS.footstepMud
        : surface === 'rock'
          ? MOVEMENT_AUDIO_POOLS.footstepRock
          : surface === 'water'
            ? MOVEMENT_AUDIO_POOLS.footstepWater
            : MOVEMENT_AUDIO_POOLS.footstep;
    this.playPool(
      surfacePool,
      `movement:footstep:${surface}`,
      variance + (surface === 'concrete' ? 0.14 : surface === 'rock' ? -0.08 : 0),
    );
    if (surface === 'soil') this.playDirtCrunch(variance);
  }

  surfaceImpact(
    surface: 'grass' | 'soil' | 'rock' | 'metal' | 'concrete' | 'water',
    position: AudioVector,
    intensity = 1,
  ): void {
    const pool = surface === 'soil'
      ? SURFACE_IMPACT_AUDIO_POOLS.soil
      : surface === 'grass'
        ? SURFACE_IMPACT_AUDIO_POOLS.grass
        : surface === 'water'
          ? SURFACE_IMPACT_AUDIO_POOLS.water
          : null;
    if (!pool) return;
    const cell = `${Math.round(position.x / 3)}:${Math.round(position.y / 3)}:${Math.round(position.z / 3)}`;
    this.playPool(pool, `surface:${surface}:${cell}`, clampAudioVariance(intensity * 0.25), { position });
  }

  tracerPass(position: AudioVector, nearMiss: boolean, variance: number, emitterId: string): void {
    const pool = nearMiss ? TRACER_AUDIO_POOLS.nearMiss : TRACER_AUDIO_POOLS.pass;
    this.playPool(pool, `tracer:${emitterId}`, variance, { position });
  }

  grunt(position: AudioVector | undefined, intensity: number, emitterId: string): void {
    this.playPool(
      PLAYER_AUDIO_POOLS.grunt,
      `grunt:${emitterId}`,
      clampAudioVariance(intensity - 0.5),
      position ? { position } : undefined,
    );
  }

  damage(armored: boolean): void {
    const pool = armored ? IMPACT_AUDIO_POOLS.armor : PLAYER_AUDIO_POOLS.damage;
    this.playPool(pool, 'player:damage', armored ? 0 : -0.3);
  }

  death(): void {
    this.playPool(PLAYER_AUDIO_POOLS.death, 'player:death', -0.45);
  }

  reset(): void {
    this.stopLaserBeamImmediately();
    this.stopAllVoices();
    this.jetpackActive = false;
    this.jetpackLoopVoice = null;
    this.lastPlayedAt.clear();
    this.lastVariant.clear();
    this.resetCount += 1;
  }

  diagnostics(): AudioDiagnostics {
    const contextState = this.context
      ? this.context.state
      : this.hasAudioContext()
        ? 'uninitialized'
        : 'unavailable';
    return {
      supported: contextState !== 'unavailable',
      contextState,
      unlocked: this.unlocked,
      muted: this.muted,
      paused: this.paused,
      visibilitySuspended: this.visibilitySuspended,
      loading: Boolean(this.loadPromise) && this.buffers.size + this.missingUrls.size < AUDIO_ASSET_URLS.length,
      expectedAssets: AUDIO_ASSET_URLS.length,
      loadedAssets: this.buffers.size,
      missingAssets: this.missingUrls.size,
      fallbackMode: false,
      activeVoices: this.voices.size,
      activeVoicesByPool: Object.fromEntries(
        [...this.voicesByPool].map(([id, voices]) => [id, voices.size]),
      ),
      jetpackActive: this.jetpackActive,
      laserBeamActive: Boolean(this.laserBeamVoice && this.laserBeamRequested),
      lastEvent: this.lastEvent,
      playCounts: Object.fromEntries(this.playCounts),
      resets: this.resetCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.settleTimer);
    window.clearTimeout(this.laserBeamStopTimer);
    window.removeEventListener('pointerdown', this.onUserGesture);
    window.removeEventListener('keydown', this.onUserGesture);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopAllVoices();
    this.groups.clear();
    this.buffers.clear();
    this.missingUrls.clear();
    this.assetPromises.clear();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.dirtCrunchBuffer = null;
    this.jetpackLoopVoice = null;
    this.jetpackActive = false;
    this.laserBeamBuffer = null;
    this.laserBeamVoice = null;
    this.laserBeamGain = null;
    this.laserBeamRequested = false;
  }

  private readonly onUserGesture = (): void => {
    void this.unlock().then(() => {
      if (!this.paused) return;
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        if (this.paused) void this.context?.suspend().catch(() => undefined);
      }, 80);
    });
  };

  private readonly onVisibilityChange = (): void => {
    this.visibilitySuspended = document.hidden;
    window.clearTimeout(this.settleTimer);
    if (document.hidden) {
      this.stopLaserBeamImmediately();
      void this.context?.suspend().catch(() => undefined);
    }
    else if (!this.paused) void this.unlock();
  };

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const AudioContextClass = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -11;
    compressor.knee.value = 8;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.14;
    const master = context.createGain();
    master.gain.value = this.muted ? 0 : 0.72;
    master.connect(compressor).connect(context.destination);
    for (const name of Object.keys(GROUP_VOLUMES) as AudioGroup[]) {
      const gain = context.createGain();
      gain.gain.value = GROUP_VOLUMES[name];
      gain.connect(master);
      this.groups.set(name, gain);
    }
    this.context = context;
    this.master = master;
    this.applyListenerTransform();
    return context;
  }

  private hasAudioContext(): boolean {
    return Boolean(
      window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext,
    );
  }

  private async loadAssets(context: AudioContext): Promise<void> {
    let nextAsset = 0;
    const loadNext = async (): Promise<void> => {
      while (nextAsset < AUDIO_ASSET_URLS.length && !this.disposed) {
        const url = AUDIO_ASSET_URLS[nextAsset++];
        await this.loadAsset(context, url);
        await this.yieldToGameplay();
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(BACKGROUND_AUDIO_DECODE_CONCURRENCY, AUDIO_ASSET_URLS.length) },
      () => loadNext(),
    ));
  }

  private async yieldToGameplay(): Promise<void> {
    await new Promise<void>((resolve) => {
      const requestIdle = (window as unknown as {
        requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
      }).requestIdleCallback;
      if (requestIdle) {
        requestIdle.call(window, () => resolve(), { timeout: 250 });
      } else {
        setTimeout(resolve, 50);
      }
    });
  }

  private loadAsset(context: AudioContext, url: string): Promise<void> {
    if (this.buffers.has(url) || this.missingUrls.has(url)) return Promise.resolve();
    const existing = this.assetPromises.get(url);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await context.decodeAudioData((await response.arrayBuffer()).slice(0));
        if (!this.disposed) this.buffers.set(url, buffer);
      } catch {
        if (!this.disposed) this.missingUrls.add(url);
      }
    })();
    this.assetPromises.set(url, promise);
    return promise;
  }

  private playPool(
    pool: AudioPool,
    emitter: string,
    variance: number,
    spatial?: SpatialOptions,
  ): void {
    if (!this.canPlay()) return;
    const context = this.context;
    if (!context) return;
    const cooldownKey = `${pool.id}:${emitter}`;
    const lastPlayed = this.lastPlayedAt.get(cooldownKey) ?? Number.NEGATIVE_INFINITY;
    if (context.currentTime - lastPlayed < pool.cooldown) return;
    this.lastPlayedAt.set(cooldownKey, context.currentTime);
    this.recordEvent(pool.id);
    const urls = pool.urls.filter((url) => this.buffers.has(url));
    if (urls.length === 0) return;
    const url = this.selectVariant(pool.id, urls, variance);
    const buffer = this.buffers.get(url);
    if (buffer) this.playBuffer(pool, buffer, variance, spatial);
  }

  private startLoopIfReady(pool: AudioPool): void {
    if (this.jetpackLoopVoice || !this.canPlay()) return;
    const context = this.context;
    if (!context) return;
    const url = pool.urls.find((candidate) => this.buffers.has(candidate));
    if (!url) return;
    const buffer = this.buffers.get(url);
    const group = this.groups.get(pool.group);
    if (!buffer || !group) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = pool.volume;
    const nodes = this.connectVoice(source, gain, group);
    this.recordEvent(pool.id);
    this.jetpackLoopVoice = this.trackVoice(source, nodes, pool.id, pool.maxVoices);
    source.start();
  }

  private startLaserBeam(): void {
    if (this.laserBeamVoice || !this.canPlay()) return;
    const context = this.context;
    const group = this.groups.get('weapons');
    if (!context || !group) return;
    this.laserBeamBuffer ??= this.createLaserBeamBuffer(context);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = this.laserBeamBuffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = this.laserBeamBuffer.duration;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      LASER_BEAM_VOLUME,
      context.currentTime + LASER_BEAM_ATTACK_SECONDS,
    );
    const nodes = this.connectVoice(source, gain, group, undefined, {
      lowShelfFrequencyHz: 180,
      lowShelfGainDb: -2.5,
      presenceFrequencyHz: 1_650,
      presenceGainDb: 2.2,
      lowpassHz: 5_200,
    });
    this.recordEvent('weapon.laser');
    this.laserBeamGain = gain;
    this.laserBeamVoice = this.trackVoice(source, nodes, 'weapon.laser', 1);
    source.start();
  }

  private fadeLaserBeamOut(): void {
    const context = this.context;
    const voice = this.laserBeamVoice;
    const beamGain = this.laserBeamGain;
    if (!context || !voice || !beamGain) return;
    const now = context.currentTime;
    beamGain.gain.cancelScheduledValues(now);
    beamGain.gain.setValueAtTime(Math.max(0.0001, beamGain.gain.value), now);
    beamGain.gain.exponentialRampToValueAtTime(0.0001, now + LASER_BEAM_RELEASE_SECONDS);
    this.laserBeamStopTimer = window.setTimeout(() => {
      this.laserBeamStopTimer = 0;
      if (this.laserBeamRequested || this.laserBeamVoice !== voice) return;
      this.stopVoice(voice);
    }, (LASER_BEAM_RELEASE_SECONDS + 0.04) * 1_000);
  }

  private stopLaserBeamImmediately(): void {
    this.laserBeamRequested = false;
    window.clearTimeout(this.laserBeamStopTimer);
    this.laserBeamStopTimer = 0;
    if (this.laserBeamVoice) this.stopVoice(this.laserBeamVoice);
  }

  private createLaserBeamBuffer(context: AudioContext): AudioBuffer {
    // Every component completes an integer number of cycles in this half-second
    // buffer, so the held beam loops without a seam or a repeated attack click.
    const duration = 0.5;
    const sampleCount = Math.round(context.sampleRate * duration);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      const time = index / context.sampleRate;
      const phaseMotion = Math.sin(Math.PI * 2 * 8 * time) * 0.12;
      const carrier = Math.sin(Math.PI * 2 * 146 * time + phaseMotion) * 0.48;
      const harmonic = Math.sin(Math.PI * 2 * 292 * time - phaseMotion * 0.7) * 0.22;
      const edge = Math.sin(Math.PI * 2 * 584 * time + phaseMotion * 1.4) * 0.1;
      const electricalTexture = (
        Math.sin(Math.PI * 2 * 1_872 * time + phaseMotion * 2.1)
        + Math.sin(Math.PI * 2 * 2_310 * time - phaseMotion * 1.8)
      ) * 0.035;
      channel[index] = (carrier + harmonic + edge + electricalTexture) * 0.34;
    }
    return buffer;
  }

  private playDirtCrunch(variance: number): void {
    if (!this.canPlay()) return;
    const context = this.context;
    const movementGroup = this.groups.get('movement');
    if (!context || !movementGroup) return;
    const cooldownKey = 'movement:dirt-crunch';
    const lastPlayed = this.lastPlayedAt.get(cooldownKey) ?? Number.NEGATIVE_INFINITY;
    if (context.currentTime - lastPlayed < 0.085) return;
    this.lastPlayedAt.set(cooldownKey, context.currentTime);
    this.recordEvent('movement:dirt-crunch');

    if (!this.dirtCrunchBuffer) {
      const sampleCount = Math.ceil(context.sampleRate * 0.115);
      const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
      const channel = buffer.getChannelData(0);
      let held = 0;
      for (let index = 0; index < sampleCount; index += 1) {
        const progress = index / sampleCount;
        if (index % 9 === 0) held = Math.random() * 2 - 1;
        const grit = (Math.random() * 2 - 1) * 0.58 + held * 0.42;
        const pebble = index % 137 < 4 ? (Math.random() * 2 - 1) * 0.72 : 0;
        channel[index] = (grit + pebble) * Math.pow(1 - progress, 2.25);
      }
      this.dirtCrunchBuffer = buffer;
    }

    const source = context.createBufferSource();
    source.buffer = this.dirtCrunchBuffer;
    source.playbackRate.value = 0.88 + Math.max(-0.5, Math.min(0.5, variance)) * 0.18;
    const bandpass = context.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1180 + (variance + 0.5) * 420;
    bandpass.Q.value = 0.68;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3900;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.19, context.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.105);
    source.connect(bandpass).connect(lowpass).connect(gain).connect(movementGroup);
    this.trackVoice(source, [bandpass, lowpass, gain], 'movement:dirt-crunch', 5);
    source.start();
  }

  private canPlay(): boolean {
    return Boolean(
      !this.disposed
      && !this.muted
      && !this.paused
      && !document.hidden
      && this.context?.state === 'running',
    );
  }

  private selectVariant(poolId: string, urls: readonly string[], variance: number): string {
    if (urls.length === 1) return urls[0];
    let index = Math.abs(Math.floor((variance + 1.37) * 100_003)) % urls.length;
    if (this.lastVariant.get(poolId) === index) index = (index + 1) % urls.length;
    this.lastVariant.set(poolId, index);
    return urls[index];
  }

  private playBuffer(pool: AudioPool, buffer: AudioBuffer, variance: number, spatial?: SpatialOptions): void {
    const context = this.context;
    const group = this.groups.get(pool.group);
    if (!context || !group) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = Boolean(pool.loop);
    source.playbackRate.value = 1 + Math.max(-0.5, Math.min(0.5, variance)) * (pool.pitchVariance ?? 0);
    gain.gain.value = pool.volume;
    const nodes = this.connectVoice(source, gain, group, spatial, pool.tone);
    this.trackVoice(source, nodes, pool.id, pool.maxVoices);
    source.start();
  }

  private startAmbience(): void {
    for (const pool of AMBIENCE_AUDIO_POOLS) {
      if (this.voicesByPool.get(pool.id)?.size) continue;
      this.playPool(pool, 'global', 0);
    }
  }

  private connectVoice(
    source: AudioNode,
    gain: GainNode,
    destination: AudioNode,
    spatial?: SpatialOptions,
    tone?: AudioPool['tone'],
  ): AudioNode[] {
    const toneNodes: BiquadFilterNode[] = [];
    let output = source;
    const addFilter = (type: BiquadFilterType, frequency: number, gainDb = 0, q = 0.707): void => {
      if (!this.context) return;
      const filter = this.context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.gain.value = gainDb;
      filter.Q.value = q;
      output.connect(filter);
      output = filter;
      toneNodes.push(filter);
    };
    if (tone?.lowShelfFrequencyHz && tone.lowShelfGainDb) {
      addFilter('lowshelf', tone.lowShelfFrequencyHz, tone.lowShelfGainDb);
    }
    if (tone?.presenceFrequencyHz && tone.presenceGainDb) {
      addFilter('peaking', tone.presenceFrequencyHz, tone.presenceGainDb, 0.85);
    }
    if (tone?.lowpassHz) addFilter('lowpass', tone.lowpassHz);
    output.connect(gain);
    if (!spatial || !this.context) {
      gain.connect(destination);
      return [...toneNodes, gain];
    }
    const panner = this.context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 3.5;
    panner.maxDistance = 110;
    panner.rolloffFactor = 1.15;
    panner.positionX.value = spatial.position.x;
    panner.positionY.value = spatial.position.y;
    panner.positionZ.value = spatial.position.z;
    gain.connect(panner).connect(destination);
    return [...toneNodes, gain, panner];
  }

  private trackVoice(source: AudioScheduledSourceNode, nodes: AudioNode[], poolId: string, maxVoices: number): ActiveVoice {
    const poolVoices = this.voicesByPool.get(poolId) ?? new Set<ActiveVoice>();
    this.voicesByPool.set(poolId, poolVoices);
    while (poolVoices.size >= maxVoices) {
      const oldest = poolVoices.values().next().value as ActiveVoice | undefined;
      if (!oldest) break;
      this.stopVoice(oldest);
    }
    const voice: ActiveVoice = { source, nodes, poolId };
    this.voices.add(voice);
    poolVoices.add(voice);
    source.onended = () => this.cleanupVoice(voice);
    return voice;
  }

  private stopVoice(voice: ActiveVoice): void {
    try {
      voice.source.stop();
    } catch {
      // It may already have ended.
    }
    this.cleanupVoice(voice);
  }

  private cleanupVoice(voice: ActiveVoice): void {
    if (!this.voices.delete(voice)) return;
    this.voicesByPool.get(voice.poolId)?.delete(voice);
    if (this.jetpackLoopVoice === voice) this.jetpackLoopVoice = null;
    if (this.laserBeamVoice === voice) {
      window.clearTimeout(this.laserBeamStopTimer);
      this.laserBeamStopTimer = 0;
      this.laserBeamVoice = null;
      this.laserBeamGain = null;
    }
    voice.source.disconnect();
    for (const node of voice.nodes) node.disconnect();
  }

  private stopAllVoices(): void {
    for (const voice of [...this.voices]) this.stopVoice(voice);
    this.voicesByPool.clear();
  }

  private recordEvent(id: string): void {
    this.lastEvent = id;
    this.playCounts.set(id, (this.playCounts.get(id) ?? 0) + 1);
  }

  private applyListenerTransform(): void {
    if (!this.context) return;
    const listener = this.context.listener;
    const now = this.context.currentTime;
    listener.positionX.setValueAtTime(this.listenerPosition.x, now);
    listener.positionY.setValueAtTime(this.listenerPosition.y, now);
    listener.positionZ.setValueAtTime(this.listenerPosition.z, now);
    listener.forwardX.setValueAtTime(this.listenerForward.x, now);
    listener.forwardY.setValueAtTime(this.listenerForward.y, now);
    listener.forwardZ.setValueAtTime(this.listenerForward.z, now);
    listener.upX.setValueAtTime(0, now);
    listener.upY.setValueAtTime(1, now);
    listener.upZ.setValueAtTime(0, now);
  }
}

function clampAudioVariance(value: number, min = -0.5, max = 0.5): number {
  return Math.max(min, Math.min(max, value));
}
