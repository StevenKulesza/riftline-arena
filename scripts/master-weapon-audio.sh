#!/usr/bin/env bash

set -euo pipefail

readonly AUDIO_ROOT="public/assets/audio"
readonly RAW_BACKUP="artifacts/audio-raw"

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf 'ffmpeg is required to master the generated audio.\n' >&2
  exit 1
fi

if [[ ! -d "${AUDIO_ROOT}" ]]; then
  printf 'No generated audio found under %s.\n' "${AUDIO_ROOT}" >&2
  exit 1
fi

mkdir -p "${RAW_BACKUP}"

target_lufs() {
  local relative="$1"
  case "${relative}" in
    weapons/machine-fire-*|weapons/plasma-fire-*|weapons/laser-fire-*) printf '%s\n' -18 ;;
    weapons/shotgun-fire-*|weapons/sniper-fire-*|weapons/rocket-launch-*) printf '%s\n' -14 ;;
    weapons/rail-fire-*) printf '%s\n' -13 ;;
    impacts/rocket-explosion-*) printf '%s\n' -14 ;;
    impacts/player-death-*) printf '%s\n' -16 ;;
    impacts/*) printf '%s\n' -18 ;;
    movement/*) printf '%s\n' -23 ;;
    pickups/*) printf '%s\n' -21 ;;
    ui/*|weapons/empty-trigger-*|weapons/equip-*) printf '%s\n' -22 ;;
    *) printf '%s\n' -18 ;;
  esac
}

while IFS= read -r -d '' file; do
  relative="${file#${AUDIO_ROOT}/}"
  raw_copy="${RAW_BACKUP}/${relative}"
  if [[ ! -s "${raw_copy}" ]]; then
    mkdir -p "$(dirname "${raw_copy}")"
    cp "${file}" "${raw_copy}"
  fi
  target="$(target_lufs "${relative}")"
  temporary="${file%.mp3}.mastering.mp3"
  printf 'MASTER %-44s %s LUFS\n' "${relative}" "${target}"
  ffmpeg -hide_banner -loglevel error -y \
    -i "${file}" \
    -af "loudnorm=I=${target}:LRA=5:TP=-2" \
    -ar 44100 \
    -b:a 128k \
    "${temporary}"
  mv -f "${temporary}" "${file}"
done < <(find "${AUDIO_ROOT}" -type f -name '*.mp3' -print0 | sort -z)

printf 'Mastered audio in %s; untouched renders preserved in %s.\n' "${AUDIO_ROOT}" "${RAW_BACKUP}"
