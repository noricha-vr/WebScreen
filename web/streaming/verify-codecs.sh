#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_VIDEO_CODEC='h264'
readonly FFPROBE_BIN="${FFPROBE_BIN:-ffprobe}"
readonly MAX_PROBE_ATTEMPTS=3
readonly PROBE_RETRY_DELAY_SECONDS=1
readonly PROBE_TIMEOUT_MICROSECONDS=5000000
script_directory="$(unset CDPATH; cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY="$script_directory"

# shellcheck disable=SC1091
. "$SCRIPT_DIRECTORY/audio-profile.sh"

if [[ $# -lt 1 ]] || [[ $# -gt 2 ]] || [[ ${2:-} != '' && ${2:-} != '--video-only' ]]; then
  echo "usage: $0 rtsp-url [--video-only]" >&2
  exit 64
fi

require_probe_url() {
  local input_url="$1"
  local probe_url

  case "$input_url" in
    rtspt://*) probe_url="rtsp://${input_url#rtspt://}" ;;
    rtsp://*) probe_url="$input_url" ;;
    *)
      echo 'verify-codecs requires an rtsp or rtspt URL' >&2
      exit 64
      ;;
  esac

  if [[ ! "$probe_url" =~ ^rtsp://[^/?#]+/live/[A-Za-z0-9]{12}$ ]]; then
    echo 'verify-codecs refused an invalid stream path' >&2
    exit 64
  fi
  printf '%s' "$probe_url"
}

probe_streams() {
  local probe_url="$1"
  local attempt=1
  local codec_rows

  while (( attempt <= MAX_PROBE_ATTEMPTS )); do
    if codec_rows="$("$FFPROBE_BIN" -v error -rtsp_transport tcp \
      -timeout "$PROBE_TIMEOUT_MICROSECONDS" -read_intervals '%+1' \
      -show_entries stream=codec_type,codec_name,sample_rate,channels -of csv=p=0 "$probe_url")"; then
      printf '%s\n' "$codec_rows"
      return 0
    fi
    if (( attempt == MAX_PROBE_ATTEMPTS )); then
      return 1
    fi
    sleep "$PROBE_RETRY_DELAY_SECONDS"
    ((attempt += 1))
  done
}

probe_url="$(require_probe_url "$1")"
if ! codec_rows="$(probe_streams "$probe_url")"; then
  echo "ffprobe failed after $MAX_PROBE_ATTEMPTS attempts" >&2
  exit 1
fi
video_codec="$(awk -F, '$2 == "video" { print $1; exit }' <<< "$codec_rows")"
audio_codec="$(awk -F, '$2 == "audio" { print $1; exit }' <<< "$codec_rows")"
audio_sample_rate="$(awk -F, '$2 == "audio" { print $3; exit }' <<< "$codec_rows")"
audio_channels="$(awk -F, '$2 == "audio" { print $4; exit }' <<< "$codec_rows")"
if [[ "$video_codec" != "$EXPECTED_VIDEO_CODEC" ]]; then
  echo "expected video=$EXPECTED_VIDEO_CODEC; got video=$video_codec" >&2
  exit 1
fi
if [[ ${2:-} == '--video-only' ]]; then
  if [[ -n "$audio_codec" ]]; then
    echo "expected no audio; got audio=$audio_codec" >&2
    exit 1
  fi
  exit 0
fi
# shellcheck disable=SC2153
if [[ "$audio_codec" != "$EXPECTED_AUDIO_CODEC" \
  || "$audio_sample_rate" != "$AUDIO_SAMPLE_RATE" \
  || "$audio_channels" != "$AUDIO_CHANNELS" ]]; then
  echo "expected video=$EXPECTED_VIDEO_CODEC audio=$EXPECTED_AUDIO_CODEC rate=$AUDIO_SAMPLE_RATE channels=$AUDIO_CHANNELS; got video=$video_codec audio=$audio_codec rate=$audio_sample_rate channels=$audio_channels" >&2
  exit 1
fi
