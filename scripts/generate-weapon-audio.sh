#!/usr/bin/env bash

set -euo pipefail

force_generate=0
if [[ "${1:-}" == "--force" ]]; then
  force_generate=1
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--force]\n' "$0" >&2
  exit 64
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
  printf 'Set ELEVENLABS_API_KEY in this process, then rerun this script.\n' >&2
  exit 2
fi

generate_set() {
  local category="$1"
  local stem="$2"
  local count="$3"
  local duration="$4"
  local influence="$5"
  local prompt="$6"
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
      --out "${output}"
  done
}

generate_set weapons machine-fire 4 0.5 0.76 \
  "short first-person futuristic machine-gun shot for a fast sci-fi arena FPS, hard powder-like crack, compact electromechanical bolt clack, solid low-mid body, tiny outdoor reflection tail ending within 0.45 seconds, single shot not a burst, no music, no voice, clear transient readable under dense combat"

generate_set weapons shotgun-fire 3 1.0 0.74 \
  "futuristic double-barrel combat shotgun blast, immediate wide pressure transient, deep chest body, restrained metallic receiver slap, short open-arena reflection tail, one shot only, no reload, no music, no voice"

generate_set weapons rocket-launch 3 0.8 0.72 \
  "shoulder-fired sci-fi rocket launch, sharp igniter snap, heavy tube concussion, fast propellant whoosh leaving the muzzle, short dry arena tail, no explosion, no music, no voice"

generate_set weapons plasma-fire 4 0.5 0.76 \
  "single futuristic plasma-bolt discharge, hard electrical transient, dense ionized pulse body, tiny descending energy tail, aggressive and compact, no impact, no music, no voice"

generate_set weapons laser-fire 4 0.5 0.76 \
  "single high-energy laser weapon pulse, razor-sharp electrical attack, compact hot beam crack, brief synthetic decay, powerful without a cartoon pew, no music, no voice"

generate_set weapons sniper-fire 2 1.2 0.74 \
  "heavy futuristic precision-rifle shot, extremely crisp supersonic crack, deep controlled receiver body, metallic action resonance, open-air arena reflection tail, one shot, no music, no voice"

generate_set weapons rail-fire 2 1.5 0.74 \
  "experimental electromagnetic railgun discharge, microsecond capacitor rise into a violent hypersonic crack, huge low electromagnetic body, piercing ionized tail, one shot, no music, no voice"

generate_set impacts rocket-explosion 4 1.8 0.72 \
  "close sci-fi arena rocket detonation, brutal initial pressure wave, dense debris burst, deep compact sub body, short outdoor reflection tail, no launch, no music, no voice"

generate_set impacts plasma-impact 3 0.7 0.76 \
  "plasma projectile striking hard futuristic arena material, bright electrical splat transient, hot ion crackle and brief energy dissipation, no weapon fire, no music, no voice"

generate_set impacts armor-hit 3 0.6 0.78 \
  "hostile projectile striking a futuristic combat suit, hard armor snap, compact shield-like crackle, muted body thump, very short tail, no gunshot, no music, no voice"

generate_set ui hit-confirm 2 0.5 0.78 \
  "tiny premium sci-fi hit-confirm sound, precise hard tick with restrained warm energy body, immediate and non-musical, no voice, readable beneath gunfire"

generate_set ui elimination-confirm 2 0.6 0.78 \
  "short premium arena elimination-confirm sound, decisive metallic lock and compact energy punctuation, rewarding but non-musical, no voice"

generate_set weapons empty-trigger 3 0.5 0.8 \
  "empty futuristic firearm trigger pull, dry mechanical click and failed feed latch, close first-person perspective, no shot, no music, no voice"

generate_set pickups ammo-ballistic 2 0.7 0.76 \
  "fast futuristic ballistic ammunition pickup, compact cartridge rattle into a firm magnetic magazine lock, rewarding transient, no weapon fire, no music, no voice"

generate_set pickups ammo-energy 2 0.7 0.76 \
  "fast sci-fi energy ammunition pickup, charged cell insertion, solid clamp lock and brief clean power chirp, no melody, no voice"

generate_set pickups ammo-rocket 2 0.8 0.76 \
  "heavy futuristic rocket ammunition pickup, compact ordnance canister clunk, locking rail snap and restrained confirmation pulse, no explosion, no music, no voice"

generate_set pickups rail-acquire 2 1.0 0.74 \
  "rare electromagnetic power-weapon acquisition, heavy magnetic latch, rising capacitor surge and decisive energy lock, premium and dangerous, no melody, no voice"

generate_set weapons equip-light 1 0.6 0.78 \
  "quick first-person sci-fi weapon equip, light polymer handling, compact magnetic latch and ready click, no gunfire, no music, no voice"

generate_set weapons equip-heavy 1 0.8 0.78 \
  "heavy first-person sci-fi weapon equip, weighty chassis movement, reinforced clamp lock and firm ready clack, no gunfire, no music, no voice"

generate_set weapons equip-precision 1 0.7 0.78 \
  "precision futuristic rifle equip, machined metal handling, optic-power flick and crisp bolt lock, no gunfire, no music, no voice"

generate_set movement jump 2 0.5 0.8 \
  "first-person powered arena jump, compact boot servo compression and immediate air release, athletic and fast, no voice, no weapon, no music, no footsteps"

generate_set movement dash 2 0.55 0.8 \
  "first-person futuristic arena dash, instantaneous boot-thruster punch with a tight lateral air displacement and compact suit servo snap, extremely fast and athletic, no voice, no weapon, no music"

generate_set movement wall-jump 2 0.65 0.8 \
  "first-person armored wall jump in a fast arena, hard boot contact against metal followed immediately by a powered rebound servo burst, compact and forceful, no voice, no weapon, no music"

generate_set movement land-light 2 0.5 0.8 \
  "light armored combat boot landing on futuristic composite arena flooring, short sole impact and tiny gear settle, dry and close, no voice, no music"

generate_set movement land-heavy 2 0.7 0.78 \
  "hard high-speed armored landing on futuristic arena flooring, forceful boot impact, compact suit-rig rattle and short low body, no injury voice, no music"

generate_set impacts player-damage 3 0.6 0.78 \
  "first-person sci-fi combat damage feedback without armor, compact suit fabric thump and sharp electronic warning crack, no spoken voice, no gunshot, no music"

generate_set impacts player-death 2 1.0 0.76 \
  "futuristic combat-frame shutdown, heavy body collapse, failing servo drop and descending power discharge, no scream, no spoken voice, no gunshot, no music"

generate_set pickups health 2 0.7 0.8 \
  "fast arena health pickup, clean medical injector latch and warm restorative energy pulse, immediate rewarding transient, no melody, no voice"

generate_set pickups armor 2 0.7 0.8 \
  "fast arena armor pickup, hard ceramic plate lock and compact shield charge snap, weighty and rewarding, no melody, no voice"

generate_set pickups boost 2 0.8 0.78 \
  "temporary sci-fi combat boost pickup, aggressive energy canister lock and fast rising power surge, short non-musical confirmation, no voice"

generate_set pickups core 2 1.0 0.76 \
  "rare arena objective core acquisition, deep magnetic capture lock, crystalline energy swell and decisive power seal, prestigious but non-musical, no voice"

printf 'Generated complete arena audio under %s.\n' "${AUDIO_ROOT}"
