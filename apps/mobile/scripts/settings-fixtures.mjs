/**
 * What the Settings flows need around the throwaway hub (plan: S2 to S7 of feat/mobile-settings):
 *
 * - `settingsEnv()` starts the fake GitHub releases endpoint and the speech-to-text stub and
 *   returns the hub environment that points at them, plus a hub version, so a worker can be
 *   behind it. Call it before the hub starts.
 * - `seedSettings(hub)` makes the data once the hub is up: an admin device token (the flows'
 *   regular `deviceToken` is not an admin), a second device to revoke and a configured voice
 *   endpoint. The stand-in workers start with /workers-start.
 * - `handleSettingsControl(...)` serves the control endpoints the flows call:
 *   /worker-drop?name=<n>, /worker-finish-update?name=<n>, /expect-update?name=<n>,
 *   /check-device-gone?label=<l> and /expect-stt. /workers-start brings the workers to their
 *   starting state (build-box on 0.49.0 behind the hub, edge-box current, old-box offline).
 *
 * The workers are `connectStandInWorker` stand-ins (the real link protocol, no git or terminals).
 */
import { connectStandInWorker } from "../../hub/tests/helpers/stand-in-worker.ts";
import { startReleasesStub } from "../../hub/tests/fixtures/github-releases-stub.ts";
import { startSttStub } from "../../hub/tests/fixtures/stt-stub.ts";

export const HUB_VERSION = "0.50.0";
export const LATEST_RELEASE = "v9.0.0";
export const STT_TEXT = "Fix the login bug";

const workers = new Map();
let releases = null;
let stt = null;
const updates = new Map();
const pendingReconnect = new Map();

export async function settingsEnv() {
  releases = await startReleasesStub(LATEST_RELEASE);
  stt = await startSttStub({ text: STT_TEXT });
  return {
    BAND_GITHUB_API_URL: releases.url,
    BAND_INSTALL_METHOD: "compose",
    BAND_HUB_VERSION: HUB_VERSION,
  };
}

async function call(hub, token, method, procedure, input) {
  const query = method === "GET" ? `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}` : "";
  const res = await fetch(`${hub.url}/trpc/${procedure}${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Connection: "close" },
    body: method === "GET" ? undefined : JSON.stringify(input ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result) {
    throw new Error(`${procedure} failed (HTTP ${res.status}): ${body?.error?.message ?? "no body"}`);
  }
  return body.result.data;
}

async function addWorker(hub, name, { version, online = true }) {
  const worker = await connectStandInWorker(
    { hubUrl: hub.url, adminToken: hub.adminToken, name, version, serviceManager: "systemd" },
    () => {
      updates.set(name, (updates.get(name) ?? 0) + 1);
      // The worker comes back on the hub's version when the flow says so, not by itself, so the
      // row shows the update in progress for as long as the flow looks at it.
      pendingReconnect.set(name, () => worker.reconnect(HUB_VERSION));
      return { ok: true };
    },
  );
  workers.set(name, worker);
  if (!online) await worker.close();
  return worker;
}

/** Returns the extra tokens the flows pair with. */
export async function seedSettings(hub) {
  const admin = await call(hub, hub.adminToken, "POST", "tokens.createDevice", {
    label: "mobile-verify-admin",
    admin: true,
  });
  // The device an admin revokes in the Devices flow.
  await call(hub, hub.adminToken, "POST", "tokens.createDevice", { label: "tablet" });
  await call(hub, hub.adminToken, "POST", "settings.update", {
    voice: {
      enabled: true,
      baseUrl: stt.baseUrl,
      model: "whisper-1",
      language: "",
      hostId: "",
      apiKeyItemId: "",
    },
  });
  return { adminDeviceToken: admin.token };
}

const WORKERS = [
  { name: "build-box", version: "0.49.0", online: true },
  { name: "edge-box", version: HUB_VERSION, online: true },
  { name: "old-box", version: HUB_VERSION, online: false },
];

/**
 * Brings the stand-in workers to their starting state. A hub restart (hub-down.yaml) drops their
 * links, so the Hosts flows call this first: it makes each worker the first time and later
 * dials the same one again, back on its starting version.
 */
async function startWorkers(hub) {
  updates.clear();
  pendingReconnect.clear();
  for (const spec of WORKERS) {
    const known = workers.get(spec.name);
    if (!known) {
      await addWorker(hub, spec.name, spec);
    } else if (spec.online) {
      await known.reconnect(spec.version);
    }
  }
}

async function waitForRevoked(hub, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { tokens } = await call(hub, hub.adminToken, "GET", "tokens.list", {});
    const found = tokens.find((t) => t.kind === "device" && t.label === label);
    if (!found) return;
    if (Date.now() > deadline) throw new Error(`device ${label} is still listed`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Returns true when it handled the path. */
export async function handleSettingsControl(hub, url, notes) {
  const name = url.searchParams.get("name") ?? "";
  switch (url.pathname) {
    case "/workers-start":
      await startWorkers(hub);
      return true;
    case "/worker-drop":
      await workers.get(name)?.close();
      return true;
    case "/worker-finish-update": {
      const reconnect = pendingReconnect.get(name);
      if (!reconnect) throw new Error(`no update is waiting on ${name}`);
      pendingReconnect.delete(name);
      await reconnect();
      return true;
    }
    case "/expect-update": {
      const n = updates.get(name) ?? 0;
      if (n < 1) throw new Error(`hosts.update never reached ${name}`);
      notes.push(`hosts.update reached ${name} ${n} time(s)`);
      return true;
    }
    case "/check-device-gone": {
      await waitForRevoked(hub, url.searchParams.get("label") ?? "");
      notes.push(`device ${url.searchParams.get("label")} is gone from tokens.list`);
      return true;
    }
    case "/expect-stt": {
      const n = stt?.requests.length ?? 0;
      if (n < 1) throw new Error("the speech-to-text stub got no request");
      notes.push(`voice.test sent ${n} request(s) to the speech-to-text stub`);
      return true;
    }
    default:
      return false;
  }
}

export async function stopSettingsFixtures() {
  await Promise.all([...workers.values()].map((w) => w.close().catch(() => {})));
  workers.clear();
  await releases?.close();
  await stt?.close();
}

