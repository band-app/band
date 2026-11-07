/**
 * Extension worker services (`docs/extensions.md`). The hub tells a worker which extension
 * services it should run, and the worker fetches each archive from the hub.
 */

/** Hub to worker: `ExtensionsSyncParams`. The worker makes its running set equal to `items`. */
export const METHOD_EXTENSIONS_SYNC = "extensions.sync";

export interface ExtensionSyncItem {
  id: string;
  version: string;
  /** SHA-256 of the archive, hex. The worker refuses a download that does not match. */
  sha256: string;
}

export interface ExtensionsSyncParams {
  items: ExtensionSyncItem[];
}

/** What the worker did with the set, one entry per service the extensions declare. */
export interface ExtensionServiceState {
  extensionId: string;
  serviceId: string;
  capability: string;
  version: string;
  state: "running" | "restarting" | "stopped" | "failed" | "not-eligible";
  /** Why the service is not running. */
  reason?: string;
}

/** A language server an extension contributes, as this worker can run it. */
export interface LanguageServerState {
  extensionId: string;
  serverId: string;
  /** `<extension id>/<server id>`, the `lang` of an `/lsp` connection. */
  key: string;
  languages: string[];
  files: string[];
  state: "ready" | "unavailable";
  /** Why the server cannot run here, such as `needs node`. */
  reason?: string;
}

export interface ExtensionsSyncReply {
  services: ExtensionServiceState[];
  /** Absent from an older worker. */
  languageServers?: LanguageServerState[];
  /** Extensions the worker could not set up at all (a failed download, a bad archive), with the reason. */
  problems: Array<{ extensionId: string; reason: string }>;
}

/** Hub to worker: the current service states, without changing anything. */
export const METHOD_EXTENSIONS_STATUS = "extensions.status";

/**
 * Worker to hub: `ExtensionsFetchParams`. The reply carries the size and sha256 and `{ chan }`, a
 * channel the hub writes the `.tar.gz` bytes to and then ends.
 */
export const METHOD_EXTENSIONS_FETCH = "extensions.fetch";

export interface ExtensionsFetchParams {
  id: string;
  version: string;
}

export interface ExtensionsFetchReply {
  sha256: string;
  size: number;
  chan: number;
}

/**
 * Worker to hub notification, no params: the service states changed (a crash, a restart, a
 * failure). The hub asks for them with `extensions.status`.
 */
export const METHOD_EXTENSIONS_CHANGED = "extensions.changed";
