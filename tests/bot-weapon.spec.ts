import { expect, test } from '@playwright/test';
import { BOT_WEAPON_RANGE, botWeaponBandForDistance } from '../src/entities/BotWeapons';

test('extreme range never offers the machine gun', () => {
  const band = botWeaponBandForDistance(155, true);
  expect(band).not.toContain('machine');
  expect(band).toEqual(['rail', 'sniper']);
  expect(BOT_WEAPON_RANGE.machine).toBeLessThan(155);
  expect(BOT_WEAPON_RANGE.rail).toBeGreaterThan(155);
});

test('mid range prefers splash and hitscan that can actually reach', () => {
  const band = botWeaponBandForDistance(30, true);
  expect(band).toContain('rocket');
  expect(band).toContain('disc');
  for (const weapon of band) {
    expect(BOT_WEAPON_RANGE[weapon], `${weapon} must reach 30 m`).toBeGreaterThanOrEqual(30);
  }
});

test('unseen targets still prefer long-range weapons before the MG', () => {
  const band = botWeaponBandForDistance(120, false);
  expect(band[0]).toBe('rail');
  expect(band).toContain('sniper');
});
