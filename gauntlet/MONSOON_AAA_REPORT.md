# Monsoon Divide AAA pass — director report

## Game design brief

Monsoon Divide is a 960 × 800 m, high-speed outdoor arena built around Tribes-style gravity skiing and route conversion, with Warsow-style combat decisions at gates, ramps, bunkers, and pickups. The intended fantasy is a storm-harvesting archipelago installation: wet blue-slate terrain, moss/soil ski grades, six silhouette-readable industrial anchors, a central collector complex, and a weather front that changes presentation without hiding combat.

## Core loop

Read a downhill line, convert gravity into speed, choose an upper ridge or central recovery route, launch through a gate or ramp, contest the Flux Core/pickups, fight at speed, then use the opposite grade to preserve momentum into the next engagement. The loop must remain readable at first-person speed and recoverable after a missed launch.

## Level/encounter plan

- Macro: four broad cross-island ski lanes, an inner recovery bowl, an outer ridge loop, six jump pads, and six authored landmark anchors.
- Meso: enterable west/east bunkers, a south underpass, roof-access ramps, route gates, ridge shoulders, and stormwall cover split long rail/sniper chords.
- Micro: pickup cover within 8 m, signal beacons, shallow wet patches, terrain transitions, structural trim, and contact shadows provide moment-to-moment reads.
- Encounter cadence: long-range ridge pressure converts into mid-bowl projectile combat, then into bunker/gate close-range checks before the next gravity line.

## Skill-loading ledger

- threejs-game-director: orchestration, phase gates, ledgers, and report audit.
- threejs-gameplay-systems: skiing/controller and bot movement parity.
- threejs-aaa-graphics-builder: premium visual scorecard, technical-art gate, and fresh-eyes review.
- threejs-game-ui-designer: desktop/mobile active-play evidence.
- threejs-debug-profiler: deterministic diagnostics and render audit.
- threejs-qa-release: build, Playwright, console/page-error, desktop/mobile, screenshot, canvas, and pixel evidence.
- threejs-3d-generator, threejs-image-generator, and threejs-audio-generator: credential probes and asset strategy.

## Reference ledger

- Tribes: Ascend / Katabatic: broad mountainous terrain, deliberate skiing hills, sharp formation silhouettes, bases, and towers set the macro-flow and landmark bar.
- Tribes: Ascend / Crossfire: island perimeter, opposing installations, and ocean-separated silhouette reference.
- Warsow WCA1/wdm5: compact route choices, high-contrast traversal grammar, and combat-space density set the micro-flow bar.
- Local comparison images: `gauntlet/shots/bar/katabatic-wide.jpg` and `gauntlet/shots/bar/warsow-ingame-03.jpg`.

## Phase ledger

### Gameplay systems

- Made exact rendered triangle height and normal sampling authoritative for player support, props, routes, bots, and projectile decisions.
- Raised the 120 Hz fixed timestep catch-up budget to four steps so the supported 30 FPS floor advances in real time.
- Added bot tangent gravity, carve steering, momentum drag, and bounded low-authority recovery so bots use the same downhill logic as the player.
- Shortened the southwest launch entry and retained its validated speed, lip crossing, climb, and airtime.

### AAA graphics

- Replaced duplicated toy masts and visible tall collider slabs with six original storm-harvester silhouettes plus a central collector shell.
- Added 39 layered basalt stormbreaks, 32 beacon housings, 76 cyan/amber route signals, wet clearcoat, structural ribs, panel/bump response, shoreline foam, storm puddles, reactive vegetation, smoother storm-toned ocean shading, and severity-responsive lighting.
- Removed the rectangular perimeter berm and editor-like radial route decals; terrain color now carries the broad ski lines while the inner race line keeps restrained packed earth.
- Added SMAA after bloom/color grading for normal play.

### UI

- Captured the existing full desktop HUD and portrait mobile controls in deterministic active combat. The mobile layout exposes health, armor, weapon/ammo, movement, fire, jump, ski, hook, dash, grenade, swap, alt, view, board, and virtual stick without hiding the target lane.

### Debug/profile

- Visual test harness: `gauntlet/shots/capture-critic.mjs` captures deterministic desktop/mobile overview, route, landmark, weather, and active-combat states and writes `gauntlet/shots/critic-measurements.json`.
- Measured evidence: map occupancy 806/806 samples, vertical range 182.937 m, ski probes 125.252 m and 130.772 m, and jump-pad lifts 72.037 m, 60.464 m, and 95.256 m.
- Arena render audit: 93 visible draws + 13 shadow draws, 494,722 triangles, 39,868 instances. Full active-combat evidence: 394 calls and 931,184 triangles including a 75,502-triangle first-person weapon.

### QA/release

- `npm run build` passes; Vite only reports the pre-existing large-chunk advisory.
- Focused desktop geometry/flow/cover/fog/lighting/world-art suite passes with one intentionally skipped rock-tunneling probe.
- Desktop and mobile project coverage passed in the earlier combined focused run.
- Latest capture has zero console errors and zero page errors.
- Screenshot evidence: `gauntlet/shots/r11-monsoon-overlook.png`, `r11-monsoon-ramp.png`, `r11-monsoon-weather.png`, `r11-monsoon-active-combat.png`, and `r11-monsoon-active-mobile.png`.

## Physics engine

The runtime uses custom fixed-step capsule movement and ray/triangle queries accelerated by `three-mesh-bvh`; it does not use a separate rigid-body engine. Timestep is 1/120 s with a four-step frame catch-up cap. Static terrain, ramp geometry, collider boxes, and authored world-art anchor colliders are merged into the BVH. Exact 24,000-triangle parity checks require height error below 0.1 mm and face-normal dot above 0.99999.

## External asset sourcing

### Credential probe output

- `TRIPO_API_KEY=MISSING`
- `GEMINI_API_KEY=MISSING`
- `ELEVENLABS_API_KEY=MISSING`

The 3D generator and image generator could not produce new external assets because both required credentials are missing. Chosen sources therefore remain deterministic, project-original procedural geometry/textures plus the existing generated sky. Hero/player: existing original player/bot/weapon assets. World/sky/background: `public/assets/maps/monsoon-equirect-v4.jpg`. Materials/textures/decals: generated in runtime code with original canvas/data textures and no new third-party downloads.

Audio is integrated from existing project assets including `public/assets/audio/ambience/monsoon-wind-loop-v1.mp3`, `public/assets/audio/movement/footstep-mud-v1.mp3`, and `public/assets/audio/pickups/core-v1.mp3`. The audio generator could not create a new pass because `ELEVENLABS_API_KEY=MISSING`.

## Technical art

### Render budget

- World-art kit: five visible batches and two shadow submissions.
- Whole map: 93 visible + 13 shadow submissions in the deterministic audit.
- Instancing: 39,868 map instances, including 36,000 desktop grass clusters and batched rocks, beacons, signals, gates, and trim.
- Shadow atlas: 2048² desktop; mobile uses the lower authored setting.
- Current caveat: the full active-combat frame is 394 calls because character/weapon/VFX presentation is outside the map-only budget.

### VFX readability

Rain is player-relative and wind-driven, weather severity reduces sun/sky contribution, shoreline foam and wet patches establish the storm layer, and pickup/weapon emissives remain the brightest cues. Fog is bounded so the weather does not erase routes or opponent silhouettes.

## Premium visual scorecard

### Fresh-eyes review

Round-four independent score was 0.60/3 and failed every category because the submission omitted active-play/UI/performance evidence and showed primitive-dominant overviews. Round eleven was submitted to a new clean-context critic with direct Katabatic/Warsow comparison, active desktop/mobile frames, weather/landmark/route frames, and measured evidence. Final scores are recorded below after that review.

| Category | Score (0–3) | Evidence |
|---|---:|---|
| Art direction | pending | Storm-harvester archipelago language and cyan/amber navigation grammar. |
| Hero/player | pending | Active first-person weapon/hands and live opponent framing. |
| Obstacles/enemies | pending | Traversal kit, collector shell, gates, cover, and bots. |
| Rewards/interactables | pending | Flux Core, pickup rings, pads, and HUD states. |
| World/environment | pending | 960 × 800 terrain, ocean, shoreline, anchors, vegetation, weather. |
| Materials/textures | pending | Terrain PBR, wet clearcoat, concrete atlas/bump, decals and puddles. |
| Lighting/render | pending | Map rig, contact shadows, fog, bloom/grade, SMAA, storm response. |
| VFX/motion | pending | Plasma shot, pickups, rain, wind-reactive foliage, ocean, weather. |
| UI/HUD | pending | Desktop and portrait active-play captures. |
| Performance evidence | pending | Renderer and map-only budgets above. |

Average: pending. Automatic failures: pending final fresh-eyes review. The report does not claim a strict visual pass until every category is at least 2 and the average is at least 2.3.
