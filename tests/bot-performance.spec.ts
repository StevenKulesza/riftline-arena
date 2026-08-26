import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

test('bot fixed-step paths remain free of transient vector and array pipelines', async () => {
  const source = await readFile(new URL('../src/entities/Bot.ts', import.meta.url), 'utf8');
  const fixedUpdate = section(source, '  update(', '  private tryStepMove(');
  const stepMovement = section(source, '  private tryStepMove(', '  takeDamage(');
  const weaponChoice = section(source, '  private chooseWeapon(', '  get grenadesRemaining');
  const navigationProbe = section(source, '  private selectTraversableHeading(', '  dispose():');
  const hotPath = [fixedUpdate, stepMovement, weaponChoice, navigationProbe].join('\n');

  expect(hotPath).not.toMatch(/new THREE\.(?:Vector2|Vector3|Quaternion|Euler|Matrix4)/);
  expect(hotPath).not.toContain('.clone()');
  expect(hotPath).not.toMatch(/\.(?:map|filter|sort)\(/);
  expect(source).toContain('private readonly scratchStartPosition = new THREE.Vector3()');
  expect(source).toContain('private readonly scratchTraversalProbe = new THREE.Vector3()');
});
