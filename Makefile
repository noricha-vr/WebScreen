SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

WEB_DIR := web
STREAM_HOST ?= webscreen-indigo-poc
SMOKE_URLS ?= https://web-screen.net/ https://web-screen.net/api/health/ https://web-screen.net/api/streams/jwks/
STREAM_CONTROL_URL := https://stream.web-screen.net
STREAM_PUBLIC_URL := https://webscreen.tv

.PHONY: help install dev typecheck test e2e build check smoke stream-health stream-probe stream-logs stream-paths latency-probe stream-source

help: ## 利用可能な開発・運用コマンドを表示
	@awk 'BEGIN { FS = ":.*##"; printf "使い方: make <target> [VAR=value]\n\n" } /^[a-zA-Z0-9_-]+:.*##/ { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '  %-20s %s\n' 'deploy' 'デプロイは main への push（CI）'

install: ## web の依存関係を lockfile 固定でインストール
	cd "$(WEB_DIR)" && bun install --frozen-lockfile

dev: ## ローカル開発サーバーを起動
	cd "$(WEB_DIR)" && bun run dev

typecheck: ## TypeScript の型チェックを実行
	cd "$(WEB_DIR)" && bun run typecheck

test: ## ユニットテストを実行（FILE=tests/example.test.ts で絞り込み）
	cd "$(WEB_DIR)" && if [[ -n "$(FILE)" ]]; then bun test "$(FILE)"; else bun test; fi

e2e: ## Playwright E2E テストを実行
	cd "$(WEB_DIR)" && bunx playwright test

build: ## 本番ビルドを実行
	cd "$(WEB_DIR)" && bun run build

check: ## 型チェック・ユニットテスト・ビルドを順に実行
	@run_step() { \
		local name="$$1" output status; \
		shift; \
		if output="$$($$@ 2>&1)"; then \
			printf '%s: 成功\n' "$$name"; \
		else \
			status="$$?"; \
			printf '%s: 失敗（終了コード %s）\n%s\n' "$$name" "$$status" "$$output" >&2; \
			return "$$status"; \
		fi; \
	}; \
	cd "$(WEB_DIR)"; \
	run_step 'typecheck' bun run typecheck; \
	run_step 'test' bun test; \
	run_step 'build' bun run build

smoke: ## 本番公開 URL の HTTP ステータスを確認（SMOKE_URLS=... で上書き可）
	@failed=0; \
	for url in $(SMOKE_URLS); do \
		code="$$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$$url" || true)"; \
		printf '%s %s\n' "$$code" "$$url"; \
		if [[ ! "$$code" =~ ^[23][0-9][0-9]$$ ]]; then failed=1; fi; \
	done; \
	exit "$$failed"

stream-health: ## 配信の外形4点（Control API・WHIP・RTSP・JWKS）を確認
	@curl -si "$(STREAM_CONTROL_URL)/v3/paths/list"
	@curl -s -X POST -H 'Content-Type: application/sdp' --data 'v=0' -o /dev/null -w '%{http_code}\n' "$(STREAM_PUBLIC_URL)/live/x/whip"
	@# 匿名 read の経路（path は live/[A-Za-z0-9]{12} に限定）を通した 404 を確認するため、未使用の 12 文字 ID を使う
	@ffprobe -rtsp_transport tcp "rtsp://webscreen.tv/live/nonexistent0" || true
	@curl -s "https://web-screen.net/api/streams/jwks/" | head -c 100; printf '\n'

stream-probe: ## 出口の codec・音量・L-R 差分を確認（ID=12文字）
	@id="$(ID)"; \
	if [[ ! "$$id" =~ ^[A-Za-z0-9]{12}$$ ]]; then \
		echo 'ID は英数字12文字で指定してください（例: make stream-probe ID=AbCdEf123456）' >&2; \
		exit 64; \
	fi; \
	url="rtsp://webscreen.tv/live/$$id"; \
	echo 'codec:'; \
	ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_type,codec_name,sample_rate,channels -of default=noprint_wrappers=1 "$$url"; \
	echo '音量:'; \
	ffmpeg -nostdin -hide_banner -rtsp_transport tcp -i "$$url" -t 5 -af 'volumedetect' -f null - 2>&1 | awk '/mean_volume:|max_volume:/'; \
	echo 'L-R 差分（-90 dB 近辺ならモノラル）:'; \
	ffmpeg -nostdin -hide_banner -rtsp_transport tcp -i "$$url" -t 5 -af 'pan=mono|c0=0.5*c0-0.5*c1,volumedetect' -f null - 2>&1 | awk '/mean_volume:|max_volume:/'

stream-logs: MIN ?= 15
stream-logs: ## 配信サーバーの journald を表示（MIN=15、GREP=... で絞り込み）
	@if [[ ! "$(MIN)" =~ ^[0-9]+$$ ]]; then echo 'MIN は0以上の整数で指定してください' >&2; exit 64; fi; \
	ssh "$(STREAM_HOST)" "journalctl -u webscreen-mediamtx-ingress -u webscreen-mediamtx-egress --since '-$(MIN) min'" \
		| if [[ -n "$(GREP)" ]]; then grep -F -- "$(GREP)"; else cat; fi

stream-paths: ## ingress / egress の MediaMTX path 一覧を表示
	@echo 'ingress (:9997):'
	@ssh "$(STREAM_HOST)" 'curl -fsS http://127.0.0.1:9997/v3/paths/list | jq'
	@echo 'egress (:9998):'
	@ssh "$(STREAM_HOST)" 'curl -fsS http://127.0.0.1:9998/v3/paths/list | jq'

latency-probe: MIN ?= 5
# 変数はレシピ文字列へ展開せず環境変数で渡す（Make 変数にシェル記号が入ってもコマンドにならない）
latency-probe: export MIN := $(MIN)
latency-probe: export SOURCE := $(SOURCE)
latency-probe: export PLAYER := $(PLAYER)
latency-probe: export NOTIFY_DISCORD := $(NOTIFY_DISCORD)
latency-probe: export SERVER_SNAP := $(SERVER_SNAP)
latency-probe: export NODE_HOST := $(NODE_HOST)
latency-probe: ## 遅延測定を実行（MIN=5 SOURCE=URL、PLAYER=win2022、NOTIFY_DISCORD=ID、SERVER_SNAP=HOST、NODE_HOST=HOST）
	@script="$(WEB_DIR)/scripts/latency-probe.ts"; \
	if [[ ! -f "$$script" ]]; then echo 'feat/latency-harness をマージしてください' >&2; exit 1; fi; \
	if [[ -z "$$SOURCE" ]]; then echo 'SOURCE=URL を指定してください' >&2; exit 64; fi; \
	cd "$(WEB_DIR)" && bun scripts/latency-probe.ts run --minutes "$$MIN" --source "$$SOURCE" $${PLAYER:+--player "$$PLAYER"} $${NOTIFY_DISCORD:+--notify-discord "$$NOTIFY_DISCORD"} $${SERVER_SNAP:+--server-snap "$$SERVER_SNAP"} $${NODE_HOST:+--node-host "$$NODE_HOST"}

stream-source: ## 遅延測定中の配信元タブの表示先を切り替える（URL=URL）
	@script="$(WEB_DIR)/scripts/latency-probe.ts"; \
	if [[ ! -f "$$script" ]]; then echo 'feat/latency-harness をマージしてください' >&2; exit 1; fi; \
	if [[ -z "$(URL)" ]]; then echo 'URL=URL を指定してください' >&2; exit 64; fi; \
	cd "$(WEB_DIR)" && bun scripts/latency-probe.ts source --url "$(URL)"
