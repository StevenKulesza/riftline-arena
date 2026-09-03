# Riftline Arena

An original Three.js browser arena FPS vertical slice built around air strafing, bunny hopping, slope skiing, weapon timing, and arena control.

## Run

```bash
npm install
npm run dev
```

Production verification:

```bash
npm run build
npm run preview
npm run verify:visual
npm run inspect:canvas
```

## Audio assets

Weapon, impact, confirmation, equip, dry-fire, ammunition-pickup, terrain, jetpack, tracer, grunt, and layered ambience cues are pre-generated assets served from `public/assets/audio`. Runtime playback uses pooled variants, separate music/ambience groups, positional enemy/world audio, and a procedural dirt layer for extra surface grit.

To regenerate them, copy `.env.example` to `.env`, add an ElevenLabs API key, then run:

```bash
./scripts/generate-weapon-audio.sh
./scripts/generate-environment-audio.sh
./scripts/master-weapon-audio.sh
```

The `.env` file is ignored by version control. It is used only by the local generation script and is never bundled into the browser build.

## Controls

- Move: `WASD`
- Aim: mouse after clicking the canvas
- Fire: left mouse or `F`
- Jump: `Space`. Hold `Space` on the ground to bunny hop (frictionless landings; a
  ramp or stair launch stacks a second jump on top of the rise).
- Jetpack: while airborne, press `Space` again and hold to jet. Holding `Space`
  through a ground jump never thrusts; only a fresh press in the air arms the pack.
- Wall jump: press `Space` in the air with a wall in reach. One per airtime,
  1.3 s cooldown; it clears the dash cooldown and locks air control until the rise ends.
- Dash: `E` or `CapsLock` on the ground. Sets run speed to 1.4× along your input
  with a short hop; 1 s cooldown that any jump or wall jump resets.
- Ski: hold `Shift`
- Grapple: hold `G` or `E`; release to detach
- Grenade: `Q`
- Zoom sniper/rail: `C` or `Ctrl`
- Weapons: `1`–`8` or mouse wheel
- Pause/resume: `P` or `Esc`
- Mute: `M`

Touch layouts expose movement, fire, jump, ski, grapple, and grenade controls on narrow/coarse-pointer screens.

## Deployment

Pushes to `main` build and deploy the production `dist/` artifact to GitHub Pages through
`.github/workflows/pages.yml`. The build uses relative public-asset URLs so it works from a
GitHub project Pages path as well as a root or custom domain.

## Match rules

The default Arena protocol is a six-minute free-for-all: the first combatant to 20 points wins, or the highest score wins at time. Optional team protocols are available with `?mode=tdm`, `?mode=ctf`, and `?mode=raid`. All three are true 8v8 matches (player + 7 allies versus 8 opponents); TDM reaches 20 team frags first, CTF reaches three captures, and Raid contests three uplinks while hostile drones add pressure. Friendly fire is disabled in team protocols. The Flux Core remains the Arena/TDM objective, while damage and speed boosts last 15 seconds and respawn every 60 seconds. The railgun provides three shots and respawns every 45 seconds.

Riftline's game code, procedural weapon geometry, UI, and generated audio implementation are
project work. The arena includes converted WCA1/Funpark geometry and selected materials from
the archived Warsow asset repository, and the character model is SWAT by Quaternius. See
[ASSET_LICENSES.md](ASSET_LICENSES.md) for source links, attribution, and license details.
