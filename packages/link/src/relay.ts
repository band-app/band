/**
 * The messages of the worker relay (plan step 2.5).
 *
 * A worker listens on loopback for the calls its agents make to the hub (the
 * `band` CLI, the MCP endpoint, agent hooks). The hub issues each agent a
 * token, the worker holds the token's scope, and a call goes up the link as
 * one `relay.http` request. The hub answers with the status and headers and
 * streams the body down a channel.
 */

/** Hub to worker: `RelayRegisterParams` in, `RelayRegisterReply` out. */
export const METHOD_RELAY_REGISTER = "relay.register";
/** Hub to worker: `RelayRevokeParams` in. */
export const METHOD_RELAY_REVOKE = "relay.revoke";
/** Worker to hub: `RelayHttpRequest` in, `RelayHttpReply` out. */
export const METHOD_RELAY_HTTP = "relay.http";

/** Largest request body the relay forwards. A link message is capped at 1 MiB, and base64 adds a third. */
export const RELAY_MAX_BODY_BYTES = 512 * 1024;

export interface RelayScopeParams {
  workspaceId: string;
  chatId?: string;
}

export interface RelayRegisterParams extends RelayScopeParams {
  token: string;
}

export interface RelayRegisterReply {
  /** The relay's address on the worker, such as `http://127.0.0.1:41234`. */
  url: string;
}

export interface RelayRevokeParams {
  token: string;
}

export interface RelayHttpRequest {
  /** What the worker holds for the caller's token. The hub checks it against the worker's own workspaces. */
  scope: RelayScopeParams;
  method: string;
  /** Path and query, as the caller sent them. */
  path: string;
  /** Only the request headers the hub looks at. The caller's credentials are never in here. */
  headers: Record<string, string>;
  /** Base64. */
  body?: string;
}

export interface RelayHttpReply {
  status: number;
  headers: Record<string, string>;
  /** The channel the body comes down. The hub ends it after the last chunk. */
  chan: number;
}
