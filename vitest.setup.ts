import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// DOM shims Mantine expects (matchMedia, ResizeObserver, scrollIntoView). Guarded so
// this file is a no-op under the default `node` environment; it only does work in
// files that opt into jsdom via a `// @vitest-environment jsdom` header.
if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView = () => {};

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserver;

  // jsdom's Blob omits arrayBuffer() (real browsers and Node both implement it), which
  // sha256Hex needs to hash generated/reference bytes. Shim it via FileReader so
  // component tests can drive a real generation run. No-op if a real implementation exists.
  if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
}
