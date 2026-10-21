/**
 * What a worker's agents may ask of the hub through the relay (plan step 2.5).
 *
 * The worker forwards calls from processes it started, so the hub treats each
 * one as coming from that worker and allows only the agent surface the `band`
 * CLI, the MCP endpoint and the hooks use. A call must name a worktree on the
 * worker's own host (a worktree id, a chat of one, or a working directory in
 * one), so an agent on one machine cannot reach another machine's worktrees.
 */

import path from "node:path";
import type { RelayHttpRequest } from "@band-app/link";
import type { HostTrust } from "@band-app/shared/host-trust";
import { toWorktreeId } from "@band-app/shared/worktree-id";

/**
 * The tRPC procedures an agent may call, by exact name. A procedure missing
 * from this list is refused, so one added to a router later stays out of
 * agent reach until someone reads its input and adds it here.
 */
export const RELAY_PROCEDURES: ReadonlySet<string> = new Set([
  "chats.list",
  "chats.create",
  "chats.get",
  "chats.sessionState",
  "chats.update",
  "chats.remove",
  "chats.send",
  "chats.stop",
  "chats.resume",
  "tasks.list",
  "tasks.submit",
  "tasks.isRunning",
  "tasks.abort",
  "queue.push",
  "queue.set",
  "queue.get",
  "queue.remove",
  "queue.update",
  "queue.shift",
  "queue.clear",
  "terminal.list",
  "terminal.create",
  "terminal.send",
  "terminal.output",
  "terminal.kill",
  "browsers.list",
  "browsers.create",
  "browsers.get",
  "browsers.update",
  "browsers.setProfile",
  "browsers.navigate",
  "browsers.remove",
  "subscriptions.create",
  "subscriptions.list",
  "agentSessions.list",
  "agentSessions.launch",
  "editor.openFile",
  "statuses.notify",
  "statuses.clearNeedsAttention",
  "repos.list",
  "repos.add",
  "repos.addFromWorker",
  "repos.addByUrl",
  "repos.inspectFolder",
  "repos.resolveRemote",
  "repos.gitInit",
  "repos.promoteToGit",
  "repos.update",
  "repos.updateLabel",
  "repos.reorder",
  "repos.remove",
  "hosts.list",
  "hosts.forAgents",
  "workers.list",
  "workers.forAgents",
  "cronjobs.list",
  "cronjobs.create",
  "cronjobs.update",
  "cronjobs.delete",
  "cronjobs.trigger",
  "subscriptions.remove",
  "terminal.stream",
  "worktrees.create",
  "worktrees.remove",
]);

/**
 * What an agent on a `restricted` host may call: its own worktrees' chats, tasks, terminals,
 * browsers, queue and subscriptions, and the lists it needs to find them. No worktree
 * creation or removal, no repo writes, no cronjobs, and `hosts.forAgents` instead of `hosts.list`.
 */
export const RESTRICTED_PROCEDURES: ReadonlySet<string> = new Set(
  [...RELAY_PROCEDURES].filter(
    (p) =>
      !(
        p === "worktrees.create" ||
        p === "worktrees.remove" ||
        p === "hosts.list" ||
        p === "workers.list" ||
        p.startsWith("cronjobs.") ||
        (p.startsWith("repos.") && p !== "repos.list")
      ),
  ),
);

/** What an agent on an `admin` host may call besides `RELAY_PROCEDURES`. */
export const ADMIN_EXTRA_PROCEDURES: ReadonlySet<string> = new Set([
  "settings.get",
  "settings.update",
]);

/**
 * Never available to an agent, whatever its host's trust level: credentials, and the trust
 * levels themselves (no host can raise its own or another's).
 */
const NEVER_FOR_AGENTS = (procedure: string): boolean =>
  procedure.startsWith("tokens.") ||
  procedure.startsWith("vault.") ||
  procedure.startsWith("provisioning.") ||
  procedure.startsWith("agentLogins.") ||
  procedure === "hosts.setTrust" ||
  procedure === "hosts.audit" ||
  procedure === "workers.setTrust" ||
  procedure === "workers.audit";

/**
 * The settings an admin host may change, by allow-list. Everything else (credentials, agent
 * commands, runners, CORS origins, the port, the tunnel, unknown keys) needs a person's token,
 * because the hub applies them with its own authority.
 */
const AGENT_SETTABLE_SETTINGS = new Set([
  "agents",
  "labels",
  "notifications",
  "defaultCodingAgent",
  "theme",
  "translucentSidebar",
  "enableLSP",
  "enableFilePreviewTabs",
  "useWebGLTerminalRenderer",
  "usageRetentionDays",
  "usagePollingEnabled",
]);

/** The id of the hub's own machine. */
const HUB_HOST_ID = "local";

const allowedFor = (trust: HostTrust): ReadonlySet<string> =>
  trust === "restricted"
    ? RESTRICTED_PROCEDURES
    : trust === "admin"
      ? new Set([...RELAY_PROCEDURES, ...ADMIN_EXTRA_PROCEDURES])
      : RELAY_PROCEDURES;

/** Calls whose body or answer the relay rewrites, which only works for a single, unbatched call. */
const UNBATCHABLE = new Set([
  "settings.get",
  "repos.list",
  "hosts.list",
  "workers.list",
  "worktrees.create",
  "worktrees.remove",
  "statuses.notify",
]);

/** `input` with `hostId` set to the worker's, or left alone when `keep` and the call named a host. */
function pinHost(input: unknown, workerId: string, keep: boolean): object {
  const base =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return keep && typeof base.hostId === "string" ? base : { ...base, hostId: workerId };
}

/**
 * `worktrees.create` from a worker makes the worktree on that worker unless it names another host
 * that `checkCall` approved (`crossHostRefusal`). `worktrees.remove` removes the one of that name on
 * the worker, because the same repo and branch can live on several hosts. The check refuses another
 * `hostId` for a remove, and this puts the caller's own into the body the hub sees, so a call that
 * names no host cannot land on the hub's machine. `statuses.notify` gets the worker's id the same
 * way, so a hook is matched to a worktree on the host it ran on.
 */
export function pinWorktreeHost(
  request: RelayHttpRequest,
  workerId: string,
  trust: HostTrust = "standard",
): RelayHttpRequest {
  if (request.method !== "POST") return request;
  // Read the path as the check and the hub's HTTP server do, so `/trpc/worktrees%2Eremove` or
  // `/trpc/../trpc/worktrees.remove` cannot pass the check and skip the pin.
  let call: string;
  try {
    call = decodeURIComponent(new URL(request.path, "http://relay.invalid").pathname);
  } catch {
    return request;
  }
  const isTrpc =
    call === "/trpc/worktrees.create" ||
    call === "/trpc/worktrees.remove" ||
    call === "/trpc/statuses.notify";
  const isMcp = call === "/mcp";
  if (!isTrpc && !isMcp) return request;
  const parsed = parseJson(bodyText(request.body));
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") return request;
  let value: unknown;
  if (isTrpc) {
    // An admin host's remove names the host the worktree is on, as a create does.
    const keep =
      call === "/trpc/worktrees.create" || (trust === "admin" && call === "/trpc/worktrees.remove");
    value = pinHost(parsed.value, workerId, keep);
  } else {
    // The same tools through the MCP endpoint, as `tools/call` messages (one or a batch).
    const pin = (message: unknown): unknown => {
      if (message === null || typeof message !== "object") return message;
      const { method, params } = message as { method?: unknown; params?: Record<string, unknown> };
      if (
        method !== "tools/call" ||
        (params?.name !== "band_worktrees_create" && params?.name !== "band_worktrees_remove")
      ) {
        return message;
      }
      const keep =
        params.name === "band_worktrees_create" ||
        (trust === "admin" && params.name === "band_worktrees_remove");
      return {
        ...message,
        params: { ...params, arguments: pinHost(params.arguments, workerId, keep) },
      };
    };
    value = Array.isArray(parsed.value) ? parsed.value.map(pin) : pin(parsed.value);
  }
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  return { ...request, body };
}

/**
 * Procedures that take the worktree from the caller's headers, which the hub
 * sets from the token's scope. `repos.list` names nothing, and the relay
 * service cuts its answer down to the worker's own worktrees
 * (`filterRelayReply`).
 */
const SCOPE_FROM_HEADERS = new Set([
  "subscriptions.create",
  "subscriptions.list",
  "repos.list",
  "hosts.list",
  "hosts.forAgents",
  "workers.list",
  "workers.forAgents",
]);

const MCP_PROXY_ROUTE = /^\/mcp-proxy\/[^/]+\/?$/;

/** The cronjob key is the id of the worktree the job belongs to. */
const CRONJOB_KEY_PROCEDURES = new Set([
  "cronjobs.create",
  "cronjobs.update",
  "cronjobs.delete",
  "cronjobs.trigger",
]);

/** The tRPC error code and JSON-RPC number for each refusal status. */
const TRPC_ERRORS: Record<number, { code: string; number: number }> = {
  400: { code: "BAD_REQUEST", number: -32600 },
  403: { code: "FORBIDDEN", number: -32003 },
  404: { code: "NOT_FOUND", number: -32004 },
};

/**
 * The body of a refused tRPC call, in the shape the hub's own tRPC handler
 * answers with, so the `band` CLI and the web client print the message.
 */
export function trpcRefusalBody(status: number, message: string, batch: boolean): unknown {
  const known = TRPC_ERRORS[status] ?? TRPC_ERRORS[403];
  const error = {
    message,
    code: known.number,
    data: { code: known.code, httpStatus: status },
  };
  return batch ? [{ error }] : { error };
}

/** Keeps only the worktrees on `workerId` in a `repos.list` answer, and the repos that have any. */
export function filterReposReply(data: unknown, workerId: string): unknown {
  if (data === null || typeof data !== "object") return data;
  const result = (data as { result?: { data?: { repos?: unknown } } }).result;
  const repos = result?.data?.repos;
  if (!Array.isArray(repos)) return data;
  const kept = repos
    .map((repo) => {
      const worktrees = Array.isArray(repo?.worktrees) ? repo.worktrees : [];
      const clones = Array.isArray(repo?.clones) ? repo.clones : undefined;
      return {
        ...repo,
        worktrees: worktrees.filter((w: { hostId?: string }) => w.hostId === workerId),
        // Another worker's folder is no business of this worker's agent.
        ...(clones
          ? { clones: clones.filter((c: { hostId?: string }) => c.hostId === workerId) }
          : {}),
      };
    })
    .filter((repo) => repo.worktrees.length > 0);
  return { ...data, result: { ...result, data: { ...result?.data, repos: kept } } };
}

/** What an agent may know about a host. No roots, home, tools, report, runner settings or tokens. */
export interface AgentHostView {
  id: string;
  name: string;
  status: string;
  mode: string;
  os: string | null;
  arch: string | null;
  agents: string[];
  capabilities: string[];
  labels: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The redacted view of one `hosts.list` row. Lists the fields it keeps, so a field added later stays hidden. */
export function agentHostView(host: Record<string, unknown>): AgentHostView {
  const info = (host.info ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: String(host.id ?? ""),
    name: String(host.name ?? ""),
    status: String(host.status ?? ""),
    mode: String(host.mode ?? ""),
    os: text(info.os),
    arch: text(info.arch),
    agents: strings(host.agents),
    capabilities: strings(host.capabilities),
    labels: strings(host.labels),
  };
}

/**
 * A `settings.get` answer cut down to `AGENT_SETTABLE_SETTINGS`. The hub replays the call with its
 * own token, so the full reply holds runner `env` (provider credentials), agent commands, CORS
 * origins, pairing addresses and the voice endpoint, none of which an agent may read.
 */
export function redactSettingsReply(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const result = (data as { result?: { data?: Record<string, unknown> } }).result;
  if (!result?.data || typeof result.data !== "object") return data;
  const kept = Object.fromEntries(
    Object.entries(result.data).filter(([key]) => AGENT_SETTABLE_SETTINGS.has(key)),
  );
  return { ...data, result: { ...result, data: kept } };
}

/** Cuts a `hosts.list` answer down to `agentHostView` rows. A reply of another shape becomes empty. */
export function redactHostsReply(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const result = (data as { result?: { data?: { hosts?: unknown } } }).result;
  const hosts = result?.data?.hosts;
  const view = Array.isArray(hosts)
    ? hosts.map((h) => agentHostView((h ?? {}) as Record<string, unknown>))
    : [];
  return { ...data, result: { ...result, data: { ...result?.data, hosts: view } } };
}

const CHAT_ROUTE = /^\/api\/chats\/([^/]+)\/(events|history|messages)$/;
const MAX_DEPTH = 8;

export interface ScopeLookups {
  /** The host a worktree lives on, or null when there is no such worktree. */
  hostOfWorktree(worktreeId: string): string | null;
  /** The worktree a chat belongs to, or null when the chat does not exist. */
  worktreeOfChat(chatId: string): string | null;
  /** The worktree whose worktree contains `cwd`, or null. */
  /** The worktree on host `hostId` that contains `cwd`. */
  worktreeOfCwd(cwd: string, hostId: string): string | null;
  /** The host a terminal runs on, or null when there is no such terminal. */
  hostOfTerminal(terminalId: string): string | null;
  /** The worktree a browser tab belongs to, or null when there is no such tab. */
  worktreeOfBrowser(browserId: string): string | null;
  /** The worktree a subscription belongs to, or null when there is no such subscription. */
  worktreeOfSubscription(subscriptionId: string): string | null;
  /** Why an agent on `callerHostId` may not create a worktree of `repo` on `hostId`, or null when it may. */
  crossHostRefusal(repo: string, hostId: string, callerHostId: string): string | null;
  /** Why an agent on `callerHostId` may not act on `repo`, or null when it may (or the repo does not exist). */
  repoHostRefusal(repo: string, callerHostId: string): string | null;
  /** The trust level of a host, read on every call. Absent means `standard`. */
  trustOf?(hostId: string): HostTrust;
}

/** One cross-host or admin-only call an admin host made, for the audit log. */
export interface RelayAudit {
  procedure: string;
  targetHostId: string | null;
  target: string | null;
}

export type RelayVerdict =
  | { ok: true; audit?: RelayAudit[]; trust?: HostTrust }
  | { ok: false; status: number; reason: string };

/** Who is calling, and what the call needs to remember on the way through. */
interface Ctx {
  workerId: string;
  trust: HostTrust;
  lookups: ScopeLookups;
  audit: RelayAudit[];
  /** Set while checking a `tools/call` on `/mcp`, whose replies the relay does not rewrite. */
  viaMcp?: boolean;
}

const deny = (status: number, reason: string): RelayVerdict => ({ ok: false, status, reason });

interface Named {
  worktrees: string[];
  chats: string[];
  cwds: string[];
  terminals: string[];
  browsers: string[];
  /** Set when an input carries a key that names a target the relay cannot check. */
  unscoped: boolean;
}

/** Keys that pick a target on their own. An unchecked one next to a valid worktreeId would slip past the scope check. */
const UNSCOPED_KEYS = new Set([
  "taskId",
  "hostId",
  "hostRepoPath",
  "worktreePath",
  "key",
  "profileId",
]);

function collect(value: unknown, into: Named, workerId: string, depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, workerId, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (depth === 0) {
    const { repo, name } = record;
    if (typeof repo === "string" && typeof name === "string") {
      into.worktrees.push(toWorktreeId(repo, name, workerId));
    } else if (repo !== undefined) {
      into.unscoped = true;
    }
    // A `name` with no `repo` is a display name (a chat or a job), not a worktree.
  }
  for (const [key, v] of Object.entries(record)) {
    if (depth === 0 && UNSCOPED_KEYS.has(key)) into.unscoped = true;
    if (typeof v === "string") {
      if (key === "terminalId") into.terminals.push(v);
      else if (key === "browserId") into.browsers.push(v);
      else if (key === "worktreeId") into.worktrees.push(v);
      else if (key === "chatId") into.chats.push(v);
      else if (key === "cwd") into.cwds.push(v);
    } else {
      collect(v, into, workerId, depth + 1);
    }
  }
}

/**
 * Checks that everything `input` names belongs to the caller's host. An admin host may name
 * anything that exists, and the targets on other hosts come back in `crossHosts` for the audit log.
 */
function checkNamed(
  input: unknown,
  ctx: Ctx,
): RelayVerdict & {
  named?: number;
  crossHosts?: Array<{ hostId: string; target: string }>;
} {
  const { workerId, lookups } = ctx;
  const named: Named = {
    worktrees: [],
    chats: [],
    cwds: [],
    terminals: [],
    browsers: [],
    unscoped: false,
  };
  collect(input, named, workerId);
  const outside = deny(403, "That worktree is not on this worker");
  if (named.unscoped) return deny(403, "That call names a target the relay cannot check");
  const wide = ctx.trust === "admin";
  const crossHosts: Array<{ hostId: string; target: string }> = [];
  /** Whether a target on `hostId` may be used: this host always, any known host for an admin. */
  const reach = (hostId: string | null, target: string): boolean => {
    if (hostId === workerId) return true;
    // The hub's own machine holds the hub's tokens and vault key, so no agent reaches it.
    if (!wide || hostId === null || hostId === HUB_HOST_ID) return false;
    crossHosts.push({ hostId, target });
    return true;
  };
  for (const id of named.worktrees) {
    if (!reach(lookups.hostOfWorktree(id), id)) return outside;
  }
  for (const id of named.chats) {
    const worktree = lookups.worktreeOfChat(id);
    if (worktree === null || !reach(lookups.hostOfWorktree(worktree), worktree)) return outside;
  }
  for (const cwd of named.cwds) {
    const worktree = lookups.worktreeOfCwd(path.resolve(cwd), workerId);
    if (worktree === null || lookups.hostOfWorktree(worktree) !== workerId) return outside;
  }
  for (const id of named.terminals) {
    if (!reach(lookups.hostOfTerminal(id), id)) return outside;
  }
  for (const id of named.browsers) {
    const worktree = lookups.worktreeOfBrowser(id);
    if (worktree === null || !reach(lookups.hostOfWorktree(worktree), worktree)) return outside;
  }
  return {
    ok: true,
    crossHosts,
    named:
      named.worktrees.length +
      named.chats.length +
      named.cwds.length +
      named.terminals.length +
      named.browsers.length,
  };
}

/**
 * `chats.create` and `browsers.create` let the caller pick the new id. An id
 * that already exists must belong to the worktree the call names, so an agent
 * cannot take over or collide with another worktree's chat or tab.
 */
function checkChosenId(procedure: string, input: unknown, lookups: ScopeLookups): RelayVerdict {
  if (procedure !== "chats.create" && procedure !== "browsers.create") return { ok: true };
  const { id, worktreeId } = (input ?? {}) as { id?: unknown; worktreeId?: unknown };
  if (id === undefined) return { ok: true };
  if (typeof id !== "string") return deny(400, "id must be a string");
  const owner =
    procedure === "chats.create" ? lookups.worktreeOfChat(id) : lookups.worktreeOfBrowser(id);
  if (owner !== null && owner !== worktreeId) {
    return deny(403, "That id belongs to another worktree");
  }
  return { ok: true };
}

/** Repo procedures that act on one existing repo, by the `name` in their input. */
const REPO_BY_NAME_PROCEDURES = new Set([
  "repos.update",
  "repos.updateLabel",
  "repos.remove",
  "repos.promoteToGit",
]);

/**
 * Repo management from a worker. The one limit is a repo's allowed hosts: an agent may not act on a
 * repo limited to workers that exclude its own, nor add a repo limited to hosts that exclude the host
 * the folder is on. These calls name a repo or a host, not a worktree, so they skip `checkNamed`.
 * An admin host is not held to the first limit, and its writes go in the audit log.
 */
function checkRepoCall(procedure: string, input: unknown, ctx: Ctx): RelayVerdict {
  const { workerId, lookups } = ctx;
  const record = (input ?? {}) as Record<string, unknown>;
  const admin = ctx.trust === "admin";
  const hostArg = typeof record.hostId === "string" ? record.hostId : null;
  const audited = (): RelayVerdict => {
    if (admin && procedure !== "repos.inspectFolder" && procedure !== "repos.resolveRemote") {
      ctx.audit.push({
        procedure,
        targetHostId: hostArg,
        target: typeof record.name === "string" ? record.name : null,
      });
    }
    return { ok: true };
  };
  if (REPO_BY_NAME_PROCEDURES.has(procedure)) {
    if (typeof record.name !== "string") return deny(400, `${procedure} needs a repo name`);
    if (admin) return audited();
    const refusal = lookups.repoHostRefusal(record.name, workerId);
    return refusal === null ? { ok: true } : deny(403, `${procedure}: ${refusal}`);
  }
  if (procedure === "repos.addFromWorker") {
    const { hostId, name, allowedHostIds, addRoot } = record;
    if (addRoot === true) {
      return deny(403, `${procedure}: Adding a folder root needs a person's confirmation`);
    }
    if (typeof hostId !== "string") return deny(400, `${procedure} needs a hostId`);
    if (Array.isArray(allowedHostIds) && !allowedHostIds.includes(hostId)) {
      return deny(
        403,
        `${procedure}: The repo would be limited to workers that exclude ${hostId}, where the folder is`,
      );
    }
    // An existing repo named by the call is checked here. One found by the folder's remote is
    // checked against the folder's host in the service (`assertHostAllowed`).
    if (typeof name === "string" && !admin) {
      const refusal = lookups.repoHostRefusal(name, workerId);
      if (refusal !== null) return deny(403, `${procedure}: ${refusal}`);
    }
  }
  return audited();
}

/** `settings.update` from an admin host: everything except the credentials and programs the hub runs. */
function checkSettingsCall(procedure: string, input: unknown, ctx: Ctx): RelayVerdict {
  if (ctx.viaMcp) return deny(403, `${procedure} is not available over /mcp to agents`);
  if (procedure === "settings.update") {
    const record = (input ?? {}) as Record<string, unknown>;
    const blocked = Object.keys(record).filter((key) => !AGENT_SETTABLE_SETTINGS.has(key));
    if (blocked.length > 0) {
      return deny(
        403,
        `${procedure}: ${blocked.join(", ")} can only be changed by a person's admin token`,
      );
    }
    ctx.audit.push({ procedure, targetHostId: null, target: Object.keys(record).sort().join(",") });
  }
  return { ok: true };
}

/** The cronjobs of an admin host: any worktree on a host it may reach. Jobs on other hosts are audited. */
function checkAdminCronjob(procedure: string, key: string, ctx: Ctx): RelayVerdict {
  const host = ctx.lookups.hostOfWorktree(key);
  if (host === null) return deny(404, `${procedure}: No such worktree`);
  if (host === HUB_HOST_ID) {
    return deny(403, `${procedure}: Agents cannot schedule work on the hub's own machine`);
  }
  if (host !== ctx.workerId) {
    ctx.audit.push({ procedure, targetHostId: host, target: key });
  }
  return { ok: true };
}

/** One procedure call: allowed, and tied to this host by what it names (or by the token's scope). */
function checkCall(procedure: string, input: unknown, ctx: Ctx): RelayVerdict {
  const { workerId, lookups, trust } = ctx;
  if (NEVER_FOR_AGENTS(procedure)) {
    return deny(
      403,
      `${procedure} is not available to agents, whatever their worker's trust level`,
    );
  }
  if (!allowedFor(trust).has(procedure)) {
    return deny(
      403,
      trust === "restricted" && RELAY_PROCEDURES.has(procedure)
        ? `${procedure} is not available to agents on a restricted worker`
        : `${procedure} is not available to agents`,
    );
  }
  // Which account a chat runs on is a person's choice. An agent may not switch its own chat's login.
  if (
    procedure === "chats.update" &&
    input !== null &&
    typeof input === "object" &&
    (input as { loginId?: unknown }).loginId !== undefined
  ) {
    return deny(403, "chats.update: an agent may not change a chat's login");
  }
  if (procedure.startsWith("settings.")) return checkSettingsCall(procedure, input, ctx);
  if (procedure.startsWith("repos.") && procedure !== "repos.list") {
    return checkRepoCall(procedure, input, ctx);
  }
  const admin = trust === "admin";
  let named = input;
  if (CRONJOB_KEY_PROCEDURES.has(procedure)) {
    const { key, ...rest } = (input ?? {}) as Record<string, unknown>;
    // A create names its worktree in `worktreeId`; the others name it as the key.
    const worktree = procedure === "cronjobs.create" ? (rest.worktreeId ?? key) : key;
    if (typeof worktree !== "string") {
      return deny(
        400,
        procedure === "cronjobs.create"
          ? `${procedure} needs a worktreeId`
          : `${procedure} needs a key`,
      );
    }
    named = { ...rest, worktreeId: worktree };
    if (typeof rest.worktreeId === "string" && rest.worktreeId !== worktree) {
      return deny(403, `${procedure} names two different worktrees`);
    }
    if (typeof key === "string" && key !== worktree) {
      return deny(403, `${procedure} names two different worktrees`);
    }
    // An admin host may schedule on any worktree of a host it can reach, and the call is audited.
    if (admin) return checkAdminCronjob(procedure, worktree, ctx);
  }
  if (procedure === "worktrees.create") {
    const { repo, branch, hostId, origin } = (input ?? {}) as Record<string, unknown>;
    if (typeof repo !== "string" || typeof branch !== "string") {
      return deny(400, `${procedure} needs a repo and a branch`);
    }
    // An origin names a parent worktree, so it must be one on this host like any other target
    // (any existing worktree for an admin host).
    if (origin !== undefined) {
      const originHost = typeof origin === "string" ? lookups.hostOfWorktree(origin) : null;
      if (
        originHost === null ||
        (originHost !== workerId && (!admin || originHost === HUB_HOST_ID))
      ) {
        return deny(403, `${procedure}: The origin is not a worktree on this worker`);
      }
    }
    if (hostId !== undefined && hostId !== workerId) {
      if (typeof hostId !== "string") return deny(400, `${procedure}: hostId must be a string`);
      const refusal = lookups.crossHostRefusal(repo, hostId, workerId);
      if (refusal !== null) return deny(403, `${procedure}: ${refusal}`);
      const { hostRepoPath, placement } = (input ?? {}) as Record<string, unknown>;
      if (hostRepoPath !== undefined || placement !== undefined) {
        return deny(
          403,
          `${procedure}: hostRepoPath and placement cannot be set for another worker from a worker`,
        );
      }
      if (admin) {
        ctx.audit.push({ procedure, targetHostId: hostId, target: `${repo}:${branch}` });
      }
    }
    return { ok: true };
  }
  if (procedure === "worktrees.remove") {
    const { hostId, ...rest } = (input ?? {}) as Record<string, unknown>;
    if (hostId !== undefined && hostId !== workerId) {
      if (!admin) {
        return deny(
          403,
          `${procedure}: A worktree on another worker cannot be removed from a worker`,
        );
      }
      if (typeof hostId !== "string") return deny(400, `${procedure}: hostId must be a string`);
      if (hostId === HUB_HOST_ID) {
        return deny(403, `${procedure}: Agents cannot remove worktrees on the hub's own machine`);
      }
      // The worktree id of a name on another host carries that host's id.
      const { repo, name } = rest;
      if (typeof repo === "string" && typeof name === "string") {
        const id = toWorktreeId(repo, name, hostId);
        if (lookups.hostOfWorktree(id) !== hostId) {
          return deny(404, `${procedure}: No such worktree on ${hostId}`);
        }
        ctx.audit.push({ procedure, targetHostId: hostId, target: id });
        return { ok: true };
      }
    }
    named = rest;
  }
  if (procedure === "subscriptions.remove") {
    const { id } = (input ?? {}) as { id?: unknown };
    if (typeof id !== "string") return deny(400, `${procedure} needs an id`);
    const owner = lookups.worktreeOfSubscription(id);
    const ownerHost = owner === null ? null : lookups.hostOfWorktree(owner);
    if (ownerHost === null || (ownerHost !== workerId && (!admin || ownerHost === HUB_HOST_ID))) {
      return deny(403, `${procedure}: That subscription is not on this worker`);
    }
    if (ownerHost !== workerId) {
      ctx.audit.push({ procedure, targetHostId: ownerHost, target: owner });
    }
    return { ok: true };
  }
  const verdict = checkNamed(named, ctx);
  if (!verdict.ok) return deny(verdict.status, `${procedure}: ${verdict.reason}`);
  if (verdict.named === 0 && !SCOPE_FROM_HEADERS.has(procedure)) {
    return deny(403, `${procedure} must name a worktree on this worker`);
  }
  for (const c of verdict.crossHosts ?? []) {
    ctx.audit.push({ procedure, targetHostId: c.hostId, target: c.target });
  }
  const chosen = checkChosenId(procedure, input, lookups);
  return chosen.ok ? chosen : deny(chosen.status, `${procedure}: ${chosen.reason}`);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function checkTrpc(request: RelayHttpRequest, url: URL, ctx: Ctx): RelayVerdict {
  const procedures = decodeURIComponent(url.pathname.slice("/trpc/".length))
    .split(",")
    .filter((p) => p !== "");
  if (procedures.length === 0) return deny(400, "No procedure named");
  const isBatch = url.searchParams.get("batch") === "1" || procedures.length > 1;
  const raw = request.method === "GET" ? url.searchParams.get("input") : bodyText(request.body);
  let input: unknown;
  if (raw) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return deny(400, "The input is not JSON");
    input = parsed.value;
  }
  for (const [i, procedure] of procedures.entries()) {
    const own =
      isBatch && input !== null && typeof input === "object"
        ? (input as Record<string, unknown>)[String(i)]
        : input;
    if (isBatch && UNBATCHABLE.has(procedure)) {
      return deny(400, `${procedure}: cannot be batched through the relay`);
    }
    const verdict = checkCall(procedure, own, ctx);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function bodyText(body: string | undefined): string {
  return body ? Buffer.from(body, "base64").toString("utf8") : "";
}

function checkMcp(request: RelayHttpRequest, ctx: Ctx): RelayVerdict {
  const text = bodyText(request.body);
  if (text === "") return { ok: true };
  const parsed = parseJson(text);
  if (!parsed.ok) return deny(400, "The body is not JSON");
  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const { method, params } = message as { method?: unknown; params?: Record<string, unknown> };
    if (method !== "tools/call") continue;
    const name = typeof params?.name === "string" ? params.name : "";
    if (!name.startsWith("band_")) return deny(403, "Unknown tool");
    const procedure = name.slice("band_".length).replace(/_/g, ".");
    const verdict = checkCall(procedure, params?.arguments, { ...ctx, viaMcp: true });
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

function checkChatRoute(request: RelayHttpRequest, chatId: string, ctx: Ctx): RelayVerdict {
  const body = request.method === "POST" ? parseJson(bodyText(request.body)) : null;
  if (body && !body.ok) return deny(400, "The body is not JSON");
  const worktree = ctx.lookups.worktreeOfChat(chatId);
  if (worktree === null) return deny(404, "No such chat");
  const verdict = checkNamed({ chatId, ...(body?.ok ? { body: body.value } : {}) }, ctx);
  if (!verdict.ok) return verdict;
  for (const c of verdict.crossHosts ?? []) {
    ctx.audit.push({
      procedure: `${request.method} ${request.path.split("?")[0]}`,
      targetHostId: c.hostId,
      target: c.target,
    });
  }
  return { ok: true };
}

/** The trust level of the caller's host, read now. A lookup that cannot say means `standard`. */
export function trustFor(workerId: string, lookups: ScopeLookups): HostTrust {
  return lookups.trustOf?.(workerId) ?? "standard";
}

/**
 * Whether a call that came up a worker's link may go on to the hub. The level of the caller's host
 * is read from `lookups` on every call. A refusal on a restricted host names that level. An allowed
 * call returns the cross-host and admin-only steps it takes in `audit`.
 */
export function checkRelayRequest(
  request: RelayHttpRequest,
  workerId: string,
  lookups: ScopeLookups,
): RelayVerdict {
  const trust = trustFor(workerId, lookups);
  const verdict = checkRelay(request, { workerId, trust, lookups, audit: [] });
  if (!verdict.ok && trust === "restricted") {
    return { ...verdict, reason: `${verdict.reason} (this worker's trust level is restricted)` };
  }
  // The level the check used goes with the verdict, so the relay shapes the call and the reply by it.
  return verdict.ok ? { ...verdict, trust } : verdict;
}

function checkRelay(request: RelayHttpRequest, ctx: Ctx): RelayVerdict {
  const { workerId, lookups } = ctx;
  // The worktree the call comes from is always on the caller's own host, for every level.
  const scope = checkNamed(
    { worktreeId: request.scope.worktreeId, chatId: request.scope.chatId },
    { ...ctx, trust: "standard" },
  );
  if (!scope.ok) return scope;
  if (lookups.hostOfWorktree(request.scope.worktreeId) !== workerId) {
    return deny(403, "That worktree is not on this worker");
  }

  let url: URL;
  try {
    url = new URL(request.path, "http://relay.invalid");
  } catch {
    return deny(400, "Bad path");
  }
  const { pathname } = url;
  let verdict: RelayVerdict;
  if (pathname === "/api/health" && request.method === "GET") return { ok: true };
  if (pathname === "/mcp") verdict = checkMcp(request, ctx);
  // The MCP proxy checks its own per-session token, so the relay only has to
  // let the call through. The worktree was checked above.
  else if (MCP_PROXY_ROUTE.test(pathname)) return { ok: true };
  else if (request.path.startsWith("/mcp-proxy/")) return deny(403, "Not an MCP proxy route");
  else if (pathname.startsWith("/trpc/")) {
    try {
      verdict = checkTrpc(request, url, ctx);
    } catch {
      return deny(400, "Bad path");
    }
  } else {
    const chat = CHAT_ROUTE.exec(pathname);
    if (!chat) return deny(403, "That route is not available to agents");
    try {
      verdict = checkChatRoute(request, decodeURIComponent(chat[1]), ctx);
    } catch {
      return deny(400, "Bad path");
    }
  }
  if (!verdict.ok) return verdict;
  return ctx.audit.length > 0 ? { ok: true, audit: ctx.audit } : { ok: true };
}
