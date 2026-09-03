# Monsoon Divide AAA pass — director report

## Game design brief

Monsoon Divide is a 3,840 × 3,200 m, high-speed outdoor arena built around Tribes-style gravity skiing and route conversion, with Warsow-style combat decisions at gates, ramps, bunkers, and pickups. The intended fantasy is a storm-harvesting archipelago installation: wet blue-slate terrain, moss/soil ski grades, six silhouette-readable industrial anchors, a central collector complex, and a weather front that changes presentation without hiding combat.

## Tropical biome follow-up

- Removed every imported tree, fern, shrub, and billboard asset from the runtime and repository; Monsoon's vegetation is now fully project-original procedural geometry and runtime-generated texture work.
- Added four layered rainforest broadleaf/emergent tree families and two lowland palm families with secondary branching, alpha-tested individual leaves, procedural bark, buttress roots, habitat-aware placement, 9–44 m canopy strata, and subtle GPU wind.
- Expanded the authored desktop biome to 1,400 trees, 3,200 shrubs, 11,700 ferns, 29,000 grass clusters, 2,200 weeds, and 1,400 boulders while retaining stronger tree/shrub exclusions around CTF base aprons and primary ski grades.
- Prior vegetation QA: build, desktop/mobile biome tests, the enterable-bunker regression, and the outpost tests passed; the pre-existing southwest launch-speed test still failed. Pre-fix callback timings were desktop 68.31 average / 24.70 1% low and mobile 100.02 / 83.52. The profiler counted skipped-render callbacks, so these are historical callback metrics, not verified delivered-frame guarantees. The new ground-cover and pacing fix passed its initial build and 21 offline contracts. Final full-workspace build is blocked by concurrent, incomplete CTF edits; fresh hardware and visual verification remain pending. See [frame-pacing report](MONSOON_FRAME_PACING_REPORT.md).

## Core loop

Latest focused rock pass: six geological forms × two seeded variants replace the old three-family scatter. Four size/detail tiers compose 56 downhill fields, with full-footprint structural clearance. The isolated field is 1,400 rocks / 114,240 triangles / 48 instanced batches; this is not a fresh FPS result. See [rock-field report](MONSOON_ROCK_FIELD_REPORT.md) for current verification and inspection captures.

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
- Added SMAA after color grading for normal play and removed the costly broad bloom pass from the dense outdoor scene.

### UI

- Captured the existing full desktop HUD and portrait mobile controls in deterministic active combat. The mobile layout exposes health, armor, weapon/ammo, movement, fire, jump, ski, hook, dash, grenade, swap, alt, view, board, and virtual stick without hiding the target lane.

### Debug/profile

- Visual test harness: `gauntlet/shots/capture-critic.mjs` captures deterministic desktop/mobile overview, route, landmark, weather, and active-combat states and writes `gauntlet/shots/critic-measurements.json`.
- Measured evidence: map occupancy 806/806 samples and a 911.801 m sampled vertical range across the 3,840 × 3,200 m world footprint.
- Arena render audit: 93 visible draws + 13 shadow draws, 494,722 triangles, 39,868 instances. Full active-combat evidence: 394 calls and 931,184 triangles including a 75,502-triangle first-person weapon.

### QA/release

- `npm run build` passes; Vite only reports the pre-existing large-chunk advisory.
- Focused desktop geometry/flow/cover/fog/lighting/world-art suite passes with one intentionally skipped rock-tunneling probe.
- Desktop and mobile project coverage passed in the earlier combined focused run.
- Latest procedural-biome captures have zero console errors and zero page errors.
- Screenshot evidence: `gauntlet/shots/r68-monsoon-tropical-canopy.png`, `r68-monsoon-fern-detail.png`, `r68-monsoon-procedural-palm-grove.png`, and `r68-monsoon-bounds-high.png`.

## Physics engine

The runtime uses custom fixed-step capsule movement and ray/triangle queries accelerated by `three-mesh-bvh`; it does not use a separate rigid-body engine. Timestep is 1/120 s with a four-step frame catch-up cap. Static terrain, ramp geometry, collider boxes, and authored world-art anchor colliders are merged into the BVH. Exact 96,000-triangle parity checks require height error below 0.1 mm and face-normal dot above 0.99999.

## External asset sourcing

### Credential probe output

- `TRIPO_API_KEY=MISSING`
- `GEMINI_API_KEY=MISSING`
- `ELEVENLABS_API_KEY=MISSING`

The external 3D generators could not produce new assets because their credentials were missing. The final vegetation direction does not depend on those services: all trees, palms, shrubs, ferns, grasses, weeds, and boulders are generated by deterministic project code. The existing generated sky remains `public/assets/maps/monsoon-equirect-v4.jpg`.

Audio is integrated from existing project assets including `public/assets/audio/ambience/monsoon-wind-loop-v1.mp3`, `public/assets/audio/movement/footstep-mud-v1.mp3`, and `public/assets/audio/pickups/core-v1.mp3`. The audio generator could not create a new pass because `ELEVENLABS_API_KEY=MISSING`.

## Technical art

### Render budget

- World-art kit: five visible batches and two shadow submissions.
- Full active-play hardware frame: 710 renderer calls and 7,599,257 triangles at adaptive DPR 0.875 in the final desktop profile.
- Instancing: the desktop biome includes 29,000 grass clusters, 2,200 weeds, 11,700 procedural ferns, 3,200 procedural shrubs, 1,400 procedural trees/palms, and 1,400 boulders, with repeated route props and trim also batched.
- Shadow atlas: 2048² desktop; mobile uses the lower authored setting.
- Current caveat: the full frame includes character, weapon, VFX, and distant-world presentation outside the vegetation budget; the strict desktop 1% low gate remains open despite the sustained average clearing 65 FPS.

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
| World/environment | pending | 3,840 × 3,200 terrain, ocean, shoreline, anchors, vegetation, weather. |
| Materials/textures | pending | Terrain PBR, wet clearcoat, concrete atlas/bump, decals and puddles. |
| Lighting/render | pending | Map rig, contact shadows, fog, bloom/grade, SMAA, storm response. |
| VFX/motion | pending | Plasma shot, pickups, rain, wind-reactive foliage, ocean, weather. |
| UI/HUD | pending | Desktop and portrait active-play captures. |
| Performance evidence | pending | Renderer and map-only budgets above. |

Average: pending. Automatic failures: pending final fresh-eyes review. The report does not claim a strict visual pass until every category is at least 2 and the average is at least 2.3.
