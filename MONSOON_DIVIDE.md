# Monsoon Divide

Monsoon Divide is Riftline's deterministic, procedural outdoor movement arena. It is built for high-speed skiing, ramp chaining, air control, and readable combat rather than corridor traversal.

## Reproduce the map

- Canonical runtime seed: `?mapSeed=450600`
- Generation version: `8`
- Play space: `960 × 800` metres
- Base terrain: `120 × 100` cells / `24,000` low-poly triangles
- Runtime diagnostics: `window.__THREE_GAME_DIAGNOSTICS__.map`
- Deterministic QA states: `monsoon-overlook`, `monsoon-grassland`, `monsoon-structure`, `monsoon-ramp`, `monsoon-damage`, and `monsoon-weather`

## Movement layout

Two continuous cross-island ski grades thread three connected, asymmetric ridgelines through the central recovery bowl. Layered upper benches, broad foothill shelves, carved side valleys, unequal escarpments, and an irregular bay-and-headland coastline replace the former compact ring of isolated massifs. Six concrete launch zones, six jump pads, route gates, a two-way underpass, and two enterable relay structures create alternate lines without turning the map into a hallway network. Authored crowns, secondary shoulders, saddles, and banked approaches let a descent store the momentum needed for the opposing climb. Terrain support, route dressing, prop placement, and projectiles now share the exact piecewise-triangle surface; the 24,000-triangle parity gate holds height error below `0.1 mm` and face-normal agreement above `0.99999`.

Fifteen spawns sit 6–14 m off the nearest bunker, gate, or ridge shoulder rather than on open flats. Low concrete cover (1.2–1.5 m) stands 4–8 m from every pickup and three 5–6 m mid-bowl fragments break the crater through-lines. The irregular cliff coast, animated ocean, wind-broken foam, and hard arena bounds close the play space without a rectangular perimeter wall.

Substantial faceted rocks, gate columns, reactor/tower bases, and every structural wall are solid capsule colliders. Ambient animal routes resolve against the same collision set.

## Rendering and authored procedural assets

- Equirectangular storm-break sky: `public/assets/maps/monsoon-equirect-v4.jpg`, with weather-severity exposure response
- Smooth terrain normals with height/slope-driven forest, soil, blue-slate cliff, crater, and coast colors
- Procedural detailed dirt and concrete texture atlases
- Dense foliage: 36,000 instanced grass clusters on desktop (`12,000` on coarse-pointer/mobile devices), plus mixed weed and seed-head layers
- GPU vertex wind and local player push interaction for grass and weeds
- Instanced rocks, route gates, navigation strips, storm puddles, shoreline foam, rain, birds, beetles, and structural trim
- Six silhouette-distinct storm-harvester/relay anchors, a central collector complex, 39 layered basalt stormbreaks, and 76 cyan/amber route signals in five visible world-art batches
- Five skinned low-poly grazers with articulated spine, head/neck, tail, hips, and knees

The sky panorama was generated with the built-in image generator from an original prompt for a bright cel-shaded archipelago storm break. All terrain, textures, foliage, structures, creatures, effects, and collision are project-original procedural assets.

## Surface response

- Soil: synthesized granular crunch footsteps and alternating persistent tread marks
- Grass: physically lit blades with wind and proximity bending
- Concrete: procedural aggregate/panel texture and pooled persistent fracture decals from hitscan, laser, grenade, rocket, and plasma impacts
- Weather: cyclic localized shower front, changing wind strength, player-relative wind-driven rain, animated ocean, and sun shafts that strengthen between showers

## Performance rules

Foliage and repeated props use spatially culled instancing. The world-art kit adds five visible calls plus two silhouette-critical shadow submissions; the round-eleven map audit records 93 visible and 13 shadow submissions for 494,722 map triangles and 39,868 instances. Normal gameplay resolves geometry edges with SMAA after bloom/grade. The 120 Hz simulation permits four catch-up steps so the supported 30 FPS floor advances in real time. Map screenshots and automated QA must use `?qa=1&mapSeed=450600`; software-rendered SwiftShader runs are valid for pixel/budget checks but not FPS claims.
