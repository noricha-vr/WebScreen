#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_VIDEO_CODEC='h264'
readonly EXPECTED_AUDIO_CODEC='aac'
readonly FFPROBE_BIN="${FFPROBE_BIN:-ffprobe}"

if [[ $# -lt 1 ]] || [[ $# -gt 2 ]] || [[ ${2:-} != '' && ${2:-} != '--video-only' ]]; then
  echo "usage: $0 rtsp-url [--video-only]" >&2
  exit 64
fi

probe_url="${1/#rtspt:\/\//rtsp://}"
codec_rows="$("$FFPROBE_BIN" -v error -rtsp_transport tcp -read_intervals '%+1' \
  -show_entries stream=codec_type,codec_name -of csv=p=0 "$probe_url")"
video_codec="$(awk -F, '$2 == "video" { print $1; exit }' <<< "$codec_rows")"
audio_codec="$(awk -F, '$2 == "audio" { print $1; exit }' <<< "$codec_rows")"
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
if [[ "$audio_codec" != "$EXPECTED_AUDIO_CODEC" ]]; then
  echo "expected video=$EXPECTED_VIDEO_CODEC audio=$EXPECTED_AUDIO_CODEC; got video=$video_codec audio=$audio_codec" >&2
  exit 1
fi
