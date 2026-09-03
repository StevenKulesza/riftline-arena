# QuickSense concept gauntlet

Status: **PASS — complete**

Reference: the user's `1-Pasted-Image-1.jpg` canyon/outpost concept (2026-09-03).

Deterministic hero review:

`http://127.0.0.1:5271/?map=quicksense&mapSeed=450600&qa=capture&qaState=quicksense-tower-concept-overview`

The result is an in-game, collision-safe translation of the reference rather than a literal replacement of the project's existing tower and fighter assets.

## Final visual acceptance

The final fresh independent critic returned **PASS**:

> The tightened central tower dominates cleanly, while continuous layered viaducts, faceted canyon walls, varied terrain, desert dressing, and atmospheric depth create a convincing, artifact-free playable translation.

The closing loop also found and fixed three presentation defects before acceptance: a redundant procedural signal crown above the imported tower, an off-frame command-ark wing beneath the left route, and terrain-buried access-apron fragments. The final 1280×832 hero frame contains the complete imported antenna silhouette, a continuous tower ramp, readable sky saddle, and no detached or clipped hero geometry.

## Concept translation delivered

- The real imported outpost tower is scaled as a monumental, gameplay-collidable centerpiece with four aircraft pads, dark graphite shells, terracotta identity panels, cyan systems, and a clean terrain-seated foundation.
- A north skyline viaduct, looping side routes, cross-basin bridges, transit stations, route supports, cliff habitats, and distant industrial structures reproduce the reference's stacked traversal hierarchy.
- Eight terrain strata, authored macro mesas, broad canyon saddles, faceted terrain normals, angular ridge fields, talus, and clustered polyhedral outcrops replace the previous smooth, open bowl.
- Warm sandstone/iron-rock surfaces, dark industrial decks, restrained cyan/amber navigation lights, a desert panorama, warm key light, cool rim, and long atmospheric fog provide the reference's orange/graphite/cyan value structure.
- Boulders, talus, cacti, scrub, dust, beacons, station anchors, and secondary stones are distributed across all four quadrants while preserving ski lines, spawns, pickups, ramps, and entrances.
- The command ark remains available as a distant map landmark but is repositioned outside the deterministic hero crop; only intentional connected skyline infrastructure remains in view.

## Final measured population

Seed `450600`, production arena constructor, real `outpost-tower-fxb.glb`:

| Component | Count |
| --- | ---: |
| Boulder anchors | 18 |
| Angular outcrop clusters | 18 |
| Companion rocks | 146 |
| Scrub tufts | 110 |
| Cactus clusters | 10 |
| Dust patches | 44 |
| Basin beacons | 5 |

Total map render geometry: **375,412 triangles**.

Exact desert collision tree: **10,356 visible triangles / 204 solid instances**, with **0 broad-proxy fallbacks**. Dust and scrub remain decoration-only; stone, cacti, and beacons use visible-triangle projectile and player-capsule contact.

## Verification

- `npm run build`: **passed**. Vite reports only the existing advisory for the application chunk exceeding 900 kB.
- `npx playwright test -c playwright.quicksense-unit.config.ts`: **5 passed**.
- `git diff --check`: **passed**.
- Live 1280×832 browser review: **passed**, including hero overview, ground-depth, and tower exterior angles.
- Runtime console: **clean**; only Vite connection debug messages were present.

The geometry suite loads the real GLB and verifies distributed hierarchy, closed boulder/outcrop surfaces, route and spawn clearance, terrain-normal dust alignment, exact collision accounting, projectile surface hits, player-capsule response, and alternate-seed construction.
