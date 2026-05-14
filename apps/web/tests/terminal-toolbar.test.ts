// @vitest-environment jsdom
/**
 * Behaviour tests for the iOS terminal accessory toolbar (issue #390).
 *
 * These tests exercise the *real* React component + hook through the DOM —
 * we do not mock TerminalToolbar or useVirtualKeyboardToolbar. The only
 * dependencies we stub are the browser primitives those modules touch
 * (matchMedia, visualViewport, navigator.clipboard) and the xterm.js
 * Terminal instance (whose public surface is well-defined: hasSelection /
 * getSelection / selectAll / focus).
 *
 * Each test mounts the component, simulates a `pointerdown` (the gesture iOS
 * Safari requires for clipboard access), and asserts the externally
 * observable effect: bytes sent, clipboard writes, or DOM/state changes.
 */
import type { Terminal } from "@xterm/xterm";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalToolbar } from "../src/components/TerminalToolbar";
import { useVirtualKeyboardToolbar } from "../src/hooks/useVirtualKeyboardToolbar";

// ---------------------------------------------------------------------------
// Browser primitive stubs.
// jsdom omits matchMedia + visualViewport. We install them globally and let
// each test override the matchMedia result (touch vs desktop) and viewport
// dimensions (keyboard open vs closed).
// ---------------------------------------------------------------------------

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let matchMediaResult: { matches: boolean; listeners: Set<(e: MediaQueryListEvent) => void> };
let vvHeight: number;
let vvOffsetTop: number;
let vvListeners: Set<() => void>;
let originalMatchMedia: typeof window.matchMedia | undefined;
let originalVisualViewport: VisualViewport | undefined;

beforeEach(() => {
  matchMediaResult = { matches: true, listeners: new Set() };
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matchMediaResult.matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      matchMediaResult.listeners.add(cb);
    },
    removeEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
      matchMediaResult.listeners.delete(cb);
    },
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  vvHeight = 800;
  vvOffsetTop = 0;
  vvListeners = new Set();
  // window.innerHeight defaults to 768 in jsdom; force a known value.
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  originalVisualViewport = window.visualViewport ?? undefined;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      get height() {
        return vvHeight;
      },
      get offsetTop() {
        return vvOffsetTop;
      },
      addEventListener: (_event: string, cb: () => void) => {
        vvListeners.add(cb);
      },
      removeEventListener: (_event: string, cb: () => void) => {
        vvListeners.delete(cb);
      },
    },
  });
});

afterEach(() => {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  if (originalVisualViewport !== undefined) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  }
});

afterAll(() => {
  // Restore jsdom defaults for any cross-file leakage.
  Reflect.deleteProperty(window, "visualViewport");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setKeyboardOpen(keyboardPx: number) {
  vvHeight = 800 - keyboardPx;
  for (const cb of vvListeners) cb();
}

function setTouchDevice(touch: boolean) {
  matchMediaResult.matches = touch;
  // matchMedia listeners receive a MediaQueryListEvent — we only read .matches.
  for (const cb of matchMediaResult.listeners) {
    cb({ matches: touch } as MediaQueryListEvent);
  }
}

interface FakeTerminal {
  selection: string;
  selectAllCalls: number;
  focusCalls: number;
  hasSelection: () => boolean;
  getSelection: () => string;
  selectAll: () => void;
  focus: () => void;
}

function makeFakeTerminal(initialSelection = ""): FakeTerminal {
  const t: FakeTerminal = {
    selection: initialSelection,
    selectAllCalls: 0,
    focusCalls: 0,
    hasSelection: () => t.selection.length > 0,
    getSelection: () => t.selection,
    selectAll: () => {
      t.selectAllCalls += 1;
      t.selection = "all-selected";
    },
    focus: () => {
      t.focusCalls += 1;
    },
  };
  return t;
}

function mount(props: {
  terminal: FakeTerminal;
  sendInput: (data: string) => void;
  pendingCtrl?: boolean;
  onToggleCtrl?: () => void;
}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      createElement(TerminalToolbar, {
        terminal: props.terminal as unknown as Terminal,
        sendInput: props.sendInput,
        pendingCtrl: props.pendingCtrl ?? false,
        onToggleCtrl: props.onToggleCtrl ?? (() => {}),
      }),
    );
  });
  return { container, root: root as Root };
}

function unmount(root: Root, container: HTMLDivElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function dispatchPointerDown(el: Element) {
  // jsdom doesn't ship a PointerEvent constructor; React's synthetic event
  // bridge accepts a MouseEvent of type "pointerdown" just fine for the
  // pointerdown listener we attach in the toolbar.
  const ev = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

// ---------------------------------------------------------------------------
// Hook: useVirtualKeyboardToolbar
// ---------------------------------------------------------------------------

describe("useVirtualKeyboardToolbar", () => {
  function renderToolbarHook() {
    const result: { current: ReturnType<typeof useVirtualKeyboardToolbar> | undefined } = {
      current: undefined,
    };
    function TestComponent() {
      result.current = useVirtualKeyboardToolbar();
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    act(() => {
      root = createRoot(container);
      root.render(createElement(TestComponent));
    });
    return {
      result,
      unmount: () => unmount(root as Root, container),
    };
  }

  it("returns enabled=true on touch-only devices", () => {
    setTouchDevice(true);
    const { result, unmount: u } = renderToolbarHook();
    expect(result.current?.enabled).toBe(true);
    u();
  });

  it("returns enabled=false on desktop (hover-capable pointer)", () => {
    setTouchDevice(false);
    const { result, unmount: u } = renderToolbarHook();
    expect(result.current?.enabled).toBe(false);
    u();
  });

  it("bottomOffset is 0 when the virtual keyboard is closed", () => {
    setTouchDevice(true);
    const { result, unmount: u } = renderToolbarHook();
    expect(result.current?.bottomOffset).toBe(0);
    u();
  });

  it("bottomOffset tracks the keyboard pixel height when open", () => {
    setTouchDevice(true);
    const { result, unmount: u } = renderToolbarHook();
    act(() => {
      setKeyboardOpen(300);
    });
    expect(result.current?.bottomOffset).toBe(300);
    u();
  });

  it("clamps a negative measurement to 0 (defensive against stale geometry)", () => {
    setTouchDevice(true);
    const { result, unmount: u } = renderToolbarHook();
    act(() => {
      // Visual viewport reports MORE area than window.innerHeight — should not
      // push the toolbar off-screen.
      vvHeight = 1000;
      for (const cb of vvListeners) cb();
    });
    expect(result.current?.bottomOffset).toBe(0);
    u();
  });
});

// ---------------------------------------------------------------------------
// Component: TerminalToolbar
// ---------------------------------------------------------------------------

describe("TerminalToolbar – visibility", () => {
  it("renders nothing on desktop", () => {
    setTouchDevice(false);
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    expect(container.querySelector("[data-testid='terminal-toolbar']")).toBeNull();
    unmount(root, container);
  });

  it("renders the toolbar on touch-only devices", () => {
    setTouchDevice(true);
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    expect(container.querySelector("[data-testid='terminal-toolbar']")).not.toBeNull();
    unmount(root, container);
  });

  it("positions itself bottomOffset pixels above the viewport bottom", () => {
    setTouchDevice(true);
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    // Open the keyboard *after* the toolbar is mounted to exercise the
    // visualViewport resize subscription.
    act(() => {
      setKeyboardOpen(280);
    });
    const el = container.querySelector("[data-testid='terminal-toolbar']") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.bottom).toBe("280px");
    unmount(root, container);
  });
});

describe("TerminalToolbar – clipboard actions", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let readText: ReturnType<typeof vi.fn>;
  let originalClipboard: Clipboard | undefined;

  beforeEach(() => {
    setTouchDevice(true);
    writeText = vi.fn(() => Promise.resolve());
    readText = vi.fn(() => Promise.resolve("pasted-text"));
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText },
    });
  });

  afterEach(() => {
    if (originalClipboard !== undefined) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("Copy writes the terminal selection to the clipboard", async () => {
    const term = makeFakeTerminal("hello world");
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    const copyBtn = container.querySelector(
      "button[aria-label='Copy selection']",
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.disabled).toBe(false);
    await act(async () => {
      dispatchPointerDown(copyBtn);
      // Microtask flush so the async handler resolves before we assert.
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello world");
    unmount(root, container);
  });

  it("Copy button is disabled when there is no selection", () => {
    const term = makeFakeTerminal("");
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    const copyBtn = container.querySelector(
      "button[aria-label='Copy selection']",
    ) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
    unmount(root, container);
  });

  it("Paste reads the clipboard and forwards via sendInput", async () => {
    const sent: string[] = [];
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: (d) => sent.push(d) });
    const pasteBtn = container.querySelector(
      "button[aria-label='Paste from clipboard']",
    ) as HTMLButtonElement;
    await act(async () => {
      dispatchPointerDown(pasteBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["pasted-text"]);
    unmount(root, container);
  });

  it("Paste silently swallows clipboard denial (no exception bubbles)", async () => {
    readText.mockRejectedValueOnce(new Error("denied"));
    const sent: string[] = [];
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: (d) => sent.push(d) });
    const pasteBtn = container.querySelector(
      "button[aria-label='Paste from clipboard']",
    ) as HTMLButtonElement;
    const errorSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      dispatchPointerDown(pasteBtn);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sent).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    unmount(root, container);
  });

  it("Select All asks xterm to select everything and re-focuses", () => {
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: () => {} });
    const allBtn = container.querySelector("button[aria-label='Select all']") as HTMLButtonElement;
    act(() => {
      dispatchPointerDown(allBtn);
    });
    expect(term.selectAllCalls).toBe(1);
    expect(term.focusCalls).toBe(1);
    unmount(root, container);
  });
});

describe("TerminalToolbar – special keys", () => {
  beforeEach(() => {
    setTouchDevice(true);
  });

  it("Esc, Tab, and arrow keys send the canonical ANSI escape sequences", () => {
    const sent: string[] = [];
    const term = makeFakeTerminal();
    const { container, root } = mount({ terminal: term, sendInput: (d) => sent.push(d) });
    const tap = (label: string) => {
      const btn = container.querySelector(`button[aria-label='${label}']`) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      act(() => {
        dispatchPointerDown(btn);
      });
    };
    tap("Send Escape");
    tap("Send Tab");
    tap("Arrow Up");
    tap("Arrow Down");
    tap("Arrow Left");
    tap("Arrow Right");
    expect(sent).toEqual(["\x1b", "\t", "\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C"]);
    unmount(root, container);
  });

  it("Ctrl button toggles a pending state via onToggleCtrl", () => {
    const onToggleCtrl = vi.fn();
    const term = makeFakeTerminal();
    const { container, root } = mount({
      terminal: term,
      sendInput: () => {},
      pendingCtrl: false,
      onToggleCtrl,
    });
    const ctrlBtn = container.querySelector(
      "button[aria-label='Arm Ctrl modifier']",
    ) as HTMLButtonElement;
    expect(ctrlBtn.getAttribute("aria-pressed")).toBeNull();
    act(() => {
      dispatchPointerDown(ctrlBtn);
    });
    expect(onToggleCtrl).toHaveBeenCalledTimes(1);
    unmount(root, container);
  });

  it("renders the Ctrl button as pressed when pendingCtrl is true", () => {
    const term = makeFakeTerminal();
    const { container, root } = mount({
      terminal: term,
      sendInput: () => {},
      pendingCtrl: true,
      onToggleCtrl: () => {},
    });
    const ctrlBtn = container.querySelector(
      "button[aria-label='Cancel pending Ctrl']",
    ) as HTMLButtonElement;
    expect(ctrlBtn).not.toBeNull();
    expect(ctrlBtn.getAttribute("aria-pressed")).toBe("true");
    unmount(root, container);
  });
});
