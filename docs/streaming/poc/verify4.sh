#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
RTSP="rtsp://localhost:28554/live/test"; MPID=$(cat mediamtx.pid)
# CPU 時間(秒)を取る。ps の TIME は [dd-]hh:mm:ss.ff
cputime() { ps -o time= -p "$MPID" | tr -d ' ' | awk -F: '{n=NF; s=$n; if(n>1) s+=$(n-1)*60; if(n>2) s+=$(n-2)*3600; print s}'; }
rss() { ps -o rss= -p "$MPID" | awk '{printf "%.1f", $1/1024}'; }
# 10 秒間の CPU 使用率（1 コア=100%）を実測
measure() {
  local t0 c0 t1 c1
  c0=$(cputime); t0=$(python3 -c 'import time;print(time.time())'); sleep 10
  c1=$(cputime); t1=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(f'{($c1-$c0)/($t1-$t0)*100:.1f}')"
}
node run-publisher.mjs 340 2000 > publisher4.log 2>&1 &
PUB=$!; trap 'kill $PUB 2>/dev/null; pkill -f "rtsp://localhost:28554" 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s http://localhost:29997/v3/paths/get/live/test 2>/dev/null | jq -e '.ready==true and (.source!=null)' >/dev/null 2>&1 && break; sleep 1; done
echo "stream ready (${i}s)"
printf "\n%-10s %-12s %-10s %s\n" "reader数" "CPU(1コア%)" "RSS(MB)" "備考"
printf "%-10s %-12s %-10s %s\n" "0" "$(measure)" "$(rss)" "publisher のみ"
PIDS=()
for target in 20 40 60 80; do
  while [ ${#PIDS[@]} -lt $target ]; do
    ffmpeg -v quiet -rtsp_transport tcp -i "$RTSP" -c copy -f null - >/dev/null 2>&1 & PIDS+=($!)
  done
  sleep 6   # 接続確立の山を越える
  N=$(curl -s http://localhost:29997/v3/paths/get/live/test | jq '.readers|length')
  printf "%-10s %-12s %-10s %s\n" "$target" "$(measure)" "$(rss)" "API上 $N"
done
for p in "${PIDS[@]}"; do kill $p 2>/dev/null; done; sleep 4
printf "%-10s %-12s %-10s %s\n" "0(切断後)" "$(measure)" "$(rss)" "リーク確認"
kill $PUB 2>/dev/null
