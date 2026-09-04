#!/usr/bin/env bash
# Read replica pull hook invoked by MediaMTX `runOnDemand`.
#
# Behavior:
#   - Validate `MTX_PATH` as `live/{12-character base62 id}` (same rule as relay.sh).
#   - Try each origin in `ORIGINS` (comma-separated `host` or `host:port`, default port 554)
#     in the listed order. We pull with `ffmpeg -c copy` from the origin's egress (:554, TCP RTSP),
#     never from the origin's ingress: egress already exposes the normalized AAC audio and is the
#     public read surface, ingress is loopback-only.
#   - If any `ORIGINS` host matches `SELF_HOSTS`, refuse to start (self-loop guard).
#   - A quick connection failure (missing path / unreachable) advances to the next origin.
#     Once a pull sustains beyond `REPLICA_SUSTAINED_PULL_SECONDS`, a later drop is treated as
#     a post-connect disconnection and re-enters the origin loop with the same
#     MAX_RETRIES / backoff cadence as relay.sh.
#   - `runOnDemandRestart: no` is expected on the MediaMTX side; a non-zero exit here means every
#     origin was tried and none served the path.
#   - SIGINT / SIGTERM terminate the child ffmpeg and exit 0 (MediaMTX sends SIGINT when the last
#     reader disconnects, which is a clean shutdown).
set -euo pipefail

readonly STREAM_PATH_PREFIX='live/'
readonly STREAM_ID_LENGTH=12
readonly DEFAULT_ORIGIN_PORT=554
readonly SUSTAINED_PULL_SECONDS="${REPLICA_SUSTAINED_PULL_SECONDS:-5}"
readonly MAX_RETRIES="${REPLICA_MAX_RETRIES:-3}"
readonly BASE_BACKOFF_SECONDS="${REPLICA_BASE_BACKOFF_SECONDS:-1}"
readonly RTSP_CONNECT_TIMEOUT_US="${REPLICA_RTSP_CONNECT_TIMEOUT_US:-5000000}"
readonly LOCAL_RTSP_PORT="${RTSP_PORT:-554}"
readonly FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"

PARSED_ORIGINS=()
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
    echo 'replica-pull refused an invalid MediaMTX path' >&2
    exit 64
  fi
  printf '%s' "$id"
}

trim_whitespace() {
  local value="$1"
  if [[ "$value" =~ ^[[:space:]]*(.*[^[:space:]])[[:space:]]*$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' ''
  fi
}

require_unsigned_int() {
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "replica-pull requires $name to be an unsigned integer" >&2
    exit 64
  fi
}

# The env file is root-owned, but bash arithmetic and IFS splitting still deserve a fail-closed gate:
# a stray newline or a non-numeric value must stop the pull instead of being silently truncated.
validate_env() {
  require_unsigned_int REPLICA_SUSTAINED_PULL_SECONDS "$SUSTAINED_PULL_SECONDS"
  require_unsigned_int REPLICA_MAX_RETRIES "$MAX_RETRIES"
  require_unsigned_int REPLICA_BASE_BACKOFF_SECONDS "$BASE_BACKOFF_SECONDS"
  require_unsigned_int REPLICA_RTSP_CONNECT_TIMEOUT_US "$RTSP_CONNECT_TIMEOUT_US"
  require_unsigned_int RTSP_PORT "$LOCAL_RTSP_PORT"
  local name
  for name in ORIGINS SELF_HOSTS; do
    if [[ "${!name:-}" == *$'\n'* ]]; then
      echo "replica-pull refused $name containing a newline (use a single comma-separated line)" >&2
      exit 64
    fi
  done
}

parse_origins_env() {
  local raw="${ORIGINS:-}"
  if [[ -z "$raw" ]]; then
    echo 'replica-pull requires ORIGINS to be a non-empty comma-separated list of host or host:port entries' >&2
    exit 64
  fi
  local -a raw_entries=()
  IFS=',' read -r -a raw_entries <<< "$raw"
  local entry cleaned
  for entry in "${raw_entries[@]}"; do
    cleaned="$(trim_whitespace "$entry")"
    [[ -z "$cleaned" ]] && continue
    # Validate the host syntax up front (rejects IPv6 literals) even when SELF_HOSTS is unset.
    origin_host "$cleaned" >/dev/null
    PARSED_ORIGINS+=("$cleaned")
  done
  if (( ${#PARSED_ORIGINS[@]} == 0 )); then
    echo 'replica-pull requires ORIGINS to contain at least one non-empty entry' >&2
    exit 64
  fi
}

# Lower-cased host part of `host` or `host:port`. IPv6 literals are refused: the `%%:*` split and the
# URL builder below only support one colon, and the self-loop guard would silently miss `[::1]`.
origin_host() {
  local origin="$1"
  if [[ "$origin" == *\[* || "$origin" == *:*:* ]]; then
    echo "replica-pull does not support IPv6 literals in ORIGINS/SELF_HOSTS ($origin); use a hostname or IPv4" >&2
    exit 64
  fi
  local host="${origin%%:*}"
  printf '%s' "${host,,}"
}

enforce_self_loop_guard() {
  local raw="${SELF_HOSTS:-}"
  [[ -z "$raw" ]] && return 0
  local -a self_entries=()
  IFS=',' read -r -a self_entries <<< "$raw"
  local origin host self_host cleaned_self
  for origin in "$@"; do
    host="$(origin_host "$origin")"
    for self_host in "${self_entries[@]}"; do
      cleaned_self="$(trim_whitespace "$self_host")"
      [[ -z "$cleaned_self" ]] && continue
      # Compare host parts case-insensitively; a stray `:port` in SELF_HOSTS must not defeat the guard.
      cleaned_self="$(origin_host "$cleaned_self")"
      if [[ "$host" == "$cleaned_self" ]]; then
        echo "replica-pull refused an ORIGINS entry that matches SELF_HOSTS ($host)" >&2
        exit 64
      fi
    done
  done
}

origin_url() {
  local origin="$1"
  local id="$2"
  if [[ "$origin" == *:* ]]; then
    printf 'rtsp://%s/%s%s' "$origin" "$STREAM_PATH_PREFIX" "$id"
  else
    printf 'rtsp://%s:%s/%s%s' "$origin" "$DEFAULT_ORIGIN_PORT" "$STREAM_PATH_PREFIX" "$id"
  fi
}

run_ffmpeg_once() {
  local input_url="$1"
  local output_url="$2"
  local status=0
  "$FFMPEG_BIN" -nostdin \
    -rtsp_transport tcp -timeout "$RTSP_CONNECT_TIMEOUT_US" -i "$input_url" \
    -map 0 -c copy \
    -f rtsp -rtsp_transport tcp "$output_url" &
  child_pid=$!
  wait "$child_pid" || status=$?
  child_pid=''
  return "$status"
}

pull_loop() {
  local id="$1"
  shift
  local -a origins=("$@")
  local output_url="rtsp://127.0.0.1:$LOCAL_RTSP_PORT/$STREAM_PATH_PREFIX$id"
  local retry_count=0
  local origin input_url start_seconds duration_seconds
  while (( retry_count <= MAX_RETRIES )); do
    for origin in "${origins[@]}"; do
      (( stopping )) && return 0
      input_url="$(origin_url "$origin" "$id")"
      start_seconds=$SECONDS
      if run_ffmpeg_once "$input_url" "$output_url"; then
        (( stopping )) && return 0
        # ffmpeg exited cleanly (MediaMTX closed the pull after the last reader left).
        return 0
      fi
      (( stopping )) && return 0
      duration_seconds=$(( SECONDS - start_seconds ))
      if (( duration_seconds >= SUSTAINED_PULL_SECONDS )); then
        # A sustained pull dropped; reset the retry counter and start over from the top origin.
        retry_count=0
        continue 2
      fi
      # Quick failure: treat as connection failure and advance to the next origin.
    done
    if (( retry_count >= MAX_RETRIES )); then
      echo 'replica-pull exhausted all origins' >&2
      return 1
    fi
    sleep "$(( BASE_BACKOFF_SECONDS * (retry_count + 1) ))"
    (( retry_count += 1 ))
  done
  return 1
}

stream_id="$(require_stream_id)"
validate_env
parse_origins_env
enforce_self_loop_guard "${PARSED_ORIGINS[@]}"
pull_loop "$stream_id" "${PARSED_ORIGINS[@]}"
