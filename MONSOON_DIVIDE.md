# Monsoon Divide

Monsoon Divide is Riftline's deterministic, procedural outdoor movement arena. It is built for high-speed skiing, ramp chaining, air control, and readable combat rather than corridor traversal.

## Reproduce the map

- Canonical runtime seed: `?mapSeed=450600`
- Generation version: `5`
- Play space: `480 × 400` world units
- Base terrain: `120 × 100` cells / `24,000` low-poly triangles
- Runtime diagnostics: `window.__THREE_GAME_DIAGNOSTICS__.map`
- Deterministic QA states: `monsoon-overlook`, `monsoon-grassland`, `monsoon-structure`, `monsoon-ramp`, `monsoon-damage`, and `monsoon-weather`

## Movement layout

Two continuous cross-island ski grades thread three connected, asymmetric ridgelines through the central recovery bowl. Layered upper benches, broad foothill shelves, carved side valleys, unequal escarpments, and an irregular bay-and-headland coastline replace the former compact ring of isolated massifs. Six concrete launch zones, six jump pads, route gates, a two-way underpass, and two enterable relay structures create alternate lines without turning the map into a hallway network. Authored crowns, secondary shoulders, saddles, and banked approaches let a descent store the momentum needed for the opposing climb. Terrain, ramps, platforms, and structures expose analytic floor height/normal queries; projectile traces use the merged BVH collision surface.

Substantial faceted rocks, gate columns, reactor/tower bases, and every structural wall are solid capsule colliders. Ambient animal routes resolve against the same collision set.

## Rendering and authored procedural assets

- Bright equirectangular sky/ocean backdrop: `public/assets/maps/monsoon-sky-v1.png`
- Smooth terrain normals with height/slope-driven forest, soil, blue-slate cliff, crater, and coast colors
- Procedural detailed dirt and concrete texture atlases
- Dense foliage: 52,000 instanced clusters / 468,000 short grass blades on desktop, plus 3,600 mixed weed and seed-head instances
- GPU vertex wind and local player push interaction for grass and weeds
- Instanced rocks, route gates, navigation strips, sun shafts, rain, birds, beetles, and structural trim
- Five skinned low-poly grazers with articulated spine, head/neck, tail, hips, and knees

The sky panorama was generated with the built-in image generator from an original prompt for a bright cel-shaded archipelago storm break. All terrain, textures, foliage, structures, creatures, effects, and collision are project-original procedural assets.

## Surface response

- Soil: synthesized granular crunch footsteps and alternating persistent tread marks
- Grass: physically lit blades with wind and proximity bending
- Concrete: procedural aggregate/panel texture and pooled persistent fracture decals from hitscan, laser, grenade, rocket, and plasma impacts
- Weather: cyclic localized shower front, changing wind strength, wind-driven rain, animated ocean, and sun shafts that strengthen between showers

## Performance rules

Foliage and repeated props use instancing. The desktop grass field is one draw call and each blade is one triangle. Map screenshots and automated QA must use `?qa=1&mapSeed=450600`; software-rendered SwiftShader runs are valid for pixel/budget checks but not FPS claims.
