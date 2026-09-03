# Bipbeta2 procedural gauntlet report

## Scope

This is a project-owned procedural reconstruction of the Bipbeta2 movement read. The public Bipbeta2 archive and gameplay video were used as references; the original `.pk3`, BSP, textures, and models were not imported. The goal of this pass is to reproduce the playable room graph, landmark order, fast routes, and visual language inside the existing Three.js game. The current authored revision is generation version 8.

Reference evidence retained in `gauntlet/shots/`:

- `bipbeta2-reference.png` — direct gameplay frame: left energy waterfall, central stacked opening, right vertical lights, broad charcoal balcony, tiled lower floor, and right-wall zero.
- `bipbeta2-reference-frame-01..03.png` — narrow curved movement spaces, purple arches, tiled approach, stacked openings, and the red-marked zero.
- `bipbeta2-reference-route-20pct.png` — lower run with dark cover, sloped transfer, distant stacked wall, and red-marked zero.
- `bipbeta2-reference-route-40pct.png` — broad room with repeated luminaires, diagonal/curved purple structure, and multi-level ledges.
- `bipbeta2-reference-route-60pct.png` — open tiled lower apron with a long purple lane and low transfer geometry.
- `bipbeta2-reference-route-80pct.png` — upper return with layered balcony bands, curved wall, and repeated light bays.
- `bipbeta2-hero-final-v8.png`, `bipbeta2-lower-route-final-v9.png`, and `bipbeta2-overlook-final-v8.png` — fresh browser captures after the smooth-shell, low-cover visual pass.
- `bipbeta2-west-tube-final-v8.png` and `bipbeta2-energy-final-v8.png` — fresh acceleration-tube and energy-gate captures after the smooth-shell pass.

The archive lookup is documented by the [public basewf archive](https://wf.inthekeep.com/files/basewf/); the movement reference is the [Warsow: Tricks in Bipbeta video](https://www.youtube.com/watch?v=EJBcSdTaa-w).

## Reconstructed layout and flow

The map is a sealed 240 x 192 indoor course with a recessed center, perimeter galleries, high cross routes, mirrored end approaches, and two parallel enclosed acceleration tubes. The authored movement graph is exposed as `group.userData.movementFlow` and tested through the browser hook.

| Route | Entry → exit | Intended read |
| --- | --- | --- |
| West accelerator tube | `(-38,0,-68)` → `(-38,0,66)` | Build speed through the long tube, strike the rear wall, return into the opposite deck |
| East accelerator tube | `(38,0,68)` → `(38,0,-66)` | Mirrored high-speed decision and return |
| West jumper | `(-38,0,-63)` → `(-38,10,-48)` | First of exactly two primary jumpers; feeds west tube |
| East jumper | `(38,0,63)` → `(38,10,48)` | Second primary jumper; feeds east tube |
| North gallery return | `(-84,6,-57)` → `(84,6,-57)` | High perimeter crossback |
| South gallery return | `(84,6,57)` → `(-84,6,57)` | Mirrored high perimeter crossback |
| Lower decks | `x=-76 ↔ 76`, `z=±61` | Fast ground-level crossings between tube mouths |

The visual facade follows the same ordered composition as the reference: left white energy gate in a rounded purple arch → compact dark stacked transfer opening with four receding gallery levels → three tall black/white light bays → red-bracketed oversized zero. A broad charcoal balcony separates that upper read from the lower tiled movement deck. Both accelerator tubes now carry exterior violet wall bands so the fast lane remains legible from the lower apron.

The latest route dressing adds a dark lower cover mass, an authored sloped transfer, curved service braces, and a lane-aligned lower QA view. The full-map overlook is intentionally a cutaway QA camera; it verifies the graph and vertical layering, not a claimed source screenshot match.

## Landmark coverage matrix

| Reference area | Procedural coverage | QA state |
| --- | --- | --- |
| Left waterfall gate | Opaque white/cyan waterfall, black recess, rounded purple jambs and arch | `bipbeta2-energy` |
| Central stacked opening | Five purple shelf bands, four white shelf lights, rounded posts, inset service windows, four receding gallery decks, deep back wall | `bipbeta2-stack`, `bipbeta2-hero` |
| Upper balcony | Continuous charcoal parapet with purple lip | `bipbeta2-hero`, `bipbeta2-catwalk` |
| Right light rhythm | Three evenly spaced tall dark housings with proud white faces and lower controls | `bipbeta2-hero`, `bipbeta2-lights` |
| Right wall marking | Large white torus zero with two magenta/red vertical surrounds | `bipbeta2-lights` |
| Lower floor | Repeating pale concrete tile/grid, purple route edges, recessed central shaft | `bipbeta2-hero`, `bipbeta2-overlook` |
| Paired acceleration tubes | Two long procedural cylindrical shells, circumferential ribs, longitudinal rails, overhead bands, rear target rings, collision flanks and caps | `bipbeta2-tubes`, `bipbeta2-west-tube`, `bipbeta2-east-tube` |
| Jump/return flow | Exactly two launch pads plus explicit movement-flow metadata and mirrored gallery returns | `bipbeta2-jumper`, `bipbeta2-overlook` |

## Gauntlet loop

1. Baseline rejected: an open white slab did not read as Bipbeta2.
2. Indoor rebuild rejected: generic tunnel framing and actors obscured the room structure.
3. Composition pass rejected: the near parapet became a black wall and the landmark order was unreadable.
4. Flow pass added the two defining enclosed tubes, rear-wall caps, route rails, two jumpers, and mirrored returns.
5. Facade pass matched the observed order and repeated light rhythm; the right zero was moved into the readable wall composition.
6. Cutaway QA pass added the real full-map overlook and blind recaptured hero, overlook, energy, stack, lights, tube, and jumper views.
7. Source-frame comparison rejected a flat central opening; the transfer was rebuilt with real setbacks, tiered decks, and a back wall.
8. Source-frame comparison rejected a clipped light/zero sequence; facade spacing was tightened to keep all three luminaires and the zero in the hero frame.
9. Lower-route comparison rejected a wall-dominated camera; the QA rig was lowered and aligned to the purple lane, then exterior tube bands were added for route continuity.
10. Ceiling comparison rejected the visible square-grid roof; the roof became a smooth concrete shell with three sparse transverse purple crown bows, while retaining the source-like ceiling fixtures.
11. Hero composition rejected black foreground pillars; the shaft retaining walls and service pillars were lowered to combat-cover height so the room reads open at player eye level.

## Verification

- `npx vite build` — passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` on the Bipbeta2 implementation — passed.
- Browser visual captures — completed through the connected browser runtime.
- Fresh evidence was captured after the v8 visual pass and copied into `gauntlet/shots/`; invalid menu/inside-geometry frames were discarded.
- Asset sourcing ledger: procedural Three.js geometry/materials only. The 3D asset generator probe reported `TRIPO_API_KEY=MISSING`; the image generator probe was blocked by unavailable network access while resolving its Pillow dependency. No generated or third-party map assets were substituted.
- Shell Playwright test — attempted, but the host blocks the configured Chromium/server port before the test body; the deterministic test remains in `tests/bipbeta2.spec.ts`.
- `tests/bipbeta2.spec.ts` asserts 240 x 192 bounds, 12 grounded spawns, exactly two jump pads, exactly two 1800-speed tube nodes, altitude, route count, triangle budget, and floor samples.

## Honest fidelity gate

This pass is materially closer in room graph, movement flow, landmark order, and reference composition, but it is not a pixel-identical source-map reproduction and is not being called 1:1. Exact BSP dimensions, brush seams, original light falloff, and original assets cannot be claimed without importing the original map package. The remaining visual gap is primarily the source engine's cel-shaded material response, curved brush proportions, and exact first-person route timing; those remain isolated in the dedicated QA states above for the next comparison loop.
