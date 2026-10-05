#!/usr/bin/env node
/**
 * A fake `kubectl` for the k8s runner hook tests. The hook runs it when `BAND_KUBECTL_BIN` points
 * here. It keeps what it was asked in the JSON file named by `STUB_KUBECTL_STATE`
 * (`{ calls: [{ args, stdin }], phases: string[], failCreate: string[], failDelete: boolean }`), so a
 * test reads back the manifests and arguments the hook produced.
 *
 *   get pods ...           prints `phases`, one per line (the pods "already there")
 *   create --filename -    records the manifest from stdin, prints `uid-<kind>-<name>`;
 *                          fails when the manifest's kind is in `failCreate`
 *   delete ...             records the call; fails when `failDelete` is set
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const statePath = process.env.STUB_KUBECTL_STATE;
if (!statePath) {
  process.stderr.write("kubectl stub: STUB_KUBECTL_STATE is not set\n");
  process.exit(1);
}
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.calls ??= [];

// Global flags come first: --context X, --namespace X.
const rest = [...args];
while (rest[0]?.startsWith("--")) rest.splice(0, 2);
const verb = rest[0];

let stdin = "";
if (args.includes("-") || args.includes("--filename")) {
  try {
    stdin = readFileSync(0, "utf8");
  } catch {}
}
state.calls.push({ args, stdin, tokenInEnv: process.env.BAND_BOOTSTRAP_TOKEN ?? null });

function save() {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
}
function exit(code, message) {
  save();
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (verb === "get") {
  save();
  process.stdout.write((state.phases ?? []).map((p) => `${p}\n`).join(""));
  process.exit(0);
}
if (verb === "create") {
  const manifest = JSON.parse(stdin);
  if ((state.failCreate ?? []).includes(manifest.kind)) {
    exit(1, `error: ${manifest.kind} create refused`);
  }
  save();
  process.stdout.write(`uid-${manifest.kind.toLowerCase()}-${manifest.metadata.name}`);
  process.exit(0);
}
if (verb === "delete") {
  if (state.failDelete) exit(1, "Unable to connect to the server");
  exit(0);
}
exit(1, `kubectl stub: unsupported ${args.join(" ")}`);
