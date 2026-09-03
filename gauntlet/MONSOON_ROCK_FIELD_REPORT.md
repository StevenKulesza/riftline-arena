# Monsoon rock-field pass

## Technical art brief

Keep the existing tropical highland palette. Replace repeated faceted blobs with six geological silhouettes, each with two seeded variants: weathered block, bedded slab, split fin, rounded corestone, talus wedge, and broken outcrop. Compose primary outcrops, secondary blocks, cobbles, and rubble in asymmetric downhill fans, leaving open ground between groups. Primary forms carry the detail; tiny rubble uses simpler shared meshes.

All assets remain project-original procedural geometry/textures, per the user's explicit procedural-only direction. The 3D/image generator skills were inspected; external generation is intentionally not used under that direction, not skipped for missing credentials. No credential probe or paid generation is needed.

Budget: retain approximately 1,400 rocks; at most 48 shared instanced batches, one opaque PBR material, three small shared surface textures, and ~115k total rock triangles at the planned tier mix (previous field: 112k). No additional lights or post passes. Only the two larger tiers cast static shadows. Keep CPU generation out of the frame loop. Preserve terrain support, ski-route margins, CTF base clearances, and existing structural approaches across the entire rock footprint.

## Verification

- `npm run test:performance-unit`: **26 passed**. Five rock-specific contracts cover finite/distinct models and detail tiers, repeatable field hierarchy, terrain seating and route/base margins, predominantly downhill debris, safe omission when no placement is possible, and actual world-art/outpost/stair footprints. The structural test also checks every transformed mesh vertex against its protected footprint radius.
- `npm run build`: **passed** after the final runtime changes. Vite reports its existing large-chunk advisory. Concurrent edits briefly produced unrelated `Game.ts` / `QuickSenseArena.ts` errors during earlier checks; those files were not modified by this pass.
- `git diff --check`: passed.
- Runner caveat: an earlier superseded version of the structural test used an assertion per vertex and remained unresponsive in session `31590`. Interrupting it did not confirm termination, and the restricted environment denied signaling its worker. The current test reduces each mesh to one maximum-radius assertion and the fresh complete suite finishes in ~8 seconds; its 26-pass result is the verification cited above.
- Seed `450600`: **56 fields / 1,400 rocks**, split into 56 anchors, 224 companions, 392 cobbles, and 728 rubble pieces. Both the isolated field and the actual world-art/outpost/stair fixture retain the full population. The fixture does not instantiate every Arena subsystem.
- Geometry: **114,240 total rock triangles**, versus 112,000 previously (+2%). The four detail tiers use 500 / 180 / 80 / 20 triangles per rock. Budget is deliberately spent on the larger silhouettes.
- Rendering: **48 maximum instanced batches**, versus three previously; **24 shadow-casting batches**. One opaque shared PBR material and three 128×128 shared generated textures. This increases submissions despite the nearly unchanged triangle total. No new runtime lights, render passes, per-frame generation, or per-rock updates.
- Collision: 280 simplified solid-core AABBs, derived from rotated geometry bounds for the two large tiers. These are conservative gameplay cores, not exact rock hulls.
- Visual inspection: reviewed the six-family/twelve-variant catalog and field/ground views in the local browser. The first iteration looked too box-like; softened mass exponents, asymmetric erosion, narrower fins, creased fracture normals, and more restrained mineral colors were revised after that review. Preview warnings/errors were empty at that inspection.
- Inspection entry point: `scripts/rock-field-preview.html?qa=1&mapSeed=450600`. Uses production rock geometry/materials and terrain sampling, but simplified inspection lighting and terrain material; it is **not a full-game screenshot**. After initial timeouts, the actual game's `qaState=monsoon-overlook` capture succeeded: `shots/r69-monsoon-full-map.jpg`. The user reviewed this full-map view and approved the pass. `shots/r69-monsoon-boulder-field.jpg` remains the isolated rock study. A complete gameplay playtest is not claimed.

Live FPS remains a separate, unverified gate; do not use this model pass as evidence of a >35 FPS 1% low. Mobile visual QA, whole-Arena placement diagnostics, and a fresh hardware profile remain open. No visual score or AAA completion claim is made.

## Reference ledger

Read in full: graphics-builder SKILL.md; implementation-blueprint.md; model-recipes.md; render-recipes.md; technical-art.md; visual-scorecard.md; procedural-model-quality.md; material-lighting-quality.md; performance-safe-visual-detail.md; 3D-generator and image-generator SKILL.md.

This is a focused world-prop pass, not a claim that the whole game passes an AAA scorecard.

## Main-branch publication checks

The exact staged source was exported to an isolated directory with `git checkout-index` and checked independently of unrelated working-tree edits. Production build passed (1,973.13 kB JS / 580.73 kB gzip; existing large-chunk advisory), and all 26 performance/geometry contracts passed in 5.6 seconds. Staged whitespace checks passed. Vite retains the existing relative base and GitHub repository-prefix support. The commit excludes in-progress QuickSense, Bipbeta2, menus, and match-mode changes.

QA/release references read in full for this publication: `threejs-qa-release/SKILL.md`, `references/qa-release-checklists.md`, and `references/checklists/release.md`. Existing visual harness retained; new screenshot baselines and bot playtests were not run for this Git-only publication. No production deployment or fresh mobile/hardware-FPS pass is claimed.
