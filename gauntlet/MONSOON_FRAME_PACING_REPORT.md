# Monsoon strict 1% low follow-up

## Status

Performance implementation and offline contracts pass. **The >35 FPS delivered-frame 1% low target is not yet verified.** No new hardware FPS number is claimed. Early full-workspace checks were blocked by concurrent CTF work, which was preserved. The subsequent Monsoon-only publication snapshot builds successfully and passes all 26 current contracts; see `MONSOON_ROCK_FIELD_REPORT.md` for the staged-source checks and approved full-map screenshot.

## Evidence and changes

- Historical production artifact: `artifacts/performance/monsoon-all-procedural-jungle-65-desktop.json`, Apple M4, 1280×720, 12 s. Callback average 68.31 FPS, strict callback 1% low 24.70 FPS, 710 draws, 7,599,257 triangles, DPR 0.875.
- The saved loop trace contains 36.4–45.6 ms render submissions. Its slow-callback records sampled the *next* game's work, which previously obscured these render stalls. Some update stalls also exist; without a fresh CPU/GPU trace their cause remains unproven.
- Small ground cover was submitted in up-to-640 m batches. It now uses static 128 m cells, shared original geometry/materials, and per-plant fade bands: grass 120–220 m, weeds 180–320 m, ferns 240–400 m, shrubs 480–720 m. Bounds include instance roots, geometry overhang, and wind margin; scoped FOV extends ranges. No placements are resampled, thinned, or moved. Trees and boulders are unchanged. The distant understory is intentionally less detailed; nearby detail is unchanged.
- Dynamic quality previously considered only CPU submission cost. It now includes delivered intervals, uses elapsed-time windows, reacts to repeated >28.57 ms frames, tolerates healthy 60 Hz presentation, and requires eight seconds of recovery headroom. Isolated scheduling gaps still do not cause a downshift.
- Profile schema 3 measures actual game-render timestamps. Skipped high-refresh callbacks no longer inflate average or 1% low FPS. Raw callback metrics remain separately available. The slowest-1%-mean calculation and strict hardware gate were not weakened.
- Instanced buffers are disposed on map teardown; cell updates do not rewrite instance matrices.

## Verification

- `npm run build`: initial pass (~1.99 MB JS / 586 kB gzip, existing bundle advisory). Final rechecks blocked while concurrent CTF changes were in flight; the last check reported missing `areFriendlyOwners` / `chooseCaptureTheFlagObjective` and unused match-mode/flag declarations in `Game.ts`. These unrelated edits were not changed.
- `npm run test:performance-unit`: 21 passed, covering stall sensitivity, false recovery prevention, display cadence, actual-render accounting, complete placement preservation, culling/restoration, scoped visibility, boundary safety, and shader-hook composition.
- `git diff --check`: pass.
- New GPU profile: blocked. Starting a local production listener returned EPERM in this session; privileged live browser profiling permission was declined. The existing development URL subsequently stopped responding. No alternate privileged profiling path was attempted.
- New visual/gameplay regression: pending; the previous r68 screenshots are pre-fix evidence only.

Production recheck (run locally with server/browser permissions):

```sh
npm run build
node scripts/profile-performance.mjs --map monsoon --target 35 --duration 30000 --warmup 8000 --label monsoon-1percent35-fixed
node scripts/profile-performance.mjs --map monsoon --target 35 --duration 30000 --warmup 8000 --combat --fly --fire-weapon machine --label monsoon-1percent35-combat
node scripts/profile-performance.mjs --map monsoon --target 35 --duration 30000 --warmup 8000 --mobile --label monsoon-1percent35-fixed
```

Review the PNGs plus near/far foliage transitions and scoped views. Require repeatable actual-render 1% lows above 35, no console/page errors, and preserved navigation/CTF clearance. These commands are pending, not executed passes.

## Reference ledger

All below were read in full; no required reference was skipped.

| Read | Skill-relative path | Use |
| --- | --- | --- |
| Yes | threejs-debug-profiler/references/debug-profile-checklists.md | Baseline, owner isolation, CPU/GPU distinction |
| Yes | threejs-debug-profiler/references/checklists/performance-profile.md | Draw/resource and frame-tail analysis |
| Yes | threejs-debug-profiler/references/checklists/scene-debugging.md | Frame loop, render sizing, shader ownership |
| Yes | threejs-qa-release/references/qa-release-checklists.md | Build, strict evidence, residual risks |
| Yes | threejs-qa-release/references/checklists/visual-verification.md | Visual recheck requirements; live check blocked |
| Yes | threejs-aaa-graphics-builder/references/checklists/material-lighting-quality.md | Preserve lighting/material character; visual check remains pending |
| Yes | threejs-aaa-graphics-builder/references/checklists/performance-safe-visual-detail.md | Shared resources, LOD, disposal, and stress-case recheck |

Existing visual harness retained; no baselines refreshed without rendering. Bot playtest skipped: this is a targeted rendering/pacing change, with no release-ready gameplay claim. No deployment performed. Files changed in this follow-up: `GroundCoverCulling.ts`, Arena integration, quality controller/Game integration, Loop timing, profiler, performance unit config/tests, timing types, package script, and these reports. Other in-progress map/menu/lighting work was preserved.
