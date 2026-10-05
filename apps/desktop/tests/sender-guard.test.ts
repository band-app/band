/**
 * The IPC sender check: only the main window's top frame, on a bundled
 * `app://` origin, may call a privileged channel. No Electron needed; the
 * events are plain objects shaped like the parts `isTrustedSender` reads.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { guardedHandler, isTrustedSender } from "../src/main/ipc/sender-guard.ts";

const TRUSTED = ["app://local"];

function makeWindow() {
  const mainFrame = { url: "app://local/worktree/abc" };
  const webContents = { mainFrame };
  return { win: { isDestroyed: () => false, webContents }, webContents, mainFrame };
}

describe("isTrustedSender", () => {
  test("accepts the main window's top frame on a trusted origin", () => {
    const { win, webContents, mainFrame } = makeWindow();
    assert.equal(
      isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, TRUSTED),
      true,
    );
  });

  test("rejects a <webview> guest, which is another webContents", () => {
    const { win } = makeWindow();
    const guestFrame = { url: "app://local/" };
    const guest = { mainFrame: guestFrame };
    assert.equal(isTrustedSender({ sender: guest, senderFrame: guestFrame }, win, TRUSTED), false);
  });

  test("rejects a subframe of the main window", () => {
    const { win, webContents } = makeWindow();
    const sub = { url: "app://local/embedded" };
    assert.equal(isTrustedSender({ sender: webContents, senderFrame: sub }, win, TRUSTED), false);
  });

  test("rejects a top frame that navigated to another origin", () => {
    const { win, webContents, mainFrame } = makeWindow();
    for (const url of ["https://evil.example/", "app://evil/", "file:///etc/passwd", ""]) {
      mainFrame.url = url;
      assert.equal(
        isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, TRUSTED),
        false,
        url,
      );
    }
  });

  test("rejects a missing frame and a destroyed window", () => {
    const { win, webContents, mainFrame } = makeWindow();
    assert.equal(isTrustedSender({ sender: webContents, senderFrame: null }, win, TRUSTED), false);
    const destroyed = { ...win, isDestroyed: () => true };
    assert.equal(
      isTrustedSender({ sender: webContents, senderFrame: mainFrame }, destroyed, TRUSTED),
      false,
    );
  });
});

describe("guardedHandler", () => {
  test("does not run the handler for an untrusted sender", () => {
    let ran = false;
    const handler = guardedHandler(
      () => false,
      () => {
        ran = true;
      },
    );
    assert.throws(() => handler({ sender: {}, senderFrame: null }, undefined), /Not allowed/);
    assert.equal(ran, false);
  });

  test("passes args and event to the handler for a trusted sender", () => {
    const event = { sender: {}, senderFrame: null };
    const handler = guardedHandler(
      () => true,
      (args: number, e) => (e === event ? args + 1 : -1),
    );
    assert.equal(handler(event, 1), 2);
  });
});
