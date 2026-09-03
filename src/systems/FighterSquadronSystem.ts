import * as THREE from 'three';
import { FighterVisual } from '../entities/FighterVisual';
import {
  createFighterFlightState,
  resetFighterFlightState,
  type FighterControlIntent,
  type FighterFlightState,
} from '../game/FighterFlightPhysics';

export const FIGHTER_HULL_MAX = 900;
export const FIGHTER_SHIELD_MAX = 400;
export const FIGHTER_RESPAWN_SECONDS = 12;
export const FIGHTER_BOARD_RANGE = 22;
export const FIGHTER_PRIMARY_COOLDOWN = 0.13;
export const FIGHTER_MISSILE_COOLDOWN = 1.35;

export type FighterPilot = 'player' | number | null;

export type FighterPadDefinition = Readonly<{
  id: string;
  label: string;
  position: THREE.Vector3;
  yaw: number;
  accent: THREE.ColorRepresentation;
}>;

export type FighterRuntime = {
  readonly id: string;
  readonly pad: FighterPadDefinition;
  readonly visual: FighterVisual;
  readonly flight: FighterFlightState;
  readonly intent: {
    throttle: number;
    strafe: number;
    lift: number;
    pitch: number;
    yaw: number;
    roll: number;
    afterburner: boolean;
    boost: boolean;
  };
  pilot: FighterPilot;
  reservedBy: number | null;
  reservationSeconds: number;
  hull: number;
  shield: number;
  shieldDelay: number;
  hullHit: number;
  shieldHit: number;
  destroyed: boolean;
  explosions: number;
  respawnSeconds: number;
  primaryCooldown: number;
  missileCooldown: number;
  weaponAlternator: number;
  flightAccumulator: number;
};

const pad = (
  id: string,
  label: string,
  x: number,
  y: number,
  z: number,
  yaw: number,
  accent: THREE.ColorRepresentation,
): FighterPadDefinition => ({ id, label, position: new THREE.Vector3(x, y, z), yaw, accent });

/**
 * Ventral housing sits this far below the flight-state root. Matching
 * FIGHTER_FLIGHT_TUNING.supportOffsetY + probe + contact gap keeps the hull
 * flush on the live deck instead of clipping through it.
 */
export const FIGHTER_PAD_HOUSING_OFFSET = 3.05245;

/**
 * Sample well above the bay so floorHeightAt returns the open deck, not the
 * basin or an interior ceiling the root used to sit under.
 */
const FIGHTER_PAD_DECK_SAMPLE_Y = 80;

/**
 * Four authored aircraft pads on QuickSense's central Outpost Tower. XZ are
 * the measured centroids of the four chamfered upper-deck vehicle bays. Y is
 * a fallback that `seatQuickSenseFighterPads` replaces with live deck height
 * plus FIGHTER_PAD_HOUSING_OFFSET after the tower is seated, so vertical
 * arena scale cannot bury the hull under a raised slab.
 */
export const QUICKSENSE_FIGHTER_PADS: readonly FighterPadDefinition[] = Object.freeze([
  pad('sparrow-north-west', 'NEXUS PAD N-W', -27.3785, 43.6478, 20.5484, 0.8051, 0x38e5ff),
  pad('sparrow-north-east', 'NEXUS PAD N-E', 27.3794, 43.6478, 20.5484, -0.8005, 0xff3db5),
  pad('sparrow-south-west', 'NEXUS PAD S-W', -27.4356, 43.6478, -32.176, -0.8099, 0xffb33d),
  pad('sparrow-south-east', 'NEXUS PAD S-E', 27.3218, 43.6478, -32.1761, 0.8052, 0x8dffdc),
]);

export function seatQuickSenseFighterPads(
  floorHeightAt: (x: number, z: number, fromY: number) => number | null,
): void {
  for (const definition of QUICKSENSE_FIGHTER_PADS) {
    const deckY = floorHeightAt(
      definition.position.x,
      definition.position.z,
      FIGHTER_PAD_DECK_SAMPLE_Y,
    );
    if (deckY === null) continue;
    definition.position.y = deckY + FIGHTER_PAD_HOUSING_OFFSET;
  }
}

const orientationForPad = (definition: FighterPadDefinition): THREE.Quaternion => (
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0, definition.yaw, 0))
);

export function createQuickSenseFighters(scene: THREE.Scene): FighterRuntime[] {
  return QUICKSENSE_FIGHTER_PADS.map((definition) => {
    const orientation = orientationForPad(definition);
    const visual = new FighterVisual({ targetLength: 28.5, engineColor: definition.accent });
    const flight = createFighterFlightState(definition.position, orientation);
    visual.root.position.copy(flight.position);
    visual.root.quaternion.copy(flight.orientation);
    visual.root.userData.fighterId = definition.id;
    visual.root.userData.pad = definition.label;
    scene.add(visual.root);
    return {
      id: definition.id,
      pad: definition,
      visual,
      flight,
      intent: {
        throttle: 0,
        strafe: 0,
        lift: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
        afterburner: false,
        boost: false,
      } satisfies FighterControlIntent,
      pilot: null,
      reservedBy: null,
      reservationSeconds: 0,
      hull: FIGHTER_HULL_MAX,
      shield: FIGHTER_SHIELD_MAX,
      shieldDelay: 0,
      hullHit: 0,
      shieldHit: 0,
      destroyed: false,
      explosions: 0,
      respawnSeconds: 0,
      primaryCooldown: 0,
      missileCooldown: 0,
      weaponAlternator: 0,
      flightAccumulator: 0,
    };
  });
}

export function resetFighterAtPad(fighter: FighterRuntime): void {
  resetFighterFlightState(fighter.flight, fighter.pad.position, orientationForPad(fighter.pad));
  fighter.pilot = null;
  fighter.reservedBy = null;
  fighter.reservationSeconds = 0;
  fighter.hull = FIGHTER_HULL_MAX;
  fighter.shield = FIGHTER_SHIELD_MAX;
  fighter.shieldDelay = 0;
  fighter.hullHit = 0;
  fighter.shieldHit = 0;
  fighter.destroyed = false;
  fighter.respawnSeconds = 0;
  fighter.primaryCooldown = 0;
  fighter.missileCooldown = 0;
  fighter.weaponAlternator = 0;
  fighter.flightAccumulator = 0;
  fighter.visual.root.position.copy(fighter.flight.position);
  fighter.visual.root.quaternion.copy(fighter.flight.orientation);
  fighter.visual.root.visible = true;
}

export function nearestBoardableFighter(
  fighters: readonly FighterRuntime[],
  position: THREE.Vector3,
  maxRange = FIGHTER_BOARD_RANGE,
): FighterRuntime | null {
  let best: FighterRuntime | null = null;
  let bestDistanceSq = maxRange * maxRange;
  for (const fighter of fighters) {
    if (fighter.destroyed || fighter.pilot !== null) continue;
    const distanceSq = fighter.flight.position.distanceToSquared(position);
    if (distanceSq >= bestDistanceSq) continue;
    best = fighter;
    bestDistanceSq = distanceSq;
  }
  return best;
}

export function updateFighterPresentation(
  fighter: FighterRuntime,
  delta: number,
  reducedMotion: boolean,
): void {
  fighter.visual.root.position.copy(fighter.flight.position);
  fighter.visual.root.quaternion.copy(fighter.flight.orientation);
  fighter.visual.updateVisual(delta, {
    throttle: Math.max(0, fighter.flight.controlThrottle),
    boost: fighter.flight.boostActive || fighter.flight.afterburnerActive,
    health: fighter.hull / FIGHTER_HULL_MAX,
    shield: fighter.shield / FIGHTER_SHIELD_MAX,
    hullHit: fighter.hullHit,
    shieldHit: fighter.shieldHit,
    destroyed: fighter.destroyed,
    respawning: fighter.destroyed,
    reducedMotion,
    visible: !fighter.destroyed || fighter.respawnSeconds <= 1.15,
    assemblyProgress: fighter.destroyed
      ? THREE.MathUtils.clamp(1 - fighter.respawnSeconds, 0, 1)
      : 1,
  });
}
