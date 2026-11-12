/**
 * Worker profiles: named bundles of how a worker is provisioned (repo, labels, trust, worker
 * settings) and which vault credentials it may receive.
 *
 * Profiles live in `settings.workerProfiles` and are checked on every read: an invalid entry is
 * reported by `list` and never applied. An admin attaches a profile to a worker (`hosts.profile`);
 * a worker cannot choose or change its own. The hub reads the profile on every credential request,
 * so changing it takes effect on the worker's next call.
 *
 * A profile with a `credentials` object is a policy: git items, the `gh` item and agent logins not
 * listed are refused. A profile without it, and a worker without a profile, keep the rules from
 * before profiles. A worker whose profile name no longer resolves gets nothing, not everything.
 */

import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { AgentLoginQueries } from "../infra/db/queries/agent-logins";
import { TokenQueries } from "../infra/db/queries/tokens";
import { checkRepoUrl, checkStartCommand } from "./_utils/provision-checks";
import { describeIssue, type WorkerProfile, workerProfileSchema } from "./_utils/worker-profile";
import { hostTrustService } from "./host-trust-service";
import { settingsService } from "./settings-service";
import { vaultService } from "./vault-service";

const log = createLogger("worker-profiles");
const EMPTY: unknown[] = [];

export interface InvalidProfile {
  index: number;
  name: string | null;
  error: string;
}

export interface ProfileList {
  profiles: (WorkerProfile & { workers: number })[];
  invalid: InvalidProfile[];
}

/** What a worker with a profile may receive. */
export interface CredentialPolicy {
  /** Names of the vault git items. */
  git: string[];
  /** Name of the git item `gh` gets, or null for none. */
  gh: string | null;
  /** Ids or labels of the agent logins. */
  agentLogins: string[];
}

export class WorkerProfileService {
  private readonly hosts = new TokenQueries();
  private readonly logins = new AgentLoginQueries();

  private raw(): unknown[] {
    const value = settingsService.get().workerProfiles;
    return Array.isArray(value) ? value : EMPTY;
  }

  /** Parsed result for the settings array it was built from; the settings cache keeps that array until the file changes. */
  private parsed: {
    source: unknown[];
    result: { valid: WorkerProfile[]; invalid: InvalidProfile[] };
  } | null = null;

  private parse(): { valid: WorkerProfile[]; invalid: InvalidProfile[] } {
    const source = this.raw();
    if (this.parsed?.source === source) return this.parsed.result;
    const result = this.parseEntries(source);
    this.parsed = { source, result };
    return result;
  }

  private parseEntries(source: unknown[]): { valid: WorkerProfile[]; invalid: InvalidProfile[] } {
    const valid: WorkerProfile[] = [];
    const invalid: InvalidProfile[] = [];
    source.forEach((entry, index) => {
      const parsed = workerProfileSchema.safeParse(entry);
      const name =
        entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? (entry as { name: string }).name
          : null;
      if (!parsed.success) {
        invalid.push({ index, name, error: describeIssue(parsed.error) });
      } else if (valid.some((p) => p.name === parsed.data.name)) {
        invalid.push({ index, name, error: "name: duplicate profile name" });
      } else {
        valid.push(parsed.data);
      }
    });
    for (const bad of invalid) log.warn(`profile #${bad.index} (${bad.name ?? "?"}): ${bad.error}`);
    return { valid, invalid };
  }

  list(): ProfileList {
    const { valid, invalid } = this.parse();
    return {
      profiles: valid.map((p) => ({ ...p, workers: this.hosts.hostIdsWithProfile(p.name).length })),
      invalid,
    };
  }

  get(name: string): WorkerProfile | null {
    return this.parse().valid.find((p) => p.name === name) ?? null;
  }

  /** Throws BAD_REQUEST naming the field when the profile is not acceptable. */
  check(input: unknown): WorkerProfile {
    const parsed = workerProfileSchema.safeParse(input);
    if (!parsed.success) throw bad(describeIssue(parsed.error));
    const profile = parsed.data;
    const p = profile.provisioning;
    if (p?.repoUrl) this.field("provisioning.repoUrl", () => checkRepoUrl(p.repoUrl as string));
    if (p?.command)
      this.field("provisioning.command", () => checkStartCommand(p.command as string));
    if (p?.command && !p.repoUrl) throw bad("provisioning.repoUrl: a start command needs a repo");
    const gitItems = new Set(
      vaultService
        .list()
        .filter((i) => i.kind === "git")
        .map((i) => i.name),
    );
    const c = profile.credentials;
    for (const name of c?.git ?? []) {
      if (!gitItems.has(name)) throw bad(`credentials.git: no vault git item named "${name}"`);
    }
    if (c?.gh && !gitItems.has(c.gh)) {
      throw bad(`credentials.gh: no vault git item named "${c.gh}"`);
    }
    const logins = this.logins.list();
    for (const ref of c?.agentLogins ?? []) {
      if (!logins.some((l) => l.id === ref || l.label === ref)) {
        throw bad(`credentials.agentLogins: no agent login "${ref}"`);
      }
    }
    return profile;
  }

  private field(path: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      throw bad(`${path}: ${err instanceof TRPCError ? err.message : String(err)}`);
    }
  }

  create(input: unknown): WorkerProfile {
    const profile = this.check(input);
    if (this.raw().some((e) => (e as { name?: unknown } | null)?.name === profile.name)) {
      throw bad(`name: a profile named "${profile.name}" already exists`);
    }
    this.save([...this.raw(), profile]);
    return profile;
  }

  update(name: string, input: unknown): WorkerProfile {
    const profile = this.check(input);
    if (profile.name !== name) throw bad("name: a profile cannot be renamed");
    if (!this.get(name))
      throw new TRPCError({ code: "NOT_FOUND", message: `No profile "${name}".` });
    this.save(
      this.raw().map((e) => ((e as { name?: unknown } | null)?.name === name ? profile : e)),
    );
    return profile;
  }

  remove(name: string): void {
    const used = this.hosts.hostIdsWithProfile(name);
    if (used.length > 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `The profile "${name}" is used by ${used.length} worker${used.length === 1 ? "" : "s"}. Detach it first.`,
      });
    }
    if (!this.raw().some((e) => (e as { name?: unknown } | null)?.name === name)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No profile "${name}".` });
    }
    this.save(this.raw().filter((e) => (e as { name?: unknown } | null)?.name !== name));
  }

  private save(next: unknown[]): void {
    // Entries already in the file stay as they are, valid or not; only the changed one was checked.
    settingsService.update({ workerProfiles: next as WorkerProfile[] });
  }

  /** The profile name of a worker, or null. */
  profileNameOf(hostId: string): string | null {
    return this.hosts.findHost(hostId)?.profile ?? null;
  }

  /**
   * Attaches a profile to a worker, or removes it with null. Attaching sets the worker's trust to
   * the profile's, when the profile has one. The per-worker trust selector still works afterwards.
   */
  setHostProfile(hostId: string, name: string | null): { hostId: string; profile: string | null } {
    if (!this.hosts.findHost(hostId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: `No worker "${hostId}".` });
    }
    if (name === null) {
      this.hosts.setHostProfile(hostId, null);
      return { hostId, profile: null };
    }
    const profile = this.get(name);
    if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: `No profile "${name}".` });
    this.hosts.setHostProfile(hostId, name);
    if (profile.trust) hostTrustService.setTrust(hostId, profile.trust);
    log.info(`attached profile ${name} to worker ${hostId}`);
    return { hostId, profile: name };
  }

  /**
   * The credential policy of a worker, or null when today's rules apply (no profile, or a profile
   * without `credentials`). A profile that no longer resolves is the empty policy.
   */
  policyFor(hostId: string): CredentialPolicy | null {
    const name = this.profileNameOf(hostId);
    if (!name) return null;
    const profile = this.get(name);
    if (!profile) {
      log.warn(
        `worker ${hostId} names profile ${name}, which is missing or invalid: no credentials`,
      );
      return { git: [], gh: null, agentLogins: [] };
    }
    if (!profile.credentials) return null;
    return {
      git: profile.credentials.git ?? [],
      gh: profile.credentials.gh ?? null,
      agentLogins: profile.credentials.agentLogins ?? [],
    };
  }
}

function bad(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

export const workerProfileService = new WorkerProfileService();
