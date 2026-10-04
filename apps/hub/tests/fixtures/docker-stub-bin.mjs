#!/usr/bin/env node
/**
 * A fake `docker` and `devcontainer` for integration tests. The server runs it
 * when `BAND_DOCKER_BIN` or `BAND_DEVCONTAINER_BIN` points here. It keeps the
 * images and containers it "creates" in the JSON file named by
 * `STUB_DOCKER_STATE` (`{ images: { <name>: <id> }, containers: {...}, calls: [...] }`),
 * so a test can seed the worker base image and read back what the builder ran.
 *
 * Failures are driven by the repository's own content, so a test makes a build
 * fail by committing a file that says so:
 *   - a Dockerfile or devcontainer.json containing FAIL_BUILD fails its build;
 *   - an install script containing FAIL_INSTALL fails `docker start --attach`.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const statePath = process.env.STUB_DOCKER_STATE;
if (!statePath) {
  process.stderr.write("docker stub: STUB_DOCKER_STATE is not set\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.images ??= {};
state.containers ??= {};
state.calls ??= [];
// A credential-like variable that reached the stub is a leak the builder should have blanked.
const leaked = Object.entries(process.env)
  .filter(([k, v]) => v && /(TOKEN|SECRET|PASSWORD)/i.test(k))
  .map(([k]) => k);
const isDevcontainer = args[0] === "build" && args.includes("--workspace-folder");
state.calls.push({ tool: isDevcontainer ? "devcontainer" : "docker", args, leaked });

// Written to a temp file and renamed, so a test reading the file never sees half of it.
function save() {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
}
function fail(message, code = 1) {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
function flag(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
function newImage(name, seed) {
  state.images[name] = `sha256:${createHash("sha256").update(`${name}:${seed}:${randomUUID()}`).digest("hex")}`;
}
function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (isDevcontainer) {
  const config = flag("--config");
  if (read(config).includes("FAIL_BUILD")) fail("devcontainer: build failed (FAIL_BUILD)");
  const name = flag("--image-name");
  newImage(name, config);
  save();
  process.stdout.write(`{"outcome":"success","imageName":["${name}"]}\n`);
  process.exit(0);
}

const [command, ...rest] = args;
switch (command) {
  case "version":
    process.stdout.write("27.0.0\n");
    break;
  case "image": {
    // image inspect --format {{.Id}} <name>
    const name = rest[rest.length - 1];
    if (!state.images[name]) fail(`Error response from daemon: No such image: ${name}`);
    process.stdout.write(`${state.images[name]}\n`);
    break;
  }
  case "pull": {
    const name = rest[rest.length - 1];
    if (!state.images[name]) newImage(name, "pull");
    process.stdout.write(`pulled ${name}\n`);
    break;
  }
  case "build": {
    const tag = flag("--tag");
    const file = flag("--file") ?? join(rest[rest.length - 1], "Dockerfile");
    if (read(file).includes("FAIL_BUILD")) {
      fail(`#5 ERROR: process "/bin/sh -c false" did not complete successfully (FAIL_BUILD in ${file})`);
    }
    newImage(tag, read(file));
    process.stderr.write(`#1 [internal] load build definition from ${file}\n#2 DONE\n`);
    break;
  }
  case "create": {
    const name = flag("--name");
    const cIndex = rest.lastIndexOf("-c");
    state.containers[name] = { image: rest[cIndex - 1], script: rest[cIndex + 1] };
    process.stdout.write(`${randomUUID()}\n`);
    break;
  }
  case "cp":
    break;
  case "start": {
    const container = state.containers[rest[rest.length - 1]];
    if (!container) fail("No such container");
    if (container.script.includes("FAIL_INSTALL")) {
      fail(`sh: install failed (FAIL_INSTALL) in ${container.script}`);
    }
    process.stdout.write(`ran: ${container.script}\n`);
    break;
  }
  case "commit": {
    const tag = rest[rest.length - 1];
    const container = state.containers[rest[rest.length - 2]];
    newImage(tag, container?.script ?? "");
    break;
  }
  case "tag":
    if (!state.images[rest[0]]) fail(`No such image: ${rest[0]}`);
    state.images[rest[1]] = state.images[rest[0]];
    break;
  case "rm":
    delete state.containers[rest[rest.length - 1]];
    break;
  case "rmi":
  case "push":
    break;
  default:
    fail(`docker stub: unsupported command ${command}`);
}
save();
