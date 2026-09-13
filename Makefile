SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

WEB_DIR := web
SMOKE_URLS ?= https://web-screen.net/ https://web-screen.net/api/health/

.PHONY: help install dev typecheck test e2e build check smoke usage-report video-check vrchat-status vrchat-start vrchat-snapshot vrchat-paste test-tools

# 外部入力をレシピへ直接展開しない。value で Make の再展開も避ける。
export TOOL_FILE := $(value FILE)
export TOOL_GREP := $(value GREP)
export TOOL_URL := $(value URL)
export VRCHAT_SSH_HOST := $(value VRCHAT_SSH_HOST)

help: ## 利用可能な開発・運用コマンドを表示
	@awk 'BEGIN { FS = ":.*##"; printf "使い方: make <target> [VAR=value]\n\n" } /^##@/ { printf "\n%s\n", substr($$0, 5) } /^[a-zA-Z0-9_-]+:.*##/ { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '  %-20s %s\n' 'deploy' 'デプロイは main への push（CI）'

##@ 開発
install: ## web の依存関係を lockfile 固定でインストール
	cd "$(WEB_DIR)" && bun install --frozen-lockfile

dev: ## ローカル開発サーバーを起動
	cd "$(WEB_DIR)" && bun run dev

##@ 自動検証
typecheck: ## TypeScript の型チェックを実行
	cd "$(WEB_DIR)" && bun run typecheck

test: ## ユニットテストを実行（FILE=tests/example.test.ts で絞り込み）
	cd "$(WEB_DIR)" && if [[ -n "$$TOOL_FILE" ]]; then bun test "$$TOOL_FILE"; else bun test; fi

e2e: ## Playwright E2E テストを実行
	cd "$(WEB_DIR)" && args=(); [[ -z "$$TOOL_FILE" ]] || args+=("$$TOOL_FILE"); [[ -z "$$TOOL_GREP" ]] || args+=(--grep "$$TOOL_GREP"); bunx playwright test "$${args[@]}"

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

##@ 運用
usage-report: ## 本番 D1 の利用ログ（usage_events）からユーザー別・日次の利用状況を表示（読み取りのみ）
	cd "$(WEB_DIR)" && bunx wrangler d1 execute webscreen-beta-db --remote --file scripts/usage-report.sql

smoke: ## 本番公開 URL の HTTP ステータスを確認（SMOKE_URLS=... で上書き可）
	@failed=0; \
	for url in $(SMOKE_URLS); do \
		code="$$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 "$$url" || true)"; \
		printf '%s %s\n' "$$code" "$$url"; \
		if [[ ! "$$code" =~ ^[23][0-9][0-9]$$ ]]; then failed=1; fi; \
	done; \
	exit "$$failed"

##@ 動画・Windows 実機（VRCHAT_SSH_HOST を設定）
video-check: ## MP4 契約を検査（FILE=動画.mp4、ffprobe 必須）
	@test -n "$$TOOL_FILE" || { echo 'FILE=動画.mp4 を指定してください' >&2; exit 2; }
	python3 web/scripts/video-check.py -- "$$TOOL_FILE"

test-tools: ## 操作ツールと MP4 検査のテスト（実機接続なし）
	python3 -m unittest discover -s web/tests/tools -v

vrchat-status: ## Windows の VRChat・対話セッション・残留タスクを確認
	python3 web/scripts/windows-player-control.py status

vrchat-start: ## Steam 経由で VRChat を起動（起動後に画面を確認）
	python3 web/scripts/windows-player-control.py launch

vrchat-snapshot: ## VRChat の画面を docs/tmp/windows-player/screen.png に保存
	python3 web/scripts/windows-player-control.py snapshot

vrchat-paste: ## URL=公開 MP4 URL を貼付（確定は画像確認後）
	python3 web/scripts/windows-player-control.py paste-url -- "$$TOOL_URL"
