import { expect, test, type Page } from '@playwright/test';
import { MOVEMENT } from '../src/game/config';

type PlayerDiagnostics = NonNullable<Window['__THREE_GAME_DIAGNOSTICS__']>['player'];
type Vec3 = { x: number; y: number; z: number };

const RADIANS_TO_DEGREES = 180 / Math.PI;

const player = async (page: Page): Promise<PlayerDiagnostics> => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);

const step = async (page: Page, seconds: number): Promise<PlayerDiagnostics> => page.evaluate((value) => {
  window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(value);
  return window.__THREE_GAME_DIAGNOSTICS__!.player;
}, seconds);

const sampleSteps = async (page: Page, count: number, seconds: number): Promise<PlayerDiagnostics[]> => page.evaluate(({ n, dt }) => {
  const out: PlayerDiagnostics[] = [];
  for (let index = 0; index < n; index += 1) {
    window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(dt);
    out.push(window.__THREE_GAME_DIAGNOSTICS__!.player);
  }
  return out;
}, { n: count, dt: seconds });

const headingDegrees = (velocity: Vec3): number => Math.atan2(velocity.x, velocity.z) * RADIANS_TO_DEGREES;

const headingDelta = (before: Vec3, after: Vec3): number => {
  let delta = headingDegrees(after) - headingDegrees(before);
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return Math.abs(delta);
};

async function openFlatGround(page: Page): Promise<Vec3> {
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 180_000 });
  return page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    // setState clears the screenshot pause; freeze after the spawn so rAF
    // cannot spend jump/dash presses or extra physics ticks between commands.
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
    return window.__THREE_GAME_DIAGNOSTICS__!.player.position;
  });
}

async function tapJump(page: Page): Promise<void> {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.queueJumpPress());
}

async function tapDash(page: Page): Promise<void> {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.queueDash());
}

async function placeAirborne(page: Page, ground: Vec3, height: number, velocity: Vec3): Promise<PlayerDiagnostics> {
  return page.evaluate(({ origin, lift, motion }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics({ x: origin.x, y: origin.y + lift, z: origin.z }, motion);
    return window.__THREE_GAME_DIAGNOSTICS__!.player;
  }, { origin: ground, lift: height, motion: velocity });
}

async function releaseAll(page: Page): Promise<void> {
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyE']) await page.keyboard.up(key);
}

test.describe('Warsow movement parity', () => {
  test.describe.configure({ timeout: 180_000 });

  test.afterEach(async ({ page }) => {
    await releaseAll(page);
  });

  test('pure-strafe air input does not turn the heading for free; forward-only air control does', async ({ page }) => {
    const ground = await openFlatGround(page);
    const cruise = { x: 0, y: 4, z: -20 };

    // Side-only input: CPM strafe accel only adds up to strafeWishSpeed laterally,
    // so the heading may change by at most atan(strafeWishSpeed / speed) — never
    // the 67° a 2.35 rad/s free carve would have produced in the same window.
    // Lift well above jump apex so a 0.5 s sample cannot land (3 m falls in 0.49 s).
    const strafeStart = await placeAirborne(page, ground, 8, cruise);
    expect(strafeStart.grounded).toBe(false);
    await page.keyboard.down('KeyD');
    const strafeEnd = await step(page, 0.5);
    await page.keyboard.up('KeyD');
    expect(strafeEnd.grounded, 'strafe sample must stay airborne').toBe(false);
    const strafeTurn = headingDelta(strafeStart.velocity, strafeEnd.velocity);
    const strafeBound = Math.atan(MOVEMENT.strafeWishSpeed / strafeStart.speed) * RADIANS_TO_DEGREES + 0.5;
    expect(strafeTurn, 'pure side strafe must not rotate the heading for free').toBeLessThan(strafeBound);
    expect(strafeTurn, 'CPM side accel is a few degrees, not a free carve').toBeLessThan(12);
    expect(strafeEnd.speed, 'pure strafe must not bleed speed').toBeGreaterThan(strafeStart.speed - 0.05);

    // Forward-only with the aim offset 35° from the heading: Warsow air control
    // rotates conserved momentum toward the view.
    const controlStart = await placeAirborne(page, ground, 8, cruise);
    const aimYaw = controlStart.yaw + 0.62;
    await page.evaluate((yaw) => window.__THREE_GAME_TEST_HOOKS__!.setAim(yaw, -0.04), aimYaw);
    await page.keyboard.down('KeyW');
    const controlEnd = await step(page, 0.5);
    await page.keyboard.up('KeyW');
    const controlTurn = headingDelta(controlStart.velocity, controlEnd.velocity);
    expect(controlTurn, 'forward-only air control must steer the heading').toBeGreaterThan(5);
    expect(controlTurn).toBeLessThan(0.62 * RADIANS_TO_DEGREES + 1);
    expect(controlEnd.speed, 'air control preserves speed (accel 1 may add a little)').toBeGreaterThan(controlStart.speed * 0.98);

    // Aim straight behind the heading (dot <= 0): air control cannot turn while
    // decelerating; only Q3 air decel (2) bleeds speed along the heading.
    const reverseStart = await placeAirborne(page, ground, 8, cruise);
    await page.evaluate((yaw) => window.__THREE_GAME_TEST_HOOKS__!.setAim(yaw + Math.PI, -0.04), reverseStart.yaw);
    await page.keyboard.down('KeyW');
    const reverseEnd = await step(page, 0.3);
    await page.keyboard.up('KeyW');
    expect(headingDelta(reverseStart.velocity, reverseEnd.velocity), 'no free turn when aiming against the heading').toBeLessThan(1);
    expect(reverseEnd.speed).toBeLessThan(reverseStart.speed);
    expect(reverseEnd.speed, 'air decel is 2 × wishSpeed per second, not a brake').toBeGreaterThanOrEqual(reverseStart.speed - 2 * MOVEMENT.wishSpeed * 0.3 - 0.5);
  });

  test('holding Space from the ground bunny hops and never fires the jetpack', async ({ page }) => {
    const ground = await openFlatGround(page);
    // Hop from rest on the pad. Residual run speed from spawn 13 slides into
    // the z=118 gates in about a second and breaks the landing count.
    await placeAirborne(page, ground, 0, { x: 0, y: 0, z: 0 });
    await page.keyboard.down('Space');
    await tapJump(page);
    let landings = 0;
    let jetpackTicks = 0;
    let armedTicks = 0;
    let peakHeight = ground.y;
    let previousGrounded = true;
    const groundedSamples: boolean[] = [];
    const hopSamples = await sampleSteps(page, 100, 0.025);
    for (const sample of hopSamples) {
      groundedSamples.push(sample.grounded);
      if (sample.grounded && !previousGrounded) landings += 1;
      previousGrounded = sample.grounded;
      if (sample.jetpacking) jetpackTicks += 1;
      if (sample.jetpackArmed) armedTicks += 1;
      peakHeight = Math.max(peakHeight, sample.position.y);
    }
    const final = await player(page);
    await page.keyboard.up('Space');
    const airborneCount = groundedSamples.filter((grounded) => !grounded).length;
    expect(
      landings,
      `a held jump must chain hops (airborne=${airborneCount} peak=${(peakHeight - ground.y).toFixed(2)} y=${final.position.y.toFixed(2)})`,
    ).toBeGreaterThanOrEqual(2);
    expect(jetpackTicks, 'a held ground jump must never ignite the jetpack').toBe(0);
    expect(armedTicks, 'a held ground jump must never arm the jetpack').toBe(0);
    expect(final.jetpackCharge, 'jetpack charge must be untouched').toBe(1);
    expect(peakHeight - ground.y, 'hops stay at jump height, not a jet climb').toBeLessThan(4);
    expect(peakHeight - ground.y, 'hops must clear the authored jump apex').toBeGreaterThan(1.2);
    expect(airborneCount, 'most of the chain is airborne').toBeGreaterThan(60);

    // Momentum preservation is a separate sample so the chain can stay on the pad.
    const look = await player(page);
    await placeAirborne(page, ground, 0, {
      x: -Math.sin(look.yaw) * 16,
      y: 0,
      z: -Math.cos(look.yaw) * 16,
    });
    await page.keyboard.down('Space');
    await tapJump(page);
    const hopping = await step(page, 0.3);
    await page.keyboard.up('Space');
    expect(hopping.grounded).toBe(false);
    expect(hopping.jetpacking).toBe(false);
    expect(hopping.speed, 'bunny hopping must preserve run speed').toBeGreaterThan(13);
  });

  test('a fresh Space press while airborne arms and fires the jetpack', async ({ page }) => {
    const ground = await openFlatGround(page);
    const start = await placeAirborne(page, ground, 8, { x: 0, y: 0, z: 0 });
    expect(start.grounded).toBe(false);
    await page.keyboard.down('Space');
    await tapJump(page);
    const burning = await step(page, 0.25);
    expect(burning.jetpackArmed).toBe(true);
    expect(burning.jetpacking).toBe(true);
    expect(burning.jetpackPhase).toBe('burning');
    expect(burning.velocity.y, 'thrust must overcome gravity').toBeGreaterThan(0);
    await page.keyboard.up('Space');
    const released = await step(page, 0.05);
    expect(released.jetpackArmed, 'releasing Space disarms the pack').toBe(false);
    expect(released.jetpacking).toBe(false);

    // Thrust never clamps a faster rise down.
    const fast = await placeAirborne(page, ground, 8, { x: 0, y: MOVEMENT.jetpackMaxRiseSpeed + 8, z: 0 });
    await page.keyboard.down('Space');
    await tapJump(page);
    const afterTick = await step(page, MOVEMENT.fixedStep);
    await page.keyboard.up('Space');
    expect(afterTick.jetpacking).toBe(true);
    expect(afterTick.velocity.y).toBeGreaterThan(fast.velocity.y - MOVEMENT.gravity * MOVEMENT.fixedStep * 1.5);
    expect(afterTick.velocity.y).toBeGreaterThan(MOVEMENT.jetpackMaxRiseSpeed);
  });

  test('dash is ground-only, sets speed to the dash speed with a hop, and is cleared by a jump', async ({ page }) => {
    const ground = await openFlatGround(page);
    await page.keyboard.down('KeyW');
    await step(page, 0.1);
    const beforeDash = await player(page);
    expect(beforeDash.grounded).toBe(true);
    await tapDash(page);
    const dashed = await step(page, MOVEMENT.fixedStep);
    expect(dashed.speed, 'dash sets horizontal speed to dashSpeed').toBeGreaterThanOrEqual(20);
    expect(dashed.speed).toBeLessThan(MOVEMENT.dashSpeed + 0.5);
    expect(dashed.velocity.y, 'dash hops').toBeGreaterThan(4);
    expect(dashed.grounded).toBe(false);
    expect(dashed.dashCooldown).toBeGreaterThan(0.9);

    // Dashing again while airborne (buffer expires before landing) does nothing.
    const aloft = await step(page, 0.1);
    expect(aloft.grounded).toBe(false);
    await page.keyboard.up('KeyW');
    const airborne = await placeAirborne(page, ground, 6, { x: 0, y: 2, z: -10 });
    await tapDash(page);
    const afterAirDash = await step(page, 0.3);
    expect(afterAirDash.grounded).toBe(false);
    expect(afterAirDash.speed, 'airborne dash must not change speed').toBeLessThan(airborne.speed + 0.3);
    expect(afterAirDash.dashCooldown, 'airborne dash must not start a cooldown').toBe(0);

    // A dash at speed never adds above the current speed, only redirects.
    // Push along the movement-flat look (toward the core), not world +X —
    // spawn 13's east ridge drops off within a few meters.
    const look = await player(page);
    const alongLook = (speed: number): Vec3 => ({
      x: -Math.sin(look.yaw) * speed,
      y: 0,
      z: -Math.cos(look.yaw) * speed,
    });
    const fastRunner = await placeAirborne(page, ground, 0, alongLook(30));
    expect(fastRunner.grounded).toBe(true);
    await tapDash(page);
    const fastDash = await step(page, MOVEMENT.fixedStep);
    expect(fastDash.speed).toBeLessThan(30.5);
    expect(fastDash.speed).toBeGreaterThan(27);

    // Any jump clears the dash cooldown.
    await placeAirborne(page, ground, 0, alongLook(5));
    await tapDash(page);
    const cooling = await step(page, 0.5);
    expect(cooling.grounded, 'dash hop lands within half a second').toBe(true);
    expect(cooling.dashCooldown).toBeGreaterThan(0.3);
    await tapJump(page);
    const jumped = await step(page, MOVEMENT.fixedStep);
    expect(jumped.velocity.y).toBeGreaterThan(MOVEMENT.jumpImpulse - 0.5);
    expect(jumped.dashCooldown, 'a jump resets the dash timer').toBe(0);
  });

  test('a fresh airborne Space press against a wall performs a wall jump', async ({ page }) => {
    const ground = await openFlatGround(page);
    const planted = await page.evaluate((origin) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      // East face of midfield-north-breaker (4.6 × 5.8 × 3.2). Plant outside
      // the box; probing from the interior misses or picks a roof lip.
      const wallX = 8 + 4.6 * 0.5;
      const standX = wallX + 0.4;
      const standZ = 34;
      const floor = hooks.sampleFloorHeight(standX, standZ, 200) ?? origin.y;
      const confirm = hooks.sampleMovementHit(
        { x: standX, y: floor + 2.2, z: standZ },
        { x: wallX - 0.2, y: floor + 2.2, z: standZ },
      );
      if (!confirm || Math.abs(confirm.normal.y) >= 0.3) return null;
      hooks.setPlayerKinematics(
        { x: standX, y: floor, z: standZ },
        { x: -9, y: 0, z: 0 },
      );
      hooks.setAim(Math.PI / 2, -0.04);
      hooks.setPausedForScreenshot(true);
      return window.__THREE_GAME_DIAGNOSTICS__!.player;
    }, ground);
    expect(planted, 'a near-vertical wall must exist near movement-flat').not.toBeNull();
    await page.keyboard.down('KeyW');
    let pressed = await player(page);
    for (let index = 0; index < 16 && !pressed.wallContact; index += 1) pressed = await step(page, 0.05);
    expect(pressed.wallContact, 'the player must be pressing into a wall').toBe(true);
    expect(pressed.wallJumpCount).toBe(0);

    // First press: ordinary ground jump (still pushing into the wall).
    await tapJump(page);
    const risen = await step(page, 0.08);
    expect(risen.grounded).toBe(false);
    expect(risen.wallJumpCount, 'a ground jump is not a wall jump').toBe(0);

    // Second, fresh press in the air with the wall in reach: wall jump.
    await tapJump(page);
    const wallJumped = await step(page, MOVEMENT.fixedStep);
    await page.keyboard.up('KeyW');
    expect(wallJumped.wallJumpCount).toBe(1);
    expect(wallJumped.velocity.y, 'wall jump rises at wallJumpUpSpeed').toBeGreaterThan(MOVEMENT.wallJumpUpSpeed - MOVEMENT.gravity * MOVEMENT.fixedStep * 2);
    expect(wallJumped.velocity.y).toBeGreaterThan(risen.velocity.y);
    expect(wallJumped.speed, 'wall jump never leaves the player below pm_wjminspeed').toBeGreaterThan(MOVEMENT.wishSpeed * MOVEMENT.wallJumpMinSpeedFactor - 0.5);
    expect(wallJumped.wallJumpAirLockout).toBe(true);
    expect(wallJumped.jetpackArmed, 'the press that wall-jumped must not arm the jetpack').toBe(false);
    expect(wallJumped.dashCooldown).toBe(0);
    expect(wallJumped.wallJumpCooldown).toBeGreaterThan(MOVEMENT.wallJumpCooldown - 0.05);

    // One wall jump per airtime.
    await tapJump(page);
    const secondAttempt = await step(page, MOVEMENT.fixedStep * 2);
    expect(secondAttempt.wallJumpCount).toBe(1);
    const audio = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts);
    expect(audio['movement.wall-jump'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('jumping while already rising stacks the impulse instead of overwriting it', async ({ page }) => {
    const ground = await openFlatGround(page);
    // A grounded body with a small existing rise (below the resolver's
    // un-ground threshold): the jump adds to it.
    const rising = await placeAirborne(page, ground, 0, { x: 0, y: 1, z: -6 });
    expect(rising.grounded).toBe(true);
    expect(rising.velocity.y).toBeGreaterThan(0.5);
    await tapJump(page);
    const stacked = await step(page, MOVEMENT.fixedStep);
    const expectedRise = rising.velocity.y + MOVEMENT.jumpImpulse - MOVEMENT.gravity * MOVEMENT.fixedStep;
    expect(stacked.velocity.y).toBeGreaterThan(expectedRise - 0.15);
    expect(stacked.velocity.y, 'a jump from rest never stacks').toBeGreaterThan(MOVEMENT.jumpImpulse);

    // Walked leftover rise is dropped (gs_pmove.c:781-790). Jump already
    // stacked above; a walk frame must not keep that 1 m/s loft.
    const leftover = await placeAirborne(page, ground, 0, { x: 0, y: 1, z: -6 });
    expect(leftover.grounded).toBe(true);
    const walked = await step(page, MOVEMENT.fixedStep);
    expect(walked.grounded, 'a 1 m/s leftover is not a ramp launch').toBe(true);
    expect(walked.velocity.y, 'PM_WalkMove zeroes leftover rise').toBeLessThan(leftover.velocity.y);
    expect(walked.velocity.y, 'clip bounce is not a seated loft').toBeLessThan(MOVEMENT.rampUngroundSpeed);

    // Shallow west-core-launch (~11°): 18 m/s converts to ~3.5 m/s of slide Z,
    // below 180 u/s, so Warsow stays grounded and the next walk frame zeros it.
    // A seated loft would accumulate past rampUngroundSpeed over ~1 s.
    const slopeTop = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('movement-slope');
      hooks.setPausedForScreenshot(true);
      return window.__THREE_GAME_DIAGNOSTICS__!.player.position;
    });
    const climbAt = async (speed: number) => {
      await page.evaluate(({ top, speed: runSpeed }) => {
        const hooks = window.__THREE_GAME_TEST_HOOKS__!;
        const bottom = { x: -119, z: 58 };
        const floor = hooks.sampleFloorHeight(bottom.x, bottom.z, 200) ?? top.y;
        const direction = { x: top.x - bottom.x, z: top.z - bottom.z };
        const length = Math.hypot(direction.x, direction.z);
        hooks.setPlayerKinematics(
          { x: bottom.x, y: floor, z: bottom.z },
          { x: (direction.x / length) * runSpeed, y: 0, z: (direction.z / length) * runSpeed },
        );
      }, { top: slopeTop, speed });
      await page.keyboard.down('KeyW');
      let climbing = await step(page, MOVEMENT.fixedStep);
      for (let index = 0; index < 8 && climbing.grounded; index += 1) {
        climbing = await step(page, MOVEMENT.fixedStep);
      }
      await page.keyboard.up('KeyW');
      return climbing;
    };
    const slow = await climbAt(18);
    expect(slow.grounded, '18 m/s on an 11° ramp is not a 180 u/s launch').toBe(true);
    expect(slow.velocity.y, 'leftover slide Z must not accumulate into a loft').toBeLessThan(MOVEMENT.rampUngroundSpeed);
    expect(Math.hypot(slow.velocity.x, slow.velocity.z), '2D speed is preserved through the ramp').toBeGreaterThan(12);

    const fast = await climbAt(50);
    expect(fast.grounded, 'one StepSlideMove at 50 m/s must convert past 180 u/s').toBe(false);
    expect(fast.velocity.y, 'the slide Z is kept, not zeroed').toBeGreaterThan(MOVEMENT.rampUngroundSpeed);
    expect(Math.hypot(fast.velocity.x, fast.velocity.z), '2D speed is preserved through the ramp launch').toBeGreaterThan(12);
  });
});
