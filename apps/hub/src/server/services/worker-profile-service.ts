/**
 * Worker profiles: named bundles of how a worker is provisioned (repo, labels, trust, worker
 * settings) and which vault items it receives as environment variables and files.
 *
 * Profiles live in `settings.workerProfiles` and are checked on every read: an invalid entry is
 * reported by `list` and never applied. An admin attaches a profile to a worker (`hosts.profile`),
 * and a runner names one for the workers it starts. A worker cannot choose or change its own.
 * `worker-secrets-service.ts` hands the secrets over the worker's link.
 */

import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
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

export class WorkerProfileService {
  private readonly hosts = new TokenQueries();

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
    // The vault changes without the settings file, so the items are checked on every read.
    const usable: WorkerProfile[] = [];
    const bad = [...invalid];
    valid.forEach((p, index) => {
      const problem = this.itemProblem(p);
      if (problem) bad.push({ index, name: p.name, error: problem });
      else usable.push(p);
    });
    return {
      profiles: usable.map((p) => ({
        ...p,
        workers: this.hosts.hostIdsWithProfile(p.name).length,
      })),
      invalid: bad,
    };
  }

  /** The first mapped or clone item that is not a usable vault item, as `path: message`. */
  private itemProblem(profile: WorkerProfile): string | null {
    const mapped = (profile.secrets ?? []).map((m, i) => [`secrets.${i}.item`, m.item] as const);
    const clone = profile.provisioning?.tokenItem
      ? [["provisioning.tokenItem", profile.provisioning.tokenItem] as const]
      : [];
    for (const [path, name] of [...mapped, ...clone]) {
      const kind = vaultService.globalKindOf(name);
      if (!kind) return `${path}: no vault item named "${name}"`;
      if (kind === "oauth")
        return `${path}: "${name}" is an OAuth connection, which cannot be mapped`;
    }
    return null;
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
    const problem = this.itemProblem(profile);
    if (problem) throw bad(problem);
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
   * The profile a worker has, or null. A worker whose profile no longer resolves (removed, or
   * broken in `settings.json`) gets null as well, so it receives nothing.
   */
  profileOf(hostId: string): WorkerProfile | null {
    const name = this.profileNameOf(hostId);
    if (!name) return null;
    const profile = this.get(name);
    if (!profile) {
      log.warn(`worker ${hostId} names profile ${name}, which is missing or invalid: no secrets`);
    }
    return profile;
  }
}

function bad(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

export const workerProfileService = new WorkerProfileService();
