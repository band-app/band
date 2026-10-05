// The cloud-init user data both VM hooks send (plan step 3.8). It installs the band worker, starts it as
// `band-worker --ephemeral` under systemd with the contract environment, and powers the VM off when the
// worker exits, so a VM never idles on the bill after its work is done.
//
// The result is `#cloud-config` followed by JSON, which is valid YAML, so every value is quoted and no
// token, URL or label can break the document. `renderCloudInit` is pure: tests render it and check it
// against the cloud-config schema.
//
// Settings (the runner's "env"):
//   BAND_VM_WORKER         npm (default): Node 22 and `npm install -g $BAND_VM_WORKER_PACKAGE`.
//                          docker: docker and the image in BAND_VM_WORKER_IMAGE.
//   BAND_VM_WORKER_PACKAGE npm package with the worker (default @band-app/worker).
//   BAND_VM_WORKER_IMAGE   worker image for docker mode (required there).
//   BAND_VM_MAX_HOURS      the worker is stopped, and the VM powers off, after this long (default 12).
//   BAND_IDLE_EXIT         idle time before the ephemeral worker exits, like 90s.
//
// With BAND_SNAPSHOT_ID set the machine boots from a snapshot of an earlier one (plan step 3.10). The
// worker, the clone and the user are on its disk already, so the script only removes the dead session token
// the snapshot holds and starts the worker with the new bootstrap token.

import { cloneUrl, repoName } from "./lib.mjs";

const SAFE_ENV_VALUE = /^[^\n\r"\\]*$/;

/**
 * One line of the worker's environment file. systemd strips the double quotes, but `docker run --env-file`
 * keeps them as part of the value, so docker mode writes the value bare.
 */
function envLine(key, value, quote) {
  if (!SAFE_ENV_VALUE.test(value)) throw new Error(`${key} holds a character that cannot go in the worker's environment file`);
  return quote ? `${key}="${value}"` : `${key}=${value}`;
}

function systemdUnit({ mode, image, maxSeconds }) {
  const start =
    mode === "docker"
      ? `/usr/bin/docker run --rm --name band-worker --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges --env-file /etc/band-worker.env -v /var/lib/band-work:/work ${image}`
      : "/usr/bin/band-worker --ephemeral";
  return [
    "[Unit]",
    "Description=Band worker",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    ...(mode === "docker" ? [] : ["User=band"]),
    "EnvironmentFile=/etc/band-worker.env",
    `ExecStart=${start}`,
    "Restart=no",
    `RuntimeMaxSec=${maxSeconds}`,
    // The "+" runs it as root even though the worker does not.
    "ExecStopPost=+/usr/sbin/poweroff",
    "",
  ].join("\n");
}

/**
 * Render the user data for one VM from the hook contract's environment. Throws on a missing variable or a
 * value that cannot be carried safely.
 */
export function renderCloudInit(env = process.env) {
  const need = (name) => {
    if (!env[name]) throw new Error(`${name} is required`);
    return env[name];
  };
  const mode = env.BAND_VM_WORKER || "npm";
  if (mode !== "npm" && mode !== "docker") throw new Error(`BAND_VM_WORKER must be npm or docker, got ${mode}`);
  const image = env.BAND_VM_WORKER_IMAGE || "";
  if (mode === "docker" && !image) throw new Error("BAND_VM_WORKER_IMAGE is required when BAND_VM_WORKER is docker");
  if (image && !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(image)) throw new Error("BAND_VM_WORKER_IMAGE is not an image name");
  const pkg = env.BAND_VM_WORKER_PACKAGE || "@band-app/worker";
  if (!/^[A-Za-z0-9@][A-Za-z0-9_.@/~^<>=-]*$/.test(pkg)) throw new Error("BAND_VM_WORKER_PACKAGE is not a package spec");
  const hours = Number(env.BAND_VM_MAX_HOURS || 12);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("BAND_VM_MAX_HOURS must be a positive number");

  const hubUrl = need("BAND_HUB_URL");
  const home = mode === "docker" ? "/work/home" : "/home/band";
  const work = mode === "docker" ? "/work" : "/home/band/work";
  const name = repoName();
  const repo = cloneUrl();

  const line = (key, value) => envLine(key, value, mode !== "docker");
  const envFile = [
    line("BAND_HUB_URL", hubUrl),
    line("BAND_WORKER_ID", need("BAND_WORKER_ID")),
    line("BAND_BOOTSTRAP_TOKEN", need("BAND_BOOTSTRAP_TOKEN")),
    line("BAND_WORKER_LABELS", env.BAND_LABELS || ""),
    line("BAND_WORKER_EPHEMERAL", "1"),
    line("BAND_WORKER_ROOTS", work),
    line("BAND_WORKER_STATE_DIR", `${work}/.band-worker`),
    line("HOME", home),
    ...(env.BAND_IDLE_EXIT ? [line("BAND_WORKER_IDLE_EXIT", env.BAND_IDLE_EXIT)] : []),
    "",
  ].join("\n");

  const packages = mode === "docker" ? ["git", "docker.io", "ca-certificates"] : ["git", "curl", "ca-certificates", "gnupg"];

  const stateDir = mode === "docker" ? "/var/lib/band-work/.band-worker" : "/home/band/work/.band-worker";
  const restore = Boolean(env.BAND_SNAPSHOT_ID);

  // Every step runs under `set -e`. Any failure powers the VM off at once: a VM with no worker only costs money,
  // and the hub destroys it after its timeout anyway.
  const bootstrap = [
    "#!/bin/sh",
    "set -eu",
    ...(restore
      ? [
          // The hub revoked the session token the snapshot holds, so the worker has to trade the bootstrap token.
          `rm -f '${stateDir}/session-token'`,
        ]
      : mode === "docker"
      ? [
          "mkdir -p /var/lib/band-work/home",
          ...(repo
            ? [`GIT_ALLOW_PROTOCOL=https:ssh:git git clone --quiet -- '${repo.replace(/'/g, "'\\''")}' '/var/lib/band-work/${name}'`]
            : []),
          "chown -R 65532:65532 /var/lib/band-work",
          `docker pull --quiet '${image}'`,
        ]
      : [
          "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
          "apt-get install -y nodejs",
          `npm install -g '${pkg}'`,
          "useradd --create-home --shell /bin/bash band",
          "mkdir -p /home/band/work",
          ...(repo
            ? [
                `runuser -u band -- env GIT_ALLOW_PROTOCOL=https:ssh:git git clone --quiet -- '${repo.replace(/'/g, "'\\''")}' '/home/band/work/${name}'`,
              ]
            : []),
          "chown -R band:band /home/band",
        ]),
    "systemctl daemon-reload",
    "systemctl start band-worker.service",
    // `docker run --env-file` reads the file after the unit forks, so wait for the container before the file goes.
    ...(mode === "docker" ? ["for i in $(seq 1 60); do docker inspect band-worker >/dev/null 2>&1 && break; sleep 1; done"] : []),
    // The unit has read its environment file, so the token goes. It also goes from cloud-init's copy of the
    // user data. The provider's metadata service keeps serving the user data, so the token's single use is
    // what protects it, not this cleanup.
    "rm -f /etc/band-worker.env /var/lib/cloud/instance/user-data.txt /var/lib/cloud/instance/cloud-config.txt",
    "rm -f /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/user-data.txt.i /var/lib/cloud/instances/*/cloud-config.txt /var/lib/cloud/instances/*/obj.pkl",
    "",
  ].join("\n");

  const config = {
    package_update: true,
    packages,
    write_files: [
      { path: "/etc/band-worker.env", permissions: "0600", owner: "root:root", content: envFile },
      {
        path: "/etc/systemd/system/band-worker.service",
        permissions: "0644",
        owner: "root:root",
        content: systemdUnit({ mode, image, maxSeconds: Math.round(hours * 3600) }),
      },
      { path: "/usr/local/sbin/band-bootstrap.sh", permissions: "0700", owner: "root:root", content: bootstrap },
    ],
    runcmd: [["sh", "-c", "/usr/local/sbin/band-bootstrap.sh || poweroff"]],
  };
  return `#cloud-config\n${JSON.stringify(config, null, 2)}\n`;
}
