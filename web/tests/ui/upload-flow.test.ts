import { describe, expect, test } from 'bun:test';

import { MAX_UPLOAD_BYTES } from '../../src/lib/contracts/api';
import {
  ACCEPT_ATTRIBUTE,
  INITIAL_UPLOAD_STATE,
  detectUploadKind,
  preflightInputFiles,
  reduceUpload,
  type UploadEvent,
  type UploadState,
} from '../../src/lib/ui/upload-flow';

function select(filename: string, sizeBytes = 1024): UploadState {
  return reduceUpload(INITIAL_UPLOAD_STATE, { type: 'selectFile', filename, sizeBytes });
}

describe('detectUploadKind', () => {
  test.each([
    ['slides.pdf', 'pdf'],
    ['photo.PNG', 'image'],
    ['photo.jpeg', 'image'],
  ])('%s は %s として扱う', (filename, expected) => {
    expect(detectUploadKind(filename as string)).toBe(expected as never);
  });

  test('拡張子が無い・対応外のファイルは判定できない', () => {
    expect(detectUploadKind('README')).toBeNull();
    expect(detectUploadKind('archive.zip')).toBeNull();
  });

  test('accept 属性は表示している対応形式と同じ集合を並べる', () => {
    expect(ACCEPT_ATTRIBUTE.split(',')).toEqual([
      '.pdf',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
    ]);
  });

  test('画像だけは複数ファイルを 1 回の変換として受け付ける', () => {
    const state = reduceUpload(INITIAL_UPLOAD_STATE, {
      type: 'selectFiles',
      files: [
        { filename: 'first.png', sizeBytes: 100 },
        { filename: 'second.webp', sizeBytes: 100 },
      ],
    });

    expect(state.phase).toBe('converting');
    expect(state.kind).toBe('image');
  });
});

describe('ファイル選択', () => {
  test('対応形式を選ぶと変換中になる', () => {
    const state = select('slides.pdf');

    expect(state.phase).toBe('converting');
    expect(state.source).toBe('slides.pdf');
    expect(state.kind).toBe('pdf');
    expect(state.errorCode).toBeNull();
  });

  test('対応外の形式はエラーになり変換を始めない', () => {
    const state = select('archive.zip');

    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('unsupported');
  });

  test('上限を超えるサイズはエラーになる', () => {
    const state = select('huge.png', MAX_UPLOAD_BYTES + 1);

    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('tooLarge');
  });

  test('上限ちょうどは受け付ける', () => {
    expect(select('limit.png', MAX_UPLOAD_BYTES).phase).toBe('converting');
  });

  test('エラーの後に選び直すとエラー表示が消える', () => {
    const failed = select('archive.zip');
    const retried = reduceUpload(failed, {
      type: 'selectFile',
      filename: 'slides.pdf',
      sizeBytes: 2048,
    });

    expect(retried.phase).toBe('converting');
    expect(retried.errorCode).toBeNull();
  });
});

function file(name: string, bytes: number[], type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('ローカル入力の preflight', () => {
  test.each([
    ['PDF', file('slides.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d], 'application/pdf'), 'pdf'],
    ['PNG', file('photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'), 'image'],
    ['JPEG', file('photo.jpeg', [0xff, 0xd8, 0xff], 'image/jpeg'), 'image'],
    ['GIF', file('photo.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'), 'image'],
    ['WebP', file('photo.webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'image/webp'), 'image'],
  ])('%s の署名と拡張子が整合すると受け付ける', async (_label, input, kind) => {
    await expect(preflightInputFiles([input])).resolves.toEqual({ ok: true, kind: kind as 'pdf' | 'image' });
  });

  test.each([
    ['動画', file('clip.mp4', [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], 'video/mp4')],
    ['署名不足', file('short.png', [0x89, 0x50], 'image/png')],
    ['拡張子と署名の不一致', file('photo.png', [0xff, 0xd8, 0xff], 'image/jpeg')],
    ['既知 MIME の不一致', file('photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/jpeg')],
    ['PDF と画像の混在', [file('slides.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]), file('photo.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]],
    ['複数 PDF', [file('one.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]), file('two.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d])]],
  ])('%s は変換前に拒否する', async (_label, value) => {
    const files = Array.isArray(value) ? value : [value];
    await expect(preflightInputFiles(files)).resolves.toEqual({ ok: false });
  });

  test('空または generic MIME は署名と拡張子が整合すれば補助情報として無視する', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    await expect(preflightInputFiles([file('empty.png', png)])).resolves.toEqual({ ok: true, kind: 'image' });
    await expect(preflightInputFiles([file('generic.png', png, 'application/octet-stream')])).resolves.toEqual({ ok: true, kind: 'image' });
  });
});

describe('変換の進行', () => {
  test('変換 → アップロード → 完了で公開 URL が入る', () => {
    let state = select('slides.pdf');
    state = reduceUpload(state, { type: 'stageProgress', stage: 'preparing', current: 2, total: 4 });
    expect(state.progress).toBe(35);

    state = reduceUpload(state, { type: 'converted' });
    expect(state.phase).toBe('uploading');
    expect(state.stage).toBe('uploading');
    expect(state.progress).toBe(95);

    state = reduceUpload(state, {
      type: 'uploaded',
      publicUrl: 'https://example.com/movies/x.mp4',
      shortId: 'Ab12Cd34Ef56',
    });
    expect(state.phase).toBe('done');
    expect(state.progress).toBe(100);
    expect(state.publicUrl).toBe('https://example.com/movies/x.mp4');
    expect(state.shortId).toBe('Ab12Cd34Ef56');
  });

  test('段階内の進み具合は帯域からはみ出さない', () => {
    const state = reduceUpload(select('slides.pdf'), {
      type: 'stageRatio',
      stage: 'preparing',
      ratio: 1.4,
    });

    expect(state.progress).toBe(70);
  });

  test('変換中の再選択は無視する（二重投入させない）', () => {
    const converting = select('slides.pdf');
    const state = reduceUpload(converting, {
      type: 'selectFile',
      filename: 'other.png',
      sizeBytes: 512,
    });

    expect(state).toBe(converting);
  });

  test('失敗した後にやり直すと初期状態に戻る', () => {
    const failed = reduceUpload(select('slides.pdf'), { type: 'failed', errorCode: 'failed' });
    expect(failed.phase).toBe('error');

    expect(reduceUpload(failed, { type: 'reset' })).toEqual(INITIAL_UPLOAD_STATE);
  });
});

describe('URL からの変換', () => {
  test('URL を送ると web 種別で変換中になる', () => {
    const state = reduceUpload(INITIAL_UPLOAD_STATE, {
      type: 'selectUrl',
      url: 'https://example.com',
    });

    expect(state.phase).toBe('converting');
    expect(state.kind).toBe('web');
    expect(state.source).toBe('https://example.com');
  });

  test('URL 起因のエラーは URL 欄へ出す対象として保持する', () => {
    const selected = reduceUpload(INITIAL_UPLOAD_STATE, {
      type: 'selectUrl',
      url: 'https://example.com/report.pdf',
    });
    const state = reduceUpload(selected, {
      type: 'failed',
      errorCode: 'pdfUrlNotSupported',
      target: 'url',
    });

    expect(state.errorTarget).toBe('url');
    expect(state.errorCode).toBe('pdfUrlNotSupported');
  });
});

describe('段階ごとの進捗', () => {
  function convertingUrl(): UploadState {
    return reduceUpload(INITIAL_UPLOAD_STATE, { type: 'selectUrl', url: 'https://example.com' });
  }

  test('% と枚数は必ず同じ段階のものになる', () => {
    // 撮影が終わっても変換段階の % は撮影の 100% を引き継がない（「100% なのに 88/100」を作らない）。
    let state = reduceUpload(convertingUrl(), {
      type: 'stageProgress',
      stage: 'capturing',
      current: 213,
      total: 213,
    });
    expect(state.progress).toBe(55);
    expect([state.current, state.total]).toEqual([213, 213]);

    state = reduceUpload(state, { type: 'stageProgress', stage: 'encoding', current: 88, total: 100 });

    expect(state.stage).toBe('encoding');
    expect([state.current, state.total]).toEqual([88, 100]);
    // 70〜95% の帯域を 88/100 まで進んだところ。枚数と % が同じ段階を指す。
    expect(state.progress).toBe(92);
  });

  test('段階が進むとバーは後退しない', () => {
    const events: UploadEvent[] = [
      { type: 'stageRatio', stage: 'capturing', ratio: 0.08 },
      { type: 'stageProgress', stage: 'capturing', current: 30, total: 213 },
      { type: 'stageProgress', stage: 'capturing', current: 213, total: 213 },
      { type: 'stageProgress', stage: 'preparing', current: 1, total: 213 },
      { type: 'stageProgress', stage: 'preparing', current: 213, total: 213 },
      { type: 'stageProgress', stage: 'encoding', current: 0, total: 213 },
      { type: 'stageProgress', stage: 'encoding', current: 213, total: 213 },
      { type: 'converted' },
      { type: 'stageRatio', stage: 'uploading', ratio: 0.2 },
      { type: 'stageRatio', stage: 'uploading', ratio: 0.8 },
    ];

    const progresses: number[] = [];
    let state = convertingUrl();
    for (const event of events) {
      state = reduceUpload(state, event);
      progresses.push(state.progress);
    }

    expect(progresses).toEqual([...progresses].sort((a, b) => a - b));
    expect(progresses.at(-1)).toBe(99);
  });

  test('撮影中に総枚数が増えてもバーは戻さない', () => {
    // 遅延読み込みで伸びるページでは総枚数が途中で増える（capture-pages.ts が許容している）。
    // 比率だけ見ると 100/150 → 200/500 で後退するため、到達済みの値を下限にする必要がある。
    let state = convertingUrl();
    state = reduceUpload(state, { type: 'stageProgress', stage: 'capturing', current: 100, total: 150 });
    const before = state.progress;

    state = reduceUpload(state, { type: 'stageProgress', stage: 'capturing', current: 200, total: 500 });

    expect(state.progress).toBeGreaterThanOrEqual(before);
    // 枚数の表示は最新の実態に追従する（バーだけを据え置く）
    expect([state.current, state.total]).toEqual([200, 500]);
  });

  test('遅れて届いた同じ段階の疑似進捗ではバーを戻さない', () => {
    // 疑似進捗のタイマーは実進捗が来た後にも 1 回発火しうる
    let state = convertingUrl();
    state = reduceUpload(state, { type: 'stageProgress', stage: 'capturing', current: 120, total: 213 });
    const before = state.progress;

    state = reduceUpload(state, { type: 'stageRatio', stage: 'capturing', ratio: 0.01 });

    expect(state.progress).toBe(before);
  });

  test('同じ段階で報告が逆行してもバーは戻さない', () => {
    // ffmpeg の progress は稀に前の値より小さい値を返す
    let state = convertingUrl();
    state = reduceUpload(state, { type: 'stageProgress', stage: 'encoding', current: 90, total: 100 });
    const before = state.progress;

    state = reduceUpload(state, { type: 'stageProgress', stage: 'encoding', current: 40, total: 100 });

    expect(state.progress).toBe(before);
    expect([state.current, state.total]).toEqual([40, 100]);
  });

  test('遅れて届いた前の段階の報告ではバーを戻さない', () => {
    let state = reduceUpload(convertingUrl(), {
      type: 'stageProgress',
      stage: 'encoding',
      current: 50,
      total: 100,
    });
    const encoding = state.progress;

    state = reduceUpload(state, { type: 'stageProgress', stage: 'capturing', current: 213, total: 213 });

    expect(state.progress).toBe(encoding);
    expect(state.stage).toBe('encoding');
    expect([state.current, state.total]).toEqual([50, 100]);
  });

  test('URL 変換とファイル変換で帯域が切り替わる', () => {
    const url = reduceUpload(convertingUrl(), {
      type: 'stageProgress',
      stage: 'preparing',
      current: 1,
      total: 1,
    });
    const file = reduceUpload(select('slides.pdf'), {
      type: 'stageProgress',
      stage: 'preparing',
      current: 1,
      total: 1,
    });

    // 撮影段階がある URL 変換は準備を 55〜70%、撮影の無いファイル変換は 0〜70% に割り当てる。
    expect(url.progress).toBe(70);
    expect(file.progress).toBe(70);
    expect(reduceUpload(convertingUrl(), { type: 'stageRatio', stage: 'preparing', ratio: 0 }).progress).toBe(55);
    expect(reduceUpload(select('slides.pdf'), { type: 'stageRatio', stage: 'preparing', ratio: 0 }).progress).toBe(0);
  });

  test('撮影段階はファイル変換では進まない', () => {
    const state = reduceUpload(select('photo.png'), {
      type: 'stageProgress',
      stage: 'capturing',
      current: 1,
      total: 1,
    });

    expect(state.progress).toBe(0);
  });

  test('アップロード段階は枚数を持たない', () => {
    const state = reduceUpload(
      reduceUpload(select('slides.pdf'), { type: 'converted' }),
      { type: 'stageRatio', stage: 'uploading', ratio: 0.8 }
    );

    expect(state.progress).toBe(99);
    expect(state.current).toBeNull();
    expect(state.total).toBeNull();
  });

  test('選択した時点で段階が決まる', () => {
    expect(convertingUrl().stage).toBe('capturing');
    expect(select('slides.pdf').stage).toBe('preparing');
  });

  test('変換前後は進捗イベントを無視する', () => {
    const idle = INITIAL_UPLOAD_STATE;
    expect(reduceUpload(idle, { type: 'stageProgress', stage: 'preparing', current: 1, total: 4 })).toBe(idle);

    const done = reduceUpload(reduceUpload(select('slides.pdf'), { type: 'converted' }), {
      type: 'uploaded',
      publicUrl: 'https://example.com/movies/x.mp4',
      shortId: 'Ab12Cd34Ef56',
    });
    expect(reduceUpload(done, { type: 'stageRatio', stage: 'uploading', ratio: 1 })).toBe(done);
  });

  test('総数が 0 以下の報告は捨てる', () => {
    const converting = select('slides.pdf');
    expect(reduceUpload(converting, { type: 'stageProgress', stage: 'preparing', current: 0, total: 0 })).toBe(
      converting
    );
  });
});

describe('変換対象の上限', () => {
  test('複数ファイルのどれかが 50 MB を超えると変換前に拒否する', () => {
    const state = reduceUpload(INITIAL_UPLOAD_STATE, {
      type: 'selectFiles',
      files: [
        { filename: 'first.png', sizeBytes: 100 },
        { filename: 'too-large.png', sizeBytes: MAX_UPLOAD_BYTES + 1 },
      ],
    });

    expect(state.errorCode).toBe('tooLarge');
  });
});
