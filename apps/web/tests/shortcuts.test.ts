// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assignBinding,
  COMMAND_DEFS,
  chordFromEvent,
  defaultChordFor,
  effectiveChord,
  eventMatchesChord,
  findConflicts,
  getOverrides,
  isOverridden,
  matchesCommand,
  normalizeChord,
  parseChord,
  parseOverrides,
  resetAllBindings,
  resetBinding,
  SHORTCUT_OVERRIDES_KEY,
  setBinding,
} from "../src/lib/shortcuts";

function key(init: Partial<KeyboardEventInit> & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

describe("shortcut registry", () => {
  beforeEach(() => {
    setPlatform("MacIntel");
    localStorage.clear();
    resetAllBindings();
  });
  afterEach(() => {
    localStorage.clear();
    resetAllBindings();
  });

  it("gives every command a unique id and every default chord to one command only", () => {
    const ids = COMMAND_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mac of ["MacIntel", "Win32"]) {
      setPlatform(mac);
      const seen = new Map<string, string>();
      for (const d of COMMAND_DEFS) {
        const c = defaultChordFor(d.id);
        if (!c) continue;
        const n = normalizeChord(c) as string;
        expect(seen.get(n), `${mac}: ${d.id} shares ${n} with ${seen.get(n)}`).toBeUndefined();
        seen.set(n, d.id);
      }
    }
  });

  it("matches shifted bracket chords by physical key (⌘⇧[ and ⌘⇧])", () => {
    expect(
      matchesCommand(
        key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }),
        "next-tab",
      ),
    ).toBe(true);
    expect(
      matchesCommand(
        key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }),
        "previous-tab",
      ),
    ).toBe(true);
    expect(
      matchesCommand(key({ key: "]", code: "BracketRight", metaKey: true }), "next-pane"),
    ).toBe(true);
    expect(
      matchesCommand(
        key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }),
        "next-pane",
      ),
    ).toBe(false);
  });

  it("zooms in on ⌘= and ⌘+", () => {
    expect(matchesCommand(key({ key: "=", code: "Equal", metaKey: true }), "zoom-in")).toBe(true);
    expect(
      matchesCommand(key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), "zoom-in"),
    ).toBe(true);
  });

  it("keeps ⌘0 and ⌃0 apart on macOS and lets Meta stand in for Ctrl elsewhere", () => {
    const cmd0 = key({ key: "0", code: "Digit0", metaKey: true });
    const ctrl0 = key({ key: "0", code: "Digit0", ctrlKey: true });
    expect(matchesCommand(cmd0, "show-all-repos")).toBe(true);
    expect(matchesCommand(cmd0, "focus-repos")).toBe(false);
    expect(matchesCommand(ctrl0, "focus-repos")).toBe(true);
    expect(matchesCommand(ctrl0, "show-all-repos")).toBe(false);
    setPlatform("Win32");
    // Both chords name Ctrl+0 off macOS; Meta+0 only matches the platform-modifier command.
    expect(matchesCommand(ctrl0, "focus-repos")).toBe(true);
    expect(matchesCommand(cmd0, "show-all-repos")).toBe(true);
    expect(matchesCommand(cmd0, "focus-repos")).toBe(false);
  });

  it("stores an override, stops matching the old chord and survives a re-read", () => {
    setBinding("quick-open", "Cmd+Shift+O");
    expect(effectiveChord("quick-open")).toBe("Cmd+Shift+O");
    expect(matchesCommand(key({ key: "p", code: "KeyP", metaKey: true }), "quick-open")).toBe(
      false,
    );
    expect(
      matchesCommand(key({ key: "O", code: "KeyO", metaKey: true, shiftKey: true }), "quick-open"),
    ).toBe(true);
    expect(JSON.parse(localStorage.getItem(SHORTCUT_OVERRIDES_KEY) as string)).toEqual({
      "quick-open": "Cmd+Shift+O",
    });
    expect(getOverrides()["quick-open"]).toBe("Cmd+Shift+O");
  });

  it("clears, resets one and resets all", () => {
    setBinding("quick-open", null);
    expect(effectiveChord("quick-open")).toBeUndefined();
    expect(isOverridden("quick-open")).toBe(true);
    resetBinding("quick-open");
    expect(effectiveChord("quick-open")).toBe("Cmd+P");
    setBinding("find-in-file", null);
    setBinding("quick-open", "Cmd+Shift+O");
    resetAllBindings();
    expect(localStorage.getItem(SHORTCUT_OVERRIDES_KEY)).toBeNull();
    expect(effectiveChord("find-in-file")).toBe("Cmd+F");
  });

  it("binds a chord to a context-menu action that has no default", () => {
    expect(effectiveChord("worktree-git-pull")).toBeUndefined();
    setBinding("worktree-git-pull", "Cmd+Alt+L");
    expect(effectiveChord("worktree-git-pull")).toBe("Cmd+Alt+L");
  });

  it("reports the commands that hold a chord and takes it over on assign", () => {
    expect(findConflicts("Cmd+P", "worktree-git-pull").map((d) => d.id)).toEqual(["quick-open"]);
    assignBinding("worktree-git-pull", "Cmd+P");
    expect(effectiveChord("quick-open")).toBeUndefined();
    expect(effectiveChord("worktree-git-pull")).toBe("Cmd+P");
  });

  it("ignores malformed stored values and unknown shapes", () => {
    expect(parseOverrides("not json")).toEqual({});
    expect(parseOverrides("[1]")).toEqual({});
    expect(parseOverrides('{"a":"Cmd+K","b":5,"c":null,"d":"Hyper+K"}')).toEqual({
      a: "Cmd+K",
      c: null,
    });
  });

  it("records a chord from a keydown", () => {
    expect(
      chordFromEvent(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })),
    ).toBe("Cmd+Shift+]");
    expect(chordFromEvent(key({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeNull();
  });

  it("parses the literal plus key", () => {
    const c = parseChord("Cmd++");
    expect(c?.key).toBe("+");
    expect(
      eventMatchesChord(key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), c!),
    ).toBe(true);
  });
});
