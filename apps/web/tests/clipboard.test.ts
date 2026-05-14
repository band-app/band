// @vitest-environment jsdom
/**
 * Tests for the clipboard compat helper. The most important case is when
 * `navigator.clipboard` is missing entirely — the production failure mode
 * was iPhones loading the dev server over HTTP on a LAN IP, where the
 * Clipboard API is gated behind secure-context and the property is
 * `undefined`. The helper has to detect that and fall back to
 * `document.execCommand('copy')`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readClipboardText, writeClipboardText } from "../src/lib/clipboard";

const realClipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");

afterEach(() => {
  // Restore whatever jsdom installed by default. If the descriptor existed,
  // re-install it on Navigator.prototype; otherwise wipe the per-instance
  // override our setters left behind.
  if (realClipboardDescriptor) {
    Object.defineProperty(Navigator.prototype, "clipboard", realClipboardDescriptor);
  } else {
    // No prototype default existed — drop the per-instance override the
    // tests installed by re-defining the slot as undefined. (Direct
    // assignment fails because `clipboard` is non-writable in the WebIDL
    // bindings jsdom synthesizes.)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  }
  vi.restoreAllMocks();
});

function installClipboard(stub: Partial<Clipboard> | undefined) {
  // Define a per-instance property because the jsdom default is on the
  // prototype and isn't configurable in some versions.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: stub,
  });
}

/**
 * jsdom does not implement `document.execCommand`, so `vi.spyOn` rejects
 * it. Install our own implementation via Object.defineProperty so the
 * helper's call path is exercised. Returns a spy on the implementation
 * for call-tracking.
 */
function installExecCommand(impl: (cmd: string) => boolean): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: fn,
  });
  return fn;
}

// ---------------------------------------------------------------------------
// writeClipboardText
// ---------------------------------------------------------------------------

describe("writeClipboardText – modern API", () => {
  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    installClipboard({ writeText } as unknown as Clipboard);
    const result = await writeClipboardText("hello");
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the modern API rejects", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    installClipboard({ writeText } as unknown as Clipboard);
    const execSpy = installExecCommand(() => true);
    const result = await writeClipboardText("hello");
    expect(result).toBe(true);
    expect(execSpy).toHaveBeenCalledWith("copy");
  });
});

describe("writeClipboardText – non-secure context fallback", () => {
  it("uses execCommand('copy') when navigator.clipboard is undefined", async () => {
    installClipboard(undefined);
    const execSpy = installExecCommand(() => true);
    const result = await writeClipboardText("hello world");
    expect(result).toBe(true);
    expect(execSpy).toHaveBeenCalledWith("copy");
  });

  it("populates and selects a hidden textarea with the payload", async () => {
    installClipboard(undefined);
    let capturedValue: string | undefined;
    let selectCalled = false;
    let setRangeArgs: [number, number] | undefined;
    const origAppend = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLTextAreaElement) {
        capturedValue = node.value;
        const origSelect = node.select.bind(node);
        node.select = () => {
          selectCalled = true;
          origSelect();
        };
        const origSetRange = node.setSelectionRange.bind(node);
        node.setSelectionRange = ((start: number, end: number) => {
          setRangeArgs = [start, end];
          origSetRange(start, end);
        }) as typeof node.setSelectionRange;
      }
      return origAppend(node);
    });
    installExecCommand(() => true);
    await writeClipboardText("hello world");
    expect(capturedValue).toBe("hello world");
    expect(selectCalled).toBe(true);
    expect(setRangeArgs).toEqual([0, "hello world".length]);
  });

  it("returns false when execCommand also fails", async () => {
    installClipboard(undefined);
    installExecCommand(() => false);
    const result = await writeClipboardText("hello");
    expect(result).toBe(false);
  });

  it("cleans up the temporary textarea even when execCommand throws", async () => {
    installClipboard(undefined);
    installExecCommand(() => {
      throw new Error("boom");
    });
    const before = document.body.children.length;
    const result = await writeClipboardText("hello");
    expect(result).toBe(false);
    expect(document.body.children.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// readClipboardText
// ---------------------------------------------------------------------------

describe("readClipboardText", () => {
  it("uses navigator.clipboard.readText when available", async () => {
    const readText = vi.fn(() => Promise.resolve("pasted"));
    installClipboard({ readText } as unknown as Clipboard);
    expect(await readClipboardText()).toBe("pasted");
    expect(readText).toHaveBeenCalled();
  });

  it("returns an empty string when navigator.clipboard is undefined", async () => {
    installClipboard(undefined);
    expect(await readClipboardText()).toBe("");
  });

  it("returns an empty string when the read promise rejects", async () => {
    const readText = vi.fn(() => Promise.reject(new Error("denied")));
    installClipboard({ readText } as unknown as Clipboard);
    expect(await readClipboardText()).toBe("");
  });
});
