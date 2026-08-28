import { describe, expect, test } from 'bun:test';

import ja from '../../src/i18n/ja.json';
import { renderConvertPanel } from '../../src/lib/ui/convert-panel-view';
import { INITIAL_UPLOAD_STATE, reduceUpload, type UploadState } from '../../src/lib/ui/upload-flow';

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
