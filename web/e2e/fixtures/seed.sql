-- e2e 用のローカル D1 データ。playwright.config.ts の webServer が
-- migrations 適用の直後に流し込む（本番 DB には投入しない --local 専用）。
--
-- created_at は D1 の DEFAULT datetime('now') と同じ "YYYY-MM-DD HH:MM:SS"（UTC）形式で入れ、
-- expires_at は実行日からの相対で作る（固定日付にすると時間の経過でテストが壊れるため）。
DELETE FROM movies;
DELETE FROM users;

INSERT INTO users (id, discord_id, name, avatar)
VALUES (1, 'e2e-owner', 'e2e owner', NULL);

INSERT INTO movies (short_id, user_id, filename, size_bytes, status, pinned, created_at, expires_at)
VALUES
  (
    'E2EReady0001',
    1,
    'slides.pdf',
    1048576,
    'ready',
    0,
    datetime('now', '-2 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+15 days')
  ),
  (
    'E2EPinned001',
    1,
    'pinned-clip.mp4',
    2097152,
    'ready',
    1,
    datetime('now', '-3 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+365 days')
  ),
  (
    'E2EPending01',
    1,
    'processing.pdf',
    0,
    'pending',
    0,
    datetime('now', '-1 hours'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+30 days')
  ),
  -- 期限切れ専用。保持期間バッチは e2e では走らないので、行はそのまま残る。
  (
    'E2EExpired01',
    1,
    'expired.pdf',
    1024,
    'ready',
    0,
    datetime('now', '-40 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 days')
  ),
  -- 削除テスト専用。テストは並列実行されるので、状態を変える試験ごとに行を分ける。
  (
    'E2EDelete001',
    1,
    'to-delete.pdf',
    1024,
    'ready',
    0,
    datetime('now', '-1 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+29 days')
  ),
  -- リネーム専用。E2EReady0001 を書き換えると、公開プレビューが期待する
  -- ファイル名・タイトルが崩れる。spec の実行順が変わっても壊れないよう行を分ける。
  (
    'E2ERename001',
    1,
    'rename-me.pdf',
    1048576,
    'ready',
    0,
    datetime('now', '-2 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+15 days')
  ),
  -- pin 解除専用。E2EPinned001 の pin を外すと、残日数を見る他の spec が崩れる。
  -- 3 日前に作られているので、解除すると作成 + 30 日 = あと 27 日に戻る。
  (
    'E2EUnpin0001',
    1,
    'unpin-me.mp4',
    2097152,
    'ready',
    1,
    datetime('now', '-3 days'),
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+365 days')
  );

-- 保持期間バッチの実行記録。e2e ではバッチが走らないので、直前に成功した状態を作って
-- /api/health/ が stale: false を返すことを確認する（0002 の適用漏れもここで落ちる）。
DELETE FROM cron_runs;

INSERT INTO cron_runs (name, last_success_at, last_summary)
VALUES (
  'retention',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-13 minutes'),
  '{"deletedMovies":0,"deletedCaptures":0}'
);
