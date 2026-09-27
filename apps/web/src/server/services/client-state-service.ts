/**
 * Client state: small UI values the dashboard keeps on the server so the
 * phone and the desktop show the same tabs, drafts and panel layout.
 *
 * The dashboard reads a workspace's (or the global) entries in one call,
 * writes one key at a time with the version it last saw, and learns about
 * other devices' writes from the `client-state-changed` status event. A write
 * whose base version is stale is refused and answered with the current row,
 * so a client coming back online can't overwrite a newer value.
 */

import { createLogger } from "@band-app/logger";
import {
  CLIENT_STATE_MAX_VALUE_BYTES,
  type ClientStateEntry,
  type ClientStateScope,
  type ClientStateWriteResult,
  type DeviceType,
} from "../../shared/client-state";
import { ClientStateValueTooLargeError } from "../errors";
import { ClientStateQueries } from "../infra/db/queries/client-state";
import { emit } from "./watcher-service";

const log = createLogger("client-state-service");

export interface ClientStateSetInput {
  key: string;
  scope: ClientStateScope;
  workspaceId: string | null;
  value?: unknown;
  baseVersion: number;
  clientId: string;
}

export interface ClientStateDeleteInput {
  key: string;
  scope: ClientStateScope;
  workspaceId: string | null;
  baseVersion: number;
  clientId: string;
}

export class ClientStateService {
  constructor(private readonly queries = new ClientStateQueries()) {}

  /** Entries of one workspace (or global ones) visible to a device type. */
  list(workspaceId: string | null, deviceType: DeviceType): ClientStateEntry[] {
    return this.queries.list(workspaceId, ["all", deviceType]);
  }

  set(input: ClientStateSetInput): ClientStateWriteResult {
    const serialized = JSON.stringify(input.value ?? null);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > CLIENT_STATE_MAX_VALUE_BYTES) {
      throw new ClientStateValueTooLargeError(bytes, CLIENT_STATE_MAX_VALUE_BYTES);
    }
    return this.write(input, input.value == null ? null : serialized);
  }

  delete(input: ClientStateDeleteInput): ClientStateWriteResult {
    return this.write(input, null);
  }

  /** Drop every entry of a deleted workspace. */
  removeAllForWorkspace(workspaceId: string): void {
    const removed = this.queries.removeForWorkspace(workspaceId);
    if (removed > 0) log.info({ workspaceId, removed }, "removed workspace client state");
  }

  private write(
    input: Omit<ClientStateSetInput, "value">,
    value: string | null,
  ): ClientStateWriteResult {
    const result = this.queries.compareAndSet({
      key: input.key,
      scope: input.scope,
      workspaceId: input.workspaceId,
      value,
      baseVersion: input.baseVersion,
      updatedAt: Date.now(),
    });
    if (result.ok) {
      emit({
        kind: "client-state-changed",
        workspaceId: result.entry.workspaceId ?? undefined,
        clientState: result.entry,
        clientId: input.clientId,
      });
    }
    return result;
  }
}

/** Shared instance for the API tier and the workspace delete path. */
export const clientStateService = new ClientStateService();
