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

    state = reduceUpload(state, { type: 'uploaded', publicUrl: 'https://example.com/movies/x.mp4' });
    expect(state.phase).toBe('done');
    expect(state.progress).toBe(100);
    expect(state.publicUrl).toBe('https://example.com/movies/x.mp4');
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
