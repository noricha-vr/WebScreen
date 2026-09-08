-- 利用状況の集計（make usage-report）。usage_events は追記専用で行が消えないため、
-- movies の行が保持期間で消えた後も「誰が・いつ・何を・どれだけ」を出せる。
-- 読み取りだけ。実行者は所有者なので表示名を出してよい（外へ貼る時は user_id だけにする）。

-- 1. ユーザー別の利用量（変換本数・容量・種別・最終利用）
SELECT
  u.id AS user_id,
  u.name,
  date(u.created_at, '+9 hours') AS joined_jst,
  SUM(CASE WHEN e.event = 'login' THEN 1 ELSE 0 END) AS logins,
  SUM(CASE WHEN e.event = 'movie_ready' THEN 1 ELSE 0 END) AS movies,
  ROUND(SUM(CASE WHEN e.event = 'movie_ready' THEN COALESCE(e.size_bytes, 0) ELSE 0 END) / 1048576.0, 1) AS movies_mb,
  SUM(CASE WHEN e.event = 'movie_ready' AND e.kind = 'web' THEN 1 ELSE 0 END) AS web,
  SUM(CASE WHEN e.event = 'movie_ready' AND e.kind = 'pdf' THEN 1 ELSE 0 END) AS pdf,
  SUM(CASE WHEN e.event = 'movie_ready' AND e.kind = 'image' THEN 1 ELSE 0 END) AS image,
  SUM(CASE WHEN e.event = 'movie_pinned' THEN 1 ELSE 0 END) AS pinned,
  SUM(CASE WHEN e.event = 'movie_deleted' THEN 1 ELSE 0 END) AS deleted,
  MAX(datetime(e.created_at, '+9 hours')) AS last_active_jst
FROM users u
LEFT JOIN usage_events e ON e.user_id = u.id
GROUP BY u.id
ORDER BY movies DESC, logins DESC, u.id;

-- 2. 日次の推移（JST）
SELECT
  date(created_at, '+9 hours') AS day_jst,
  SUM(CASE WHEN event = 'login' THEN 1 ELSE 0 END) AS logins,
  COUNT(DISTINCT CASE WHEN event = 'login' THEN user_id END) AS login_users,
  SUM(CASE WHEN event = 'movie_ready' THEN 1 ELSE 0 END) AS movies,
  COUNT(DISTINCT CASE WHEN event = 'movie_ready' THEN user_id END) AS creators,
  SUM(CASE WHEN event = 'movie_expired' THEN 1 ELSE 0 END) AS expired,
  SUM(CASE WHEN event = 'movie_deleted' THEN 1 ELSE 0 END) AS deleted
FROM usage_events
GROUP BY day_jst
ORDER BY day_jst;
