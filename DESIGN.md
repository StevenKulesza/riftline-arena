# Riftline Arena — Vertical Slice Contract

## Game design brief

- Player promise: carve impossible sci-fi terrain at lethal speed, out-aim rivals, and control the arena's timed resources.
- Target feeling: immediate, fast, precise, readable, aggressive, and replayable; Quake III Arena urgency with Warsow air control and Tribes-style slope skiing.
- Primary verbs: move, aim, fire.
- Secondary verbs: jump/bunny-hop, ski, air-strafe, weapon-swap, collect, route-plan, and rocket-jump.
- Objective: lead the score when the six-minute Arena/TDM match expires, reach the mode target first, capture three flags in CTF, or secure three uplinks in Raid.
- Pressure: an 8v8 roster across all team modes, scarce armor/health, timed damage/speed power-ups, mode objectives, hostile drones in Raid, and a rare railgun spawn.
- Reward/progression: kills score 1 for the owning team; suicides score -1 in Arena; the Flux Core scores 3 in Arena/TDM; CTF captures score 1; Raid uplinks score 1; midair eliminations are a tiebreaker rather than match score; controlling timed items produces tactical advantage.
- Fail/retry: death names the cause and respawns the player at a safe spawn after 1.6 seconds without resetting the match.
- Skill expression: momentum preservation, route timing, prediction shots, weapon matchups, rocket jumps, resource denial, and accurate fire while airborne.
- Readability promise: strong silhouettes, weapon-specific colors, pickup beams/timers, directional damage, compact HUD, and visible arena landmarks.
- Non-goals for this slice: network multiplayer, accounts, matchmaking, campaign progression, monetization, and licensed Quake/Warsow/Tribes assets.

## Core loop contract

The player chains movement and weapon fire to eliminate enemies, move with a squad, and contest the active mode objective. Success gives team score, item control, and momentum, while death costs position and causes a fast readable respawn.

## Match mode plan

- Arena: legacy free-for-all with three combat bots, first to 20 individual points, and the rotating Flux Core.
- Team Deathmatch: player + seven Azure allies versus eight Crimson opponents; friendly fire is disabled, team frags are shared, and the Flux Core awards three team points.
- Capture the Flag: the same 8v8 roster, with readable Azure/Crimson flag bases, dropped-flag returns, carrier drops on elimination, and first to three captures.
- Raid: player + seven Azure allies versus eight Crimson opponents while hostile drones pressure both squads; the controlling team holds three rotating uplinks for four seconds each to extract.
- Team assignment: in competitive modes, player and bot IDs 0–6 are Azure and bot IDs 7–14 are Crimson, keeping the 16-combatant split deterministic.

## Movement contract

- Fixed simulation step: 1/120 second with clamped frame accumulation; movement subdivides again so no collision sweep exceeds 0.25 m.
- Collider: swept custom kinematic capsule approximation (0.55 m radius, 1.8 m standing height) over an analytic open-terrain height/normal field; walls, tunnels, ramps, and overhangs use separate convex proxy volumes.
- Movement numbers follow Warsow/qfusion `gs_pmove.c` with 320 u/s mapped to 15 m/s.
- Ground: wish speed 15 m/s, Quake accelerate 11.5, friction 8 with stop speed 10.5 → 0→14 m/s in ≈0.16 s; hard 15 m/s cap on foot.
- Air: Q3 accelerate 1 (2 when pushing against velocity), CPM side-only strafe accel 74 at a 1.9 m/s cap, forward-only air control `k = 32 × 7.03 × dot² × dt` that preserves speed and cannot turn while decelerating (dot ≤ 0). No air friction and no gameplay speed cap (120 m/s NaN/tunnelling safety clamp only).
- Jump impulse: 9 m/s (1.62 m apex, 0.72 s airtime); gravity 25 m/s²; coyote window 100 ms; jump buffer 120 ms. A held jump re-jumps on the landing frame with zero friction frames. If the body is already rising (ramp/stair launch) the jump adds: `vy > 0.35 × jump → vy += jump` (double-jump event), `0 < vy → vy += jump`, else `vy = jump`. Any jump clears dash and wall-jump timers.
- Dash: ground only, sets `hspeed = max(current, 21 m/s)` along the input direction plus a 5.6 m/s hop (0.45 s airtime); 1.0 s cooldown cleared by any jump or wall jump.
- Wall jump: fresh airborne Space press with a near-vertical wall (|normal.y| < 0.3) within radius + 0.2 m across 12 probes at 30°; horizontal speed `max(|v|, 11.25)` clipped off the wall plus 0.3 × normal; `vy = max(vy, 10.6)`; one per airtime, 1.3 s cooldown, blocked in the first 100 ms of a dash; air accel/control are off while still rising afterwards.
- Jetpack: only a fresh airborne Space press arms thrust; holding through a ground jump bunny hops instead. Thrust adds 42 m/s² while `vy < 18` and never reduces a faster rise. 2.25 s burn, 4.5 s refill.
- Knockback lockout (PM_STAT_KNOCKBACK): while active there is no ground friction, dash, strafe-mode accel, or air control, so weapon shoves are not absorbed on the landing frame.
- Skiing projects gravity onto the ground tangent at full strength (scale 1.12) and never scales it down; drag is `0.025 × v + 0.004 × max(0, v − 22)²`, so a 30° slope settles above 45 m/s (3× run) and a 15° slope still passes 70 km/h. Ski steering blends toward input at `1.6 × dt / (1 + v / 42)` — a 90° carve at run speed takes over 1.2 s — and ski input pushes only to 3 m/s, so the line does the work.
- Walkable slope limit: 50°; ground snap: 0.25 m; step height: 0.4 m.
- Rocket splash can add controlled self-knockback; the player cannot self-kill from full health with one rocket.
- Camera FOV scales from 82° to 102° with speed; landing, damage, rail, and rocket events use bounded trauma shake.

## Arena and encounter plan

- Spatial format: a mirrored open bowl with a central Flux Core dais, two downhill perimeter lanes, four launch ramps, two jump pads, an elevated railgun perch, and tunnel-like underpasses.
- Start: safe upper ledge facing the central landmark and one visible weapon pickup.
- First decision: descend toward the core for objective points, rotate to armor, or build speed on the perimeter ski line.
- First threat: a bot contests the core within ten seconds.
- First reward: nearby machine-gun ammunition and health, followed by the core or armor route.
- Landmarks: cyan core spire, magenta rail perch, amber damage tower, and lime speed ring.
- Escalation: item denial and route conflicts become more important after the first minute; bots never gain hidden accuracy from the player's lead.
- Recovery beats: protected respawn ledges, outer health alcoves, and broad low-friction bowls.
- Failure readability: colored hit direction, weapon name, kill feed, respawn countdown, and unobstructed sightlines around lethal pickups.

## Weapon roles

| Weapon | Role |
| --- | --- |
| Machine gun | Reliable medium-range sustained hitscan pressure. |
| Shotgun | Close-range burst with deterministic pellet spread. |
| Rocket launcher | Prediction, splash zoning, and rocket jumps. |
| Plasma gun | Fast projectile suppression and corridor denial. |
| Laser | Accurate short-to-mid-range beam with heat management. |
| Sniper | Slow scoped hitscan precision with a clear tracer. |
| Railgun | Rare timed power weapon; piercing high-damage shot with a long recovery. |

Combat baselines: 100 health; 100 armor absorbing 66%; machine gun 8 damage at 10 Hz; shotgun 10×8 every 0.9 s; rocket 90 direct plus 70-to-0 splash over 5 m at 40 m/s; plasma 18 at 8 Hz and 45 m/s; laser 90 DPS with a 1.2 s overheat; sniper 70 every 1.1 s; railgun 110 piercing every 1.5 s with three shots and a 45-second respawn. Self-rocket damage is 55%.

The Flux Core activates after 30 seconds, requires an uncontested four-second hold inside its four-meter ring, awards three points, and then cools down for 45 seconds. Damage and speed power-ups respawn every 60 seconds and last 15 seconds. Bots make tactical decisions at 10 Hz, react in 200–280 ms, use only line-of-sight information, and carry 1.5–3° aim error.

## Verification targets

- Production build passes with no blocking console/page errors.
- Player can enter within five seconds, gain speed through jump/strafe/ski input, fire all weapons, collect an item, score, die, and respawn.
- Deterministic hooks expose active-play, combat, fail, and stress states.
- Desktop and mobile canvas captures are nonblank and HUD text does not overlap critical play.
- Target: 60 FPS desktop at 1440×900, 30+ FPS mobile emulation, DPR capped at 1.75, fewer than 180 draw calls, and fewer than 350k visible triangles.
