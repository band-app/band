import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** A hub token with this prefix is a one-time bootstrap token, not a session token. */
export const BOOTSTRAP_TOKEN_PREFIX = "bwb_";

export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;

export interface WorkerConfig {
  /** Base URL of the hub with the scheme the worker was given (`http(s)` or `ws(s)`). */
  hubUrl: URL;
  /** Session token, or a bootstrap token when it has {@link BOOTSTRAP_TOKEN_PREFIX}. */
  token: string | undefined;
  name: string | undefined;
  /** The id the hub issued for this worker. Without it the worker keeps the id in its state dir, or makes one. */
  workerId: string | undefined;
  labels: Record<string, string>;
  /** Absolute directories the worker serves. Empty means the default root under the state dir. */
  roots: string[];
  stateDir: string;
  /** Where repos the worker clones go, as `<dir>/<owner>/<name>`. Defaults to `BAND_REPOS_DIR` or `~/band/repos`. */
  reposDir?: string;
  /** The machine's `BAND_HOME`, where context working copies go. Defaults to `BAND_HOME` or `~/.band`. */
  bandHome?: string;
  ephemeral: boolean;
  idleExitMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const USAGE = `Usage: band-worker --hub <url> --token <token> [options]

  --hub <url>          Hub URL (env BAND_HUB_URL). Plain http/ws is accepted only for loopback.
  --token <token>      Bootstrap or session token (env BAND_WORKER_TOKEN, or BAND_BOOTSTRAP_TOKEN).
  --worker-id <id>     The id the hub issued with the bootstrap token (env BAND_WORKER_ID).
  --name <name>        Display name, reported as the "name" label (env BAND_WORKER_NAME).
  --labels k=v,...     Placement labels (env BAND_WORKER_LABELS).
  --root <dir>         Directory the worker may serve. Repeatable (env BAND_WORKER_ROOTS, ${delimiter} separated).
  --repos-dir <dir>    Where repos this worker clones go (env BAND_REPOS_DIR, default ~/band/repos).
  --state-dir <dir>    Where the worker id and session token live (env BAND_WORKER_STATE_DIR).
  --ephemeral          Exit when idle (env BAND_WORKER_EPHEMERAL=1).
  --idle-exit <dur>    Idle time before an ephemeral worker exits, like 90s, 10m or 1h (env BAND_WORKER_IDLE_EXIT).

Run as a service (systemd user unit on Linux, launchd agent on macOS):

  band-worker install-service --hub <url> --token <bootstrap token> [--root <dir> --name <name> --labels k=v]
  band-worker uninstall-service
  band-worker status
`;

export function usage(): string {
  return USAGE;
}

/** Parses `10`, `500ms`, `90s`, `10m` or `1h` into milliseconds. A bare number means seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) throw new ConfigError(`invalid duration "${text}", expected something like 90s or 10m`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"] as number;
  return Math.round(Number(m[1]) * unit);
}

export function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new ConfigError(`invalid label "${pair}", expected key=value`);
    labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return labels;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseHubUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`invalid hub URL "${text}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new ConfigError(`hub URL must be http(s) or ws(s), got ${url.protocol}`);
  }
  const plain = url.protocol === "http:" || url.protocol === "ws:";
  if (plain && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError("a hub that is not on this machine needs an https or wss URL");
  }
  if (url.username || url.password) {
    throw new ConfigError("put the token in --token, not in the hub URL");
  }
  return url;
}

/** `<base>/api/workers/connect` with the websocket scheme. */
export function linkUrl(hubUrl: URL): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/workers/connect`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** `<base>/<path>` with the http scheme. */
export function httpUrl(hubUrl: URL, path: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }

  const hub = values.hub ?? env.BAND_HUB_URL;
  if (!hub) throw new ConfigError("--hub (or BAND_HUB_URL) is required");

  const roots = [
    ...(values.root ?? []),
    ...(values.root === undefined && env.BAND_WORKER_ROOTS
      ? env.BAND_WORKER_ROOTS.split(delimiter).filter(Boolean)
      : []),
  ].map((r) => (isAbsolute(r) ? r : resolve(r)));

  const labelText = values.labels ?? env.BAND_WORKER_LABELS;
  const labels = labelText ? parseLabels(labelText) : {};
  const name = values.name ?? env.BAND_WORKER_NAME;
  if (name) labels.name = name;

  const idleText = values["idle-exit"] ?? env.BAND_WORKER_IDLE_EXIT;
  const ephemeral = values.ephemeral ?? isTruthy(env.BAND_WORKER_EPHEMERAL);
  if (idleText !== undefined && !ephemeral) {
    throw new ConfigError("--idle-exit only applies with --ephemeral");
  }

  return {
    hubUrl: parseHubUrl(hub),
    token: values.token ?? env.BAND_WORKER_TOKEN ?? env.BAND_BOOTSTRAP_TOKEN,
    name,
    workerId: values["worker-id"] ?? env.BAND_WORKER_ID,
    labels,
    roots,
    stateDir: resolve(
      values["state-dir"] ??
        env.BAND_WORKER_STATE_DIR ??
        join(env.BAND_HOME ?? join(homedir(), ".band"), "worker"),
    ),
    reposDir: resolve(
      values["repos-dir"] ?? env.BAND_REPOS_DIR ?? join(homedir(), "band", "repos"),
    ),
    bandHome: resolve(env.BAND_HOME ?? join(homedir(), ".band")),
    ephemeral,
    idleExitMs: idleText === undefined ? DEFAULT_IDLE_EXIT_MS : parseDuration(idleText),
  };
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      hub: { type: "string" },
      token: { type: "string" },
      name: { type: "string" },
      "worker-id": { type: "string" },
      labels: { type: "string" },
      root: { type: "string", multiple: true },
      "repos-dir": { type: "string" },
      "state-dir": { type: "string" },
      ephemeral: { type: "boolean" },
      "idle-exit": { type: "string" },
    },
    strict: true,
  });
}
