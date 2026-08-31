#!/usr/bin/env bash
# PoC サーバーを起動する。ログは $1（既定 ./mediamtx.log）へ。
set -euo pipefail
cd "$(dirname "$0")"
LOG="${1:-./mediamtx.log}"
mediamtx ./mediamtx-poc.yml >"$LOG" 2>&1 &
echo $! > ./mediamtx.pid
sleep 2
if kill -0 "$(cat ./mediamtx.pid)" 2>/dev/null; then
  echo "started pid=$(cat ./mediamtx.pid) log=$LOG"
else
  echo "FAILED to start"; tail -20 "$LOG"; exit 1
fi
