import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import en from '../../src/i18n/en.json';
import ja from '../../src/i18n/ja.json';
import { MAX_CAPTURE_IMAGES } from '../../src/lib/contracts/api';
import { renderConvertPanel } from '../../src/lib/ui/convert-panel-view';
import {
  INITIAL_UPLOAD_STATE,
  reduceUpload,
  UPLOAD_ERROR_CODES,
  type UploadErrorCode,
  type UploadState,
} from '../../src/lib/ui/upload-flow';

class FakeNode {
  textContent = '';
  hidden = false;
  readonly style = { width: '' };
  readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

type Dictionary = typeof ja;

/** 画面と同じ data 属性（辞書の値）を持つパネルを作る。 */
class FakePanel {
  readonly dataset: Record<string, string>;

  constructor(t: Dictionary = ja) {
    this.dataset = {
      labelCapturing: t.convert.stageCapturing,
      labelPreparing: t.convert.stagePreparing,
      labelEncoding: t.convert.stageEncoding,
      labelUploading: t.convert.stageUploading,
      labelSelectedFile: t.convert.selectedFile,
      labelSourceUrl: t.convert.sourceUrl,
      msgTooLarge: t.convert.errorTooLarge,
      msgUnsupported: t.convert.errorUnsupported,
      msgTooManyPages: t.convert.errorTooManyPages,
      msgPageTooLong: t.convert.errorPageTooLong,
      msgPageTooLongEstimated: t.convert.errorPageTooLongEstimated,
      msgCaptureTimeout: t.convert.errorCaptureTimeout,
      msgSessionExpired: t.actions.sessionExpired,
      msgFailed: t.convert.errorFailed,
      msgPdfUrlNotSupported: t.convert.errorPdfUrlNotSupported,
      msgImageUrlNotSupported: t.convert.errorImageUrlNotSupported,
      msgVideoUrlNotSupported: t.convert.errorVideoUrlNotSupported,
      msgNonWebPageUrl: t.convert.errorNonWebPageUrl,
      msgWasmLoadTimeout: t.convert.errorWasmLoadTimeout,
      msgImageFetchTimeout: t.convert.errorImageFetchTimeout,
      msgUploadTimeout: t.convert.errorUploadTimeout,
      msgApiTimeout: t.convert.errorApiTimeout,
    };
  }

  readonly nodes = new Map<string, FakeNode>();

  querySelectorAll<T extends Element>(selector: string): T[] {
    const node = this.nodes.get(selector) ?? new FakeNode();
    this.nodes.set(selector, node);
    return [node] as unknown as T[];
  }

  text(selector: string): string {
    return this.nodes.get(selector)?.textContent ?? '';
  }

  node(selector: string): FakeNode {
    return this.nodes.get(selector) ?? new FakeNode();
  }
}

function render(state: UploadState, dictionary: Dictionary = ja): FakePanel {
  const panel = new FakePanel(dictionary);
  renderConvertPanel(panel as unknown as HTMLElement, state);
  return panel;
}

describe('進捗表示', () => {
  test('段階名と % と枚数を同じ段階のものとして描く', () => {
    const capturing = reduceUpload(
      reduceUpload(INITIAL_UPLOAD_STATE, { type: 'selectUrl', url: 'https://example.com' }),
      { type: 'stageProgress', stage: 'capturing', current: 120, total: 213 }
    );

    const panel = render(capturing);

    expect(panel.text('[data-stage-label]')).toBe(ja.convert.stageCapturing);
    expect(panel.text('[data-progress-value]')).toBe('31%');
    expect(panel.text('[data-progress-count]')).toBe('120/213');
  });

  test('枚数を持たない段階では % だけを出す', () => {
    const uploading = reduceUpload(
      reduceUpload(INITIAL_UPLOAD_STATE, { type: 'selectFile', filename: 'slides.pdf', sizeBytes: 1024 }),
      { type: 'converted' }
    );

    const panel = render(uploading);

    expect(panel.text('[data-stage-label]')).toBe(ja.convert.stageUploading);
    expect(panel.text('[data-progress-value]')).toBe('95%');
    expect(panel.text('[data-progress-count]')).toBe('');
  });

  test('段階が決まっていなければ段階名を出さない', () => {
    expect(render(INITIAL_UPLOAD_STATE).text('[data-stage-label]')).toBe('');
  });
});

describe('エラー表示', () => {
  // 画面は data-* 属性でしか文言を受け取らない。属性名が 1 つでも欠けると文言が空になり、
  // エラー欄ごと隠れて「無反応」に見える（この Issue が潰したい症状そのもの）。
  test.each([...UPLOAD_ERROR_CODES])('%s は文言と一緒にエラー欄を出す', (code: UploadErrorCode) => {
    const panel = render({
      ...INITIAL_UPLOAD_STATE,
      phase: 'error',
      errorCode: code,
      errorTarget: 'file',
    });

    expect(panel.text('[data-file-error-message]').length).toBeGreaterThan(0);
    expect(panel.node('[data-file-error]').hidden).toBe(false);
  });

  test('ページが長すぎる時は推定画面数と上限を文言へ入れる', () => {
    const panel = render({
      ...INITIAL_UPLOAD_STATE,
      phase: 'error',
      errorCode: 'pageTooLong',
      errorTarget: 'url',
      errorEstimatedImages: 402,
    });

    const message = panel.text('[data-url-error-message]');
    expect(message).toContain('402');
    expect(message).toContain(String(MAX_CAPTURE_IMAGES));
    expect(message).not.toContain('{');
  });

  test('en でも推定画面数と上限を文言へ入れる', () => {
    const panel = render(
      {
        ...INITIAL_UPLOAD_STATE,
        phase: 'error',
        errorCode: 'pageTooLong',
        errorTarget: 'url',
        errorEstimatedImages: 402,
      },
      en
    );

    const message = panel.text('[data-url-error-message]');
    expect(message).toContain('402');
    expect(message).toContain(String(MAX_CAPTURE_IMAGES));
    expect(message).not.toContain('{');
  });

  test('上限以下の推定画面数は数を出さない', () => {
    // 上流が上限内の数を返すのは不整合。「約 150 画面あり上限の 150 画面を超えています」の
    // ような自己矛盾した文を出さないこと。
    const panel = render({
      ...INITIAL_UPLOAD_STATE,
      phase: 'error',
      errorCode: 'pageTooLong',
      errorTarget: 'url',
      errorEstimatedImages: MAX_CAPTURE_IMAGES,
    });

    const message = panel.text('[data-url-error-message]');
    expect(message).toBe(ja.convert.errorPageTooLong.replaceAll('{max}', String(MAX_CAPTURE_IMAGES)));
  });

  test('推定画面数が無い時は上限だけを伝える', () => {
    const panel = render({
      ...INITIAL_UPLOAD_STATE,
      phase: 'error',
      errorCode: 'pageTooLong',
      errorTarget: 'url',
    });

    const message = panel.text('[data-url-error-message]');
    expect(message).toContain(String(MAX_CAPTURE_IMAGES));
    expect(message).not.toContain('{');
  });
});

describe('画面テンプレート', () => {
  // dataset は kebab-case の属性から作られる。属性名の綴りは tsc が見ないため、
  // 表示コードの一覧とテンプレートの突合をここで固定する。
  const template = readFileSync(new URL('../../src/components/ConvertPanel.astro', import.meta.url), 'utf8');

  test.each([...UPLOAD_ERROR_CODES])('%s の文言を渡す data 属性がある', (code: UploadErrorCode) => {
    const attribute = `data-msg-${code.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`)}=`;

    expect(template).toContain(attribute);
  });

  // エラーコードと 1 対 1 でない文言なので上の総当たりに乗らない。落ちると推定画面数が
  // 消えて「上限だけ」の文言へ静かに退化する。
  test('推定画面数入りの文言を渡す data 属性がある', () => {
    expect(template).toContain('data-msg-page-too-long-estimated=');
  });

  // 文言側のプレースホルダが消えると、差し込みが黙って効かなくなる（上限も枚数も出ない
  // 文が出るだけでテストは緑になる）。辞書の側でも固定する。
  test.each([
    ['ja', ja],
    ['en', en],
  ])('%s の文言に差し込み用のプレースホルダがある', (_language, dictionary) => {
    expect(dictionary.convert.errorPageTooLong).toContain('{max}');
    expect(dictionary.convert.errorPageTooLongEstimated).toContain('{max}');
    expect(dictionary.convert.errorPageTooLongEstimated).toContain('{estimated}');
  });

  test('中止ボタンを置いている', () => {
    expect(template).toContain('data-abort-button');
  });
});
