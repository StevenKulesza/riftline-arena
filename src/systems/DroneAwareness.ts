/**
 * Combat drones are local sector threats, not map-wide snipers.
 * Acquisition needs LOS plus a forward cone unless the target is already
 * inside proximity range. Retained locks use a slightly longer leash.
 */
export const SENTINEL_AWARENESS = Object.freeze({
  acquireRange: 42,
  retainRange: 50,
  proximityRange: 18,
  acquireDot: 0.5,
});

export const BUSTER_AWARENESS = Object.freeze({
  acquireRange: 52,
  retainRange: 62,
  proximityRange: 20,
  acquireDot: 0.5,
});

export const GRENADIER_AWARENESS = Object.freeze({
  acquireRange: 36,
  retainRange: 44,
  proximityRange: 16,
  acquireDot: 0.5,
});

export type DroneAwarenessSample = {
  distance: number;
  acquireRange: number;
  retainRange: number;
  proximityRange: number;
  alreadyTargeting: boolean;
  facingDot: number;
  acquireDot: number;
  hasLos: boolean;
};

export function droneCanAcquire(sample: DroneAwarenessSample): boolean {
  if (!sample.hasLos) return false;
  const range = sample.alreadyTargeting ? sample.retainRange : sample.acquireRange;
  if (sample.distance >= range) return false;
  if (sample.alreadyTargeting || sample.distance <= sample.proximityRange) return true;
  return sample.facingDot >= sample.acquireDot;
}
