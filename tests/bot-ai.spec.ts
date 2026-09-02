import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import {
  AIM_DEADZONE_RADIANS,
  aimWfacMetres,
  applyAimWfacOffset,
  botMayPullTrigger,
  stepAimChangeAngle,
  type AimAngleRates,
} from '../src/entities/BotAim';
import { GRENADE } from '../src/game/config';
import { BotThreatMemory, solveBallisticLaunch } from '../src/systems/BotThreat';

test('solveBallisticLaunch writes a low-arc throw that reaches the target under grenade gravity', () => {
  const origin = new THREE.Vector3(0, 1.5, 0);
  const target = new THREE.Vector3(0, 1.2, 10);
  const launch = new THREE.Vector3();
  const flight = solveBallisticLaunch(origin, target, GRENADE.throwSpeed, GRENADE.gravity, launch);
  expect(flight).toBeGreaterThan(0.3);
  expect(flight).toBeLessThan(GRENADE.fuse);
  expect(launch.y).toBeGreaterThan(0);
  const landX = origin.x + launch.x * flight;
  const landZ = origin.z + launch.z * flight;
  const landY = origin.y + launch.y * flight - 0.5 * GRENADE.gravity * flight * flight;
  expect(landX).toBeCloseTo(target.x, 4);
  expect(landZ).toBeCloseTo(target.z, 4);
  expect(landY).toBeCloseTo(target.y, 4);
});

test('solveBallisticLaunch refuses a target outside the grenade speed envelope', () => {
  const launch = new THREE.Vector3();
  const flight = solveBallisticLaunch(
    new THREE.Vector3(0, 1.5, 0),
    new THREE.Vector3(0, 40, 80),
    GRENADE.throwSpeed,
    GRENADE.gravity,
    launch,
  );
  expect(flight).toBe(-1);
});

test('AI_ChangeAngle does not snap; a large turn overshoots the ideal', () => {
  const delta = 1 / 60;
  const yawSpeed = THREE.MathUtils.degToRad(900);
  const yawAccel = THREE.MathUtils.degToRad(100);
  const rates: AimAngleRates = { speedYaw: 0, speedPitch: 0 };
  const ideal = THREE.MathUtils.degToRad(90);
  const first = stepAimChangeAngle(0, 0, ideal, 0, rates, yawSpeed, yawAccel, delta);
  expect(THREE.MathUtils.radToDeg(first.yaw)).toBeLessThan(4);
  expect(THREE.MathUtils.radToDeg(first.yaw)).toBeCloseTo(THREE.MathUtils.radToDeg(yawAccel * delta), 5);

  let yaw = first.yaw;
  let peak = yaw;
  for (let tick = 0; tick < 40; tick += 1) {
    const next = stepAimChangeAngle(yaw, 0, ideal, 0, rates, yawSpeed, yawAccel, delta);
    yaw = next.yaw;
    if (next.yaw > peak) peak = next.yaw;
  }
  expect(THREE.MathUtils.radToDeg(peak), 'snap-to-ideal is #if 0; heading must pass 90°').toBeGreaterThan(90);
});

test('AI_ChangeAngle takes about 8 frames to reach yaw_speed from rest', () => {
  const delta = 1 / 60;
  const yawSpeed = THREE.MathUtils.degToRad(600);
  const yawAccel = THREE.MathUtils.degToRad(85);
  const rates: AimAngleRates = { speedYaw: 0, speedPitch: 0 };
  const ideal = Math.PI * 0.5;
  let yaw = 0;
  for (let tick = 0; tick < 8; tick += 1) {
    const next = stepAimChangeAngle(yaw, 0, ideal, 0, rates, yawSpeed, yawAccel, delta);
    yaw = next.yaw;
  }
  const maxStep = yawSpeed * delta;
  expect(rates.speedYaw).toBeGreaterThan(maxStep * 0.85);
  expect(rates.speedYaw).toBeLessThanOrEqual(maxStep + yawAccel * delta);
});

test('Warfork wfac is world-XY metres, not a sub-degree angular walk', () => {
  expect(aimWfacMetres('machine', 1, false)).toBeCloseTo(25 * 0.028, 6);
  expect(aimWfacMetres('rocket', 1, false)).toBeCloseTo(25 * 0.028, 6);
  expect(aimWfacMetres('rocket', 0.1, false)).toBeCloseTo((25 + 390 * 0.9) * 0.028, 6);
  expect(aimWfacMetres('rocket', 0.1, true)).toBeCloseTo((25 + 390 * 2.5 * 0.9) * 0.028, 6);
  expect(aimWfacMetres('laser', 1, false)).toBeCloseTo(25 * 0.028, 6);

  const halfWfac = aimWfacMetres('machine', 1, false) * 0.5;
  const angleAtTenMetres = Math.atan2(halfWfac, 10);
  expect(angleAtTenMetres).toBeGreaterThan(AIM_DEADZONE_RADIANS);

  const point = new THREE.Vector3(0, 1.5, 10);
  applyAimWfacOffset(point, 'machine', aimWfacMetres('machine', 1, false), 0, () => 0);
  expect(point.x).toBeCloseTo(-halfWfac, 6);
  expect(point.z).toBeCloseTo(10 - halfWfac, 6);
  expect(point.y).toBe(1.5);

  const laser = new THREE.Vector3(0, 1.5, 0);
  const laserWfac = aimWfacMetres('laser', 0.5, false);
  applyAimWfacOffset(laser, 'laser', laserWfac, 0, () => 0.99);
  expect(Math.hypot(laser.x, laser.z)).toBeCloseTo(laserWfac, 6);
});

test('Warfork trigger fires along the hunted heading with no chest cone', () => {
  const ready = {
    visible: true,
    acquired: true,
    fireCooldown: 0,
    fireProbability: 0.25,
    unitRandom: 0.25,
  };
  // Named gap: S=0.92 laser wfac is 6.9° at 10 m vs a 3.3° cone. The cone is gone.
  // Follow-up: Warfork FireWeapon has no self-splash hold; rocket/plasma use this same trigger.
  expect(botMayPullTrigger({ ...ready, continuous: true })).toBe(true);
  expect(botMayPullTrigger({ ...ready, continuous: false })).toBe(true);
  expect(botMayPullTrigger({ ...ready, continuous: false, unitRandom: 0.26 })).toBe(false);
  expect(botMayPullTrigger({ ...ready, continuous: false, visible: false })).toBe(false);
  expect(botMayPullTrigger({ ...ready, continuous: true, acquired: false })).toBe(false);
});

test('BotThreatMemory remembers an unseen attacker and decays recent damage', () => {
  const memory = new BotThreatMemory();
  const origin = new THREE.Vector3(0, 1.2, -8);
  const botPosition = new THREE.Vector3(0, 0, 0);
  const facing = new THREE.Vector3(0, 0, 1);
  memory.registerDamage('player', 24, origin, botPosition, facing, 0.55, 3);
  expect(memory.lastAttacker).toBe('player');
  expect(memory.attackerIsRecent(3.2)).toBe(true);
  expect(memory.isAlerted(3.2)).toBe(true);
  expect(memory.hasBearing).toBe(true);
  expect(memory.damageBearing.z).toBeLessThan(0);
  expect(memory.consumeDodgeRequest()).toBe(true);
  expect(memory.consumeDodgeRequest()).toBe(false);
  memory.decay(2);
  expect(memory.damageTakenRecently).toBeLessThan(24);
  expect(memory.attackerIsRecent(10)).toBe(false);
});
