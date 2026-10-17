import { describe, expect, it, vi } from "vite-plus/test";

import { installRendererErrorReporting } from "../src/lib/renderer-error-reporting";

// Drives the installer with a plain event target and a recording sender: it is a
// small adapter between two event types and one IPC call.

function fakeWindow() {
  const handlers = new Map<string, (e: never) => void>();
  return {
    location: { href: "app://local/x" },
    addEventListener: (t: string, h: (e: never) => void) => void handlers.set(t, h),
    removeEventListener: (t: string) => void handlers.delete(t),
    fire: (t: string, e: unknown) => handlers.get(t)?.(e as never),
    handlers,
  };
}

describe("renderer error reporting", () => {
  it("sends an uncaught error with message, stack and url", () => {
    const win = fakeWindow();
    const send = vi.fn();
    installRendererErrorReporting(win, send);
    const error = new Error("boom");
    win.fire("error", { error, message: "boom" });
    expect(send).toHaveBeenCalledWith({
      kind: "error",
      message: "boom",
      stack: error.stack,
      url: "app://local/x",
    });
  });

  it("sends an unhandled rejection reason", () => {
    const win = fakeWindow();
    const send = vi.fn();
    installRendererErrorReporting(win, send);
    win.fire("unhandledrejection", { reason: "nope" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unhandledrejection", message: "nope" }),
    );
  });

  it("does nothing without a desktop bridge", () => {
    const win = fakeWindow();
    const stop = installRendererErrorReporting(win, null);
    expect(win.handlers.size).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it("removes its listeners", () => {
    const win = fakeWindow();
    const stop = installRendererErrorReporting(win, vi.fn());
    stop();
    expect(win.handlers.size).toBe(0);
  });
});
