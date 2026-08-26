#!/usr/bin/env bash
set -euo pipefail

force_generate=0
if [[ "${1:-}" == "--force" ]]; then
  force_generate=1
fi

resolve_skill_dir() {
  local candidate
  for candidate in \
    "${HOME}/.claude/skills/threejs-audio-generator" \
    "${HOME}/.codex/skills/threejs-audio-generator" \
    "${HOME}/.agents/skills/threejs-audio-generator"; do
    if [[ -f "${candidate}/scripts/threejs_audio_asset.py" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf 'Three.js Audio Generator skill not found.\n' >&2
  return 1
}

readonly SKILL_DIR="$(resolve_skill_dir)"
readonly AUDIO_TOOL="${SKILL_DIR}/scripts/threejs_audio_asset.py"
readonly AUDIO_ROOT="public/assets/audio"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

probe_output="$(python3 "${AUDIO_TOOL}" probe)"
printf '%s\n' "${probe_output}"
if [[ "${probe_output}" != "ELEVENLABS_API_KEY=SET" ]]; then
  printf 'Set ELEVENLABS_API_KEY in .env or this process, then rerun this script.\n' >&2
  exit 2
fi

generate_set() {
  local category="$1"
  local stem="$2"
  local count="$3"
  local duration="$4"
  local influence="$5"
  local prompt="$6"
  local loop_flag="${7:-}"
  local variant
  local output

  mkdir -p "${AUDIO_ROOT}/${category}"
  for ((variant = 1; variant <= count; variant += 1)); do
    output="${AUDIO_ROOT}/${category}/${stem}-v${variant}.mp3"
    if [[ -s "${output}" && "${force_generate}" -eq 0 ]]; then
      printf 'SKIP %s\n' "${output}"
      continue
    fi

    printf 'GENERATE %s\n' "${output}"
    python3 "${AUDIO_TOOL}" sfx \
      --output-format mp3_44100_128 \
      --prompt "${prompt}" \
      --duration "${duration}" \
      --prompt-influence "${influence}" \
      ${loop_flag} \
      --out "${output}"
  done
}

generate_set music riftline-monsoon-bed-clean 1 16 0.56 \
  "seamless loopable dark synth soundtrack for a futuristic arena FPS, 92 BPM, C minor, warm analog bass pulse, restrained four-on-the-floor electronic groove, wide soft synth chords, sparse repeating arpeggio, tense but clean and musical, no field recording, no wind, no rain, no static, no birds, no nature sounds, no random noise, no vocals, no sound effects, seamless loop" \
  --loop

generate_set music rift-menu-loop-clean 1 20 0.56 \
  "seamless loopable title-screen music for a premium futuristic arena FPS, 84 BPM, D minor, warm analog synthesizer chords, clean soft bass pulse, sparse four-note arpeggio, restrained drum machine tick, confident and mysterious, clearly musical and polished, no field recording, no wind, no rain, no static, no birds, no nature sounds, no random noise, no vocals, no sound effects, seamless loop" \
  --loop

generate_set movement footstep-grass 2 0.55 0.78 \
  "short first-person armored combat boot step through wet tall grass, soft blade brush and damp soil compression, readable transient, tiny natural tail, no music, no voice"

generate_set movement footstep-mud 2 0.6 0.78 \
  "short first-person armored combat boot step into heavy wet mud, sticky suction, granular dirt compression and a small wet squelch, grounded but clean, no music, no voice"

generate_set movement footstep-rock 2 0.55 0.8 \
  "short first-person armored combat boot step on sharp volcanic rock, hard sole click with a small grit skitter, dry outdoor tail, no music, no voice"

generate_set movement footstep-water 2 0.6 0.78 \
  "short first-person armored combat boot step through a shallow puddle, tight water splash and rubberized sole slap, readable under combat, no music, no voice"

generate_set movement jetpack-ignite 2 0.6 0.8 \
  "short futuristic arena jetpack ignition for an armored FPS, twin turbine cough into a hot compressed thrust burst, sharp servo latch, compact tail, no music, no voice"

generate_set movement jetpack-loop 2 1.5 0.42 \
  "seamless looping armored combat jetpack thrust, twin micro-turbines under load, hot air roar with a subtle mechanical flutter, stable intensity, no ignition click, no music, no voice, seamless loop" \
  --loop

generate_set movement jetpack-cut 2 0.55 0.8 \
  "short futuristic jetpack shutdown, compressed thrust cut, descending turbine whine and tiny cooling tick, no music, no voice"

generate_set impacts dirt-impact 2 0.7 0.78 \
  "short sci-fi projectile impact in wet packed dirt, dark soil burst, small stones and damp grit, compact punch, no weapon fire, no music, no voice"

generate_set impacts grass-rustle 2 0.65 0.76 \
  "short close impact through wet tall grass, dense blade whip, seed-head rattle and a muted earth thump, no weapon fire, no music, no voice"

generate_set impacts water-splash 2 0.7 0.78 \
  "short futuristic projectile or grenade impact in shallow rainwater, sharp splash crown, low wet body and scattered droplets, no explosion, no music, no voice"

generate_set voice armored-grunt 2 0.65 0.78 \
  "short fictional armored arena combatant exertion grunt after taking a hit, breathy strained human vocalization, no words, no scream, no recognizable real person, no music"

generate_set weapons tracer-pass 2 0.65 0.76 \
  "short sci-fi tracer round passing through open air near the listener, tight high-speed electrical zip with a thin pressure whip, subtle and positional, no impact, no gunshot, no music, no voice"

generate_set weapons tracer-near-miss 2 0.75 0.76 \
  "short hostile energy tracer near miss in a fast arena FPS, sharp left-to-right ionized whip, tiny air tear and fading hiss, no impact, no gunshot, no music, no voice"

printf 'Generated environment audio under %s.\n' "${AUDIO_ROOT}"
