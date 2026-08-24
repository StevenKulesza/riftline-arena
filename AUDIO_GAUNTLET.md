# Riftline Arena Weapon Audio Gauntlet

## Quality bar

- **Reference:** *THE FINALS* by Embark Studios.
- **Primary source:** [MAKING THE FINALS | Episode 1 | Capturing Authentic Sound](https://youtu.be/zds54ehEFkE)
- **Gameplay source:** [THE FINALS | Season 1 | Launch Trailer](https://youtu.be/D_-sYUHyhAw)
- **Decision:** loudness-matched, blind A/B comparison of individual assets and captured in-game sequences.

## Reference ledger

| Reference | Status | Use |
| --- | --- | --- |
| Three.js Audio Generator `SKILL.md` | Loaded | Credential, generation, integration, and reporting requirements |
| `references/audio-workflows.md` | Loaded | Audio matrix, prompting, runtime, and verification requirements |
| THE FINALS authentic-sound episode | Selected | Transient, body, mechanical detail, and environmental tail bar |
| THE FINALS Season 1 launch trailer | Selected | Dense arena-mix readability bar |

## Live status

| Phase | Status | Evidence |
| --- | --- | --- |
| Baseline repository audit | Complete | Seven weapons plus impacts, confirms, pickups, movement, damage, and death mapped |
| Baseline build | Pass | `npm run build` |
| ElevenLabs credential probe | Complete | Initial literal output: `ELEVENLABS_API_KEY=MISSING`; local `.env` retry: `ELEVENLABS_API_KEY=SET` |
| Credential validation | Partial | SFX generation is authorized; the account `/user` probe returns 401 because the key has no `user_read` scope |
| Weapon/ammo audio matrix | Complete | Seven weapon families plus projectile impacts, armor/body damage, confirms, dry-fire, equip, movement, death, and eight pickup families |
| Asset generation | Complete | 69 purpose-generated ElevenLabs MP3 cues under `public/assets/audio/` |
| Asset mastering | Complete | Family loudness targets, 44.1 kHz stereo/128 kbps delivery, true-peak ceiling, untouched renders retained in ignored artifacts |
| Runtime asset integration | Complete | Sample-only pools, groups, HRTF world fire/impacts, voice caps, unlock, pause, mute, and diagnostics; no synthesized fallback |
| Harsh blind critic | Blocked | Official metadata/captions loaded; YouTube media requests return HTTP 403, so no listening result is claimed |
| Browser/build verification | Pass | Production build and 2/2 Chromium audio lifecycle/policy tests pass; 69/69 assets decode |

## Delivered P0 asset matrix

| Family | Variants | Intended duration |
| --- | ---: | ---: |
| Machine / shotgun / rocket / plasma / laser / sniper / rail fire | 22 | 0.5–1.5 s |
| Rocket explosion / plasma impact / armor hit | 10 | 0.6–1.8 s |
| Hit / elimination confirmations | 4 | 0.5–0.6 s |
| Empty trigger / light, heavy, precision equip | 6 | 0.5–0.8 s |
| Ballistic, energy, rocket, and rail ammo acquisition | 8 | 0.7–1.0 s |
| Jump / light landing / heavy landing | 6 | 0.5–0.7 s |
| Player damage / combat-frame death | 5 | 0.6–1.0 s |
| Health / armor / boost / Flux Core pickups | 8 | 0.7–1.0 s |

Generation prompts, durations, influence values, and output format are reproducible in `scripts/generate-weapon-audio.sh`. Mastering targets are recorded in `scripts/master-weapon-audio.sh`; all 69 delivery clips were loudness-normalized with a -2 dB true-peak ceiling, while untouched ElevenLabs renders are preserved in ignored artifacts. `rocket-launch-v1.mp3` remains in the generated set but is intentionally excluded from runtime selection because objective measurement found it approximately 9 dB quieter than its sibling variants.

## Exit condition

Do not call the audio pass complete until generated files exist under `assets/audio/`, every mapped gameplay event is verified in-browser, and a fresh critic picks Riftline Arena over the reference in a blind comparison or documents the exact remaining blocker.
