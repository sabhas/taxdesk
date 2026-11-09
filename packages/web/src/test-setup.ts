import '@testing-library/jest-dom/vitest';

// axe-core probes canvas for color-contrast; jsdom has no canvas implementation.
// Returning null keeps the accessibility checks meaningful without a native
// canvas dependency and without noisy "not implemented" stderr.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;
