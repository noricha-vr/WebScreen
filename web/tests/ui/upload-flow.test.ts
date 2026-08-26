import { describe, expect, test } from 'bun:test';

import { MAX_UPLOAD_BYTES } from '../../src/lib/contracts/api';
import {
  ACCEPT_ATTRIBUTE,
  INITIAL_UPLOAD_STATE,
  detectUploadKind,
  reduceUpload,
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
    ['clip.mp4', 'video'],
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
      '.mp4',
      '.webm',
      '.mov',
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
    const state = select('huge.mp4', MAX_UPLOAD_BYTES + 1);

    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('tooLarge');
  });

  test('上限ちょうどは受け付ける', () => {
    expect(select('limit.mp4', MAX_UPLOAD_BYTES).phase).toBe('converting');
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

describe('変換の進行', () => {
  test('変換 → アップロード → 完了で公開 URL が入る', () => {
    let state = select('slides.pdf');
    state = reduceUpload(state, { type: 'progress', value: 40 });
    expect(state.progress).toBe(40);

    state = reduceUpload(state, { type: 'converted' });
    expect(state.phase).toBe('uploading');
    expect(state.progress).toBe(0);

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

  test('進捗は 0〜100 に丸める', () => {
    const state = reduceUpload(select('slides.pdf'), { type: 'progress', value: 140 });

    expect(state.progress).toBe(100);
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
});

describe('変換ページの進捗', () => {
  function convertingUrl(): UploadState {
    return reduceUpload(INITIAL_UPLOAD_STATE, { type: 'selectUrl', url: 'https://example.com' });
  }

  test('現在位置と総数から進捗率を出す', () => {
    const state = reduceUpload(select('slides.pdf'), {
      type: 'conversionProgress',
      current: 3,
      total: 10,
    });

    expect(state.progress).toBe(30);
    expect(state.current).toBe(3);
    expect(state.total).toBe(10);
  });

  test('実進捗が疑似進捗より小さくてもバーは戻さず、現在位置と総数だけ更新する', () => {
    const pseudo = reduceUpload(convertingUrl(), { type: 'progress', value: 12 });

    const state = reduceUpload(pseudo, { type: 'conversionProgress', current: 1, total: 30 });

    expect(state.progress).toBe(12);
    expect(state.current).toBe(1);
    expect(state.total).toBe(30);
  });

  test('実進捗が疑似進捗を追い越したら実進捗の値になる', () => {
    let state = reduceUpload(convertingUrl(), { type: 'progress', value: 12 });
    state = reduceUpload(state, { type: 'conversionProgress', current: 1, total: 30 });

    state = reduceUpload(state, { type: 'conversionProgress', current: 5, total: 30 });

    expect(state.progress).toBe(17);
    expect(state.current).toBe(5);
  });

  test('変換中でなければ進捗イベントを無視する', () => {
    const uploading = reduceUpload(select('slides.pdf'), { type: 'converted' });
    expect(uploading.phase).toBe('uploading');

    expect(reduceUpload(uploading, { type: 'conversionProgress', current: 1, total: 4 })).toBe(
      uploading
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
