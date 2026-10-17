import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effectivePrimaryHost, isHostAllowed, onlyAvailableOnMessage } from "../src/repo-hosts.ts";

describe("isHostAllowed", () => {
  it("allows every host when there is no list", () => {
    assert.equal(isHostAllowed(null, "h-a"), true);
    assert.equal(isHostAllowed(undefined, "local"), true);
  });

  it("allows only the listed hosts, and treats a missing host id as local", () => {
    assert.equal(isHostAllowed(["h-a"], "h-a"), true);
    assert.equal(isHostAllowed(["h-a"], "h-b"), false);
    assert.equal(isHostAllowed(["local"], undefined), true);
    assert.equal(isHostAllowed(["h-a"], null), false);
  });
});

describe("effectivePrimaryHost", () => {
  it("keeps a stored primary that is still allowed", () => {
    assert.equal(effectivePrimaryHost("h-b", ["h-a", "h-b"], ["local", "h-a"]), "h-b");
  });

  it("falls back to the hub, then the lowest host id, among allowed hosts with a checkout", () => {
    assert.equal(effectivePrimaryHost(null, null, ["h-b", "local", "h-a"]), "local");
    assert.equal(effectivePrimaryHost(null, null, ["h-b", "h-a"]), "h-a");
    assert.equal(effectivePrimaryHost("local", ["h-a", "h-b"], ["local", "h-b", "h-a"]), "h-a");
  });

  it("is null when no allowed host has a checkout", () => {
    assert.equal(effectivePrimaryHost(null, ["h-a"], ["h-b"]), null);
  });
});

describe("onlyAvailableOnMessage", () => {
  it("names the repo and the hosts", () => {
    assert.equal(
      onlyAvailableOnMessage("epic", ["mac", "contabo"]),
      "epic is only available on mac, contabo",
    );
  });
});
