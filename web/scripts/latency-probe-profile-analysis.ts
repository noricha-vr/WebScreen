/** quality/realtime を切り替えた時刻と設定値。 */
export interface ProfileSwitch {
  observedAtMs: number;
  elapsedSeconds: number;
  profile: 'quality' | 'realtime';
  maxBitrate: number;
  /** 切替か、sender の差し替え後に同じ設定を再適用したか。 */
  action?: 'applied' | 'reapplied';
  /** 実行中だけsenderの差し替えを検出するための識別子。CSVには保存しない。 */
  senderIdentity?: string;
}

/** プロファイル区間へ分けた時系列標本。 */
export interface ProfileSegment<T extends { observedAtMs: number }> {
  profile: ProfileSwitch['profile'] | 'unknown';
  startedAtMs: number | null;
  endedAtMs: number | null;
  samples: T[];
}

/** profile-switches.csvを読み、壊れた切替履歴を明示的に拒否する。 */
export function parseProfileSwitchesCsv(csv: string): ProfileSwitch[] {
  const rows = csv.trim().split(/\r?\n/);
  const legacyHeader = 'timestamp_utc,elapsed_s,profile,max_bitrate';
  const currentHeader = `${legacyHeader},action`;
  if (!rows.length || (rows[0] !== legacyHeader && rows[0] !== currentHeader)) throw new Error('unexpected profile switches CSV header');
  if (rows.length < 2 || !rows[1]) throw new Error('profile switches CSV must include an initial profile');
  let previousAtMs = Number.NEGATIVE_INFINITY;
  return rows.slice(1).filter(Boolean).map((row, index) => {
    const [timestamp, elapsed, profile, maxBitrate, action = 'applied'] = row.split(',');
    const observedAtMs = Date.parse(timestamp ?? '');
    const elapsedSeconds = Number(elapsed);
    const parsedMaxBitrate = Number(maxBitrate);
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(elapsedSeconds) || !Number.isInteger(parsedMaxBitrate) || parsedMaxBitrate <= 0) throw new Error(`invalid profile switch at row ${index + 2}`);
    if (profile !== 'quality' && profile !== 'realtime') throw new Error(`invalid profile at row ${index + 2}`);
    if (action !== 'applied' && action !== 'reapplied') throw new Error(`invalid profile action at row ${index + 2}`);
    if (observedAtMs <= previousAtMs) throw new Error(`profile switches must be strictly chronological at row ${index + 2}`);
    previousAtMs = observedAtMs;
    return { observedAtMs, elapsedSeconds, profile, maxBitrate: parsedMaxBitrate, action };
  });
}

/** profile-switches.csv本文を作る。 */
export function formatProfileSwitchesCsv(switches: readonly ProfileSwitch[]): string {
  return ['timestamp_utc,elapsed_s,profile,max_bitrate,action', ...switches.map((item) => [new Date(item.observedAtMs).toISOString(), item.elapsedSeconds.toFixed(3), item.profile, item.maxBitrate, item.action ?? 'applied'].join(','))].join('\n') + '\n';
}

/** 切替履歴で標本を区間化し、実際の切替後だけ過渡標本を除外する。 */
export function splitByProfile<T extends { observedAtMs: number }>(samples: readonly T[], switches: readonly ProfileSwitch[], transientSeconds: number): ProfileSegment<T>[] {
  if (!Number.isFinite(transientSeconds) || transientSeconds < 0) throw new Error('transientSeconds must be non-negative');
  if (!switches.length) return [{ profile: 'unknown', startedAtMs: null, endedAtMs: null, samples: [...samples] }];
  return switches.map((profileSwitch, index) => {
    const endsAtMs = switches[index + 1]?.observedAtMs ?? null;
    // 初期行は切替ではない。画面共有開始時の標本を過渡扱いにすると最初の区間を不必要に捨てる。
    const usableFromMs = profileSwitch.observedAtMs + (index === 0 ? 0 : transientSeconds * 1_000);
    return { profile: profileSwitch.profile, startedAtMs: profileSwitch.observedAtMs, endedAtMs: endsAtMs, samples: samples.filter((sample) => sample.observedAtMs >= usableFromMs && (endsAtMs === null || sample.observedAtMs < endsAtMs)) };
  });
}

/** 同じプロファイルの区間標本をプールし、全区間の集計へ渡す。 */
export function poolProfileSegments<T extends { observedAtMs: number }>(segments: readonly ProfileSegment<T>[], profile: ProfileSwitch['profile']): T[] {
  return segments.filter((segment) => segment.profile === profile).flatMap((segment) => segment.samples);
}
