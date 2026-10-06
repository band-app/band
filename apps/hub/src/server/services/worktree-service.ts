import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join, posix } from "node:path";
import { resumeCliInvocation } from "@band-app/coding-agent";
import {
  type CommandRun,
  gitRunner,
  type Host,
  HostOfflineError,
  HostPathDeniedError,
} from "@band-app/host-api";
import { DETACHED_BRANCH_PREFIX } from "@band-app/host-local/git/git-client";
import { NOTHING_TO_COMMIT, pullRefusal, pushRefusal } from "@band-app/host-local/git/git-refusals";
import { scriptInvocation } from "@band-app/host-local/process/path";
import { createLogger } from "@band-app/logger";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import type { GitOpResult } from "@band-app/shared/git-op-result";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { z } from "zod";
import { WorktreeNotFoundError } from "../errors";
import { PendingRemovalQueries } from "../infra/db/queries/pending-removals";
import { TaskQueries } from "../infra/db/queries/tasks";
import { UsageEventQueries } from "../infra/db/queries/usage-events";
import { UsageScanStateQueries } from "../infra/db/queries/usage-scan-state";
import { WorktreeQueries } from "../infra/db/queries/worktrees";
import { hostRegistry } from "../infra/host/registry";
import { formatShellCommand } from "./_utils/format-shell-command";
import { placementInput } from "./_utils/placement-input";
import { writeBrief } from "./_utils/write-brief";
// FRAGILE: ESM cycle leg — `agent-launch-service` imports `worktreeService`
// back from this file. Safe only while `agentLaunchService` is used inside
// method bodies, never at module top level.
import { agentLaunchService } from "./agent-launch-service";
import { agentSessionRegistry } from "./agent-session-registry-service";
// FRAGILE: ESM cycle leg — `services/task-service` now imports
// `worktreeService` directly from this file (the `services/worktree.ts`
// shim that used to broker this hop was deleted in the #535 cleanup).
// The cycle is safe only because every cross-module call below
// (`submitTask`, `abortTask`, `cronjobService.*`, …) is inside a
// function body — ESM live binding fills the reference in at call time.
// Capturing any of these at module load — `const t = submitTask;` at
// the top of this file, or `const ws = worktreeService;` at the top of
// `task-service.ts` — would silently get `undefined`.
import { agentSessionService } from "./agent-session-service";
import { browserService } from "./browser-service";
import { chatService } from "./chat-service";
import { clientStateService } from "./client-state-service";
// FRAGILE: ESM cycle leg #2 — `./cronjob-service` imports `submitTask`
// from `./task-service`, which imports `worktreeService` from this
// file (see the cycle note on the import block above). Same live-
// binding constraint: keep every `cronjobService` reference inside a
// function body. Capturing `const cs = cronjobService;` at module load
// would silently get `undefined`.
import { cronjobService } from "./cronjob-service";
import { resolveWorktreeHostId } from "./local-host-policy";
import { panelFocusService } from "./panel-focus-service";
// FRAGILE: ESM cycle leg — `./placement-service` imports `worktreeService` from
// this file. Keep every `placementService` reference inside a function body.
import { placementService } from "./placement-service";
import { projectService } from "./project-service";
import { recordPushedHead } from "./pushed-sha-service";
import { agentModeFromVia, SettingsService, settingsService } from "./settings-service";
import {
  bandHome,
  deleteWorktreeStatus,
  loadState,
  type RepoState,
  saveState,
  type WorktreeState,
  worktreesDir,
} from "./state";
// FRAGILE: ESM cycle leg — `./subscription-service` imports `task-service`,
// which imports `worktreeService` from this file. Keep every
// `subscriptionService` reference inside a function body.
import { subscriptionService } from "./subscription-service";
import { syncService, type WorktreeRemoval } from "./sync-service";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
// FRAGILE: ESM cycle leg #3 — `./worktree-script-service` imports
// `worktreeService` from this file. Keep every `worktreeScriptService`
// reference inside a function body; capturing it at module load would
// silently get `undefined`.
import { worktreeScriptService } from "./worktree-script-service";

/** How long {@link WorktreeService.remove} waits for a `teardown` command. */
const TEARDOWN_TIMEOUT_MS = 60_000;
const log = createLogger("worktree-service");

/**
 * Resolved worktree shape (repo row + worktree row) returned by
 * `WorktreeService.resolve`. Mirrors the legacy `lib/worktree.ts`
 * `resolveWorktree` return type so existing callers can be migrated to
 * the service without touching their use sites.
 */
export interface ResolvedWorktree {
  repo: RepoState;
  worktree: WorktreeState;
  /** The machine the worktree lives on. */
  host: Host;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/**
 * Input schema for `WorktreeService.create`.
 *
 * Lives in the service tier (not the API router) so the service and any
 * future non-tRPC entry points (CLI, scripts) share a single source of
 * truth for the accepted shape — same pattern as `settingsUpdateInput`.
 */
/**
 * Where to dispatch a `--prompt` task on worktree create (issue #551).
 *
 *   - `"chat"` — current behavior: submit a task to the SDK-backed agent
 *     and stream events into the worktree's default chat pane.
 *   - `"terminal"` — spawn the adapter's interactive CLI (`claude
 *     "<prompt>"`, `codex "<prompt>"`, …) in a fresh terminal pane.
 *
 * The schema is the single source of truth for the field; both the API
 * tier and any future non-tRPC entry points (the Rust CLI included)
 * forward through `WorktreeService.create`.
 *
 * Superseded by `agentMode` (`gui` / `tui`, issue #682), which wins when
 * both are sent. With neither, the server's `agents.defaultMode` applies.
 * The CLI resolves `via` *client-side* (in `cmd_worktrees_create`) and
 * forwards it on every call.
 */
export const worktreeVia = z.enum(["chat", "terminal"]);
export type WorktreeVia = z.infer<typeof worktreeVia>;

export const worktreeCreateInput = z.object({
  repo: z.string(),
  branch: z.string(),
  base: z.string().optional(),
  // Cap at 100 KiB. On the via=terminal path the prompt is embedded
  // verbatim (after quoting) into the PTY command line, so an
  // unbounded value could exceed OS argv-length limits (typically
  // 128 KiB on Linux) or overflow the PTY write buffer. 100k is well
  // above any realistic interactive prompt while keeping the embed
  // safely inside the kernel's ARG_MAX.
  prompt: z.string().max(100_000).optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  codingAgentId: z.string().optional(),
  // How the prompt's agent session is displayed (issue #682): `gui` (chat)
  // or `tui` (the agent's CLI in a terminal). Browsers send their per-device
  // mode. `via` is the older name for the same choice and loses to
  // `agentMode`. With neither, `agents.defaultMode` applies.
  agentMode: z.enum(["gui", "tui"]).optional(),
  via: worktreeVia.optional(),
  // The host to create the worktree on (`hosts.list`). Defaults to the hub's own machine.
  hostId: z.string().min(1).optional(),
  // Where the repo's repository is on that host. Needed the first time a
  // repo is used on a remote host, and remembered after that.
  hostRepoPath: z.string().min(1).optional(),
  // Pick the host by criteria instead of naming one. The worktree goes on an
  // online host that fits, or waits as `provisioning` while a runner starts one
  // (plan step 3.3). `placement: {}` means any host. Excludes `hostId`.
  placement: placementInput.optional(),
  // The project (id or name) the worktree belongs to (plan step 6.1). The repo must be one
  // of the project's. The agents in the worktree use that project's context.
  projectId: z.string().min(1).optional(),
  // Markdown written to `.am/BRIEF.md` in the new worktree, which git ignores (plan step 6.3).
  // It rides in the stored create call, so a worktree placed after provisioning gets it too.
  brief: z.string().max(100_000).optional(),
});
export type WorktreeCreateInput = z.infer<typeof worktreeCreateInput>;

export const worktreeRemoveInput = z.object({
  repo: z.string(),
  // Worktree identity (the immutable `name`), NOT the live git branch. The
  // live branch to delete is resolved from the worktree row.
  name: z.string(),
});
export type WorktreeRemoveInput = z.infer<typeof worktreeRemoveInput>;

/**
 * Result of {@link WorktreeService.continueChatInTerminal}. A discriminated
 * union so the (thin) tRPC router maps the failure `code` straight onto a
 * `TRPCError` without owning the resolve / build / spawn business logic.
 */
export type ContinueChatInTerminalResult =
  | { ok: true; terminalId: string; worktreeId: string; sessionId: string }
  | { ok: false; code: "NOT_FOUND" | "PRECONDITION_FAILED" | "BAD_REQUEST"; message: string };

export const worktreeSetPinnedInput = z.object({
  repo: z.string(),
  // Worktree identity (immutable `name`), not the live git branch.
  name: z.string(),
  pinned: z.boolean(),
});
export type WorktreeSetPinnedInput = z.infer<typeof worktreeSetPinnedInput>;

export const worktreeGitInput = z.object({
  repo: z.string(),
  // Worktree identity (immutable `name`), not the live git branch.
  name: z.string(),
});
export type WorktreeGitInput = z.infer<typeof worktreeGitInput>;

export const worktreeRunScriptInput = z.object({
  path: z.string(),
  scriptType: z.string(),
});
export type WorktreeRunScriptInput = z.infer<typeof worktreeRunScriptInput>;

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Repo named in the worktree mutation does not exist in state.
 *
 * Translated by the API tier (`throwAsTrpcError` in
 * `api/worktrees/router.ts`) into a plain `Error` rethrow that surfaces
 * as HTTP 500 — that's the legacy wire contract for these procedures
 * and the existing trpc integration tests pin it. The router comment
 * explains the rationale and the migration plan; a future PR can
 * promote the mapping to `NOT_FOUND` (and update the pinned tests) in
 * lock-step.
 */
export class RepoNotFoundError extends Error {
  constructor(name: string) {
    super(`Repo "${name}" not found`);
    this.name = "RepoNotFoundError";
  }
}

/**
 * Re-export the canonical `WorktreeNotFoundError` so existing imports
 * (`api/worktrees/router.ts`) keep working. The class is defined in
 * `server/errors.ts` (imported at the top of this file for internal throws)
 * and shared with `session-service` and `task-service` — see `errors.ts`
 * for the consolidation rationale and the per-router HTTP mapping
 * (worktrees stays 500 to honor the pinned legacy contract).
 */
export { WorktreeNotFoundError };

/**
 * Worktree mutation invoked on a plain (non-git) repo. Plain repos
 * have a single implicit worktree at the repo path and don't support
 * additional worktrees, branch operations, or pinning.
 */
export class PlainRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainRepoError";
  }
}

/**
 * Business logic for the worktree domain (Phase 3 of the 3-tier refactor —
 * issue #314).
 *
 * Service tier — depends on Infra (`WorktreeQueries`, `infra/git/git-
 * client` for git exec, `infra/setup/worktree-files` for worktree
 * bootstrap) plus a handful of sibling services
 * (`chatService`, `browserService`, `terminalService`,
 * `worktreeScriptService` for the setup / teardown commands,
 * `cronjobService.removeForKey`) for worktree-scoped cleanup on
 * delete. Knows nothing about tRPC or the API surface — all callers
 * (routers, future CLI / scripts) funnel through this class.
 *
 * Persistence quirks worth knowing about:
 *
 *   - **Repos table reads/writes.** `loadState` / `saveState` still
 *     co-manage the `repos` + `worktrees` tables via a whole-tree
 *     rewrite. The persistence model belongs to the repos domain
 *     (`RepoQueries`, issue #313); once that domain owns worktree
 *     row inserts/removes too, the create/remove paths here can swap
 *     to `WorktreeQueries.insert` / `WorktreeQueries.remove`
 *     directly. Today the orchestration goes through `state.ts`'s
 *     `saveState` to keep one writer per table.
 *   - **Worktree-scoped side-effect cleanup.** `chatService`,
 *     `browserService`, `terminalService.killWorktree`,
 *     `cronjobService.removeForKey`, etc. each own their own domain;
 *     the orchestration is centralized here so the remove flow is
 *     atomic from the router's perspective.
 *
 * Stateless aside from its `queries` dependency, so a single shared
 * instance is safe across callers.
 */

/**
 * `git pull --rebase` exits non-zero with this string when the fetch
 * step already fast-forwarded the working tree. The pull effectively
 * succeeded, so both `gitPull` paths swallow the error. Centralised
 * here so the two callers don't drift on the exact substring.
 */
function isRebaseCollision(err: unknown): boolean {
  return String(err).includes("Cannot rebase onto multiple branches");
}

/**
 * `git pull --rebase` in `cwd`, shared by both `gitPull` paths. Refusals
 * (local changes, no upstream) resolve as `ok: false`; any other failure
 * rethrows with git's stderr.
 */
async function pullRebase(execGit: CommandRun, cwd: string): Promise<GitOpResult> {
  try {
    await execGit(["pull", "--rebase"], cwd);
  } catch (e) {
    if (isRebaseCollision(e)) return { ok: true };
    const refusal = await pullRefusal(e, cwd, execGit);
    if (refusal) return refusal;
    throw e;
  }
  return { ok: true };
}

/** " Roots: /a, /b" for an error message, or nothing when the host serves any path. */
function rootsHint(roots: string[]): string {
  return roots.length > 0 ? ` Allowed roots: ${roots.join(", ")}.` : "";
}

/**
 * A path the user typed for a remote host. A leading `~` means the host's home
 * directory (the worker reports it), not the hub's. Anything else must be
 * absolute, because the hub can't resolve a relative path on another machine.
 */
export function expandHome(given: string, home: string | undefined, hostId: string): string {
  const path = given.trim();
  if (path === "~" || path.startsWith("~/")) {
    if (!home) {
      throw new Error(
        `Host "${hostId}" did not report its home directory, so "${path}" cannot be expanded. Use an absolute path.`,
      );
    }
    return path === "~" ? home : posix.join(home, path.slice(2));
  }
  if (path.startsWith("~")) {
    throw new Error(`"${path}" is not supported. Use an absolute path on host "${hostId}".`);
  }
  if (!posix.isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`"${path}" is relative. Use an absolute path on host "${hostId}".`);
  }
  return path;
}

export class WorktreeService {
  private readonly pendingRemovals = new PendingRemovalQueries();

  constructor(
    private readonly queries: WorktreeQueries = new WorktreeQueries(),
    private readonly usageEventQueries: UsageEventQueries = new UsageEventQueries(),
    private readonly usageScanStateQueries: UsageScanStateQueries = new UsageScanStateQueries(),
  ) {}

  /** Removals waiting on their teardown, by worktree id, so a repeat call joins the first. */
  private readonly removing = new Map<string, Promise<{ ok: true }>>();

  /**
   * Resolve a worktree ID to its parent repo + worktree row.
   *
   * Mirrors the legacy `lib/worktree.ts::resolveWorktree` so callers can
   * be migrated incrementally. Returns `null` when the worktree ID
   * doesn't match any worktree (the caller decides whether that's a 404
   * or a fall-through).
   *
   * NOTE: deliberately uses `loadState()` (full repos + worktrees walk)
   * rather than the targeted `WorktreeQueries.findIdentity()` SQL lookup
   * that lives in the same PR. The return shape is `ResolvedWorktree =
   * { repo: RepoState, worktree: WorktreeState }` — callers (e.g.
   * `gitPull`/`gitPush`) read `repo.kind` to gate plain-repo
   * rejections, and the legacy shim in `lib/worktree.ts` exposes the
   * same shape to existing consumers. `findIdentity()` only returns
   * `(repo, branch, worktreePath)` — no `kind`, no full repo row —
   * so swapping it in here would require a second `RepoQueries`-tier
   * lookup we don't have yet (Phase 2 ships that surface). Once the
   * repos-domain queries land, this can drop to one `findIdentity()` +
   * one targeted repo read. Call frequency is low (user-initiated
   * git pull/push only), so the O(n) JS walk is acceptable in the
   * interim.
   */
  resolve(worktreeId: string): ResolvedWorktree | null {
    const state = loadState();
    for (const repo of state.repos) {
      for (const worktree of repo.worktrees) {
        // Identity is by the immutable `name`, so the resolve keeps working
        // after a git branch switch (which moves `worktree.branch`).
        if (toWorktreeId(repo.name, worktree.name) === worktreeId) {
          return { repo, worktree, host: hostRegistry.hostFor(worktreeId) };
        }
      }
    }
    return null;
  }

  /**
   * The repo's checkout on a remote host. `given` records it the first
   * time, since the hub can't know where a worker keeps the repository.
   */
  private async remoteCheckout(
    repoName: string,
    host: Host,
    given: string | undefined,
  ): Promise<string> {
    if (given !== undefined) {
      const info = await host.info();
      const where = rootsHint(info.roots);
      const path = expandHome(given, info.home, host.id);
      const resolved = await host.fs.realpath(path).catch((err: unknown) => {
        if (err instanceof HostPathDeniedError) {
          throw new Error(`${path} is outside the directories host "${host.id}" serves.${where}`);
        }
        throw new Error(`Host "${host.id}" has no directory ${path}.${where}`);
      });
      hostRegistry.setRepoPathOn(repoName, host.id, resolved);
      return resolved;
    }
    const known = hostRegistry.repoPathOn(repoName, host.id, "");
    if (!known) {
      throw new Error(
        `Repo "${repoName}" has no checkout on host "${host.id}". Pass hostRepoPath with the repository's path on that host.`,
      );
    }
    return known;
  }

  /** Where a remote host keeps the worktrees of Band worktrees: under its first root. */
  private async remoteWorktreesDir(host: Host): Promise<string> {
    const [root] = (await host.info()).roots;
    if (!root) throw new Error(`Host "${host.id}" serves no directory to put worktrees in`);
    return posix.join(root, ".band-worktrees");
  }

  /**
   * Create a worktree (git worktree) for `(repo, branch)`.
   *
   * Idempotent: returns the existing path when the branch is already a
   * worktree on the repo. Rejects plain (non-git) repos with
   * `PlainRepoError` — they have a single implicit worktree at the
   * repo path and don't support additional worktrees.
   *
   * On success:
   *   1. Creates the worktree on disk via `git worktree add` (with an
   *      optional base branch).
   *   2. Persists the new worktree row through `saveState`.
   *   3. Materialises the worktree's default chat pane.
   *   4. Kicks off the worktree's `.band/setup` script in the background.
   *      If a `prompt` was supplied, the task is submitted only after the
   *      setup script finishes (so the coding agent sees its dependencies
   *      installed). When there is no setup script, the task is dispatched
   *      synchronously.
   *
   * Dispatch target (`input.agentMode`, else `input.via`, else
   * `agents.defaultMode`; issues #551 and #682). `agentLaunchService` starts
   * the agent:
   *   - `gui` / `"chat"` — submit the prompt to the worktree's default chat
   *     pane via `taskService.submitTask`.
   *   - `tui` / `"terminal"` — resolve the chosen agent's interactive CLI
   *     invocation (`cliInvocation(type, prompt)`) and spawn it in a fresh
   *     terminal pane via `terminalService.spawn`. The pane id is returned
   *     alongside the worktree path so callers (the Rust CLI in particular)
   *     can wire follow-up commands directly to the new pane.
   *
   *   When the resolved agent doesn't have a vendor CLI for terminal
   *   dispatch (e.g. cursor-cli today), the service logs a warning and
   *   falls back to `"chat"` so the create call still succeeds. The
   *   response then carries `via: "chat"` and no `terminalId`.
   *
   * **`terminalId` is a *reserved* id, not a guarantee.** When dispatch
   * resolves to `"terminal"`, the service generates the id up front and
   * includes it in the response, but `terminalService.spawn` runs
   * asynchronously inside `onSetupComplete` — the spawn may still fail
   * (cwd missing, shell binary absent, EAGAIN, …). Failures are logged
   * and the `terminal-created` event simply never fires; the dashboard
   * will not see a panel materialise. Callers scripting on `terminalId`
   * should treat it as "the pane the server will try to spawn", not
   * "the pane that already exists". The terminal-created / terminal-killed
   * event stream is the authoritative liveness signal.
   *
   * On the **idempotent path** (the worktree's branch already exists as
   * a worktree row), the method returns just `{ ok: true, path }` —
   * `via` and `terminalId` are omitted because no fresh dispatch
   * happened. The Rust CLI propagates that absence so a caller can
   * distinguish "newly created + dispatched" from "already existed,
   * no dispatch."
   */
  async create(input: WorktreeCreateInput): Promise<{
    ok: true;
    path: string;
    via?: WorktreeVia;
    terminalId?: string;
    /** Set when no host fits yet: the worktree is created once the request is fulfilled. */
    provisioning?: { requestId: string };
  }> {
    const sanitizedBranch = slugifyBranchName(input.branch);
    if (!sanitizedBranch) {
      throw new Error(
        `Branch name "${input.branch}" is invalid — it contains no valid characters after sanitization.`,
      );
    }
    input = { ...input, branch: sanitizedBranch };

    const state = loadState();
    const repo = state.repos.find((p) => p.name === input.repo);
    if (!repo) {
      throw new RepoNotFoundError(input.repo);
    }

    // Plain repos have exactly one implicit worktree, created at
    // repo-add time. Creating additional worktrees is meaningless
    // without git worktrees, so reject the call as a backstop — the UI
    // should already be hiding the "New worktree" button.
    if (repo.kind === "plain") {
      throw new PlainRepoError(
        `Repo "${input.repo}" is a plain (non-git) folder and cannot have additional worktrees. Promote it to git (right-click the repo → "Promote to git") to enable branches.`,
      );
    }

    // Idempotency + identity-collision guard, matching on both fields:
    //   - `wt.name === input.branch`: the requested branch collides with an
    //     existing worktree's immutable identity — creating here would mint a
    //     second row with a duplicate `name` (both serialize to the same
    //     worktree id). Return the existing path instead.
    //   - `wt.branch === input.branch`: the plain idempotent case — a worktree
    //     whose live branch already matches the request (always true for a
    //     never-switched worktree, where `name === branch`).
    // Either way we return the existing path, keeping create idempotent and
    // preserving the immutable-name invariant.
    const existing = repo.worktrees.find(
      (wt) => wt.name === input.branch || wt.branch === input.branch,
    );
    if (existing) {
      return { ok: true, path: existing.path };
    }

    // Check the project before anything is created, so a bad request leaves no trace.
    const projectId = input.projectId
      ? projectService.resolveForWorktree(input.projectId, input.repo)
      : undefined;
    if (projectId) input = { ...input, projectId };

    const worktreeId = toWorktreeId(input.repo, input.branch);
    if (input.placement) {
      if (input.hostId) {
        throw new Error("Pass either hostId or placement, not both.");
      }
      const placed = await placementService.placeWorktree(input, input.placement);
      if (placed.kind === "request") {
        return { ok: true, path: "", provisioning: { requestId: placed.requestId } };
      }
      const { placement: _placement, ...rest } = input;
      return this.create({ ...rest, hostId: placed.hostId });
    }
    const hostId = resolveWorktreeHostId(input.hostId);
    // No row exists for a new worktree yet, so the host comes from the request.
    const host = hostRegistry.hostById(hostId);
    const remote = hostId !== hostRegistry.local.id;
    // On a remote host the repo's checkout and the worktree live under the
    // worker's roots, at paths the worker reports.
    const repoPath = remote
      ? await this.remoteCheckout(repo.name, host, input.hostRepoPath)
      : repo.path;
    const wtDir = remote ? await this.remoteWorktreesDir(host) : worktreesDir();
    const worktreePath = remote
      ? posix.join(wtDir, input.repo, input.branch)
      : join(wtDir, input.repo, input.branch);
    // Pre-create the `<repo>` subdir under the worktrees root so the
    // first `worktrees.create` call on a freshly-installed Band has
    // somewhere to land. For slash-containing branch names (e.g.
    // `feature/my-feature` → `<wtDir>/<repo>/feature/my-feature`)
    // we deliberately do NOT pre-create the in-between segments
    // (`feature/`): `git worktree add` itself creates every intermediate
    // directory under its target path, so an extra mkdir here would be
    // redundant. Verified against `git 2.x` — `git worktree add
    // /tmp/wt/feature/login -b feature/login` succeeds without the
    // parent existing.
    await host.fs.mkdir(remote ? posix.join(wtDir, input.repo) : join(wtDir, input.repo), {
      recursive: true,
    });

    try {
      // Async — `git worktree add` on a large repo can take 200–500 ms
      // and the surrounding `create` is already async, so blocking the
      // event loop for the duration would stall every concurrent SSE
      // stream / chat event / API request. Mirrors the async `git`
      // helpers used by `remove` below.
      await host.worktree.create({
        repoPath,
        path: worktreePath,
        branch: input.branch,
        base: input.base,
      });
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }

    // `name` == `branch` at creation and is frozen from here on — sync will
    // update `branch` to track git but never `name`, keeping the id stable.
    const row = {
      name: input.branch,
      branch: input.branch,
      path: worktreePath,
      pinned: false,
      ...(remote ? { hostId } : {}),
      ...(projectId ? { projectId } : {}),
    };
    // Re-read state: `git worktree add` took a while, and a sync or another
    // create may have saved since `state` was loaded.
    const fresh = loadState();
    const freshRepo = fresh.repos.find((p) => p.name === input.repo);
    if (freshRepo && !freshRepo.worktrees.some((wt) => wt.path === worktreePath)) {
      freshRepo.worktrees.push(row);
      saveState(fresh);
    }
    syncService.commitWorktreeAdd(input.repo, row);

    // Copy declared worktree files from the main checkout into the new
    // worktree. Driven by `.band/config.json::workspace.copyFiles` and/or
    // `.worktreeinclude` at the repo root — see `copyWorktreeFiles`
    // for the union/intersection semantics. Runs AFTER `git worktree add`
    // (so the destination directory exists) and BEFORE the setup command (so the
    // setup script can read `.env` / local credentials / etc. just like
    // it can in the main checkout). Missing source files are skipped
    // with a warning rather than failing the create, matching the
    // non-fatal contract used by the setup script itself.
    try {
      const copied = await host.scripts.copyFiles(repoPath, worktreePath);
      if (copied.length > 0) {
        log.info({ worktreeId, count: copied.length }, "copied worktree files into new worktree");
      }
    } catch (err) {
      // Catch-all backstop. `copyWorktreeFiles` already logs per-file
      // failures internally; this guard exists so an unexpected crash
      // (e.g. a truly malformed config) doesn't abort the create flow
      // before the chat pane / setup script have a chance to run.
      log.warn({ err, worktreeId }, "copyWorktreeFiles raised — continuing");
    }

    if (input.brief) {
      try {
        await writeBrief(host, worktreePath, input.brief, remote);
      } catch (err) {
        // A worker that starts without its brief would work blind, so fail the create.
        throw new Error(
          `The worktree was created, but its brief could not be written: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // How the prompt's agent is displayed (issue #682): the caller's
    // `agentMode`, else its legacy `via`, else `agents.defaultMode`.
    const agentMode =
      input.agentMode ?? agentModeFromVia(input.via) ?? settingsService.defaultAgentMode();

    // Materialize the default chat pane so the worktree surfaces a
    // ready-to-use UI even when the caller didn't pass a prompt. A `gui`
    // prompt runs in it.
    let defaultChat = chatService.getOrCreateDefault(worktreeId);
    // A dispatched worker runs on the model of its lane from its first session, which the chat's
    // own model decides (plan step 6.3).
    if (input.brief && input.model && agentMode === "gui") {
      defaultChat = chatService.update(defaultChat.id, { model: input.model }) ?? defaultChat;
    }

    // The setup command runs in its own terminal tab, in parallel with the
    // agent: the prompt goes out now rather than after setup, so a slow or
    // failing setup never holds back or drops it, and the user can watch
    // (and answer) the setup in its tab.
    worktreeScriptService.startSetup(worktreeId, worktreePath, repoPath);

    if (!input.prompt) {
      return { ok: true, path: worktreePath };
    }

    // Fire-and-forget: the launch logs its own spawn failure, and the
    // response only reserves the terminal id (see the JSDoc above). An agent
    // without a TUI invocation falls back to a chat, which the response
    // reports as `via: "chat"`.
    const launched = agentLaunchService.launch({
      worktreeId,
      agentDefinitionId: input.codingAgentId,
      prompt: input.prompt,
      mode: agentMode,
      chatId: defaultChat.id,
      model: input.model,
      permissionMode: input.mode,
    });
    return {
      ok: true,
      path: worktreePath,
      via: launched.mode === "tui" ? "terminal" : "chat",
      terminalId: launched.terminalId,
    };
  }

  /**
   * Continue a chat's coding-agent session in a terminal pane.
   *
   * Resolves the chat's underlying session id + the definition of whichever
   * agent it ran, resolves the vendor CLI's *resume* invocation
   * (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`),
   * composes it into a shell-safe command, and spawns a fresh terminal pane
   * running it — so the user keeps working in the very session the web chat
   * was running. Shares the spawn + `terminal-created` emit shape with the
   * `via=terminal` branch of {@link create} (issue #551).
   *
   * Returns a discriminated result rather than throwing so the tRPC router
   * stays a thin mapping layer — it validates input, delegates here, maps a
   * `{ ok: false, code }` straight onto a `TRPCError`, and echoes
   * `{ ok: true, … }` back to the client.
   */
  async continueChatInTerminal(chatId: string): Promise<ContinueChatInTerminalResult> {
    const chat = chatService.get(chatId);
    if (!chat) {
      return { ok: false, code: "NOT_FOUND", message: "Chat not found" };
    }
    if (!chat.activeSessionId) {
      return {
        ok: false,
        code: "PRECONDITION_FAILED",
        message: "Chat has no active session to continue",
      };
    }

    const worktree = this.resolve(chat.worktreeId);
    if (!worktree) {
      return { ok: false, code: "NOT_FOUND", message: "Worktree not found" };
    }

    const agentDef = settingsService.getAgentDefinition(chat.agent);
    const invocation = resumeCliInvocation(agentDef.type, chat.activeSessionId, {
      command: agentDef.command,
    });
    if (invocation.unsupported) {
      return { ok: false, code: "BAD_REQUEST", message: invocation.reason };
    }

    const command = formatShellCommand(invocation.command, invocation.args);
    const terminalId = randomUUID();
    await terminalService.spawn(chat.worktreeId, terminalId, { command });
    // Broadcast so an already-open dashboard adds the pane to its terminal
    // dockview without a reload — same pattern as `terminal.create` and the
    // `via=terminal` create path.
    emit({ kind: "terminal-created", worktreeId: chat.worktreeId, terminalId });

    log.info(
      { chatId, worktreeId: chat.worktreeId, terminalId },
      "continue chat session in terminal",
    );
    return { ok: true, terminalId, worktreeId: chat.worktreeId, sessionId: chat.activeSessionId };
  }

  /**
   * Remove a worktree (git worktree) and its worktree-scoped state.
   *
   * Two-phase to keep the UI snappy:
   *
   *   1. **Fast path (synchronous):** waits for any worktree sync already
   *      running (it could save the row back), then drops the row from state,
   *      deletes the worktree's prompt file / DB statuses / chats /
   *      browsers / terminals / LSPs / cronjobs / tasks, and emits a
   *      `remove` event so subscribers (the dashboard) can drop the card.
   *   2. **Background:** `git worktree remove --force` + `git branch -D`.
   *      Failures are logged but never bubble back — by then the
   *      worktree is already gone from the user's perspective and we
   *      don't want a stale `.git` to wedge the UI.
   *
   * When `.band/config.json` declares a `teardown` command, it runs first,
   * in a terminal tab of the still-listed worktree, and this call waits
   * for it (up to {@link TEARDOWN_TIMEOUT_MS}) before either phase. The
   * dashboard shows the worktree as tearing down meanwhile. A failing
   * teardown is logged and does not stop the removal. The worktree's
   * chats, agents and cronjobs are still live while it runs; they stop in
   * the fast path afterwards.
   *
   * Resolves the worktree path via `listWorktrees` rather than re-parsing
   * `git worktree list --porcelain` inline so detached-HEAD worktrees
   * (labelled `detached-<short-sha>` everywhere else in the app) round-
   * trip correctly through the remove flow — see the
   * `worktree-remove-detached.test.ts` regression test.
   */
  async remove(input: WorktreeRemoveInput): Promise<{ ok: true }> {
    const state = loadState();
    const repo = state.repos.find((p) => p.name === input.repo);
    if (!repo) {
      throw new RepoNotFoundError(input.repo);
    }

    // Plain repos can't have their (single, implicit) worktree
    // removed — the worktree is the repo. The user must remove the
    // repo entirely instead.
    if (repo.kind === "plain") {
      throw new PlainRepoError(
        `Repo "${input.repo}" is a plain (non-git) repo. Remove the repo instead of the worktree.`,
      );
    }

    // Resolve the worktree by its immutable `name`. The live git branch
    // (what we actually delete) comes from the row, since it may have been
    // switched away from `name` since creation.
    const wtRow = repo.worktrees.find((wt) => wt.name === input.name);
    if (!wtRow) {
      throw new WorktreeNotFoundError(input.name);
    }
    const currentBranch = wtRow.branch;

    // Resolve the worktree path via `listWorktrees` rather than re-parsing
    // porcelain inline — it applies the detached-HEAD → `detached-<sha>`
    // fallback that the rest of the app sees in `repo.worktrees`, so
    // the live branch matches.
    // A worktree on a remote host is listed from that host's checkout.
    const wtHostId = wtRow.hostId ?? hostRegistry.local.id;
    const checkoutPath = hostRegistry.repoPathOn(repo.name, wtHostId, repo.path) ?? repo.path;
    const worktreeId = toWorktreeId(input.repo, input.name);
    let worktrees: Awaited<ReturnType<Host["worktree"]["list"]>>;
    try {
      worktrees = await (wtHostId === hostRegistry.local.id
        ? hostRegistry.hostForRepo(repo.name)
        : hostRegistry.hostById(wtHostId)
      ).worktree.list(checkoutPath);
    } catch (err) {
      // A worker that is offline can't be asked. Take the worktree off the
      // hub now and delete the checkout when the worker reconnects.
      if (wtHostId !== hostRegistry.local.id && err instanceof HostOfflineError) {
        log.info(
          { worktreeId, hostId: wtHostId },
          "host offline; removal will finish on reconnect",
        );
        return this.removeNow(input, worktreeId, wtRow.path, currentBranch, currentBranch, true);
      }
      throw err;
    }
    const match = worktrees.find((wt) => wt.branch === currentBranch);
    if (!match) {
      throw new WorktreeNotFoundError(input.name);
    }
    const worktreePath = match.path;

    const teardownScript = { worktreePath, repoPath: checkoutPath };
    if (!(await worktreeScriptService.getCommand(worktreeId, "teardown", teardownScript))) {
      return this.removeNow(input, worktreeId, worktreePath, currentBranch, match.branch);
    }

    const inFlight = this.removing.get(worktreeId);
    if (inFlight) return inFlight;
    const removal = (async () => {
      const outcome = await worktreeScriptService.run(
        worktreeId,
        "teardown",
        teardownScript,
        TEARDOWN_TIMEOUT_MS,
      );
      // `closed` from a duplicate run is not a failure; the first run reports.
      if (outcome.kind !== "closed" && (outcome.kind !== "exited" || outcome.code !== 0)) {
        log.warn({ worktreeId, outcome }, "teardown did not succeed; removing anyway");
      }
      return this.removeNow(input, worktreeId, worktreePath, currentBranch, match.branch);
    })().finally(() => this.removing.delete(worktreeId));
    this.removing.set(worktreeId, removal);
    return removal;
  }

  /**
   * The two phases of {@link remove}, once any teardown is done. Reloads
   * state because a teardown can take a while.
   */
  private async removeNow(
    input: WorktreeRemoveInput,
    worktreeId: string,
    worktreePath: string,
    currentBranch: string,
    matchedBranch: string,
    deferCleanup = false,
  ): Promise<{ ok: true }> {
    // Until git no longer lists the worktree, a sync would add it back.
    const removal = await syncService.beginWorktreeRemoval(worktreePath);
    let cleanupScheduled = false;
    try {
      const result = this.removeFromState(
        input,
        worktreeId,
        worktreePath,
        currentBranch,
        matchedBranch,
        removal,
        deferCleanup,
      );
      cleanupScheduled = true;
      return result;
    } finally {
      if (!cleanupScheduled) removal.end();
    }
  }

  private removeFromState(
    input: WorktreeRemoveInput,
    worktreeId: string,
    worktreePath: string,
    currentBranch: string,
    matchedBranch: string,
    removal: WorktreeRemoval,
    deferCleanup: boolean,
  ): { ok: true } {
    const state = loadState();
    const repo = state.repos.find((p) => p.name === input.repo);
    if (!repo) {
      throw new RepoNotFoundError(input.repo);
    }
    if (!repo.worktrees.some((wt) => wt.name === input.name)) {
      throw new WorktreeNotFoundError(input.name);
    }
    const host = hostRegistry.hostFor(worktreeId);

    // The row is gone once saved, so read the project now for the chat capture below.
    const projectId = repo.worktrees.find((wt) => wt.name === input.name)?.projectId;

    // ── Fast path: update state and emit immediately ──
    repo.worktrees = repo.worktrees.filter((wt) => wt.name !== input.name);
    saveState(state);
    removal.commit();

    try {
      // Older installs keep prompt files in `workspace-prompts`; the directory name is not renamed.
      unlinkSync(join(bandHome(), "workspace-prompts", `${worktreeId}.json`));
    } catch {
      // Prompt file may not exist
    }
    deleteWorktreeStatus(worktreeId);
    this.queries.deleteBranchStatus(worktreeId);

    // Clean up all chat panes and their agent processes. The service
    // tears down the saved layout as part of the same call (see
    // `ChatService.removeAllForWorktree`) so a separate `deleteChatLayout`
    // step is no longer required here.
    chatService.removeAllForWorktree(worktreeId, input.repo, projectId);
    agentSessionRegistry.removeAllForWorktree(worktreeId);

    // Clean up all browser tabs + layout. Same contract as chats —
    // `BrowserService.removeAllForWorktree` drops the layout row itself.
    browserService.removeAllForWorktree(worktreeId);

    // Kill any running terminal PTY sessions + layout. Fire-and-forget: the
    // kill may hop to the terminal daemon, and a failure there must not fail
    // the worktree removal (the boot reconcile retries it).
    void terminalService.killWorktree(worktreeId).catch((err) => {
      log.warn({ worktreeId, err }, "failed to kill the worktree's terminals");
    });
    terminalService.deleteLayout(worktreeId);

    // Drop the last-focused-panel record so it doesn't outlive the worktree.
    panelFocusService.remove(worktreeId);

    // Drop the worktree's shared UI state (center tabs, drafts, splits).
    clientStateService.removeAllForWorktree(worktreeId);

    // Drop the worktree's subscriptions.
    subscriptionService.removeForWorktree(worktreeId);

    // Kill any running language server processes
    void host.lsp.killWorktree(worktreeId).catch((err) => {
      log.warn({ worktreeId, err }, "failed to kill the worktree's language servers");
    });

    // Close the worktree's browser. Only a remote host runs one, and the worker kills Chromium.
    void host.browser.close(worktreeId).catch((err) => {
      log.warn({ worktreeId, err }, "failed to close the worktree's browser");
    });

    // Clean up worktree-scoped cronjobs
    cronjobService.removeForKey(worktreeId);

    // Delete persisted task history for the worktree (issue #416).
    // Tasks aren't covered by a FK cascade because worktrees aren't a
    // first-class DB row, so the cleanup is explicit here next to the
    // other worktree-scoped removals. Task cleanup is best-effort — a
    // DB lock or WAL timeout must not abort the whole removal or
    // suppress the `emit` below, otherwise the dashboard would keep
    // showing the just-deleted worktree.
    try {
      const deletedTasks = new TaskQueries().deleteWorktreeTasks(worktreeId);
      if (deletedTasks > 0) {
        log.info({ worktreeId, count: deletedTasks }, "deleted worktree tasks on removal");
      }
    } catch (err) {
      log.error({ worktreeId, err }, "failed to delete worktree tasks on removal");
    }

    // Delete persisted usage-event history + scan watermarks alongside
    // tasks (issue #425). Same best-effort policy as the tasks cleanup
    // above. Dropping the watermark lets a future worktree at the same
    // id start scanning from scratch.
    try {
      const deletedEvents = this.usageEventQueries.deleteWorktreeEvents(worktreeId);
      if (deletedEvents > 0) {
        log.info({ worktreeId, count: deletedEvents }, "deleted worktree usage events on removal");
      }
    } catch (err) {
      log.error({ worktreeId, err }, "failed to delete worktree usage events on removal");
    }
    try {
      this.usageScanStateQueries.deleteWorktree(worktreeId);
    } catch (err) {
      log.error({ worktreeId, err }, "failed to delete worktree usage scan state on removal");
    }

    // Notify subscribers (dashboard status stream) that this worktree is gone
    emit({ kind: "remove", worktreeId });

    // ── Background cleanup: slow git/fs operations ──
    const projPath = hostRegistry.repoPathOn(repo.name, host.id, repo.path) ?? repo.path;
    // Synthetic "detached-<short-sha>" labels generated by `listWorktrees`
    // for detached-HEAD worktrees do not correspond to a real git ref.
    // Trying to `git branch -D detached-abc1234` would error ("branch not
    // found") — the catch below swallows it cleanly, but skipping the
    // call up front keeps the background logs free of noise that's hard
    // to distinguish from a genuine problem.
    const branchToDelete = matchedBranch.startsWith(DETACHED_BRANCH_PREFIX) ? null : currentBranch;
    if (deferCleanup) {
      this.pendingRemovals.add({
        hostId: host.id,
        repoPath: projPath,
        worktreePath,
        branch: branchToDelete,
      });
      removal.end();
      return { ok: true };
    }
    setImmediate(() => {
      this.cleanupWorktree(host, projPath, worktreePath, branchToDelete, worktreeId)
        .catch((err) => {
          if (err instanceof HostOfflineError) {
            // The host dropped after the worktree left the hub. The worker finishes the job on reconnect.
            log.info(
              { worktreeId, hostId: host.id },
              "host went offline; cleanup will finish on reconnect",
            );
            this.pendingRemovals.add({
              hostId: host.id,
              repoPath: projPath,
              worktreePath,
              branch: branchToDelete,
            });
            return;
          }
          log.error({ err, worktreeId }, "background worktree cleanup failed");
        })
        .finally(removal.end);
    });

    return { ok: true };
  }

  /**
   * Deletes a removed worktree's checkout on its host: the git worktree, then
   * its branch. Rejects with `HostOfflineError` when the host can't be reached,
   * so the caller can try again later.
   */
  private async cleanupWorktree(
    host: Host,
    projPath: string,
    worktreePath: string,
    branchToDelete: string | null,
    worktreeId: string,
  ): Promise<void> {
    // Unlock the worktree first. External tooling (e.g. `supacode`)
    // locks Band's worktrees — visible as a `locked "{...}"` line in
    // `git worktree list --porcelain` — most likely to stop `git gc` /
    // auto-prune from reclaiming a worktree while an agent is mid-flight.
    // A locked worktree is refused by a single `git worktree remove
    // --force` ("cannot remove a locked working tree") AND is skipped by
    // `git worktree prune`, so without this unlock the admin record in
    // `.git/worktrees/<id>/` survives and `syncWorktrees` re-adds the
    // worktree on the next tick (issue: locked worktrees resurrect
    // forever). Best-effort: swallow "not locked" and any other error.
    try {
      // Unlocks first (best-effort), then removes.
      await host.worktree.remove({ repoPath: projPath, path: worktreePath });
    } catch (err) {
      if (err instanceof HostOfflineError) throw err;
      // Worktree may be corrupted (e.g. missing .git file) or still
      // refused. Manually remove the directory and prune stale entries.
      try {
        await host.fs.rm(worktreePath, { recursive: true, force: true });
      } catch (rmErr) {
        if (rmErr instanceof HostOfflineError) throw rmErr;
        // Permission errors / EBUSY here leave the directory on disk;
        // log so a stale worktree path is traceable, then still try
        // `git worktree prune` to at least clean the index — matches
        // the existing best-effort pattern used for prune/branch -D.
        log.warn({ err: rmErr, worktreeId, worktreePath }, "manual worktree rm failed");
      }
      // Re-run the unlock: `git worktree prune` skips LOCKED entries, so
      // a still-locked admin record (whose working dir we just `rm`'d)
      // would otherwise survive the prune and resurrect on sync. Unlock
      // resolves the entry by its recorded path even when the dir is gone.
      try {
        await host.git.exec(["worktree", "unlock", worktreePath], projPath);
      } catch {
        // Already unlocked or entry gone — prune below handles the rest.
      }
      try {
        await host.git.exec(["worktree", "prune"], projPath);
      } catch (pruneErr) {
        if (pruneErr instanceof HostOfflineError) throw pruneErr;
        log.warn({ err: pruneErr, worktreeId }, "git worktree prune failed");
      }
    }

    if (branchToDelete) {
      try {
        await host.git.exec(["branch", "-D", branchToDelete], projPath);
      } catch {
        // Branch may already be deleted
      }
    }
  }

  /**
   * Deletes the checkouts of worktrees that were removed while `hostId` was
   * offline. Called when its worker connects. A removal that fails stays
   * recorded for the next connect.
   */
  async finishPendingRemovals(hostId: string): Promise<void> {
    const host = hostRegistry.hostById(hostId);
    for (const row of this.pendingRemovals.listForHost(hostId)) {
      try {
        await this.cleanupWorktree(host, row.repoPath, row.worktreePath, row.branch, hostId);
        this.pendingRemovals.delete(hostId, row.worktreePath);
        log.info({ hostId, worktreePath: row.worktreePath }, "finished a pending removal");
      } catch (err) {
        log.warn({ hostId, worktreePath: row.worktreePath, err }, "pending removal not finished");
        if (err instanceof HostOfflineError) return;
      }
    }
  }

  /**
   * Toggle a worktree's pinned flag.
   *
   * Pinning surfaces the worktree in the dashboard's "Pinned" section.
   * Rejects plain repos (they're already flat in the repos list and
   * a stray `pinned=true` strands the UI with an empty `worktrees` array;
   * the menu item is also hidden client-side as a first line of defence).
   */
  setPinned(input: WorktreeSetPinnedInput): { ok: true } {
    const state = loadState();
    const repo = state.repos.find((p) => p.name === input.repo);
    if (!repo) {
      throw new RepoNotFoundError(input.repo);
    }
    if (repo.kind === "plain") {
      throw new PlainRepoError(
        `Repo "${input.repo}" is a plain (non-git) repo. Pinning is not available.`,
      );
    }
    const worktree = repo.worktrees.find((w) => w.name === input.name);
    if (!worktree) {
      throw new WorktreeNotFoundError(input.name);
    }
    worktree.pinned = input.pinned;
    saveState(state);
    return { ok: true };
  }

  /**
   * `git pull --rebase` inside the worktree's worktree.
   *
   * Swallows the specific "Cannot rebase onto multiple branches" exit
   * status that git produces when the fetch step has already fast-
   * forwarded the working tree — the pull effectively succeeded in that
   * case and a thrown error would surface as a red toast. Local changes in
   * the way, or no upstream, come back as an `ok: false` refusal.
   */
  async gitPull(input: WorktreeGitInput): Promise<GitOpResult> {
    const worktreeId = toWorktreeId(input.repo, input.name);
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(input.name);
    }
    if (worktree.repo.kind === "plain") {
      throw new PlainRepoError(
        `Repo "${input.repo}" is a plain (non-git) repo. Git pull is not available.`,
      );
    }
    return pullRebase(gitRunner(worktree.host), worktree.worktree.path);
  }

  /**
   * `git push` inside the worktree's worktree. Falls back to
   * `git push --set-upstream origin <branch>` on first push when no
   * upstream is configured.
   *
   * The fallback only fires when git reports "no upstream branch" — all
   * other failures (auth, rejected push, network, …) rethrow immediately
   * so the real error surfaces to the caller instead of being masked by
   * a second failing push. A non-fast-forward rejection comes back as an
   * `ok: false` refusal.
   */
  async gitPush(input: WorktreeGitInput): Promise<GitOpResult> {
    const worktreeId = toWorktreeId(input.repo, input.name);
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(input.name);
    }
    if (worktree.repo.kind === "plain") {
      throw new PlainRepoError(
        `Repo "${input.repo}" is a plain (non-git) repo. Git push is not available.`,
      );
    }
    const cwd = worktree.worktree.path;
    const execGit = gitRunner(worktree.host);
    try {
      await execGit(["push"], cwd);
    } catch (err) {
      // git's "no upstream configured" error reads roughly:
      //   fatal: The current branch <name> has no upstream branch.
      // Anything else — auth, rejected push, network — should bubble up
      // unchanged so the user sees the real cause instead of a misleading
      // second-push failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/has no upstream branch/i.test(msg)) {
        const refusal = pushRefusal(err);
        if (refusal) return refusal;
        throw err;
      }
      // Set upstream for the LIVE git branch, not the worktree identity —
      // after a branch switch they differ, and we push the current checkout.
      await execGit(["push", "--set-upstream", "origin", worktree.worktree.branch], cwd);
    }
    await recordPushedHead(worktree.host, worktreeId, cwd);
    return { ok: true };
  }

  /**
   * `git pull --rebase` keyed by worktreeId rather than `(repo, branch)`.
   *
   * Used by `api/worktree/router.ts::gitPull` (the per-worktree,
   * singular-namespace variant). Runs the same `pullRebase` helper as the
   * repo-keyed `gitPull` above, so the collision guard and the refusal
   * mapping stay in one place. (We don't `this.gitPull` from here because that variant
   * additionally enforces the `kind === "plain"` rejection via
   * `PlainRepoError`; the worktreeId surface doesn't carry that
   * concern.)
   */
  async gitPullByWorktreeId(worktreeId: string): Promise<GitOpResult> {
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    return pullRebase(gitRunner(worktree.host), worktree.worktree.path);
  }

  /**
   * `git push` keyed by worktreeId rather than `(repo, branch)`.
   *
   * Used by `api/worktree/router.ts::gitPush` (the per-worktree,
   * singular-namespace variant). Resolves the live HEAD branch rather than
   * the recorded one for the upstream fallback — the worktree may have
   * been renamed via `git branch -m` and the repo record not yet
   * refreshed, in which case pushing the stale name fails too.
   */
  async gitPushByWorktreeId(worktreeId: string): Promise<GitOpResult> {
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    const cwd = worktree.worktree.path;
    const execGit = gitRunner(worktree.host);
    try {
      await execGit(["push"], cwd);
    } catch (err) {
      // Narrow the catch to the specific "no upstream configured" exit
      // — every other failure (auth, rejected push, network) must bubble
      // up unmasked so the user sees the real cause instead of a
      // misleading second-push error. Same shape as the repo-keyed
      // `gitPush` above.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/has no upstream branch/i.test(msg)) {
        const refusal = pushRefusal(err);
        if (refusal) return refusal;
        throw err;
      }
      // First push needs to set upstream. Resolve the live HEAD branch
      // rather than trusting a stale state.json entry — the worktree
      // may have been renamed via `git branch -m` and the repo
      // record not yet refreshed.
      let headBranch: string;
      try {
        headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      } catch {
        headBranch = worktree.worktree.branch;
      }
      // Don't wrap the upstream-set failure in `new Error(msg)` — that
      // would drop the original stack. Let `execGit`'s rejection bubble
      // unchanged, carrying its captured stderr.
      await execGit(["push", "--set-upstream", "origin", headBranch], cwd);
    }
    await recordPushedHead(worktree.host, worktreeId, cwd);
    return { ok: true };
  }

  /**
   * Commit all pending changes in `worktreeId` with `message` (and optional
   * `body`). Stages everything (tracked + untracked) so the commit reflects
   * the diff the user just reviewed in the Changes view. A clean working
   * tree comes back as a `nothing-to-commit` refusal.
   */
  async gitCommit(
    worktreeId: string,
    input: { message: string; body?: string },
  ): Promise<GitOpResult> {
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    const cwd = worktree.worktree.path;
    const execGit = gitRunner(worktree.host);

    await execGit(["add", "-A"], cwd);
    // `git commit` reports "nothing to commit" on stdout, which `execGit`'s
    // rejection doesn't carry, so check for staged changes first.
    if ((await execGit(["status", "--porcelain"], cwd)).trim() === "") {
      return NOTHING_TO_COMMIT;
    }

    // Pass title + body as separate `-m` args so git formats them with the
    // standard blank-line separator between subject and body.
    const args = ["commit", "-m", input.message];
    const body = input.body?.trim();
    if (body) {
      args.push("-m", body);
    }
    // `execGit`'s rejection carries the git stderr and a real stack —
    // let it propagate up the await chain unchanged.
    await execGit(args, cwd);
    return { ok: true };
  }

  /**
   * Ask the worktree's coding agent to summarise pending changes into a
   * commit message. The agent runs in the worktree's worktree with
   * `Bash`/`Read` tools and explores the diff itself rather than receiving
   * a (potentially truncated) serialised diff in the prompt.
   *
   * Returns `{ message, body, agentLabel }` — `message` is the subject
   * line (≤72 chars, imperative mood), `body` is the optional explanation
   * paragraph. Refuses early when there are no pending changes so we
   * don't spin up an agent process just to have it report "nothing to
   * commit".
   */
  async generateCommitMessage(
    worktreeId: string,
  ): Promise<{ message: string; body: string; agentLabel: string }> {
    const worktree = this.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    const cwd = worktree.worktree.path;

    // Cheap pre-flight: refuse early if there are no pending changes so
    // we don't spin up an agent process just to have it report "nothing
    // to commit". `git status --porcelain` covers staged, unstaged, and
    // untracked files in one call — and on a brand-new unborn-HEAD
    // repository it still succeeds (showing untracked entries).
    //
    // Any execGit failure here (not a git repo, git binary missing,
    // permission denied, …) is a real, user-actionable error: surface
    // it instead of silently spawning an agent that will run the same
    // status command and fail the same way.
    const execGit = gitRunner(worktree.host);
    const status = await execGit(["status", "--porcelain"], cwd);
    if (!status.trim()) {
      throw new Error("No changes to summarise");
    }

    const settings = settingsService.get();
    // Use the worktree's default chat-pane agent so the commit-message
    // agent matches the agent the user is actually looking at. Without
    // this, switching the pane to (e.g.) codex would silently keep
    // generating commit messages with the user's global default
    // (e.g. claude-code). The chat row's `agent` field is only set when
    // the user has explicitly switched panes; when it's null, we fall
    // back to the global default via SettingsService.resolveAgent —
    // which is intentional, not a silent oversight, so a freshly seeded
    // worktree still picks up the user's preferred agent.
    const defaultChat = chatService.getOrCreateDefault(worktreeId);
    const agentDef = SettingsService.resolveAgent(settings, defaultChat.agent ?? undefined);

    const prompt = [
      "You are running inside a git worktree. Write a commit message for the changes that are pending in this worktree right now.",
      "",
      "Steps:",
      "  1. Run `git status` and `git diff HEAD` (and `git diff --stat` if the diff is large) to understand what changed.",
      "  2. If helpful, read a few of the changed files or recent commits (`git log -5 --oneline`) to match the repo's commit style.",
      "  3. Write a single commit message.",
      "",
      "Format:",
      "  - First line: a concise subject (≤ 72 chars), imperative mood, no trailing period.",
      "  - Then a blank line.",
      "  - Then a body that explains *why* the change is being made and any notable details.",
      "",
      "Output ONLY the final commit message as plain text — no markdown fences, no preamble, no commentary, no tool-call summaries. Do not modify any files.",
    ].join("\n");

    let lastTurnText: string;
    try {
      lastTurnText = await agentSessionService.oneShot(agentDef, cwd, prompt, worktree.host);
    } catch (e) {
      throw new Error(
        `Coding agent "${agentDef.label}" failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const cleaned = lastTurnText.trim();
    if (!cleaned) {
      throw new Error("Agent returned an empty response");
    }

    // Split into subject + body on the first blank line.
    const lines = cleaned.split("\n");
    const subject = (lines.shift() ?? "").trim();
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    const body = lines.join("\n").trim();

    return {
      message: subject,
      body,
      agentLabel: agentDef.label,
    };
  }

  /**
   * Execute a `.band/<scriptType>` shell script in the given directory.
   *
   * Used by the dashboard's "Run script" actions on a worktree
   * (e.g. `on-create`, `on-open`). Returns once the script exits 0;
   * rejects on a non-zero exit. On POSIX the script is run via
   * `bash <scriptPath>` — execFile with a fixed argv, not a shell-spawned
   * command string. On Windows it runs through the command interpreter
   * (`cmd.exe /d /s /c <scriptPath>`), where cmd metacharacters in the path
   * WOULD be interpreted — so `scriptType` (an unconstrained `z.string()` at
   * the tRPC edge) is validated to a safe filename charset before it becomes
   * a path segment, closing both a Windows shell-injection vector and a
   * cross-platform `..` path-traversal vector.
   *
   * Missing-script case throws a generic `Error` (not a domain class) so
   * tRPC surfaces it as `INTERNAL_SERVER_ERROR` (500). The wire-level
   * contract is pinned by `worktrees.runScript returns error for missing
   * script` in `apps/hub/tests/trpc.test.ts`; a 4xx mapping would be
   * semantically nicer but would break the existing test and any client
   * pattern-matching on status.
   */
  async runScript(input: WorktreeRunScriptInput): Promise<{ ok: true }> {
    // Harden `scriptType` before it becomes a path segment / command token.
    // Real callers only ever send `"setup"` / `"teardown"` (see WorktreeCard),
    // but the tRPC input is an unconstrained `z.string()`. Restrict to a safe
    // filename charset — no path separators, no `..` segment, no cmd.exe
    // metacharacters — so the Windows `cmd /c <scriptPath>` path can't be
    // steered into shell injection or traversal outside `.band/`.
    if (!/^[a-zA-Z0-9._-]+$/.test(input.scriptType) || input.scriptType.includes("..")) {
      throw new Error(`Invalid script type "${input.scriptType}"`);
    }
    const scriptPath = join(input.path, ".band", input.scriptType);
    const host = hostRegistry.local;
    try {
      await host.fs.stat(scriptPath);
    } catch {
      throw new Error(`Script "${input.scriptType}" not found`);
    }

    try {
      // `bash <scriptPath>` on POSIX; on Windows the script runs through
      // the command interpreter (see `scriptInvocation`).
      const { file, args } = scriptInvocation(scriptPath);
      await host.exec(file, args, { cwd: input.path });
    } catch (err) {
      // Rewrap as a plain `Error` carrying just the message — preserves the
      // legacy router's behaviour, where the callback-style failure path
      // surfaced `new Error(err.message)` rather than the original
      // `ChildProcessError` (which would have leaked subprocess metadata
      // into the tRPC response body).
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }
}

/**
 * Shared singleton consumed by the API tier (worktrees router) and any
 * future non-tRPC entry points (CLI, scripts). `WorktreeService` is
 * stateless aside from its `queries` dependency, so one instance is safe
 * across callers.
 */
export const worktreeService = new WorktreeService();
