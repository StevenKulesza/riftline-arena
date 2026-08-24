import { expect, test, type Page } from '@playwright/test';

const TEST_SEED = 450_600;

type BotSnapshot = {
  frame: number;
  score: number;
  botLead: number;
  state: string;
  health: number;
  coreProgress: number;
  x: number;
  y: number;
  z: number;
  velocityY: number;
  grounded: boolean;
  skiing: boolean;
};

async function snapshot(page: Page): Promise<BotSnapshot> {
  return page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    if (!diagnostics) throw new Error('Riftline diagnostics are unavailable.');
    return {
      frame: diagnostics.frame,
      score: diagnostics.score,
      botLead: Number.parseInt(document.querySelector('#bot-lead-value')?.textContent ?? '0', 10),
      state: diagnostics.state,
      health: diagnostics.health,
      coreProgress: diagnostics.coreProgress,
      x: diagnostics.player.position.x,
      y: diagnostics.player.position.y,
      z: diagnostics.player.position.z,
      velocityY: diagnostics.player.velocity.y,
      grounded: diagnostics.player.grounded,
      skiing: diagnostics.player.skiing,
    };
  });
}

async function setState(page: Page, name: string): Promise<void> {
  await page.evaluate(({ seed, stateName }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) throw new Error('Riftline test hooks are unavailable.');
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setPausedForScreenshot(false);
    hooks.setState(stateName);
  }, { seed: TEST_SEED, stateName: name });
}

test('bot playtest: movement, jump/ski, score pressure, and redeploy all progress', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Keyboard bot runs once; mobile input is covered by visual.spec.ts.');
  test.setTimeout(60_000);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await setState(page, 'active-play');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running');

  const before = await snapshot(page);
  const movementSamples: BotSnapshot[] = [before];
  let softlockWindows = 0;

  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyD');
  await expect.poll(async () => (await snapshot(page)).skiing).toBe(true);
  for (let index = 0; index < 4; index += 1) {
    await page.waitForTimeout(180);
    const current = await snapshot(page);
    const previous = movementSamples[movementSamples.length - 1];
    const moved = Math.hypot(current.x - previous.x, current.z - previous.z);
    if (current.frame > previous.frame && moved < 0.08) softlockWindows += 1;
    movementSamples.push(current);
  }
  await page.keyboard.up('KeyD');
  await page.keyboard.up('ShiftLeft');
  await expect.poll(async () => (await snapshot(page)).skiing).toBe(false);

  const afterMovement = movementSamples[movementSamples.length - 1];
  const distanceTravelled = movementSamples.slice(1).reduce((distance, current, index) => {
    const previous = movementSamples[index];
    return distance + Math.hypot(current.x - previous.x, current.z - previous.z);
  }, 0);
  expect(distanceTravelled, 'held strafe + ski input must move the player').toBeGreaterThan(4);
  expect(afterMovement.frame - before.frame, 'the game loop must advance during movement').toBeGreaterThan(20);
  expect(softlockWindows, 'held movement produced repeated no-motion windows').toBeLessThanOrEqual(1);

  await setState(page, 'active-play');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.player.grounded === true);
  const beforeJump = await snapshot(page);
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await snapshot(page)).velocityY, { timeout: 2_000, intervals: [20, 40, 80] })
    .toBeGreaterThan(2);
  const jump = await snapshot(page);
  expect(jump.grounded, 'jump input must leave the ground').toBe(false);
  expect(jump.y, 'jump input must raise the player').toBeGreaterThan(beforeJump.y);

  // The combat state places a live bot in the player's lane. Live AI pressure
  // must advance either player's score, the rival lead, or the Flux Core.
  await setState(page, 'combat');
  const beforeProgress = await snapshot(page);
  let progress = beforeProgress;
  let maxCoreProgress = beforeProgress.coreProgress;
  await page.keyboard.down('KeyF');
  const progressDeadline = Date.now() + 15_000;
  while (Date.now() < progressDeadline) {
    await page.waitForTimeout(250);
    progress = await snapshot(page);
    maxCoreProgress = Math.max(maxCoreProgress, progress.coreProgress);
    if (
      progress.score !== beforeProgress.score
      || progress.botLead > beforeProgress.botLead
      || maxCoreProgress > beforeProgress.coreProgress + 0.02
    ) break;
  }
  await page.keyboard.up('KeyF');
  const progressed = progress.score !== beforeProgress.score
    || progress.botLead > beforeProgress.botLead
    || maxCoreProgress > beforeProgress.coreProgress + 0.02;
  expect(progressed, 'combat/objective play must advance a score or objective metric').toBe(true);

  await setState(page, 'fail');
  await expect.poll(async () => (await snapshot(page)).state).toBe('respawning');
  const failed = await snapshot(page);
  expect(failed.health).toBe(0);
  await expect(page.locator('#respawn-overlay')).toBeVisible();
  await expect(page.locator('#respawn-text')).toContainText('REDEPLOY');

  await expect
    .poll(async () => {
      const current = await snapshot(page);
      return current.state === 'running' && current.health === 100;
    }, { timeout: 4_000 })
    .toBe(true);
  await expect(page.locator('#respawn-overlay')).toBeHidden();
  const afterRespawn = await snapshot(page);

  const report = {
    seed: TEST_SEED,
    framesAdvanced: afterRespawn.frame - before.frame,
    distanceTravelled: Number(distanceTravelled.toFixed(2)),
    softlockWindows,
    jumpPeakVelocityY: Number(jump.velocityY.toFixed(2)),
    skiObserved: movementSamples.some((sample) => sample.skiing),
    scoreBefore: beforeProgress.score,
    scoreAfter: progress.score,
    botLeadBefore: beforeProgress.botLead,
    botLeadAfter: progress.botLead,
    maxCoreProgress: Number(maxCoreProgress.toFixed(3)),
    failState: failed.state,
    respawnState: afterRespawn.state,
    consoleErrors,
    pageErrors,
  };
  await testInfo.attach('bot-playtest-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`bot playtest: ${JSON.stringify(report)}`);

  expect(consoleErrors, 'console errors during bot play').toEqual([]);
  expect(pageErrors, 'page errors during bot play').toEqual([]);
});
