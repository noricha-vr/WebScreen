declare class CaptureController {
  setFocusBehavior(behavior: 'focus-captured-surface' | 'no-focus-change'): void;
}

interface DisplayMediaStreamOptions {
  controller?: CaptureController;
}
