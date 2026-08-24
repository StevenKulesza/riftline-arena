# Riftline Arena — Vertical Slice Contract

## Game design brief

- Player promise: carve impossible sci-fi terrain at lethal speed, out-aim rivals, and control the arena's timed resources.
- Target feeling: immediate, fast, precise, readable, aggressive, and replayable; Quake III Arena urgency with Warsow air control and Tribes-style slope skiing.
- Primary verbs: move, aim, fire.
- Secondary verbs: jump/bunny-hop, ski, air-strafe, weapon-swap, collect, route-plan, and rocket-jump.
- Objective: lead the score when the six-minute match expires, or reach 20 points first.
- Pressure: three combat bots, scarce armor/health, timed damage/speed power-ups, a central Flux Core objective, and a rare railgun spawn.
- Reward/progression: kills score 1; suicides score -1; capturing the Flux Core scores 3; midair eliminations are a tiebreaker rather than match score; controlling timed items produces tactical advantage.
- Fail/retry: death names the cause and respawns the player at a safe spawn after 1.6 seconds without resetting the match.
- Skill expression: momentum preservation, route timing, prediction shots, weapon matchups, rocket jumps, resource denial, and accurate fire while airborne.
- Readability promise: strong silhouettes, weapon-specific colors, pickup beams/timers, directional damage, compact HUD, and visible arena landmarks.
- Non-goals for this slice: network multiplayer, accounts, matchmaking, campaign progression, monetization, and licensed Quake/Warsow/Tribes assets.

## Core loop contract

The player chains movement and weapon fire to eliminate bots and capture the Flux Core while rivals and timed resources create pressure; success gives score, item control, and momentum, while death costs position and causes a fast readable respawn.

## Movement contract

- Fixed simulation step: 1/120 second with clamped frame accumulation; movement subdivides again so no collision sweep exceeds 0.25 m.
- Collider: swept custom kinematic capsule approximation (0.55 m radius, 1.8 m standing height) over an analytic open-terrain height/normal field; walls, tunnels, ramps, and overhangs use separate convex proxy volumes.
- Ground acceleration: 48 m/s²; air acceleration: 22 m/s²; max wish speed: 18 m/s before slope/rocket momentum.
- Normal ground friction: 9.5; skiing friction while Shift is held: 0.12.
- Jump impulse: 10.8 m/s; gravity: 28 m/s²; coyote window: 100 ms; jump buffer: 120 ms.
- Bunny hopping preserves horizontal velocity; air strafing rewards perpendicular wish direction and camera steering.
- Acceleration adds at most `min(acceleration × dt, wishSpeed - dot(horizontalVelocity, wishDirection))`; friction scales speed by `max(0, 1 - friction × dt)`.
- Skiing projects gravity onto the ground tangent without creating uphill energy, preserves downhill momentum, and allows speeds up to a 58 m/s safety cap.
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
