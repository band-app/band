/**
 * The main window's navigation rules, as pure functions: no Electron needed.
 */

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { decideNavigation, decideOpen, isTrustedUiUrl } from "../src/main/navigation-guard.ts";

const HERE = "app://local/workspace/abc";

describe("navigation guard", () => {
  test("stays on the same app:// host", () => {
    assert.equal(decideNavigation(HERE, "app://local/other/route"), "allow");
  });

  test("another app:// host, a file: URL and other schemes are dropped", () => {
    assert.equal(decideNavigation(HERE, "app://h-0123456789ab/"), "deny");
    assert.equal(decideNavigation(HERE, "file:///etc/passwd"), "deny");
    assert.equal(decideNavigation(HERE, "javascript:alert(1)"), "deny");
    assert.equal(decideNavigation(HERE, "not a url"), "deny");
  });

  test("web pages open in the browser, never in the window", () => {
    assert.equal(decideNavigation(HERE, "https://example.com/x"), "external");
    assert.equal(decideNavigation(HERE, "http://example.com/x"), "external");
    assert.equal(decideOpen("https://example.com"), "external");
    assert.equal(decideOpen("app://local/x"), "deny");
  });

  test("the dev server's own origin counts as the same page", () => {
    assert.equal(decideNavigation("http://localhost:3000/a", "http://localhost:3000/b"), "allow");
  });

  test("only frames of the served UI are trusted with the hub token", () => {
    const trusted = ["app://local", "http://localhost:3000"];
    assert.ok(isTrustedUiUrl("app://local/workspace/x", trusted));
    assert.ok(isTrustedUiUrl("http://localhost:3000/", trusted));
    assert.ok(!isTrustedUiUrl("app://h-0123456789ab/", trusted));
    assert.ok(!isTrustedUiUrl("https://evil.example/", trusted));
    assert.ok(!isTrustedUiUrl("file:///x.html", trusted));
    assert.ok(!isTrustedUiUrl(undefined, trusted));
    assert.ok(!isTrustedUiUrl("::bad::", trusted));
  });
});
