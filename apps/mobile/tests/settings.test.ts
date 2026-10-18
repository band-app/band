import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { availabilityText, modelSummary, refreshSummary } from "../src/lib/settings/agents.ts";
import {
  canRevoke,
  devicesOf,
  pairingLink,
  revokePrompt,
  type TokenLike,
} from "../src/lib/settings/devices.ts";
import { errorText, isForbidden, isMissingProcedure } from "../src/lib/settings/errors.ts";
import {
  interruptionLines,
  lastSeenText,
  showUpdateButton,
  updateButtonLabel,
  updateProgressText,
  versionStateLabel,
} from "../src/lib/settings/hosts.ts";
import { testMessage, voiceBody, voiceReady, voiceTestBody } from "../src/lib/settings/voice.ts";

const token = (over: Partial<TokenLike>): TokenLike => ({
  id: "t1",
  kind: "device",
  label: "Phone",
  admin: false,
  state: "active",
  createdAt: 0,
  lastUsedAt: null,
  ...over,
});

describe("hosts", () => {
  it("words the version state and the update button", () => {
    assert.equal(
      versionStateLabel({
        id: "a",
        name: "a",
        status: "online",
        lastSeenAt: null,
        versionState: "behind",
      }),
      "behind the hub",
    );
    assert.equal(
      versionStateLabel({
        id: "a",
        name: "a",
        status: "online",
        lastSeenAt: null,
        versionState: "current",
      }),
      null,
    );
    assert.equal(updateButtonLabel(null), "Update");
    assert.equal(updateButtonLabel({ state: "failed" }), "Retry update");
    assert.equal(updateProgressText({ state: "installing", target: "0.2.0" }), "Installing 0.2.0…");
    assert.equal(updateProgressText({ state: "failed", error: "x" }), null);
  });

  it("shows Update only to an admin for a worker that can restart", () => {
    const host = { id: "a", name: "a", status: "online", lastSeenAt: null, canUpdate: true };
    assert.equal(showUpdateButton(host, true), true);
    assert.equal(showUpdateButton(host, false), false);
    assert.equal(showUpdateButton({ ...host, canUpdate: false }, true), false);
  });

  it("says last seen without Intl.RelativeTimeFormat", () => {
    const now = Date.UTC(2026, 0, 2, 10, 0, 0);
    const host = { id: "a", name: "a", status: "offline", lastSeenAt: now - 180_000 };
    assert.equal(lastSeenText(host, now), "Last seen 3 minutes ago");
    assert.equal(lastSeenText({ ...host, lastSeenAt: null }, now), "Never seen");
    assert.equal(lastSeenText({ ...host, id: "local", lastSeenAt: null }, now), "This hub");
  });

  it("lists the agents a restart ends", () => {
    assert.deepEqual(interruptionLines([{ chatId: "c", worktreeId: "alpha-main", busy: true }]), [
      "alpha-main (working)",
    ]);
  });
});

describe("devices", () => {
  it("keeps only device tokens", () => {
    assert.deepEqual(
      devicesOf([token({}), token({ id: "w", kind: "worker_session" })]).map((d) => d.id),
      ["t1"],
    );
  });

  it("asks for the stronger confirm on the session's own token", () => {
    const own = revokePrompt(token({}), "t1");
    const other = revokePrompt(token({ id: "t2" }), "t1");
    assert.equal(own.own, true);
    assert.match(own.message, /signs you out/);
    assert.equal(other.own, false);
    assert.equal(other.confirm, "Revoke");
  });

  it("does not offer revoke for the shared token or a revoked one", () => {
    assert.equal(canRevoke(token({ id: "shared" })), false);
    assert.equal(canRevoke(token({ state: "revoked" })), false);
    assert.equal(canRevoke(token({})), true);
  });

  it("builds the same pairing link as the web", () => {
    assert.equal(
      pairingLink("http://10.0.0.2:3456/", "bdp_a b"),
      "http://10.0.0.2:3456/?pair=bdp_a%20b",
    );
  });
});

describe("voice", () => {
  const config = {
    enabled: false,
    baseUrl: " http://x/v1 ",
    model: "m",
    language: "",
    hostId: "",
    apiKeyItemId: "",
  };
  it("trims the body and sets enabled", () => {
    assert.equal(voiceBody(config, true).baseUrl, "http://x/v1");
    assert.equal(voiceBody(config, true).enabled, true);
  });
  it("sends the test without enabled", () => {
    assert.equal("enabled" in voiceTestBody(config), false);
  });
  it("needs a URL and a model", () => {
    assert.equal(voiceReady(config), true);
    assert.equal(voiceReady({ ...config, model: " " }), false);
  });
  it("names the host that reached the endpoint", () => {
    assert.equal(testMessage("local", undefined), "Connected. The hub reached the endpoint.");
    assert.equal(testMessage("h-1", "Worker"), "Connected. Worker reached the endpoint.");
  });
});

describe("agents", () => {
  it("summarises models and availability", () => {
    assert.equal(
      modelSummary({
        agentId: "a",
        agentType: "claude-code",
        agentLabel: "Claude",
        models: [{ id: "m", name: "Opus" }],
        defaultModel: "m",
      }),
      "1 model, default Opus",
    );
    assert.equal(
      availabilityText({ hostId: "local", hostName: "Local", available: true }),
      "Local: ready",
    );
    assert.equal(
      availabilityText({ hostId: "h", hostName: "W", available: false, reason: "host offline" }),
      "W: host offline",
    );
    assert.equal(refreshSummary([{ agentId: "a" }]), "Models refreshed.");
    assert.equal(refreshSummary([{ agentId: "a", error: "boom" }]), "a: boom");
  });
});

describe("errors", () => {
  it("tells a missing procedure and a refusal apart", () => {
    const missing = Object.assign(new Error('No procedure found on path "hosts.updateStatus"'), {
      data: { code: "NOT_FOUND" },
    });
    const forbidden = Object.assign(new Error("admin"), { data: { code: "FORBIDDEN" } });
    assert.equal(isMissingProcedure(missing), true);
    assert.equal(isMissingProcedure(forbidden), false);
    assert.equal(isForbidden(forbidden), true);
    assert.match(errorText(missing), /Update the hub/);
  });
});
