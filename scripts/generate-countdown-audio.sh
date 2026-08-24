#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
source ./.env
set +a

AUDIO_TOOL="/home/skulesza/.agents/skills/threejs-audio-generator/scripts/threejs_audio_asset.py"
VOICE_ID="JBFqnCBsd6RMkjVDRZzb"
COMMON_ARGS=(
  --voice-id "$VOICE_ID"
  --output-format mp3_44100_128
  --stability 0.72
  --similarity-boost 0.78
  --style 0.42
  --speaker-boost
)

python3 "$AUDIO_TOOL" tts --text "Ready." "${COMMON_ARGS[@]}" --out public/assets/audio/voice/countdown-ready.mp3
python3 "$AUDIO_TOOL" tts --text "Three." "${COMMON_ARGS[@]}" --out public/assets/audio/voice/countdown-three.mp3
python3 "$AUDIO_TOOL" tts --text "Two." "${COMMON_ARGS[@]}" --out public/assets/audio/voice/countdown-two.mp3
python3 "$AUDIO_TOOL" tts --text "One." "${COMMON_ARGS[@]}" --out public/assets/audio/voice/countdown-one.mp3
