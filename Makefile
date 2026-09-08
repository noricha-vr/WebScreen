SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

WEB_DIR := web
SMOKE_URLS ?= https://web-screen.net/ https://web-screen.net/api/health/

.PHONY: help install dev typecheck test e2e build check smoke usage-report

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
