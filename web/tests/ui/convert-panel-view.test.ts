import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';

import ja from '../../src/i18n/ja.json';
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

/** 画面と同じ data 属性（辞書の値）を持つパネルを作る。 */
class FakePanel {
  readonly dataset: Record<string, string> = {
    labelCapturing: ja.convert.stageCapturing,
    labelPreparing: ja.convert.stagePreparing,
    labelEncoding: ja.convert.stageEncoding,
    labelUploading: ja.convert.stageUploading,
    labelSelectedFile: ja.convert.selectedFile,
    labelSourceUrl: ja.convert.sourceUrl,
    msgTooLarge: ja.convert.errorTooLarge,
    msgUnsupported: ja.convert.errorUnsupported,
    msgTooManyPages: ja.convert.errorTooManyPages,
    msgPageTooLong: ja.convert.errorPageTooLong,
    msgCaptureTimeout: ja.convert.errorCaptureTimeout,
    msgSessionExpired: ja.actions.sessionExpired,
    msgFailed: ja.convert.errorFailed,
    msgPdfUrlNotSupported: ja.convert.errorPdfUrlNotSupported,
    msgImageUrlNotSupported: ja.convert.errorImageUrlNotSupported,
    msgVideoUrlNotSupported: ja.convert.errorVideoUrlNotSupported,
    msgNonWebPageUrl: ja.convert.errorNonWebPageUrl,
    msgWasmLoadTimeout: ja.convert.errorWasmLoadTimeout,
    msgImageFetchTimeout: ja.convert.errorImageFetchTimeout,
    msgUploadTimeout: ja.convert.errorUploadTimeout,
    msgApiTimeout: ja.convert.errorApiTimeout,
  };
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

function render(state: UploadState): FakePanel {
  const panel = new FakePanel();
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
});

describe('画面テンプレート', () => {
  // dataset は kebab-case の属性から作られる。属性名の綴りは tsc が見ないため、
  // 表示コードの一覧とテンプレートの突合をここで固定する。
  const template = readFileSync(new URL('../../src/components/ConvertPanel.astro', import.meta.url), 'utf8');

  test.each([...UPLOAD_ERROR_CODES])('%s の文言を渡す data 属性がある', (code: UploadErrorCode) => {
    const attribute = `data-msg-${code.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`)}=`;

    expect(template).toContain(attribute);
  });

  test('中止ボタンを置いている', () => {
    expect(template).toContain('data-abort-button');
  });
});
