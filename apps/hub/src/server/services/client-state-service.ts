/**
 * Client state: small UI values the dashboard keeps on the server so the
 * phone and the desktop show the same tabs, drafts and panel layout.
 *
 * The dashboard reads a worktree's (or the global) entries in one call,
 * writes one key at a time with the version it last saw, and learns about
 * other devices' writes from the `client-state-changed` status event. A write
 * whose base version is stale is refused and answered with the current row,
 * so a client coming back online can't overwrite a newer value.
 *
 * Only the keys in `shared/client-state-keys.ts` are accepted. A key's
 * worktree comes from the key itself, and a write for a worktree that no
 * longer exists is refused, so a device that missed a worktree's deletion
 * can't bring its rows back.
 */

import { createLogger } from "@band-app/logger";
import {
  CLIENT_STATE_MAX_VALUE_BYTES,
  type ClientStateEntry,
  type ClientStateScope,
  type ClientStateWriteResult,
  type DeviceType,
} from "@band-app/shared/client-state";
import { matchKey } from "@band-app/shared/client-state-keys";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import {
  ClientStateKeyError,
  ClientStateValueTooLargeError,
  ClientStateWorktreeNotFoundError,
} from "../errors";
import { ClientStateQueries } from "../infra/db/queries/client-state";
import { loadState } from "./state";
import { emit } from "./watcher-service";

const log = createLogger("client-state-service");

export interface ClientStateSetInput {
  key: string;
  scope: ClientStateScope;
  value?: unknown;
  baseVersion: number;
  clientId: string;
}

export type ClientStateDeleteInput = Omit<ClientStateSetInput, "value">;

export class ClientStateService {
  constructor(private readonly queries = new ClientStateQueries()) {}

  /** Whether the worktree exists, so its UI state may be stored. */
  private worktreeExists(worktreeId: string): boolean {
    return loadState().repos.some((p) =>
      p.worktrees.some((wt) => toWorktreeId(p.name, wt.name, wt.hostId) === worktreeId),
    );
  }

  /** Live entries of one worktree (or global ones) visible to a device type. */
  list(worktreeId: string | null, deviceType: DeviceType): ClientStateEntry[] {
    return this.queries.list(worktreeId, ["all", deviceType]);
  }

  set(input: ClientStateSetInput): ClientStateWriteResult {
    if (input.value == null) return this.delete(input);
    const serialized = JSON.stringify(input.value);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > CLIENT_STATE_MAX_VALUE_BYTES) {
      throw new ClientStateValueTooLargeError(bytes, CLIENT_STATE_MAX_VALUE_BYTES);
    }
    return this.write(input, serialized);
  }

  /** Delete a key. Its row stays as a tombstone so the version keeps counting. */
  delete(input: ClientStateDeleteInput): ClientStateWriteResult {
    return this.write(input, null);
  }

  /** Drop every entry of a deleted worktree. */
  removeAllForWorktree(worktreeId: string): void {
    const removed = this.queries.removeForWorktree(worktreeId);
    if (removed > 0) log.info({ worktreeId, removed }, "removed worktree client state");
  }

  /** The worktree a key belongs to (null for a global key). Throws for a key or scope that isn't synced. */
  private worktreeOf(key: string, scope: ClientStateScope): string | null {
    const matched = matchKey(key);
    if (!matched) throw new ClientStateKeyError(`Not a client-state key: ${key}`);
    const wanted = scope === "all" ? "all" : "device";
    if (!matched.parts.some((p) => p.scope === wanted)) {
      throw new ClientStateKeyError(`Key ${key} has no "${scope}" scope`);
    }
    return matched.worktreeId;
  }

  private write(input: ClientStateDeleteInput, value: string | null): ClientStateWriteResult {
    const worktreeId = this.worktreeOf(input.key, input.scope);
    if (worktreeId !== null && !this.worktreeExists(worktreeId)) {
      throw new ClientStateWorktreeNotFoundError(worktreeId);
    }
    const updatedAt = Date.now();
    const version = input.baseVersion + 1;
    const written =
      input.baseVersion === 0
        ? this.queries.insertIfAbsent({
            key: input.key,
            scope: input.scope,
            worktreeId,
            value,
            version,
            updatedAt,
          })
        : this.queries.updateIfVersion(input.key, input.scope, input.baseVersion, {
            value,
            version,
            updatedAt,
          });
    // The client thinks a row exists that doesn't (its worktree was deleted
    // and recreated): answer with an empty version 0 so it rebases on nothing.
    const entry = this.queries.find(input.key, input.scope) ?? {
      key: input.key,
      scope: input.scope,
      worktreeId,
      value: null,
      version: 0,
      updatedAt,
    };
    if (written) {
      emit({
        kind: "client-state-changed",
        worktreeId: worktreeId ?? undefined,
        clientState: entry,
        clientId: input.clientId,
      });
    }
    return written ? { ok: true, entry } : { ok: false, entry };
  }
}

/** Shared instance for the API tier and the worktree delete path. */
export const clientStateService = new ClientStateService();
