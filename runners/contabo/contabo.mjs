// Runner hook "contabo": a Contabo VPS per request, with cloud-init that starts an ephemeral band-worker
// and powers the instance off when the worker exits. Contract: docs/runner-hooks.md.
// Usage: contabo.mjs spawn | destroy | status (the .sh files call it).
//
// Contabo instances are billed monthly, so the default mode reuses a pool you already pay for:
//   pool (default)  CONTABO_POOL lists instance ids. spawn takes one that is idle, renames it
//                   band-busy-<worker id>, and reinstalls it with the cloud-init user data. destroy
//                   reinstalls it with no user data (a clean disk, no token) and renames it band-idle.
//   new             CONTABO_MODE=new. spawn buys an instance (CONTABO_PRODUCT_ID). destroy cancels it,
//                   which ends the contract at the end of its billing period. A cancelled instance
//                   cannot be reused, and you pay until then.
//
// Settings (the runner's "env"; the credentials are the runner's, never the hub's):
//   CONTABO_CLIENT_ID, CONTABO_CLIENT_SECRET, CONTABO_API_USER, CONTABO_API_PASSWORD   (required)
//   CONTABO_IMAGE_ID    id of the OS image to install, a Debian or Ubuntu one (required)
//   CONTABO_POOL        comma-separated instance ids (pool mode)
//   CONTABO_PRODUCT_ID  product to buy, like V92 (new mode, required there)
//   CONTABO_REGION      default EU (new mode)
//   CONTABO_SSH_KEYS    comma-separated secret ids of ssh keys to install (optional)
//   CONTABO_AUTH_URL    default https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token
//   CONTABO_API_URL     default https://api.contabo.com/v1
//   CONTABO_LOCK_WAIT   seconds a spawn waits for another spawn of the same runner to claim its instance (default 60)
// The cloud-init settings (BAND_VM_*) are in runners/_shared/cloud-init.mjs.
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderCloudInit } from "../_shared/cloud-init.mjs";
import { api, cloneUrl, die, need, printHandle, repoName, run } from "../_shared/lib.mjs";

const apiBase = process.env.CONTABO_API_URL || "https://api.contabo.com/v1";
const authUrl =
  process.env.CONTABO_AUTH_URL || "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const BUSY = "band-busy-";
const IDLE = "band-idle";

// The pool lookups run in parallel, so the cached value is the request, not its answer.
let bearer;
function token() {
  bearer ??= fetchToken();
  return bearer;
}
async function fetchToken() {
  const { body } = await api(authUrl, "POST", "", {
    form: {
      client_id: need("CONTABO_CLIENT_ID"),
      client_secret: need("CONTABO_CLIENT_SECRET"),
      username: need("CONTABO_API_USER"),
      password: need("CONTABO_API_PASSWORD"),
      grant_type: "password",
    },
  });
  if (!body?.access_token) throw new Error("Contabo's auth server answered without an access token");
  return body.access_token;
}

const call = async (method, path, opts = {}) =>
  api(apiBase, method, path, {
    ...opts,
    headers: { authorization: `Bearer ${await token()}`, "x-request-id": randomUUID() },
  });

const idList = (name) => (process.env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
const mode = process.env.CONTABO_MODE || "pool";
if (mode !== "pool" && mode !== "new") die(`CONTABO_MODE must be pool or new, got ${mode}`);

async function instance(id) {
  const { body, status } = await call("GET", `/compute/instances/${encodeURIComponent(id)}`, { allow: [404] });
  return status === 404 ? undefined : body?.data?.[0];
}

/** Every instance whose display name starts with band-, for new mode and status. */
async function bandInstances() {
  const found = [];
  for (let page = 1; ; page++) {
    const { body } = await call("GET", `/compute/instances?page=${page}&size=100&displayName=band-`);
    const data = body?.data ?? [];
    found.push(...data.filter((i) => (i.displayName ?? "").startsWith("band-")));
    if (data.length < 100) return found;
  }
}

async function candidates() {
  if (mode === "pool") {
    const pool = idList("CONTABO_POOL");
    if (pool.length === 0) throw new Error("CONTABO_POOL lists no instance (or set CONTABO_MODE=new)");
    return (await Promise.all(pool.map(instance))).filter(Boolean);
  }
  return bandInstances();
}

/** Two spawns of one runner must not take the same idle instance. Contabo has no compare-and-set, so the claim is a lock. */
async function withLock(fn) {
  const dir = join(process.env.BAND_RUNNER_DIR || process.cwd(), "contabo-pool.lock");
  const wait = Number(process.env.CONTABO_LOCK_WAIT || 60) * 1000;
  const deadline = Date.now() + wait;
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A hook killed mid-claim (timeout, cancel) never removes its lock. The claim is one list call and one
      // rename, so a lock older than twice the wait is abandoned.
      try {
        if (Date.now() - statSync(dir).mtimeMs > 2 * wait) {
          // The rename succeeds for one waiter only, so two waiters cannot both reclaim and then delete a fresh lock.
          const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
          renameSync(dir, stale);
          rmSync(stale, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("another spawn kept the pool locked");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sshKeys = () =>
  idList("CONTABO_SSH_KEYS").map((id) => {
    if (!/^\d+$/.test(id)) throw new Error(`CONTABO_SSH_KEYS must list numeric secret ids, got "${id}"`);
    return Number(id);
  });
const rename = (id, displayName) => call("PATCH", `/compute/instances/${id}`, { json: { displayName } });
const reinstall = (id, userData) =>
  call("PUT", `/compute/instances/${id}`, {
    json: {
      imageId: need("CONTABO_IMAGE_ID"),
      ...(sshKeys().length ? { sshKeys: sshKeys() } : {}),
      ...(userData ? { userData } : {}),
    },
  });

async function spawn() {
  const workerId = need("BAND_WORKER_ID");
  const userData = renderCloudInit();
  need("CONTABO_IMAGE_ID");
  const name = `${BUSY}${workerId}`;
  let id;

  if (mode === "pool") {
    id = await withLock(async () => {
      const all = await candidates();
      // A worker id that wakes comes back on the instance it had, wiped by the reinstall below.
      const pick =
        all.find((i) => i.displayName === name) ??
        all.find((i) => !(i.displayName ?? "").startsWith(BUSY) && !["installing", "provisioning"].includes(i.status));
      if (!pick) throw new Error(`no idle instance in CONTABO_POOL (${all.length} listed, all busy or still installing)`);
      await rename(pick.instanceId, name);
      return pick.instanceId;
    });
    await reinstall(id, userData);
  } else {
    const existing = (await bandInstances()).find((i) => i.displayName === name && !i.cancelDate);
    if (existing) throw new Error(`instance ${existing.instanceId} already runs ${workerId}`);
    const { body } = await call("POST", "/compute/instances", {
      json: {
        productId: need("CONTABO_PRODUCT_ID"),
        region: process.env.CONTABO_REGION || "EU",
        imageId: need("CONTABO_IMAGE_ID"),
        period: 1,
        displayName: name,
        userData,
        ...(sshKeys().length ? { sshKeys: sshKeys() } : {}),
      },
    });
    id = body?.data?.[0]?.instanceId;
    if (id === undefined) throw new Error("Contabo answered without an instance id");
  }

  printHandle(String(id));
  if (cloneUrl()) console.log(`BAND_HOST_REPO_PATH=${process.env.BAND_VM_WORKER === "docker" ? "/work" : "/home/band/work"}/${repoName()}`);
  console.log(`${mode === "pool" ? "reinstalled pool" : "bought"} instance ${id} as ${name}`);
}

async function destroy() {
  const name = `${BUSY}${need("BAND_WORKER_ID")}`;
  const handle = process.env.BAND_MACHINE_HANDLE;
  const found = (await candidates()).filter((i) => i.displayName === name || (handle && String(i.instanceId) === handle));
  if (found.length === 0) {
    console.log("no instance to release");
    return;
  }
  for (const i of found) {
    if (mode === "pool") {
      // No user data: the disk is clean and holds no token. The reinstall boots the instance, which then idles.
      await reinstall(i.instanceId, undefined);
      await rename(i.instanceId, IDLE);
      console.log(`reinstalled instance ${i.instanceId} and returned it to the pool`);
    } else if (i.cancelDate) {
      console.log(`instance ${i.instanceId} is already cancelled`);
    } else {
      await call("POST", `/compute/instances/${i.instanceId}/cancel`);
      console.log(`cancelled instance ${i.instanceId}; it is billed until the end of its period`);
    }
  }
}

async function status() {
  for (const i of await candidates()) {
    const busy = (i.displayName ?? "").startsWith(BUSY);
    if (mode !== "pool" && !busy && i.displayName !== IDLE) continue;
    console.log(
      `BAND_MACHINE_HANDLE=${i.instanceId} worker=${busy ? i.displayName.slice(BUSY.length) : ""} request= state=${busy ? i.status : "idle"}${i.cancelDate ? " cancelled=1" : ""}`,
    );
  }
}

const commands = { spawn, destroy, status };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: contabo.mjs spawn | destroy | status");
  process.exit(2);
}
run(command);
