#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
RTSP="rtsp://localhost:28554/live/test"
MPID=$(cat mediamtx.pid)
R() { printf "\n===== %s =====\n" "$*"; }
stat_mtx() { ps -o rss=,%cpu= -p "$MPID" | awk '{printf "RSS=%.1fMB CPU=%.1f%%", $1/1024, $2}'; }

node run-publisher.mjs "${1:-200}" 2000 > publisher2.log 2>&1 &
PUB=$!
trap 'kill $PUB 2>/dev/null; pkill -f "rtsp://localhost:28554" 2>/dev/null' EXIT
for i in $(seq 1 30); do
  if curl -s http://localhost:29997/v3/paths/get/live/test 2>/dev/null | jq -e ".ready == true and (.source != null)" >/dev/null 2>&1; then break; fi; sleep 1
done
echo "stream ready (${i}s)"

R "V10: 配信元→RTSP 受信の遅延（送出画面の時刻と受信時刻の差）"
for n in 1 2 3; do
  ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -frames:v 1 -f image2 -y ./lat_$n.png 2>/dev/null
  python3 -c "import time;print(f'  試行$n 受信完了時刻(epoch ms %% 100000) = {int(time.time()*1000)%100000}')"
  sleep 3
done
echo "  ※ lat_N.png に描かれた数字との差が遅延（画像を目視で読む）"

R "V7: RTSP reader を増やした時のサーバー負荷"
echo "  reader 0 本: $(stat_mtx)"
PIDS=()
for n in $(seq 1 20); do
  ffmpeg -v quiet -rtsp_transport tcp -i "$RTSP" -c copy -f null - >/dev/null 2>&1 &
  PIDS+=($!)
  if [ $((n % 5)) -eq 0 ]; then
    sleep 4
    echo "  reader $n 本: $(stat_mtx)  (API 上の reader 数: $(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.readers|length'))"
  fi
done
sleep 3
echo "  最終 reader 数(API): $(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.readers|length')"
echo "  最終負荷: $(stat_mtx)"
BYTES=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.bytesSent')
echo "  bytesSent 累計: $BYTES"
for p in "${PIDS[@]}"; do kill $p 2>/dev/null; done
sleep 2
echo "  reader 全切断後: $(stat_mtx)"

R "V9: 長時間の RTSP 接続維持（75 秒。60 秒切断問題）"
ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -t 75 -c copy -f mp4 -y ./long.mp4 2>./long.err
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ./long.mp4 2>/dev/null)
echo "  受信できた長さ: ${DUR}s （75 に近ければ切断なし）"
[ -s ./long.err ] && echo "  stderr:" && sed 's/^/    /' ./long.err | head -5 || echo "  stderr: なし"
kill $PUB 2>/dev/null
