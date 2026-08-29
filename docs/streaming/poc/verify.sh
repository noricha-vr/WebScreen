#!/usr/bin/env bash
# WebScreen ストリーミング PoC の検証スクリプト
# 前提: mediamtx が ./mediamtx-poc.yml で起動済み、http.server が :28080 で稼働
set -uo pipefail
cd "$(dirname "$0")"
RTSP="rtsp://localhost:28554/live/test"
HLS="http://localhost:28888/live/test/index.m3u8"
R() { printf "\n===== %s =====\n" "$*"; }

# publisher をバックグラウンドで起動
node run-publisher.mjs "${1:-90}" "${2:-2000}" > publisher.log 2>&1 &
PUB=$!
trap 'kill $PUB 2>/dev/null' EXIT
for i in $(seq 1 30); do
  curl -s http://localhost:29997/v3/paths/get/live/test 2>/dev/null | grep -q '"ready":true' && break
  sleep 1
done
echo "stream ready after ${i}s"

R "V1: RTSP 出力のコーデック契約（VRChat 互換の必須条件）"
ffprobe -v error -rtsp_transport tcp -i "$RTSP" \
  -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,has_b_frames,width,height,avg_frame_rate \
  -of default=noprint_wrappers=1 2>&1

R "V3: キーフレーム間隔（8 秒ぶんの I フレーム時刻）"
ffprobe -v error -rtsp_transport tcp -i "$RTSP" -select_streams v:0 -read_intervals "%+8" \
  -show_entries frame=pts_time,pict_type -of csv=p=0 2>/dev/null \
  | awk -F, '$2=="I"{if(p!=""){printf "  I-frame 間隔: %.2fs\n", $1-p} p=$1} END{}' | head -10

R "V5: 実効ビットレート（10 秒受信して計測）"
ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -t 10 -c copy -f mp4 -y /tmp/vseg.mp4 2>&1
if [ -f /tmp/vseg.mp4 ]; then
  SZ=$(stat -f%z /tmp/vseg.mp4)
  echo "  10 秒で ${SZ} bytes = $(( SZ * 8 / 10000 )) kbps"
  echo "  受信ファイルの契約チェック:"
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,has_b_frames -of default=noprint_wrappers=1 /tmp/vseg.mp4
fi

R "V2: 途中参加した視聴者が映像を得るまでの時間（3 回計測）"
for n in 1 2 3; do
  S=$(python3 -c 'import time;print(time.time())')
  ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -frames:v 1 -f image2 -y /tmp/first_$n.png 2>/dev/null
  E=$(python3 -c 'import time;print(time.time())')
  python3 -c "print(f'  試行$n: {($E-$S):.2f}s  (画像 $( [ -f /tmp/first_$n.png ] && echo OK || echo NG ))')"
  sleep 2
done

R "V6: HLS 同時出力（Quest 向け）"
curl -s -o /tmp/idx.m3u8 -w "  index.m3u8 HTTP %{http_code} / %{size_download} bytes\n" "$HLS"
head -8 /tmp/idx.m3u8 2>/dev/null | sed 's/^/    /'

R "V9: 長時間の RTSP 接続維持（70 秒。60 秒切断問題の確認）"
timeout 75 ffmpeg -v error -rtsp_transport tcp -i "$RTSP" -t 70 -c copy -f mp4 -y /tmp/long.mp4 2>/tmp/long.err
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/long.mp4 2>/dev/null)
echo "  受信できた長さ: ${DUR}s（70 に近ければ切断なし）"
[ -s /tmp/long.err ] && echo "  stderr:" && sed 's/^/    /' /tmp/long.err | head -5

kill $PUB 2>/dev/null
echo -e "\n===== publisher log (末尾) ====="
tail -4 publisher.log
