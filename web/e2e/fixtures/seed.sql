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
    NULL
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
  );
