/**
 * Where git credentials come from. Today the only source is a `git` item in
 * the vault (a fine-grained personal access token). A GitHub App that mints
 * short-lived installation tokens would be a second implementation of this
 * interface, so `GitCredentialService` does not change.
 */

import { type GitCredentialMatch, vaultService } from "../vault-service";

export interface GitCredential {
  username: string;
  password: string;
}

export interface GitTokenSource {
  /** The credential for a remote, or null when the source holds none for it. */
  lookup(match: GitCredentialMatch): Promise<GitCredential | null>;
}

export class VaultGitTokenSource implements GitTokenSource {
  async lookup(match: GitCredentialMatch): Promise<GitCredential | null> {
    return vaultService.findGitCredential(match) ?? null;
  }
}

export interface RemoteKey {
  /** Lowercase host, with the port when the URL has one. */
  host: string;
  /** Lowercase repository path without a leading slash or a `.git` suffix. */
  path: string;
}

/** Normalizes the `host` and `path` git sends to a credential helper. */
export function remoteKeyOf(host: string, path: string): RemoteKey {
  return {
    host: host.trim().toLowerCase(),
    path: path
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase(),
  };
}

/** Parses a remote URL (`https://`, `ssh://` or scp-like `git@host:owner/repo`), or null. */
export function parseRemoteUrl(url: string): RemoteKey | null {
  const text = url.trim();
  if (!text) return null;
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return remoteKeyOf(scp[1], scp[2]);
  try {
    const parsed = new URL(text);
    if (!parsed.host) return null;
    return remoteKeyOf(parsed.host, parsed.pathname);
  } catch {
    return null;
  }
}
