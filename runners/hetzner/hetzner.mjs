// Runner hook "hetzner": one Hetzner Cloud server per request, with cloud-init that starts an ephemeral
// band-worker and powers the server off when the worker exits. Contract: docs/runner-hooks.md.
// Usage: hetzner.mjs spawn | destroy | status | snapshot | restore | snapshot-delete (the .sh files call it).
// snapshot, restore and snapshot-delete are the hibernate hooks (plan step 3.10): a Hetzner snapshot image of the
// server, a new server created from that image, and the image's removal.
//
// Settings (the runner's "env"; HCLOUD_TOKEN is the runner's, never the hub's):
//   HCLOUD_TOKEN        API token with read and write access (required)
//   HCLOUD_SERVER_TYPE  default cx22
//   HCLOUD_IMAGE        default ubuntu-24.04 (a Debian or Ubuntu image; the cloud-init uses apt)
//   HCLOUD_LOCATION     default fsn1
//   HCLOUD_SSH_KEYS     comma-separated key names or ids, for logging in to debug (optional)
//   HCLOUD_FIREWALLS    comma-separated firewall ids (optional)
//   HCLOUD_API_URL      default https://api.hetzner.cloud/v1
//   BAND_RUNNER_POLL_MS how often snapshot polls the image action (default 5000)
// The cloud-init settings (BAND_VM_*) are in runners/_shared/cloud-init.mjs.
import { renderCloudInit } from "../_shared/cloud-init.mjs";
import { api, cloneUrl, need, printHandle, repoName, run } from "../_shared/lib.mjs";

const base = process.env.HCLOUD_API_URL || "https://api.hetzner.cloud/v1";
const call = (method, path, opts = {}) =>
  api(base, method, path, { ...opts, headers: { authorization: `Bearer ${need("HCLOUD_TOKEN")}` } });

/** Label values allow letters, digits, `-`, `_` and `.`, at most 63 characters, starting and ending alphanumeric. */
const label = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").slice(0, 63);

async function servers(selector) {
  const found = [];
  for (let page = 1; ; page++) {
    const { body } = await call("GET", `/servers?label_selector=${encodeURIComponent(selector)}&per_page=50&page=${page}`);
    found.push(...(body?.servers ?? []));
    if (!body?.meta?.pagination?.next_page) return found;
  }
}

const byWorker = (workerId) => servers(`band.worker=${label(workerId)}`);

async function remove(server) {
  const { status } = await call("DELETE", `/servers/${server.id}`, { allow: [404] });
  console.log(status === 404 ? `server ${server.id} is already gone` : `deleted server ${server.id} (${server.name})`);
}

async function spawn() {
  await create();
}

/** The numeric id of a snapshot image from BAND_SNAPSHOT_ID. */
function snapshotId() {
  const id = need("BAND_SNAPSHOT_ID");
  if (!/^\d+$/.test(id)) throw new Error(`BAND_SNAPSHOT_ID must be a Hetzner image id, got "${id}"`);
  return Number(id);
}

/** Creates the server. With `fromSnapshot` it boots the snapshot image, and the cloud-init skips the install and the clone. */
async function create(fromSnapshot = false) {
  const workerId = need("BAND_WORKER_ID");
  const imageId = fromSnapshot ? snapshotId() : undefined;
  const userData = renderCloudInit(fromSnapshot ? process.env : { ...process.env, BAND_SNAPSHOT_ID: "" });
  // A woken worker id comes back on a clean machine, so the powered-off server of its last run goes first.
  for (const old of await byWorker(workerId)) await remove(old);

  const sshKeys = (process.env.HCLOUD_SSH_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const firewalls = (process.env.HCLOUD_FIREWALLS || "").split(",").map((k) => k.trim()).filter(Boolean);
  for (const id of firewalls) if (!/^\d+$/.test(id)) throw new Error(`HCLOUD_FIREWALLS must list numeric ids, got "${id}"`);
  const { body } = await call("POST", "/servers", {
    json: {
      name: `band-${label(workerId).toLowerCase()}`,
      server_type: process.env.HCLOUD_SERVER_TYPE || "cx22",
      image: imageId ?? (process.env.HCLOUD_IMAGE || "ubuntu-24.04"),
      location: process.env.HCLOUD_LOCATION || "fsn1",
      start_after_create: true,
      user_data: userData,
      labels: {
        "band.runner": label(process.env.BAND_RUNNER_ID),
        "band.request": label(process.env.BAND_REQUEST_ID),
        "band.worker": label(workerId),
      },
      ...(sshKeys.length ? { ssh_keys: sshKeys.map((k) => (/^\d+$/.test(k) ? Number(k) : k)) } : {}),
      ...(firewalls.length ? { firewalls: firewalls.map((id) => ({ firewall: Number(id) })) } : {}),
    },
  });
  const id = body?.server?.id;
  if (id === undefined) throw new Error("Hetzner answered without a server id");
  printHandle(String(id));
  if (!fromSnapshot && cloneUrl()) console.log(`BAND_HOST_REPO_PATH=${process.env.BAND_VM_WORKER === "docker" ? "/work" : "/home/band/work"}/${repoName()}`);
  console.log(`created server ${id} (${body.server.name})`);
}

async function destroy() {
  const found = await byWorker(need("BAND_WORKER_ID"));
  if (found.length === 0 && process.env.BAND_MACHINE_HANDLE) found.push({ id: process.env.BAND_MACHINE_HANDLE, name: "?" });
  if (found.length === 0) console.log("no server to delete");
  for (const server of found) await remove(server);
}

async function restore() {
  await create(true);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a Hetzner action. The hub kills the hook at its own timeout, so there is no limit here. */
async function waitForAction(id) {
  const pollMs = Number(process.env.BAND_RUNNER_POLL_MS) || 5000;
  for (;;) {
    const { body } = await call("GET", `/actions/${id}`);
    const action = body?.action;
    if (action?.status === "success") return;
    if (action?.status === "error") throw new Error(`Hetzner action ${id} failed: ${action.error?.message ?? action.error?.code ?? "unknown error"}`);
    await sleep(pollMs);
  }
}

async function snapshot() {
  const workerId = need("BAND_WORKER_ID");
  const handle = process.env.BAND_MACHINE_HANDLE || (await byWorker(workerId))[0]?.id;
  if (handle === undefined) throw new Error(`no server for worker ${workerId} to snapshot`);
  const { body } = await call("POST", `/servers/${handle}/actions/create_image`, {
    json: {
      type: "snapshot",
      description: `band ${workerId} ${new Date().toISOString()}`,
      labels: {
        "band.runner": label(process.env.BAND_RUNNER_ID),
        "band.worker": label(workerId),
        "band.snapshot": "1",
      },
    },
  });
  const imageId = body?.image?.id;
  if (imageId === undefined) throw new Error("Hetzner answered without an image id");
  try {
    await waitForAction(body?.action?.id);
  } catch (err) {
    // A snapshot that did not finish is no use and costs storage.
    await call("DELETE", `/images/${imageId}`, { allow: [404] }).catch(() => undefined);
    throw err;
  }
  console.log(`BAND_SNAPSHOT_ID=${imageId}`);
  const { body: image } = await call("GET", `/images/${imageId}`);
  // image_size is in GB (decimal), and null until Hetzner has measured it.
  const gb = image?.image?.image_size;
  if (typeof gb === "number") console.log(`BAND_SNAPSHOT_SIZE=${Math.round(gb * 1e9)}`);
  console.log(`snapshotted server ${handle} as image ${imageId}`);
}

async function snapshotDelete() {
  const id = snapshotId();
  const { status } = await call("DELETE", `/images/${id}`, { allow: [404] });
  console.log(status === 404 ? `image ${id} is already gone` : `deleted image ${id}`);
}

async function status() {
  const runner = process.env.BAND_RUNNER_ID;
  for (const s of await servers(runner ? `band.runner=${label(runner)}` : "band.worker")) {
    console.log(
      `BAND_MACHINE_HANDLE=${s.id} worker=${s.labels?.["band.worker"] ?? ""} request=${s.labels?.["band.request"] ?? ""} state=${s.status}`,
    );
  }
}

const commands = { spawn, destroy, status, snapshot, restore, "snapshot-delete": snapshotDelete };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: hetzner.mjs spawn | destroy | status | snapshot | restore | snapshot-delete");
  process.exit(2);
}
run(command);
