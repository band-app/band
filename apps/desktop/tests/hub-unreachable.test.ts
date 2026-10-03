import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { hubFallbackAction, hubUnreachableUrl } from "../src/main/hub-unreachable.ts";

describe("hub unreachable page", () => {
  const page = hubUnreachableUrl("https://hub.example.com", "Could not reach the hub at that URL");

  test("is a data: page that offers Retry and Use local", () => {
    assert.ok(page.startsWith("data:text/html"));
    const html = decodeURIComponent(page.slice(page.indexOf(",") + 1));
    assert.match(html, /href="band-action:\/\/hub-retry"/);
    assert.match(html, /href="band-action:\/\/hub-use-local"/);
    assert.match(html, /https:\/\/hub\.example\.com/);
  });

  test("escapes the URL and the reason", () => {
    const html = decodeURIComponent(
      hubUnreachableUrl("<script>x</script>", 'a "b"').split(",").slice(1).join(","),
    );
    assert.ok(!html.includes("<script>x"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  test("turns the two links into actions, from this page only", () => {
    assert.equal(hubFallbackAction(page, "band-action://hub-retry"), "retry");
    assert.equal(hubFallbackAction(page, "band-action://hub-use-local"), "use-local");
    assert.equal(hubFallbackAction(page, "band-action://other"), null);
    assert.equal(hubFallbackAction("app://local/", "band-action://hub-retry"), null);
    assert.equal(hubFallbackAction("https://evil.example/", "band-action://hub-use-local"), null);
  });
});
