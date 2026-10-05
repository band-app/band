/**
 * Hands git credentials to workers (plan step 4.1, the credential vault).
 *
 * A git credential helper on the worker asks for the credential of one remote
 * with `git.credential`. The hub answers only for a remote of a repository
 * placed on that worker: a project with a checkout or a workspace on the
 * worker (its remotes, read from the hub's checkout, never from the
 * worker's own, which its agents can edit), or a clone the hub is about to make there (`expectRemote`). Anything
 * else is refused, so a worker cannot fish for the token of a repository it
 * does not serve.
 *
 * The secret goes only in the reply. The log has one line per request (worker,
 * host, path and the outcome) and never a username or a token.
 */

import {
  type GitCredentialParams,
  type GitCredentialReply,
  METHOD_GIT_CREDENTIAL,
  RpcError,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { ProjectQueries } from "../infra/db/queries/projects";
import { hostRegistry } from "../infra/host/registry";
import {
  type GitTokenSource,
  parseRemoteUrl,
  type RemoteKey,
  remoteKeyOf,
  VaultGitTokenSource,
} from "./_utils/git-token-source";
import { loadState } from "./state";

const log = createLogger("git-credential");

const RPC_INVALID_PARAMS = -32602;
const RPC_FORBIDDEN = -32003;
const REMOTE_V = /^\s*\S+\s+(\S+)\s+\((?:fetch|push)\)\s*$/;

interface PlacedRemote extends RemoteKey {
  project: string | null;
}

export class GitCredentialService {
  private readonly projects = new ProjectQueries();
  /** Remotes the hub will clone onto a worker that has no checkout yet, by worker id. */
  private readonly expected = new Map<string, PlacedRemote[]>();

  constructor(private readonly source: GitTokenSource = new VaultGitTokenSource()) {}

  attach(session: ServerSession): void {
    session.handle(METHOD_GIT_CREDENTIAL, (params) => this.handle(session.workerId, params));
  }

  /** Allows `url` for the worker's credential requests before it has a checkout of the repository. */
  expectRemote(workerId: string, url: string, project: string | null): void {
    const key = isHttpUrl(url) ? parseRemoteUrl(url) : null;
    if (!key) return;
    const list = this.expected.get(workerId) ?? [];
    list.push({ ...key, project });
    this.expected.set(workerId, list);
  }

  forget(workerId: string): void {
    this.expected.delete(workerId);
  }

  /** True when the vault holds a credential the hub would hand out for this remote URL. */
  async hasCredentialFor(url: string, project: string | null): Promise<boolean> {
    const key = isHttpUrl(url) ? parseRemoteUrl(url) : null;
    if (!key) return false;
    return (await this.source.lookup({ ...key, project, peek: true })) !== null;
  }

  private async handle(workerId: string, params: unknown): Promise<GitCredentialReply> {
    const { protocol, host, path } = parseParams(params);
    const where = `${host}/${path}`;
    if (protocol === "http" && !isLoopbackHost(host)) {
      log.warn(`refused ${host}/${path} for worker ${workerId}: plain http to a remote host`);
      return { found: false };
    }
    const key = remoteKeyOf(host, path);
    const placed = await this.placement(workerId, key);
    if (!placed) {
      log.warn(
        `refused ${where} for worker ${workerId}: not a remote of a repository placed on it`,
      );
      throw new RpcError(RPC_FORBIDDEN, "that repository is not placed on this worker");
    }
    const credential = await this.source.lookup({ ...key, project: placed.project });
    if (!credential) {
      log.info(`no credential for ${where} (${protocol}) for worker ${workerId}`);
      return { found: false };
    }
    log.info(`handed out the credential for ${where} (${protocol}) to worker ${workerId}`);
    return { found: true, ...credential };
  }

  /** The placed remote that `key` names on this worker, or null. */
  private async placement(workerId: string, key: RemoteKey): Promise<PlacedRemote | null> {
    const same = (r: RemoteKey) => r.host === key.host && r.path === key.path;
    const expected = this.expected.get(workerId)?.find(same);
    if (expected) return expected;
    // Only the hub's own checkout is trusted. The worker's checkout is writable by its agents,
    // which could add a remote to it and so claim any repository the vault covers.
    for (const { project } of this.projects.projectsOnHost(workerId)) {
      for (const remote of await this.remotesOf(project)) {
        if (same(remote)) return { ...remote, project };
      }
    }
    return null;
  }

  /** The remotes of a project's repository, read from the hub's checkout. */
  private async remotesOf(project: string): Promise<RemoteKey[]> {
    const local = loadState().projects.find((p) => p.name === project)?.path;
    if (!local) return [];
    try {
      const { stdout } = await hostRegistry.local.git.exec(["remote", "-v"], local);
      const urls: string[] = [];
      for (const line of stdout.split("\n")) {
        const m = REMOTE_V.exec(line);
        if (m) urls.push(m[1]);
      }
      return urls.map(parseRemoteUrl).filter((k): k is RemoteKey => k !== null);
    } catch {
      return [];
    }
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

function parseParams(params: unknown): GitCredentialParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const text = (name: string, max: number): string => {
    const v = p[name];
    if (typeof v !== "string" || v.length === 0 || v.length > max || /[\0\r\n]/.test(v)) {
      throw new RpcError(RPC_INVALID_PARAMS, `${name} must be a short single-line string`);
    }
    return v;
  };
  const protocol = text("protocol", 10);
  if (protocol !== "https" && protocol !== "http") {
    throw new RpcError(RPC_INVALID_PARAMS, "protocol must be http or https");
  }
  return { protocol, host: text("host", 260), path: text("path", 500) };
}

export const gitCredentialService = new GitCredentialService();
