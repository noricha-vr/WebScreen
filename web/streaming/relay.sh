#!/usr/bin/env bash
set -euo pipefail

readonly STREAM_PATH_PREFIX='live/'
readonly STREAM_ID_LENGTH=12
readonly MAX_RETRIES=3
readonly BASE_BACKOFF_SECONDS=1
readonly INGRESS_RTSP_ORIGIN='rtsp://127.0.0.1:8554'
readonly EGRESS_RTSP_ORIGIN='rtsp://127.0.0.1:554'
readonly FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

child_pid=''
stopping=0

stop_child() {
  stopping=1
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=''
}

on_signal() {
  stop_child
  exit 0
}

trap on_signal INT TERM

require_stream_id() {
  local media_path="${MTX_PATH:-}"
  local id="${media_path#"$STREAM_PATH_PREFIX"}"
  if [[ "$media_path" != "$STREAM_PATH_PREFIX$id" ]] || [[ ${#id} -ne $STREAM_ID_LENGTH ]] || [[ ! "$id" =~ ^[A-Za-z0-9]+$ ]]; then
    echo 'relay refused an invalid MediaMTX path' >&2
    exit 64
  fi
  printf '%s' "$id"
}

run_relay() {
  local stream_id="$1"
  local input_url="$INGRESS_RTSP_ORIGIN/$STREAM_PATH_PREFIX$stream_id"
  local output_url="$EGRESS_RTSP_ORIGIN/$STREAM_PATH_PREFIX$stream_id"
  local retry_count=0

  while (( retry_count <= MAX_RETRIES )); do
    "$FFMPEG_BIN" -nostdin -rtsp_transport tcp -i "$input_url" \
      -map 0:v:0 -c:v copy -map 0:a? -c:a aac -ar 48000 -ac 2 -b:a 128k \
      -f rtsp -rtsp_transport tcp "$output_url" &
    child_pid=$!
    if wait "$child_pid"; then
      child_pid=''
      return 0
    fi
    child_pid=''
    if (( stopping || retry_count == MAX_RETRIES )); then
      return 1
    fi
    sleep "$((BASE_BACKOFF_SECONDS * (retry_count + 1)))"
    ((retry_count += 1))
  done
}

stream_id="$(require_stream_id)"
run_relay "$stream_id"
