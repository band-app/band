import { hintForPtySpawnError } from "@band-app/host-local/terminals/pty-error-hints";
import { describe, expect, it } from "vitest";

// `hintForPtySpawnError` is the boundary between the raw node-pty error a
// spawn failure throws and the short message shown in a terminal pane (see
// `TerminalPool.spawnNew`'s catch around `nodePty.spawn`). A real end-to-end
// test would need to force a genuine native pty.spawn failure after a
// successful preload — empirically, even an unusable shell path (a
// non-executable file) doesn't make node-pty throw synchronously; it spawns
// and the failure surfaces later as a PTY exit event instead, which this
// function never sees. Resource-exhaustion (EMFILE/ENFILE) is real but not
// safe to force deterministically in a test process. So this exercises the
// pure mapping directly against representative raw error text instead.
describe("hintForPtySpawnError", () => {
  it("recognizes a node-pty native module load failure", () => {
    const err = new Error(
      "Cannot find module './prebuilds/darwin-arm64//pty.node'\nRequire stack:\n- /app/node_modules/node-pty/lib/pty.js",
    );
    expect(hintForPtySpawnError(err)).toBe(
      "The terminal service could not load its native module. Restart the terminal service from Settings.",
    );
  });

  it("recognizes a MODULE_NOT_FOUND-style failure", () => {
    const err = Object.assign(new Error("Cannot find module 'node-pty'"), {
      code: "MODULE_NOT_FOUND",
    });
    expect(hintForPtySpawnError(err)).toBe(
      "The terminal service could not load its native module. Restart the terminal service from Settings.",
    );
  });

  it("recognizes resource exhaustion (too many open pty devices / processes)", () => {
    for (const errno of ["EMFILE", "ENFILE", "EAGAIN"]) {
      const err = new Error(`posix_spawn failed: ${errno} (errno 24)`);
      expect(hintForPtySpawnError(err)).toBe(
        "Your system cannot start another terminal process. Close unused terminals and try again.",
      );
    }
  });

  it("falls back to a generic message for anything else", () => {
    expect(hintForPtySpawnError(new Error("some unrelated native failure"))).toBe(
      "Failed to start the terminal shell.",
    );
  });

  it("handles a non-Error thrown value", () => {
    expect(hintForPtySpawnError("EMFILE: too many open files")).toBe(
      "Your system cannot start another terminal process. Close unused terminals and try again.",
    );
  });
});
