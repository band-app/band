/**
 * Identity of a git remote. A repo on the hub is known by its remote URL, and a worker maps
 * that URL to a folder. `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and
 * `https://GitHub.com/o/r.git` name one repository, so they must give one key.
 */

export interface RemoteIdentity {
  /** Lowercase `host/owner/name` (or `file:///abs/path`), the same for every spelling of one remote. */
  key: string;
  /** The URL to clone from: secrets removed (web userinfo, any password), spelling otherwise kept. */
  url: string;
  host: string;
  owner: string;
  /** The repository name without `.git`. */
  name: string;
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function split(path: string): { owner: string; name: string } | null {
  const parts = stripGitSuffix(path)
    .split("/")
    .filter((p) => p !== "");
  // The owner and name become folder names on a worker, so no segment may climb out of it.
  if (parts.some((p) => p === "." || p === ".." || /[\\\0]/.test(p))) return null;
  const name = parts.pop() ?? "";
  return { owner: parts.join("/"), name };
}

/**
 * Parses a clone URL: SCP-style (`git@host:o/r.git`), `ssh://`, `http(s)://`, `git://`,
 * `file://` or an absolute local path. Returns null for anything else.
 */
export function parseRemoteUrl(input: string): RemoteIdentity | null {
  const raw = input.trim();
  // A leading dash would be read by git as an option, and `ext::` runs a command.
  if (!raw || raw.startsWith("-") || raw.includes("::")) return null;

  if (raw.startsWith("/") || raw.startsWith("file://")) {
    const path = stripGitSuffix(raw.startsWith("file://") ? raw.slice("file://".length) : raw);
    if (!path.startsWith("/")) return null;
    const sp = split(path);
    if (!sp?.name) return null;
    const { name } = sp;
    return { key: `file://${path}`, url: raw, host: "", owner: "local", name };
  }

  const scp = raw.match(/^(?:[\w.~-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const sp = split(scp[2]);
    if (!sp?.name) return null;
    const { owner, name } = sp;
    const host = scp[1].toLowerCase();
    // The user of an SCP URL is a login name (`git`), not a secret, and ssh needs it.
    return {
      key: [host, owner.toLowerCase(), name.toLowerCase()].filter(Boolean).join("/"),
      url: raw,
      host,
      owner,
      name,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (!["http", "https", "ssh", "git"].includes(scheme)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const sp = split(decoded);
  if (!sp?.name) return null;
  const { owner, name } = sp;
  const host = parsed.hostname.toLowerCase();
  // An ssh or git port does not make another repository. A web port that is not the default does.
  const webPort = scheme === "http" || scheme === "https" ? parsed.port : "";
  const hostPart = webPort ? `${host}:${webPort}` : host;
  // A web URL's user is often a token. An ssh user is a login name that ssh needs, but never a password.
  if (scheme === "http" || scheme === "https") parsed.username = "";
  parsed.password = "";
  if (scheme === "http" || scheme === "https") {
    parsed.search = "";
    parsed.hash = "";
  }
  return {
    key: [hostPart, owner.toLowerCase(), name.toLowerCase()].filter(Boolean).join("/"),
    url: parsed.toString(),
    host: hostPart,
    owner,
    name,
  };
}

/** The key of a remote URL, or null when it is not a URL git can clone. */
export function normalizeRemoteUrl(input: string): string | null {
  return parseRemoteUrl(input)?.key ?? null;
}

/** The URL with its userinfo removed. Anything that does not parse comes back with `user:pass@` cut out. */
export function stripUrlCredentials(input: string): string {
  const parsed = parseRemoteUrl(input);
  if (parsed) return parsed.url;
  return input.trim().replace(/\/\/[^/@]*@/, "//");
}
