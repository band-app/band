/**
 * Hands a worker the secrets of its profile.
 *
 * A profile maps vault items to environment variables and to files (`secrets` in
 * `_utils/worker-profile.ts`). A worker asks for them with `secrets.fetch` over its authenticated
 * link and gets only its own profile's mappings: the worker id comes from the link session, never
 * from the request. A worker with no profile gets an empty answer. When a mapped vault item or a
 * worker's profile changes, the hub sends `secrets.changed` so the worker rewrites its files.
 *
 * Values go in the reply only. The log has the worker, the profile and counts, never a value.
 */

import {
  METHOD_SECRETS_CHANGED,
  METHOD_SECRETS_FETCH,
  METHOD_SECRETS_REPORT,
  type SecretsFetchReply,
  type SecretsReportParams,
  type ServerSession,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { TokenQueries } from "../infra/db/queries/tokens";
import { onCredentialChange } from "./_utils/credential-events";
import {
  DEFAULT_SECRET_FILE_MODE,
  normalizeSecretFile,
  parseSecretMode,
} from "./_utils/worker-profile";
import { vaultService } from "./vault-service";
import { emit } from "./watcher-service";
import { workerProfileService } from "./worker-profile-service";

const log = createLogger("worker-secrets");

export class WorkerSecretsService {
  private readonly hosts = new TokenQueries();
  private readonly sessions = new Map<string, ServerSession>();
  private readonly reports = new Map<string, SecretsReportParams>();

  constructor() {
    onCredentialChange((change) => {
      if (change.kind === "vault-item") this.pushWhere((p) => p.items.has(change.name));
    });
  }

  attach(session: ServerSession): void {
    this.sessions.set(session.workerId, session);
    session.handle(METHOD_SECRETS_FETCH, () => this.fetchFor(session.workerId));
    session.handle(METHOD_SECRETS_REPORT, (params) => {
      this.reports.set(session.workerId, parseReport(params));
      emit({ kind: "host-status-changed", hostId: session.workerId });
      return null;
    });
  }

  /** The files a worker wrote and the mappings it refused, from its last report. */
  reportFor(workerId: string): SecretsReportParams | null {
    return this.reports.get(workerId) ?? null;
  }

  /** The mappings of a worker's profile with their current values. Missing items are skipped. */
  fetchFor(workerId: string): SecretsFetchReply {
    const profile = workerProfileService.profileOf(workerId);
    const reply: SecretsFetchReply = { profile: profile?.name ?? null, env: {}, files: [] };
    if (!profile) return reply;
    for (const mapping of profile.secrets ?? []) {
      const value = vaultService.getGlobalSecret(mapping.item);
      if (value === undefined) {
        log.warn(`profile ${profile.name}: no usable vault item "${mapping.item}", skipped`);
        continue;
      }
      if ("env" in mapping) {
        reply.env[mapping.env] = value;
        continue;
      }
      const path = normalizeSecretFile(mapping.file);
      if (path === null) continue;
      const mode = mapping.mode
        ? (parseSecretMode(mapping.mode) ?? DEFAULT_SECRET_FILE_MODE)
        : DEFAULT_SECRET_FILE_MODE;
      reply.files.push({ path, mode, data: Buffer.from(value, "utf8").toString("base64") });
    }
    log.debug(
      `gave worker ${workerId} ${Object.keys(reply.env).length} env and ${reply.files.length} file secrets of ${profile.name}`,
    );
    return reply;
  }

  /** Tells these workers to fetch again (their profile or a mapped item changed). */
  pushTo(workerIds: Iterable<string>): void {
    for (const id of workerIds) {
      const session = this.sessions.get(id);
      if (!session?.attached) continue;
      session.request(METHOD_SECRETS_CHANGED, {}).catch((err) => {
        log.warn(
          `could not tell worker ${id} to refresh its secrets: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  private pushWhere(match: (p: { items: Set<string> }) => boolean): void {
    const ids: string[] = [];
    for (const [workerId] of this.sessions) {
      const profile = workerProfileService.profileOf(workerId);
      if (!profile) continue;
      const items = new Set((profile.secrets ?? []).map((m) => m.item));
      if (match({ items })) ids.push(workerId);
    }
    this.pushTo(ids);
  }

  /** Called when a profile's mappings changed, or a worker got or lost a profile. */
  profileChanged(name: string | null, workerId?: string): void {
    if (workerId) this.pushTo([workerId]);
    else if (name) this.pushTo(this.hosts.hostIdsWithProfile(name));
  }
}

function parseReport(params: unknown): SecretsReportParams {
  const p = (params ?? {}) as Partial<SecretsReportParams>;
  const written = Array.isArray(p.written)
    ? p.written.filter((x): x is string => typeof x === "string").slice(0, 200)
    : [];
  const refused = Array.isArray(p.refused)
    ? p.refused
        .filter((r) => r && typeof r.path === "string" && typeof r.reason === "string")
        .slice(0, 200)
        .map((r) => ({ path: r.path.slice(0, 500), reason: r.reason.slice(0, 300) }))
    : [];
  return { written, refused };
}

export const workerSecretsService = new WorkerSecretsService();
