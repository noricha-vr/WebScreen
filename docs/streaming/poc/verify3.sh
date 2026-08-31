#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
RTSP="rtsp://localhost:28554/live/test"; MPID=$(cat mediamtx.pid)
stat_mtx() { ps -o rss=,%cpu= -p "$MPID" | awk '{printf "RSS=%.1fMB CPU=%.1f%%", $1/1024, $2}'; }
node run-publisher.mjs 300 2000 > publisher3.log 2>&1 &
PUB=$!; trap 'kill $PUB 2>/dev/null; pkill -f "rtsp://localhost:28554" 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s http://localhost:29997/v3/paths/get/live/test 2>/dev/null | jq -e '.ready==true and (.source!=null)' >/dev/null 2>&1 && break; sleep 1; done
echo "stream ready (${i}s)"

printf "\n===== V10: 定常状態の遅延（6 秒録画して最終フレームの表示時刻と録画終了時刻を比較）=====\n"
for n in 1 2 3; do
  ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -t 6 -c copy -f mp4 -y ./lat_$n.mp4 2>/dev/null
  END=$(python3 -c 'import time;print(int(time.time()*1000)%100000)')
  ffmpeg -v error -sseof -0.4 -i ./lat_$n.mp4 -frames:v 1 -y ./latframe_$n.png 2>/dev/null
  echo "  試行$n: 録画終了(epoch ms%100000)=$END → latframe_$n.png の表示数値との差が遅延"
  sleep 2
done

printf "\n===== V7b: reader を 60 本まで増やした時の定常負荷 =====\n"
PIDS=(); echo "  0 本: $(stat_mtx)"
for n in $(seq 1 60); do
  ffmpeg -v quiet -rtsp_transport tcp -i "$RTSP" -c copy -f null - >/dev/null 2>&1 & PIDS+=($!)
  if [ $((n % 20)) -eq 0 ]; then
    sleep 8   # 接続確立の山を越えて定常状態を測る
    echo "  $n 本 (定常): $(stat_mtx)  API reader=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.readers|length')"
  fi
done
sleep 10
echo "  60 本 定常(再測): $(stat_mtx)  API reader=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.readers|length')"
B1=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.bytesSent'); sleep 10
B2=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.bytesSent')
python3 -c "print(f'  実効送出: {($B2-$B1)*8/10/1e6:.1f} Mbps (60 reader 合計) = {($B2-$B1)*8/10/1e6/60*1000:.0f} kbps/reader')"
for p in "${PIDS[@]}"; do kill $p 2>/dev/null; done; sleep 3
echo "  全切断後: $(stat_mtx)"
kill $PUB 2>/dev/null
