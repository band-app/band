// Helpers shared by the VM runner hooks (runners/hetzner, runners/contabo). Plain Node, no dependencies:
// the hub runs hooks with BAND_NODE.

/** Print a message to stderr and exit 1. A hook that exits non-zero fails the attempt. */
export function die(message) {
  console.error(message);
  process.exit(1);
}

/** A required variable from the hook's environment. */
export function need(name) {
  const value = process.env[name];
  if (!value) die(`${name} is required (set it in the runner's "env")`);
  return value;
}

/** Print the machine handle line the hub reads from the hook's output. */
export function printHandle(handle) {
  console.log(`BAND_MACHINE_HANDLE=${handle}`);
}

/**
 * A JSON call to a provider API. Returns the parsed body, or null for an empty one. Throws an Error whose
 * message names the method, path, status and the provider's own message, never the request body (it holds
 * the user data, which holds the bootstrap token).
 */
export async function api(base, method, path, { headers = {}, json, form, allow = [] } = {}) {
  const timeoutMs = Number(process.env.BAND_RUNNER_HTTP_TIMEOUT_MS) || 30000;
  const init = { method, headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, init);
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok && !allow.includes(res.status)) {
    const detail = body?.error?.message ?? body?.message ?? body?.error_description ?? text.slice(0, 200);
    throw new Error(`${method} ${path} answered ${res.status}: ${detail}`);
  }
  return { status: res.status, body };
}

/** Run a hook's main function and turn a thrown error into a failed attempt. */
export function run(main) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)));
}

/** The repository name the hooks clone into, as `runners/docker` derives it. */
export function repoName() {
  const name = (process.env.BAND_PROJECT || "repo").replace(/[^A-Za-z0-9_.-]/g, "_");
  return name === "" || name === "." || name === ".." ? "repo" : name;
}

/** The first clone URL the VM can use, or "" when the project has only a path on the hub's machine. */
export function cloneUrl() {
  const first = (process.env.BAND_REPO_URLS || "").split(",")[0] ?? "";
  return first.startsWith("/") ? "" : first;
}
