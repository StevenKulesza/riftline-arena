# Monsoon Divide

Monsoon Divide is Riftline's deterministic, procedural outdoor movement arena. It is built for high-speed skiing, ramp chaining, air control, and readable combat rather than corridor traversal.

## Reproduce the map

- Canonical runtime seed: `?mapSeed=450600`
- Generation version: `13`
- Play space: `3,840 × 3,200` metres
- Base terrain: `240 × 200` cells / `96,000` triangles
- Runtime diagnostics: `window.__THREE_GAME_DIAGNOSTICS__.map`
- Deterministic QA states: `monsoon-overlook`, `monsoon-grassland`, `monsoon-structure`, `monsoon-ramp`, `monsoon-damage`, and `monsoon-weather`

## Movement layout

Two continuous cross-island ski grades thread three connected, asymmetric ridgelines through the central recovery bowl. Layered upper benches, broad foothill shelves, carved side valleys, unequal escarpments, and an irregular bay-and-headland coastline replace the former compact ring of isolated massifs. Six concrete launch zones, six jump pads, route gates, a two-way underpass, and two enterable relay structures create alternate lines without turning the map into a hallway network. Authored crowns, secondary shoulders, saddles, and banked approaches let a descent store the momentum needed for the opposing climb. Terrain support, route dressing, prop placement, and projectiles now share the exact piecewise-triangle surface; the 96,000-triangle parity gate holds height error below `0.1 mm` and face-normal agreement above `0.99999`.

Fifteen spawns sit 6–14 m off the nearest bunker, gate, or ridge shoulder rather than on open flats. Low concrete cover (1.2–1.5 m) stands 4–8 m from every pickup and three 5–6 m mid-bowl fragments break the crater through-lines. The irregular cliff coast, animated ocean, wind-broken foam, and hard arena bounds close the play space without a rectangular perimeter wall.

Substantial faceted rocks, gate columns, reactor/tower bases, and every structural wall are solid capsule colliders. Ambient animal routes resolve against the same collision set.

## Rendering and authored procedural assets

- Equirectangular storm-break sky: `public/assets/maps/monsoon-equirect-v4.jpg`, with weather-severity exposure response
- Smooth terrain normals with height/slope-driven forest, soil, blue-slate cliff, crater, and coast colors
- Procedural detailed dirt and concrete texture atlases
- Authored vegetation density zones keep primary ski routes and both CTF base aprons open while concentrating shelter groves, fern gullies, wet-slope shrubs, and talus fields in terrain-appropriate pockets
- Six project-original fern families use detailed and mass-distance pinnate geometry: `11,700` desktop instances (`2,860` mobile)
- Four procedural tropical shrub families distribute `3,200` desktop instances (`720` mobile) with multi-stem, individual-leaf silhouettes
- Six procedural tree families—four rainforest broadleaf/emergent forms and two palms—distribute `1,400` desktop instances (`360` mobile) across 9–44 m canopy layers
- Procedural alpha-tested leaf and bark atlases, buttress roots, secondary branching, species-aware lowland palm placement, and per-instance scale/yaw variation remove imported-tree repetition
- `29,000` instanced grass clusters on desktop (`9,000` mobile), plus `2,200` varied weeds and seed heads (`620` mobile)
- Six geological boulder families with two seeded variants each compose `56` asymmetric fields: `56` primary outcrops, `224` companion blocks, `392` cobbles, and `728` rubble pieces. Nominal sizes span ~0.22–26 m; fracture planes, bedding, mineral grain, and downhill debris create hierarchy while full-footprint exclusions protect ski lanes, CTF aprons, buildings, and stairs.
- GPU vertex wind animates grass, weeds, broadleaf crowns, and palm fronds; grass and weeds also respond locally to the player
- Instanced rocks, route gates, navigation strips, storm puddles, shoreline foam, rain, birds, beetles, and structural trim
- Six silhouette-distinct storm-harvester/relay anchors, a central collector complex, 39 layered basalt stormbreaks, and 76 cyan/amber route signals in five visible world-art batches
- Five skinned low-poly grazers with articulated spine, head/neck, tail, hips, and knees

The sky panorama was generated with the built-in image generator from an original prompt for a bright archipelago storm break. Terrain, structures, effects, creatures, collision, and every vegetation family are project-original procedural assets; no third-party plant meshes or texture scans are shipped for Monsoon Divide.

## Surface response

- Soil: synthesized granular crunch footsteps and alternating persistent tread marks
- Grass: physically lit blades with wind and proximity bending
- Concrete: procedural aggregate/panel texture and pooled persistent fracture decals from hitscan, laser, grenade, rocket, and plasma impacts
- Weather: cyclic localized shower front, changing wind strength, player-relative wind-driven rain, animated ocean, and sun shafts that strengthen between showers

## Performance rules

Canopy trees retain 6×5 spatial instancing. Small ground cover uses 128 m cells with gradual per-plant distance fading; all placements, species, nearby detail, trees, and boulders are retained. Scoped views extend the detail range. Normal gameplay resolves geometry edges with SMAA after color grading. The 120 Hz simulation permits four catch-up steps so the supported 30 FPS floor advances in real time. Map screenshots and automated QA must use `?qa=1&mapSeed=450600`; software-rendered SwiftShader runs are valid for pixel/budget checks but not FPS claims.

The last pre-fix Apple M4 callback profile measured `68.31 FPS` average / `24.70 FPS` 1% low on desktop. Those historical profiles counted browser callbacks, including skipped game renders, so the previous mobile `100.02 / 83.52` result is not a verified delivered-frame pass. Profile schema 3 now counts actual rendered frames and preserves the slowest-1%-mean definition. The quality controller includes delivery pacing, reacts to repeated >28.57 ms frames, and requires eight seconds of stable recovery headroom. The new **35 FPS strict 1% low gate is pending a fresh hardware run**, not claimed from unit tests. See `gauntlet/MONSOON_FRAME_PACING_REPORT.md`.
