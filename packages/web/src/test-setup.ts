import '@testing-library/jest-dom/vitest';

// axe-core probes canvas for color-contrast; jsdom has no canvas implementation.
// Returning null keeps the accessibility checks meaningful without a native
// canvas dependency and without noisy "not implemented" stderr.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

// jsdom has no PointerEvent; Base UI checkboxes construct one when clicked.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}
