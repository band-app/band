#!/usr/bin/env node
/**
 * A fake `gh` for integration tests. The server runs it in place of the real
 * CLI when `BAND_GH_BIN` points here. It forwards each invocation to the
 * Express stub at `BAND_GH_STUB_URL` (see `gh-stub.ts`) and replays the
 * stub's answer as its own stdout, stderr and exit code.
 *
 * The request goes to `POST /<command>/<subcommand>` (`/api/graphql`,
 * `/pr/merge`) with the parsed arguments:
 *   { args, positional, fields, flags, input, cwd, env: { GH_PROMPT_DISABLED }, ghToken }
 * (`ghToken` is the `GH_TOKEN` the process ran with, absent when unset)
 * `-f key=value` pairs land in `fields` (`key[]` pairs collect into an array); `--flag value` and bare `--flag`
 * land in `flags`. The stub replies `{ stdout, stderr?, exitCode? }`. A
 * command the test registered no route for exits 1.
 */

const url = process.env.BAND_GH_STUB_URL;
if (!url) {
  process.stderr.write("gh stub: BAND_GH_STUB_URL is not set\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
const fields = {};
const flags = {};
let input;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field") {
    const pair = args[++i] ?? "";
    const eq = pair.indexOf("=");
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    // `-f events[]=a -f events[]=b` builds an array, as it does in gh.
    if (key.endsWith("[]")) (fields[key] ??= []).push(value);
    else fields[key] = value;
  } else if (arg === "--input") {
    // `--input -` reads the request body from stdin; it is forwarded as `input`.
    const source = args[++i];
    if (source === "-") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        input = JSON.parse(text);
      } catch {
        input = text;
      }
    }
  } else if (arg.startsWith("--")) {
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  } else {
    positional.push(arg);
  }
}

const path = `/${positional.slice(0, 2).map(encodeURIComponent).join("/")}`;
const res = await fetch(new URL(path, url), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    args,
    positional,
    fields,
    flags,
    input,
    cwd: process.cwd(),
    env: { GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? null },
    ghToken: process.env.GH_TOKEN,
  }),
});
if (!res.ok) {
  process.stderr.write(`gh stub: no route for ${path} (HTTP ${res.status})\n`);
  process.exit(1);
}
const reply = await res.json();
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.exitCode ?? 0);
