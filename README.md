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
- Jump/bunny hop: `Space`
- Ski: hold `Shift`
- Grapple: hold `G` or `E`; release to detach (`E` also dashes)
- Grenade: `Q`
- Bunny hop: hold `Space`; press `Space` against a wall to wall-jump
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

The six-minute match ends when a combatant reaches 20 points or time expires. Kills award one point. The central Flux Core activates after 30 seconds, requires an uncontested four-second hold, awards three points, and then cools down for 45 seconds. Damage and speed boosts last 15 seconds and respawn every 60 seconds. The railgun provides three shots and respawns every 45 seconds.

Riftline's game code, procedural weapon geometry, UI, and generated audio implementation are
project work. The arena includes converted WCA1/Funpark geometry and selected materials from
the archived Warsow asset repository, and the character model is SWAT by Quaternius. See
[ASSET_LICENSES.md](ASSET_LICENSES.md) for source links, attribution, and license details.
