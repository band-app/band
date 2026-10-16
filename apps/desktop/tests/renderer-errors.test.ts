/**
 * Calls the renderer error reporter with a recording logger and a fake clock. It is
 * a pure function (report in, log entries out), and desktop.log is written by the
 * logger it is given. The preload bridge and the IPC registration need Electron, so
 * they are checked against a desktop build.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { createRendererErrorReporter, redactTokens } from "../src/main/ipc/renderer-errors.ts";

function setup() {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const log = {
    error: (obj: Record<string, unknown>, msg: string) =>
      entries.push({ level: "error", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => entries.push({ level: "warn", obj, msg }),
  };
  let t = 1_000;
  const report = createRendererErrorReporter(log, () => t);
  return { entries, report, advance: (ms: number) => (t += ms) };
}

describe("renderer error reporter", () => {
  test("logs message, stack and url at error level", () => {
    const { entries, report } = setup();
    report({ kind: "error", message: "boom", stack: "Error: boom\n at x", url: "app://local/a" });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, "error");
    assert.deepEqual(entries[0].obj, {
      kind: "error",
      message: "boom",
      stack: "Error: boom\n at x",
      url: "app://local/a",
    });
  });

  test("logs a rejection reason", () => {
    const { entries, report } = setup();
    report({ kind: "unhandledrejection", message: "nope", url: "app://local/" });
    assert.equal(entries[0].obj.kind, "unhandledrejection");
    assert.equal(entries[0].obj.message, "nope");
  });

  test("rate limits a burst and reports the suppressed count", () => {
    const { entries, report, advance } = setup();
    for (let i = 0; i < 50; i++) report({ message: "loop" });
    assert.equal(entries.length, 20);
    report({ message: "other" });
    assert.equal(entries.length, 21);
    advance(60_001);
    report({ message: "loop" });
    assert.equal(entries[21].level, "warn");
    assert.match(entries[21].msg, /suppressed 30/);
    assert.equal(entries[22].level, "error");
  });

  test("caps long fields", () => {
    const { entries, report } = setup();
    report({ message: "m", stack: "x".repeat(100_000) });
    assert.ok((entries[0].obj.stack as string).length < 8 * 1024 + 100);
  });

  test("redacts token query values", () => {
    assert.equal(redactTokens("http://h/?token=bdt_abc&x=1"), "http://h/?token=[redacted]&x=1");
    const { entries, report } = setup();
    report({ message: "failed http://h/?token=secret", url: "http://h/?token=secret#a" });
    assert.ok(!JSON.stringify(entries).includes("secret"));
  });

  test("ignores a malformed report", () => {
    const { entries, report } = setup();
    report(undefined);
    assert.equal(entries.length, 1);
  });
});
