#!/bin/sh

if [ "${RELAY_AUDIO_ENCODER+x}" = x ] \
  || [ "${EXPECTED_AUDIO_CODEC+x}" = x ] \
  || [ "${AUDIO_SAMPLE_RATE+x}" = x ] \
  || [ "${AUDIO_CHANNELS+x}" = x ] \
  || [ "${AUDIO_BITRATE+x}" = x ]; then
  printf '%s\n' 'audio profile variables must not be overridden' >&2
  return 64 2>/dev/null
  # shellcheck disable=SC2317
  exit 64
fi

readonly RELAY_AUDIO_ENCODER='libmp3lame'
readonly EXPECTED_AUDIO_CODEC='mp3'
readonly AUDIO_SAMPLE_RATE='48000'
readonly AUDIO_CHANNELS='2'
readonly AUDIO_BITRATE='128k'
