export type StreamMessage = string | Uint8Array;

/** What a call or a stream is for: one worktree on this worker. */
export interface ServiceScope {
  /** The hub's id for the worktree. File per-worktree state under it. */
  worktreeKey: string;
  /** The worktree's folder on this worker. */
  worktreePath: string;
}

/** What the worker tells the service when it starts. */
export interface ServiceInit {
  /** The worker's id. */
  worker: string;
  /** The extension version the worker unpacked. */
  version: string;
  /** The service's id in the manifest. */
  serviceId: string;
  /** A folder the service may keep files in. It survives updates and restarts. */
  stateDir: string;
}

/**
 * How a stream is carried. Band adds `profile` to the `params` of every stream open, after the
 * viewer's own params: `"direct"` when the frames go straight to the desktop app on this machine
 * (full size and rate are fine), `"hub"` when the hub carries them (send smaller frames, 15 per
 * second at most).
 */
export type StreamProfile = "direct" | "hub";

/** One block of a tool result. Images are PNG or JPEG, at most 5 MB decoded. */
export type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

/**
 * A call that backs an agent tool may return this to give the agent text and images. Any other
 * result reaches the agent as JSON text.
 */
export interface ToolContentResult {
  content: ToolContentBlock[];
}

/** A live two-way stream the service opened for the hub. */
export interface ServiceStream {
  /** Sends a message to the viewer. */
  send(message: StreamMessage): void;
  /** Ends the stream from the service's side. */
  end(): void;
}

export interface WorkerServiceDefinition {
  /** Runs once, before any call. Throw to fail the start; the message reaches the worker list. */
  onInit?(init: ServiceInit): void | Promise<void>;
  /** Request-response methods, by name. The result is JSON. */
  calls?: Record<string, (params: any, scope: ServiceScope) => unknown | Promise<unknown>>;
  /**
   * Live streams, by name. `open` gets a handle to send on and returns handlers for what the
   * viewer sends and for the stream closing.
   */
  streams?: Record<
    string,
    (
      params: { profile: StreamProfile; [key: string]: unknown },
      scope: ServiceScope,
      stream: ServiceStream,
    ) =>
      | void
      | { onMessage?(message: StreamMessage): void; onClose?(): void }
      | Promise<void | { onMessage?(message: StreamMessage): void; onClose?(): void }>
  >;
  /**
   * The worker asks before it starts an agent or a terminal in a worktree. Return variables to add
   * to its environment. Only names the manifest lists in the service's `worktreeEnv` are used, and
   * a call that fails or takes longer than 10 seconds adds nothing.
   */
  worktreeEnv?(scope: ServiceScope): Record<string, string> | Promise<Record<string, string>>;
  /** A worktree was removed (state to delete) or the service lets it go (state to keep). */
  onRelease?(
    worktreeKey: string,
    reason: "removed" | "fenced" | "shutdown",
    worktreePath?: string,
  ): void | Promise<void>;
  /**
   * A worktree was removed that this run of the service never served, so the worker has no key
   * for it. Map the folder to your own state, such as an index you wrote when you served it.
   */
  onReleasePath?(worktreePath: string): void | Promise<void>;
  /** The worker asks the service to stop. It exits after this returns. */
  onStop?(): void | Promise<void>;
}

/** Starts the stdio protocol. Call it once, at the top level of the service's entry file. */
export function defineWorkerService(definition: WorkerServiceDefinition): void;
