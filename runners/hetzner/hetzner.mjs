// Runner hook "hetzner": one Hetzner Cloud server per request, with cloud-init that starts an ephemeral
// band-worker and powers the server off when the worker exits. Contract: docs/runner-hooks.md.
// Usage: hetzner.mjs spawn | destroy | status (the .sh files call it).
//
// Settings (the runner's "env"; HCLOUD_TOKEN is the runner's, never the hub's):
//   HCLOUD_TOKEN        API token with read and write access (required)
//   HCLOUD_SERVER_TYPE  default cx22
//   HCLOUD_IMAGE        default ubuntu-24.04 (a Debian or Ubuntu image; the cloud-init uses apt)
//   HCLOUD_LOCATION     default fsn1
//   HCLOUD_SSH_KEYS     comma-separated key names or ids, for logging in to debug (optional)
//   HCLOUD_FIREWALLS    comma-separated firewall ids (optional)
//   HCLOUD_API_URL      default https://api.hetzner.cloud/v1
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
  const workerId = need("BAND_WORKER_ID");
  const userData = renderCloudInit();
  // A woken worker id comes back on a clean machine, so the powered-off server of its last run goes first.
  for (const old of await byWorker(workerId)) await remove(old);

  const sshKeys = (process.env.HCLOUD_SSH_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const firewalls = (process.env.HCLOUD_FIREWALLS || "").split(",").map((k) => k.trim()).filter(Boolean);
  for (const id of firewalls) if (!/^\d+$/.test(id)) throw new Error(`HCLOUD_FIREWALLS must list numeric ids, got "${id}"`);
  const { body } = await call("POST", "/servers", {
    json: {
      name: `band-${label(workerId).toLowerCase()}`,
      server_type: process.env.HCLOUD_SERVER_TYPE || "cx22",
      image: process.env.HCLOUD_IMAGE || "ubuntu-24.04",
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
  if (cloneUrl()) console.log(`BAND_HOST_PROJECT_PATH=${process.env.BAND_VM_WORKER === "docker" ? "/work" : "/home/band/work"}/${repoName()}`);
  console.log(`created server ${id} (${body.server.name})`);
}

async function destroy() {
  const found = await byWorker(need("BAND_WORKER_ID"));
  if (found.length === 0 && process.env.BAND_MACHINE_HANDLE) found.push({ id: process.env.BAND_MACHINE_HANDLE, name: "?" });
  if (found.length === 0) console.log("no server to delete");
  for (const server of found) await remove(server);
}

async function status() {
  const runner = process.env.BAND_RUNNER_ID;
  for (const s of await servers(runner ? `band.runner=${label(runner)}` : "band.worker")) {
    console.log(
      `BAND_MACHINE_HANDLE=${s.id} worker=${s.labels?.["band.worker"] ?? ""} request=${s.labels?.["band.request"] ?? ""} state=${s.status}`,
    );
  }
}

const commands = { spawn, destroy, status };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: hetzner.mjs spawn | destroy | status");
  process.exit(2);
}
run(command);
