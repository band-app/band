/**
 * Reads the hosts a `~/.ssh/config` names, for the "Over ssh" tab of the Add worker dialog.
 *
 * Pure text in, hosts out. The caller supplies `readInclude`, which expands one `Include`
 * pattern into the text of the files it matches, so the same parser works on any worker's disk
 * through `host.fs`.
 */

export interface SshConfigHost {
  /** The alias to pass to ssh. */
  name: string;
  user: string | null;
  hostname: string | null;
}

const MAX_INCLUDE_DEPTH = 5;
const MAX_HOSTS = 500;

/** Splits `Key value` or `Key=value` into a lowercase key and an unquoted value. */
function splitLine(raw: string): { key: string; value: string } | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  return { key: (match[1] ?? "").toLowerCase(), value: (match[2] ?? "").trim() };
}

/** Whitespace separated words, honouring double quotes. */
function words(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(value); m; m = re.exec(value)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

function isConcrete(pattern: string): boolean {
  return pattern !== "" && !/[*?!]/.test(pattern);
}

export async function parseSshConfig(
  text: string,
  readInclude: (pattern: string) => Promise<string[]>,
  depth = 0,
): Promise<SshConfigHost[]> {
  const hosts: SshConfigHost[] = [];
  let block: SshConfigHost[] = [];
  const flush = () => {
    block = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = splitLine(raw);
    if (!line) continue;
    if (line.key === "host") {
      flush();
      block = words(line.value)
        .filter(isConcrete)
        .map((name) => ({ name, user: null, hostname: null }));
      hosts.push(...block);
    } else if (line.key === "match") {
      flush();
    } else if (line.key === "include") {
      if (depth >= MAX_INCLUDE_DEPTH) continue;
      for (const pattern of words(line.value)) {
        for (const included of await readInclude(pattern)) {
          hosts.push(...(await parseSshConfig(included, readInclude, depth + 1)));
        }
      }
    } else if (line.key === "hostname") {
      for (const h of block) h.hostname ??= words(line.value)[0] ?? null;
    } else if (line.key === "user") {
      for (const h of block) h.user ??= words(line.value)[0] ?? null;
    }
    if (hosts.length >= MAX_HOSTS) break;
  }
  const seen = new Set<string>();
  return hosts.filter((h) => {
    if (seen.has(h.name)) return false;
    seen.add(h.name);
    return true;
  });
}

/** The label a row shows: `user@hostname` when the config gives them, else what it has. */
export function sshHostLabel(host: SshConfigHost): string {
  if (host.user) return `${host.user}@${host.hostname ?? host.name}`;
  return host.hostname ?? "";
}

/**
 * A typed ssh target: `host`, `user@host` or a config alias. It must start with a letter, digit
 * or underscore (never `-`, so it cannot be read as an option) and hold no whitespace or shell
 * metacharacters. Callers still pass it after `--`.
 */
export function isSafeSshTarget(target: string): boolean {
  if (target.length === 0 || target.length > 255) return false;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@:%+-]*$/.test(target)) return false;
  return target.split("@").length <= 2;
}

/** The same rule for a bare host name. */
export function isSafeSshHostname(name: string): boolean {
  return isSafeSshTarget(name) && !name.includes("@");
}
