#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_VIDEO_CODEC='h264'
readonly EXPECTED_AUDIO_CODEC='aac'

if [[ $# -ne 1 ]]; then
  echo "usage: $0 rtsp-url" >&2
  exit 64
fi

video_codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nk=1:nw=1 "$1")"
audio_codec="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=nk=1:nw=1 "$1")"
if [[ "$video_codec" != "$EXPECTED_VIDEO_CODEC" ]] || [[ "$audio_codec" != "$EXPECTED_AUDIO_CODEC" ]]; then
  echo "expected video=$EXPECTED_VIDEO_CODEC audio=$EXPECTED_AUDIO_CODEC; got video=$video_codec audio=$audio_codec" >&2
  exit 1
fi
