// @vitest-environment jsdom
/**
 * Tests for the zoom helpers backing the TerminalPanel's response to app-zoom
 * changes (band-app/band#463). The CSS variable + custom-event plumbing is
 * what lets the terminal counter-scale itself out of the document-level
 * `zoom` while still driving `terminal.options.fontSize` from the live zoom
 * factor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyZoomLevel,
  DEFAULT_ZOOM,
  getCurrentZoomLevel,
  MAX_ZOOM,
  MIN_ZOOM,
  subscribeToZoomChanges,
  ZOOM_CHANGE_EVENT,
  ZOOM_CSS_VAR,
} from "../src/lib/zoom";

function resetZoomState() {
  // Clear the persisted value so each test starts from a known baseline. The
  // CSS var on <html> is cleared too so `getCurrentZoomLevel` falls back
  // cleanly.
  try {
    localStorage.removeItem("band:zoom-level");
  } catch {}
  document.documentElement.style.removeProperty(ZOOM_CSS_VAR);
  document.documentElement.style.removeProperty("zoom");
}

beforeEach(resetZoomState);
afterEach(resetZoomState);

describe("applyZoomLevel", () => {
  it("writes `zoom` and `--app-zoom` to <html>", () => {
    applyZoomLevel(1.5);
    expect(document.documentElement.style.zoom).toBe("1.5");
    expect(document.documentElement.style.getPropertyValue(ZOOM_CSS_VAR)).toBe("1.5");
  });

  it("persists the rounded value to localStorage", () => {
    applyZoomLevel(1.234567); // rounded to 1.23
    expect(localStorage.getItem("band:zoom-level")).toBe("1.23");
    // CSS var matches the rounded value, not the raw input.
    expect(document.documentElement.style.getPropertyValue(ZOOM_CSS_VAR)).toBe("1.23");
  });

  it("clamps to [MIN_ZOOM, MAX_ZOOM]", () => {
    applyZoomLevel(10);
    expect(document.documentElement.style.zoom).toBe(String(MAX_ZOOM));
    applyZoomLevel(0);
    expect(document.documentElement.style.zoom).toBe(String(MIN_ZOOM));
  });

  it("dispatches a `band:zoom-changed` window event with the new level", () => {
    const events: number[] = [];
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      events.push(detail);
    };
    window.addEventListener(ZOOM_CHANGE_EVENT, listener);
    try {
      applyZoomLevel(1.2);
      applyZoomLevel(0.75);
    } finally {
      window.removeEventListener(ZOOM_CHANGE_EVENT, listener);
    }
    expect(events).toEqual([1.2, 0.75]);
  });
});

describe("getCurrentZoomLevel", () => {
  it("returns DEFAULT_ZOOM when nothing has been applied and storage is empty", () => {
    expect(getCurrentZoomLevel()).toBe(DEFAULT_ZOOM);
  });

  it("prefers the live CSS variable over the persisted value", () => {
    // Persisted: 1.5; live CSS var: 0.8. The CSS var wins because it reflects
    // what the DOM is actually rendering with (e.g. another window pushed an
    // update via the storage event handler — see ZoomSync).
    localStorage.setItem("band:zoom-level", "1.5");
    document.documentElement.style.setProperty(ZOOM_CSS_VAR, "0.8");
    expect(getCurrentZoomLevel()).toBe(0.8);
  });

  it("falls back to localStorage when the CSS variable is missing", () => {
    localStorage.setItem("band:zoom-level", "1.7");
    expect(getCurrentZoomLevel()).toBe(1.7);
  });

  it("ignores out-of-range values in the CSS variable and falls through", () => {
    document.documentElement.style.setProperty(ZOOM_CSS_VAR, "5");
    localStorage.setItem("band:zoom-level", "1.3");
    expect(getCurrentZoomLevel()).toBe(1.3);
  });
});

describe("subscribeToZoomChanges", () => {
  it("invokes the handler with the new zoom level on every applyZoomLevel call", () => {
    const calls: number[] = [];
    const unsubscribe = subscribeToZoomChanges((level) => calls.push(level));
    try {
      applyZoomLevel(0.9);
      applyZoomLevel(1.1);
      applyZoomLevel(2.0);
    } finally {
      unsubscribe();
    }
    expect(calls).toEqual([0.9, 1.1, 2.0]);
  });

  it("stops invoking the handler after unsubscribe", () => {
    const calls: number[] = [];
    const unsubscribe = subscribeToZoomChanges((level) => calls.push(level));
    applyZoomLevel(1.2);
    unsubscribe();
    applyZoomLevel(0.7);
    expect(calls).toEqual([1.2]);
  });

  it("handles multiple concurrent subscribers independently", () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribeToZoomChanges((level) => a.push(level));
    const unsubB = subscribeToZoomChanges((level) => b.push(level));
    try {
      applyZoomLevel(1.3);
      unsubA();
      applyZoomLevel(0.6);
    } finally {
      unsubB();
    }
    expect(a).toEqual([1.3]);
    expect(b).toEqual([1.3, 0.6]);
  });

  it("does not fire when a non-CustomEvent (no detail) is dispatched on the same name", () => {
    // Defensive: the handler ignores events without a numeric detail so an
    // accidental `window.dispatchEvent(new Event(ZOOM_CHANGE_EVENT))`
    // anywhere in the app doesn't blow up subscribers.
    const calls: number[] = [];
    const unsubscribe = subscribeToZoomChanges((level) => calls.push(level));
    try {
      window.dispatchEvent(new Event(ZOOM_CHANGE_EVENT));
    } finally {
      unsubscribe();
    }
    expect(calls).toEqual([]);
  });
});
