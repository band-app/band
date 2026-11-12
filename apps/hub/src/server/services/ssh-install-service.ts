/**
 * Installs a worker on another machine over ssh, from a worker the admin chooses (usually the
 * computer they are on, which has their `~/.ssh/config`, keys and ssh-agent).
 *
 * Everything runs through `Host`: `host.fs` reads the config and known_hosts, `host.exec` runs
 * `ssh`, `ssh-keyscan` and `ssh-keygen` on that worker. The install makes an ordinary
 * provisioning command and runs its one-line `curl ... | sh` on the target, so status, log,
 * expiry and the new worker row are the provisioning flow's own.
 *
 * - ssh always runs with `BatchMode=yes` and `StrictHostKeyChecking=yes`. It never asks for
 *   input; when it needs some, the install fails and says what to do.
 * - A target is validated and passed after `--`. No shell string is built from it.
 * - A host not in known_hosts is installed only after the admin confirms the fingerprints this
 *   service showed. A host whose key differs from known_hosts is refused.
 * - `BAND_SSH_BIN`, `BAND_SSH_KEYSCAN_BIN` and `BAND_SSH_KEYGEN_BIN` replace the three binaries,
 *   read on every call, so tests can stub them (see `.claude/rules/test-exceptions.md`).
 */

import { posix } from "node:path";
import type { Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { hostRegistry } from "../infra/host/registry";
import {
  isSafeSshHostname,
  isSafeSshTarget,
  parseSshConfig,
  type SshConfigHost,
  sshHostLabel,
} from "./_utils/ssh-config";
import { provisioningService } from "./provisioning-service";

const log = createLogger("ssh-install");

const INSTALL_TIMEOUT_MS = 35 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_CONFIG_BYTES = 256 * 1024;

export const SSH_INPUT_HINT =
  "Band runs ssh without a terminal, so it cannot type a passphrase or a password. Load the key into ssh-agent (ssh-add), set up key login for this host, or run the one-line command on the machine yourself.";

const bin = (env: string, fallback: string): string => process.env[env] || fallback;
const sshBin = () => bin("BAND_SSH_BIN", "ssh");
const keyscanBin = () => bin("BAND_SSH_KEYSCAN_BIN", "ssh-keyscan");
const keygenBin = () => bin("BAND_SSH_KEYGEN_BIN", "ssh-keygen");

export interface SshHostRow {
  name: string;
  /** `user@hostname` when the config gives them. */
  label: string;
}

export interface SshFingerprint {
  type: string;
  fingerprint: string;
}

export type SshInspection =
  | { state: "known" }
  | { state: "unknown"; fingerprints: SshFingerprint[] }
  | { state: "changed" };

interface Resolved {
  hostname: string;
  port: string;
  knownHostsFiles: string[];
}

interface KeyLine {
  type: string;
  blob: string;
  line: string;
}

function parseKeyLines(text: string): KeyLine[] {
  const out: KeyLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const type = parts[1];
    const blob = parts[2];
    if (parts.length >= 3 && type && blob)
      out.push({ type, blob, line: `${parts[0]} ${type} ${blob}` });
  }
  return out;
}

function userError(code: "BAD_REQUEST" | "PRECONDITION_FAILED", message: string): TRPCError {
  return new TRPCError({ code, message });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SshInstallService {
  private host(hostId: string): Host {
    try {
      return hostRegistry.hostById(hostId);
    } catch {
      throw userError("PRECONDITION_FAILED", `The worker "${hostId}" is not connected.`);
    }
  }

  private async home(host: Host): Promise<string> {
    const home = (await host.info()).home;
    if (!home) throw userError("PRECONDITION_FAILED", "The worker did not report its home folder.");
    return home;
  }

  /** The hosts in the worker's `~/.ssh/config`, `Include` files followed. */
  async listHosts(hostId: string): Promise<SshHostRow[]> {
    const host = this.host(hostId);
    const sshDir = posix.join(await this.home(host), ".ssh");
    const readFile = async (path: string): Promise<string | null> => {
      try {
        const stat = await host.fs.stat(path);
        if (stat.kind !== "file" || stat.size > MAX_CONFIG_BYTES) return null;
        return new TextDecoder().decode(await host.fs.readFile(path));
      } catch {
        return null;
      }
    };
    const main = await readFile(posix.join(sshDir, "config"));
    if (main === null) return [];
    const readInclude = async (pattern: string): Promise<string[]> => {
      const home = await this.home(host);
      const expanded = pattern.startsWith("~/") ? posix.join(home, pattern.slice(2)) : pattern;
      const absolute = posix.isAbsolute(expanded) ? expanded : posix.join(sshDir, expanded);
      let files: string[];
      try {
        const dir = posix.dirname(absolute);
        files = (await host.fs.glob(posix.basename(absolute), dir)).map((f) => posix.join(dir, f));
      } catch {
        return [];
      }
      const texts: string[] = [];
      for (const file of files.sort()) {
        const text = await readFile(file);
        if (text !== null) texts.push(text);
      }
      return texts;
    };
    const hosts: SshConfigHost[] = await parseSshConfig(main, readInclude);
    return hosts.map((h) => ({ name: h.name, label: sshHostLabel(h) }));
  }

  private checkTarget(target: string): string {
    const trimmed = target.trim();
    if (!isSafeSshTarget(trimmed)) {
      throw userError(
        "BAD_REQUEST",
        "That is not a valid ssh target. Use a host name, an address, or user@host, with no spaces or shell characters, and nothing starting with a dash.",
      );
    }
    return trimmed;
  }

  /** `ssh -G` resolves the config for a target without connecting. */
  private async resolve(host: Host, target: string, home: string): Promise<Resolved> {
    let out: string;
    try {
      out = (await host.exec(sshBin(), ["-G", "--", target], { timeoutMs: PROBE_TIMEOUT_MS }))
        .stdout;
    } catch (err) {
      throw userError(
        "PRECONDITION_FAILED",
        `ssh could not read the config for ${target}: ${errMessage(err)}`,
      );
    }
    const values = new Map<string, string>();
    for (const line of out.split("\n")) {
      const idx = line.indexOf(" ");
      if (idx > 0) values.set(line.slice(0, idx).toLowerCase(), line.slice(idx + 1).trim());
    }
    const hostname = values.get("hostname") ?? "";
    if (!isSafeSshHostname(hostname)) {
      throw userError("BAD_REQUEST", `ssh resolved ${target} to a host name Band will not use.`);
    }
    const port = values.get("port") ?? "22";
    if (!/^\d{1,5}$/.test(port)) throw userError("BAD_REQUEST", "ssh resolved an invalid port.");
    const files =
      `${values.get("userknownhostsfile") ?? "~/.ssh/known_hosts"} ${values.get("globalknownhostsfile") ?? ""}`
        .split(/\s+/)
        .filter((f) => f && f !== "none")
        .map((f) => (f.startsWith("~/") ? posix.join(home, f.slice(2)) : f))
        .filter((f) => posix.isAbsolute(f));
    return { hostname, port, knownHostsFiles: files };
  }

  private async scan(host: Host, r: Resolved): Promise<KeyLine[]> {
    let out: string;
    try {
      out = (
        await host.exec(keyscanBin(), ["-T", "8", "-p", r.port, "--", r.hostname], {
          timeoutMs: PROBE_TIMEOUT_MS,
        })
      ).stdout;
    } catch (err) {
      throw userError(
        "PRECONDITION_FAILED",
        `Could not read the host key of ${r.hostname}: ${errMessage(err)}`,
      );
    }
    const keys = parseKeyLines(out);
    if (keys.length === 0) {
      throw userError(
        "PRECONDITION_FAILED",
        `${r.hostname} did not offer a host key. Check that it is reachable and runs sshd.`,
      );
    }
    return keys;
  }

  /** The keys known_hosts holds for the host, from every file ssh would read. */
  private async known(host: Host, r: Resolved): Promise<KeyLine[]> {
    const name = r.port === "22" ? r.hostname : `[${r.hostname}]:${r.port}`;
    const found: KeyLine[] = [];
    for (const file of r.knownHostsFiles) {
      try {
        const out = await host.exec(keygenBin(), ["-F", name, "-f", file], {
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        found.push(...parseKeyLines(out.stdout));
      } catch {
        // No entry, or no such file.
      }
    }
    return found;
  }

  private async fingerprints(host: Host, keys: KeyLine[]): Promise<SshFingerprint[]> {
    const dir = await host.fs.mkdtemp("band-ssh-keys-");
    try {
      const file = posix.join(dir, "keys");
      await host.fs.writeFile(file, `${keys.map((k) => k.line).join("\n")}\n`);
      const out = (
        await host.exec(keygenBin(), ["-l", "-f", file], { timeoutMs: PROBE_TIMEOUT_MS })
      ).stdout;
      const result: SshFingerprint[] = [];
      for (const line of out.split("\n")) {
        const m = /^\S+\s+(SHA256:\S+)\s.*\(([A-Za-z0-9-]+)\)\s*$/.exec(line.trim());
        if (m?.[1] && m[2]) result.push({ type: m[2], fingerprint: m[1] });
      }
      return result;
    } catch (err) {
      throw userError(
        "PRECONDITION_FAILED",
        `Could not compute the host key fingerprint: ${errMessage(err)}`,
      );
    } finally {
      await host.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async inspectOn(
    host: Host,
    target: string,
  ): Promise<{ result: SshInspection; keys: KeyLine[]; resolved: Resolved }> {
    const home = await this.home(host);
    const resolved = await this.resolve(host, target, home);
    const scanned = await this.scan(host, resolved);
    const known = await this.known(host, resolved);
    if (known.length === 0) {
      const fingerprints = await this.fingerprints(host, scanned);
      return { result: { state: "unknown", fingerprints }, keys: scanned, resolved };
    }
    const match = scanned.some((s) => known.some((k) => k.type === s.type && k.blob === s.blob));
    return { result: { state: match ? "known" : "changed" }, keys: scanned, resolved };
  }

  /** Whether the target's host key is known, new (with its fingerprints) or changed. */
  async inspect(hostId: string, target: string): Promise<SshInspection> {
    const host = this.host(hostId);
    return (await this.inspectOn(host, this.checkTarget(target))).result;
  }

  private async trust(host: Host, resolved: Resolved, keys: KeyLine[]): Promise<void> {
    const home = await this.home(host);
    const file = resolved.knownHostsFiles[0] ?? posix.join(home, ".ssh", "known_hosts");
    let existing = "";
    try {
      existing = new TextDecoder().decode(await host.fs.readFile(file));
    } catch {
      await host.fs.mkdir(posix.dirname(file), { recursive: true });
    }
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await host.fs.writeFile(file, `${existing}${prefix}${keys.map((k) => k.line).join("\n")}\n`, {
      mode: 0o600,
    });
  }

  /**
   * Makes a provisioning command and runs it on the target over ssh from the chosen worker.
   * Returns at once with the command's id; the run goes on in the background and the dialog
   * follows it with `provisioning.status`.
   */
  async install(input: {
    workerId: string;
    target: string;
    hubUrl: string;
    hostName?: string;
    /** The fingerprints the admin confirmed for a host not in known_hosts yet. */
    trustFingerprints?: string[];
  }): Promise<{ id: string; expiresAt: number; hostName: string }> {
    const target = this.checkTarget(input.target);
    const host = this.host(input.workerId);
    const { result, keys, resolved } = await this.inspectOn(host, target);
    if (result.state === "changed") {
      throw userError(
        "PRECONDITION_FAILED",
        `The host key of ${target} changed since it was saved in known_hosts. Nothing was run. If the machine was rebuilt, remove the old entry (ssh-keygen -R ${resolved.hostname}) and try again.`,
      );
    }
    if (result.state === "unknown") {
      const shown = result.fingerprints.map((f) => f.fingerprint).sort();
      const confirmed = [...(input.trustFingerprints ?? [])].sort();
      if (confirmed.length === 0) {
        throw userError(
          "PRECONDITION_FAILED",
          "The host key is not confirmed yet. Nothing was run.",
        );
      }
      if (shown.join(" ") !== confirmed.join(" ")) {
        throw userError(
          "PRECONDITION_FAILED",
          "The host key differs from the one you confirmed. Nothing was run. Check the fingerprint again.",
        );
      }
      await this.trust(host, resolved, keys);
    }
    const created = await provisioningService.create({
      hubUrl: input.hubUrl,
      hostName: input.hostName || undefined,
    });
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=15",
      "--",
      target,
      created.command,
    ];
    log.info(`installing over ssh from ${input.workerId}: command ${created.id}`);
    void host
      .exec(sshBin(), args, { timeoutMs: INSTALL_TIMEOUT_MS })
      .then(
        () => provisioningService.sshEnded(created.id, null),
        (err) => provisioningService.sshEnded(created.id, sshFailureNote(errMessage(err))),
      )
      .catch((err) => log.warn(`could not record the ssh result: ${errMessage(err)}`));
    return { id: created.id, expiresAt: created.expiresAt, hostName: created.hostName };
  }
}

/** ssh's own message, with the hint when it was asking for input. */
export function sshFailureNote(message: string): string {
  const trimmed = message.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(trimmed)) {
    return `ssh refused the connection because the host key changed.\n${trimmed}`;
  }
  const needsInput =
    /permission denied|passphrase|password|publickey|authentication|no more authentication/i.test(
      trimmed,
    );
  return `ssh failed: ${trimmed}${needsInput ? `\n${SSH_INPUT_HINT}` : ""}`;
}

export const sshInstallService = new SshInstallService();
