/**
 * Follow the work: when a worktree's host is offline and someone needs a live host, Band offers
 * to continue the worktree on another allowed host from the latest checkpoint (or does it by
 * itself when the repo opts in and the checkpoint is young).
 *
 * The restore is `CheckpointService.restore` (branch and uncommitted state, the agent sessions,
 * chats moved to the new worktree id). This service adds what sits around it:
 *
 *   - `offer`: who could take the work, what will not carry over, or why it cannot continue.
 *   - `gate`: the check an entry point (a chat message, a terminal, an agent launch) runs before
 *     it needs the host. It returns at once for a worktree whose host is up.
 *   - `continueOn`: the restore, the record on the new copy, and the repo's setup.
 *   - the return of the original host: the old copy stays on disk, superseded. When its host is
 *     back the service compares its files with the checkpoint the continuation used and flags
 *     `diverged` with a diff. `bringOver` applies that diff to the new copy as a patch,
 *     `discardOld` removes the old copy after a confirmation.
 *
 * Reading a worktree (diff, files, chat history) never triggers a continuation: the checkpoint
 * views of `CheckpointService` serve it while the host is away.
 */

import { posix } from "node:path";

import { buildSnapshot, gitIn, WIP_DIR } from "@band-app/host-api/snapshot-git";
import { createLogger } from "@band-app/logger";
import {
  CONTINUE_LIMITS,
  CONTINUE_RUNS,
  type ContinueBlock,
  type ContinuedFrom,
  type ContinueOffer,
  type ContinueReason,
  type ContinueTarget,
  DEFAULT_AUTO_CONTINUE_MAX_AGE_MS,
  type Divergence,
  formatAge,
} from "@band-app/shared/continuation";
import {
  checkpointsEnabledFor,
  isHostAllowed,
  onlyAvailableOnMessage,
} from "@band-app/shared/repo-hosts";
import { toWorktreeId } from "@band-app/shared/worktree-id";

import { CheckpointError, ContinueGateError } from "../errors";
import { RepoQueries } from "../infra/db/queries/repos";
import { resolveAgentDefinition, SettingsQueries } from "../infra/db/queries/settings";
import { hostRegistry } from "../infra/host/registry";
import { hostNamesOf } from "./_utils/repo-host-policy";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { type ChangedFile, checkpointService } from "./checkpoint-service";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { modelRefreshService } from "./model-refresh-service";
import { tokenService } from "./token-service";
import { workerLeaseService } from "./worker-lease-service";
import { worktreeScriptService } from "./worktree-script-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("follow");

const LOCAL_HOST_ID = "local";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How old a checkpoint may be for a repo with auto-continue on to continue without asking. */
export function autoContinueMaxAgeMs(): number {
  const raw = Number(process.env.BAND_AUTO_CONTINUE_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_CONTINUE_MAX_AGE_MS;
}

export interface GateOptions {
  /** The chat the action is for. Its agent must be available on the target. */
  chatId?: string;
  /** The agent the action asks for, when the chat does not have one yet. */
  agentId?: string;
}

export interface GateResult {
  /** The worktree to use: the one asked for, or the new copy after an automatic continuation. */
  worktreeId: string;
  /** Set when this call continued the worktree on another host by itself. */
  continued?: ContinuedFrom;
}

export interface ContinueResult {
  worktreeId: string;
  hostId: string;
  hostName: string;
  continuedFrom: ContinuedFrom;
  chatIds: string[];
}

export interface DivergenceReport {
  worktreeId: string;
  /** The copy that replaced this one. */
  replacementId: string;
  state: Divergence["state"];
  files: ChangedFile[];
  /** False when the old copy's host is offline, so nothing could be compared. */
  hostOnline: boolean;
  checkedAt: number | null;
}

export interface BringOverResult {
  applied: boolean;
  /** The files the patch changed on the new copy. */
  files: number;
  /** Set when the patch does not apply cleanly. Nothing was changed. */
  conflicts: Array<{ path: string; message: string }>;
}

interface Located {
  repo: NonNullable<ReturnType<typeof worktreeService.resolve>>["repo"];
  worktree: NonNullable<ReturnType<typeof worktreeService.resolve>>["worktree"];
  hostId: string;
}

export class FollowService {
  private readonly repos = new RepoQueries();
  private readonly settings = new SettingsQueries();
  /** Per worktree: the continuation in flight, so two actions at once share one restore. */
  private readonly inflight = new Map<string, Promise<ContinueResult>>();

  // ---- when the gate applies ------------------------------------------------------

  private locate(worktreeId: string): Located | null {
    const found = worktreeService.resolve(worktreeId);
    if (!found) return null;
    return { ...found, hostId: found.worktree.hostId ?? LOCAL_HOST_ID };
  }

  /**
   * Whether the worktree is on a worker that is offline and is not asleep. A sleeping worktree
   * wakes on use (ephemeral lifecycle), and the hub's own machine is never offline.
   */
  isOffline(worktreeId: string): boolean {
    const at = this.locate(worktreeId);
    if (!at) return false;
    if (at.hostId === LOCAL_HOST_ID) return false;
    if (at.worktree.supersededBy) return false;
    if (checkpointService.isHostOnline(at.hostId)) return false;
    if (ephemeralLifecycleService.stateOf(worktreeId)) return false;
    return true;
  }

  // ---- the offer ----------------------------------------------------------------

  /** The agent definitions a worktree's action needs. */
  private neededAgents(worktreeId: string, opts: GateOptions): Array<string | undefined> {
    const ids = new Set<string | undefined>();
    if (opts.chatId) {
      const chat = chatService.get(opts.chatId);
      ids.add(chat?.agent ?? opts.agentId);
    } else if (opts.agentId) {
      ids.add(opts.agentId);
    } else {
      for (const chat of chatService.list(worktreeId)) ids.add(chat.agent);
    }
    if (ids.size === 0) ids.add(undefined);
    return [...ids];
  }

  /** Why one agent cannot start on a worker, or null when it can. */
  private async agentProblem(hostId: string, agentId: string | undefined): Promise<string | null> {
    const def = resolveAgentDefinition(this.settings.load(), agentId);
    const host = tokenService.listHosts(1000).find((h) => h.id === hostId);
    const reported = host?.report?.agents.find((a) => a.type === def.type);
    if (reported && !reported.installed) return `${def.label} is not installed`;
    if (reported && reported.loggedIn === false) return `${def.label} is not logged in`;
    return modelRefreshService.launchProblemOn(hostId, def.id);
  }

  /**
   * What continuing `worktreeId` would do, or why it cannot. Works for any worktree on a worker,
   * online or not, so the CLI and the UI can ask ahead of time.
   */
  async offer(worktreeId: string, opts: GateOptions = {}): Promise<ContinueOffer> {
    const at = this.locate(worktreeId);
    if (!at) throw new CheckpointError("invalid", `Unknown worktree "${worktreeId}"`);
    const { repo, worktree, hostId } = at;
    const hostName = hostNamesOf([hostId])[0] ?? "unknown host";
    const base: ContinueOffer = {
      worktreeId,
      repo: repo.name,
      fromHostId: hostId,
      fromHostName: hostName,
      targets: [],
      question: "",
      limits: [...CONTINUE_LIMITS],
      willRun: [...CONTINUE_RUNS],
      fresh: false,
    };
    const blocked = (reason: ContinueBlock, message: string): ContinueOffer => ({
      ...base,
      blocked: { reason, message },
      question: message,
    });

    if (hostId === LOCAL_HOST_ID) {
      return blocked("not-offline", "This worktree is on the hub's own machine, which is up.");
    }
    if (worktree.supersededBy) {
      return blocked(
        "already-continued",
        `${worktreeId} was already continued as ${worktree.supersededBy}. Use that worktree.`,
      );
    }

    const allowed = repo.allowedHostIds ?? null;
    if (allowed && allowed.every((id) => id === hostId)) {
      return blocked(
        "restricted-to-offline-host",
        `${onlyAvailableOnMessage(repo.name, hostNamesOf(allowed))}, and ${hostName} is offline. Bring ${hostName} back online, or allow another host for ${repo.name} in Settings > Repos.`,
      );
    }
    if (!checkpointsEnabledFor(repo.checkpointsEnabled, repo.allowedHostIds)) {
      return blocked(
        "checkpoints-off",
        `Checkpoints are off for ${repo.name}, so the hub has no copy of the work on ${hostName}. Bring ${hostName} back online, or turn on checkpoints for ${repo.name} in Settings > Repos.`,
      );
    }
    const checkpoint = checkpointService.list(worktreeId).checkpoints[0];
    if (!checkpoint) {
      return blocked(
        "no-checkpoint",
        `The hub has no checkpoint of ${worktreeId} yet, so it cannot continue on another host. Bring ${hostName} back online.`,
      );
    }

    // The old host may still be running this worktree until its lease is over.
    const leaseLeft = workerLeaseService.remainingMs(hostId);
    if (leaseLeft > 0 && !checkpointService.isHostOnline(hostId)) {
      return {
        ...blocked(
          "lease-active",
          `${hostName} may still be running ${worktreeId}. It stops all work when its lease ends, in ${formatAge(leaseLeft)}, and then this worktree can be opened on another host.`,
        ),
        leaseExpiresAt: Date.now() + leaseLeft,
        leaseRemainingMs: leaseLeft,
        checkpointId: checkpoint.id,
        checkpointAt: checkpoint.createdAt,
        checkpointAgeMs: Date.now() - checkpoint.createdAt,
      };
    }

    const needed = this.neededAgents(worktreeId, opts);
    const clones = new Set(
      [...(this.repos.allHostPaths().get(repo.name)?.keys() ?? [])].filter(
        (id) => id !== LOCAL_HOST_ID,
      ),
    );
    const load = await this.loadByHost();
    const candidates = tokenService
      .listHosts(1000)
      .filter(
        (h) =>
          h.id !== LOCAL_HOST_ID &&
          h.id !== hostId &&
          h.status === "online" &&
          checkpointService.isHostOnline(h.id) &&
          !checkpointService.isHostEphemeral(h.id) &&
          isHostAllowed(allowed, h.id),
      );
    if (candidates.length === 0) {
      return {
        ...blocked(
          "no-online-host",
          `${hostName} is offline and no other host that ${repo.name} may run on is online. Bring ${hostName} or another allowed host online and try again.`,
        ),
        checkpointId: checkpoint.id,
        checkpointAt: checkpoint.createdAt,
        checkpointAgeMs: Date.now() - checkpoint.createdAt,
      };
    }

    const targets: ContinueTarget[] = [];
    for (const h of candidates) {
      let problem: string | undefined;
      for (const agentId of needed) {
        const p = await this.agentProblem(h.id, agentId);
        if (p) {
          problem = p;
          break;
        }
      }
      targets.push({
        hostId: h.id,
        hostName: h.name,
        hasClone: clones.has(h.id),
        agentReady: problem === undefined,
        ...(problem ? { agentProblem: problem } : {}),
        load: load.get(h.id) ?? 0,
        recommended: false,
      });
    }
    targets.sort(
      (a, b) =>
        Number(b.agentReady) - Number(a.agentReady) ||
        Number(b.hasClone) - Number(a.hasClone) ||
        a.load - b.load ||
        a.hostId.localeCompare(b.hostId),
    );
    const best = targets.find((t) => t.agentReady);
    const ageMs = Date.now() - checkpoint.createdAt;
    const withCheckpoint = {
      checkpointId: checkpoint.id,
      checkpointAt: checkpoint.createdAt,
      checkpointAgeMs: ageMs,
    };
    if (!best) {
      const detail = targets.map((t) => `${t.hostName}: ${t.agentProblem}`).join("; ");
      return {
        ...blocked(
          "agent-unavailable",
          `${hostName} is offline and the agent for this work is not available on any other host that ${repo.name} may run on (${detail}). Bring ${hostName} back online, or install and log in the agent on another host.`,
        ),
        ...withCheckpoint,
        targets,
      };
    }
    best.recommended = true;
    return {
      ...base,
      ...withCheckpoint,
      targets,
      fresh: ageMs <= autoContinueMaxAgeMs(),
      question: `${hostName} is offline. Continue on ${best.hostName} from the checkpoint taken ${formatAge(ageMs)} ago?`,
    };
  }

  /** Worktrees per host, not counting superseded copies. */
  private async loadByHost(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const repo of this.repos.loadAll()) {
      for (const wt of repo.worktrees) {
        if (wt.supersededBy) continue;
        const id = wt.hostId ?? LOCAL_HOST_ID;
        out.set(id, (out.get(id) ?? 0) + 1);
      }
    }
    return out;
  }

  // ---- the gate ---------------------------------------------------------------------

  /**
   * Runs before an action that needs the worktree's host. Returns the worktree to use. When the
   * host is up the call is a no-op. When it is offline the work either continues on another host
   * by itself (the repo opted in and the checkpoint is young) or this throws `ContinueGateError`
   * with the offer or the reason it is not possible.
   */
  async gate(worktreeId: string, opts: GateOptions = {}): Promise<GateResult> {
    const stale = this.locate(worktreeId);
    const next = stale?.worktree.supersededBy ? this.locate(stale.worktree.supersededBy) : null;
    // A client still holding the old id goes to the copy the work moved to.
    if (
      stale &&
      next &&
      stale.hostId !== LOCAL_HOST_ID &&
      !checkpointService.isHostOnline(stale.hostId)
    ) {
      return { worktreeId: idOf(next) };
    }
    if (!this.isOffline(worktreeId)) return { worktreeId };
    const offer = await this.offer(worktreeId, opts);
    if (offer.blocked) {
      throw new ContinueGateError({
        code: "CONTINUE_NOT_POSSIBLE",
        error: offer.blocked.message,
        offer,
      });
    }
    const at = this.locate(worktreeId);
    const auto = at?.repo.autoContinue === true && offer.fresh;
    const target = offer.targets.find((t) => t.recommended);
    if (!auto || !target) {
      throw new ContinueGateError({ code: "HOST_OFFLINE", error: offer.question, offer });
    }
    let result: ContinueResult;
    try {
      result = await this.continueOn({
        worktreeId,
        toHostId: target.hostId,
        reason: "auto",
        ...opts,
      });
    } catch (err) {
      // Callers map only ContinueGateError, so a failed restore reaches them as a refusal.
      if (err instanceof CheckpointError) {
        throw new ContinueGateError({ code: "CONTINUE_NOT_POSSIBLE", error: err.message, offer });
      }
      throw err;
    }
    return { worktreeId: result.worktreeId, continued: result.continuedFrom };
  }

  // ---- continuing -------------------------------------------------------------------

  /**
   * Continues the worktree on `toHostId` (the offer's recommended host when left out) from its
   * latest checkpoint, records the move on the new copy and runs the repo's setup there. The
   * old copy stays on its host, superseded.
   */
  continueOn(
    input: { worktreeId: string; toHostId?: string; reason?: ContinueReason } & GateOptions,
  ): Promise<ContinueResult> {
    const running = this.inflight.get(input.worktreeId);
    if (running) return running;
    const run = this.doContinue(input).finally(() => this.inflight.delete(input.worktreeId));
    this.inflight.set(input.worktreeId, run);
    return run;
  }

  private async doContinue(
    input: { worktreeId: string; toHostId?: string; reason?: ContinueReason } & GateOptions,
  ): Promise<ContinueResult> {
    const { worktreeId } = input;
    const at = this.locate(worktreeId);
    if (!at) throw new CheckpointError("invalid", `Unknown worktree "${worktreeId}"`);
    if (!this.isOffline(worktreeId)) {
      throw new CheckpointError(
        "conflict",
        `${hostNamesOf([at.hostId])[0] ?? "unknown host"} is online. Continue on another host only when it is offline; to move the work while it is up, use "Move to host".`,
      );
    }
    const offer = await this.offer(worktreeId, input);
    if (offer.blocked) throw new CheckpointError("invalid", offer.blocked.message);
    const toHostId = input.toHostId ?? offer.targets.find((t) => t.recommended)?.hostId;
    const target = offer.targets.find((t) => t.hostId === toHostId);
    if (!toHostId || !target) {
      throw new CheckpointError(
        "invalid",
        `${toHostId ?? "That host"} cannot take ${worktreeId}: it is offline, not allowed for ${at.repo.name}, or not a worker.`,
      );
    }
    if (!target.agentReady) {
      throw new CheckpointError(
        "invalid",
        `${target.hostName} cannot take ${worktreeId}: ${target.agentProblem ?? "the agent is not available there"}.`,
      );
    }
    const checkpointId = offer.checkpointId as string;
    const checkpointAt = offer.checkpointAt as number;
    const restored = await checkpointService.restore({ worktreeId, toHostId, checkpointId });
    const continuedFrom: ContinuedFrom = {
      fromHostId: at.hostId,
      fromWorktreeId: worktreeId,
      toHostId,
      checkpointId,
      reason: input.reason ?? "manual",
      at: Date.now(),
      checkpointAt,
    };
    this.repos.setContinuedFrom(at.repo.name, at.worktree.name, toHostId, continuedFrom);
    log.info(
      { worktreeId, newId: restored.worktreeId, toHostId, reason: continuedFrom.reason },
      "continued a worktree on another host",
    );
    this.runSetup(restored.worktreeId);
    for (const chatId of restored.chatIds) {
      agentSessionService.broadcastTransient(chatId, {
        type: "notice",
        level: "info",
        text: `${offer.fromHostName} was offline. Continued on ${target.hostName} from the checkpoint taken ${formatAge(Date.now() - checkpointAt)} ago.`,
      });
    }
    return {
      worktreeId: restored.worktreeId,
      hostId: toHostId,
      hostName: target.hostName,
      continuedFrom,
      chatIds: restored.chatIds,
    };
  }

  /** Runs the repo's setup on the new copy, the way a new worktree runs it. Nothing waits on it. */
  private runSetup(worktreeId: string): void {
    try {
      const at = this.locate(worktreeId);
      if (!at) return;
      const repoPath = hostRegistry.repoPathOn(at.repo.name, at.hostId, "");
      worktreeScriptService.startSetup(worktreeId, at.worktree.path, repoPath || at.worktree.path);
    } catch (err) {
      log.warn({ worktreeId, err: errorText(err) }, "could not start setup after a continuation");
    }
  }

  // ---- the original host comes back -----------------------------------------------------

  /** The copy that replaced a superseded worktree, with the record of the continuation. */
  private replacementOf(oldId: string): { located: Located; from: ContinuedFrom } | null {
    const old = this.locate(oldId);
    if (!old?.worktree.supersededBy) return null;
    const next = this.locate(old.worktree.supersededBy);
    const from = next?.worktree.continuedFrom;
    if (!next || !from || from.fromWorktreeId !== oldId) return null;
    return { located: next, from };
  }

  /**
   * Called when a worker connects. Compares each superseded copy it holds with the checkpoint the
   * continuation used, and records whether the copy has changes the continuation did not carry.
   */
  async onHostReturned(hostId: string): Promise<void> {
    for (const repo of this.repos.loadAll()) {
      for (const wt of repo.worktrees) {
        if ((wt.hostId ?? LOCAL_HOST_ID) !== hostId || !wt.supersededBy) continue;
        const oldId = toWorktreeId(repo.name, wt.name, wt.hostId);
        if (wt.divergence?.state === "resolved") continue;
        try {
          await this.compare(oldId);
        } catch (err) {
          log.warn({ oldId, err: errorText(err) }, "could not compare the returned copy");
        }
      }
    }
  }

  /**
   * Builds a snapshot of the old copy's working tree on its host and compares its tree with the
   * checkpoint's. Stores the verdict on the old copy.
   */
  private async compare(oldId: string): Promise<{ divergence: Divergence; files: ChangedFile[] }> {
    const repl = this.replacementOf(oldId);
    const old = this.locate(oldId);
    if (!repl || !old)
      throw new CheckpointError("invalid", `${oldId} was not continued elsewhere.`);
    if (!checkpointService.isHostOnline(old.hostId)) {
      throw new CheckpointError(
        "offline",
        `${hostNamesOf([old.hostId])[0] ?? "unknown host"} is offline.`,
      );
    }
    const row = checkpointService.row(repl.from.checkpointId);
    if (!row) {
      throw new CheckpointError(
        "no-checkpoint",
        `The checkpoint ${repl.from.checkpointId} is gone, so ${oldId} cannot be compared.`,
      );
    }
    const host = hostRegistry.hostById(old.hostId);
    const [root] = (await host.info()).roots;
    if (!root)
      throw new CheckpointError(
        "invalid",
        `${hostNamesOf([old.hostId])[0] ?? "unknown host"} serves no directory.`,
      );
    const snap = await buildSnapshot(
      host,
      old.worktree.path,
      posix.join(root, WIP_DIR),
      oldId,
      `band: compare ${oldId}`,
      true,
    );
    let files: ChangedFile[] = [];
    let state: Divergence["state"] = "clean";
    let count: number | undefined;
    if (snap.treeSha !== row.treeSha) {
      state = "diverged";
      files = await this.changedFiles(old.hostId, old.worktree.path, row.treeSha, snap.treeSha);
      count = files.length > 0 ? files.length : undefined;
    }
    // A person already brought these changes over: the verdict stands until the copy changes again.
    const before = old.worktree.divergence;
    if (before?.state === "resolved" && before.treeSha === snap.treeSha) {
      return { divergence: before, files: [] };
    }
    const divergence: Divergence = {
      state,
      checkedAt: Date.now(),
      treeSha: snap.treeSha,
      checkpointId: row.id,
      ...(count !== undefined ? { files: count } : {}),
    };
    this.repos.setDivergence(old.repo.name, old.worktree.name, old.hostId, divergence);
    return { divergence, files };
  }

  /** The files that differ between two trees on a host, as `git diff` reports them. */
  private async changedFiles(
    hostId: string,
    cwd: string,
    fromTree: string,
    toTree: string,
  ): Promise<ChangedFile[]> {
    const git = gitIn(hostRegistry.hostById(hostId), cwd);
    try {
      const [names, stats] = await Promise.all([
        git(["diff", "--name-status", "-z", "--no-renames", fromTree, toTree]),
        git(["diff", "--numstat", "-z", "--no-renames", fromTree, toTree]),
      ]);
      const counts = new Map<string, { additions: number | null; deletions: number | null }>();
      for (const entry of stats.split("\0").filter(Boolean)) {
        const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
        if (m) {
          counts.set(m[3], {
            additions: m[1] === "-" ? null : Number(m[1]),
            deletions: m[2] === "-" ? null : Number(m[2]),
          });
        }
      }
      const parts = names.split("\0").filter(Boolean);
      const files: ChangedFile[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        files.push({
          path: parts[i + 1],
          status: parts[i],
          ...(counts.get(parts[i + 1]) ?? { additions: null, deletions: null }),
        });
      }
      return files;
    } catch (err) {
      log.warn({ hostId, err: errorText(err) }, "could not list the diverged files");
      return [];
    }
  }

  /** Compares the old copy with the checkpoint now and returns the verdict with the changed files. */
  async divergence(oldId: string): Promise<DivergenceReport> {
    const repl = this.replacementOf(oldId);
    if (!repl) throw new CheckpointError("invalid", `${oldId} was not continued elsewhere.`);
    const old = this.locate(oldId) as Located;
    if (!checkpointService.isHostOnline(old.hostId)) {
      return {
        worktreeId: oldId,
        replacementId: idOf(repl.located),
        state: old.worktree.divergence?.state ?? "clean",
        files: [],
        hostOnline: false,
        checkedAt: old.worktree.divergence?.checkedAt ?? null,
      };
    }
    const { divergence, files } = await this.compare(oldId);
    return {
      worktreeId: oldId,
      replacementId: idOf(repl.located),
      state: divergence.state,
      files,
      hostOnline: true,
      checkedAt: divergence.checkedAt,
    };
  }

  /** The unified diff of one file the old copy changed since the checkpoint. */
  async divergenceDiff(oldId: string, path: string): Promise<{ diff: string }> {
    const repl = this.replacementOf(oldId);
    const old = this.locate(oldId);
    if (!repl || !old)
      throw new CheckpointError("invalid", `${oldId} was not continued elsewhere.`);
    const { fromTree, toTree } = await this.trees(oldId, old, repl.from);
    const host = hostRegistry.hostById(old.hostId);
    const out = await host.exec("git", ["diff", fromTree, toTree, "--", path], {
      cwd: old.worktree.path,
    });
    return { diff: out.stdout };
  }

  private async trees(
    oldId: string,
    old: Located,
    from: ContinuedFrom,
  ): Promise<{ fromTree: string; toTree: string }> {
    if (!checkpointService.isHostOnline(old.hostId)) {
      throw new CheckpointError(
        "offline",
        `${hostNamesOf([old.hostId])[0] ?? "unknown host"} is offline.`,
      );
    }
    const row = checkpointService.row(from.checkpointId);
    if (!row)
      throw new CheckpointError("no-checkpoint", `The checkpoint ${from.checkpointId} is gone.`);
    const host = hostRegistry.hostById(old.hostId);
    const [root] = (await host.info()).roots;
    if (!root)
      throw new CheckpointError(
        "invalid",
        `${hostNamesOf([old.hostId])[0] ?? "unknown host"} serves no directory.`,
      );
    const snap = await buildSnapshot(
      host,
      old.worktree.path,
      posix.join(root, WIP_DIR),
      oldId,
      `band: compare ${oldId}`,
      true,
    );
    return { fromTree: row.treeSha, toTree: snap.treeSha };
  }

  /**
   * Applies what the old copy changed since the checkpoint to the new copy as a patch. A patch
   * that does not apply cleanly changes nothing and comes back with the conflicting files.
   */
  async bringOver(oldId: string): Promise<BringOverResult> {
    const repl = this.replacementOf(oldId);
    const old = this.locate(oldId);
    if (!repl || !old)
      throw new CheckpointError("invalid", `${oldId} was not continued elsewhere.`);
    const next = repl.located;
    const nextId = idOf(next);
    if (!checkpointService.isHostOnline(next.hostId)) {
      throw new CheckpointError(
        "offline",
        `${hostNamesOf([next.hostId])[0]} is offline, so the patch cannot be applied.`,
      );
    }
    const { fromTree, toTree } = await this.trees(oldId, old, repl.from);
    const oldHost = hostRegistry.hostById(old.hostId);
    const patch = (
      await oldHost.exec("git", ["diff", "--binary", "--no-renames", fromTree, toTree], {
        cwd: old.worktree.path,
      })
    ).stdout;
    if (patch.trim() === "") {
      this.markResolved(old, repl.from, toTree);
      return { applied: true, files: 0, conflicts: [] };
    }

    const newHost = hostRegistry.hostById(next.hostId);
    const [root] = (await newHost.info()).roots;
    if (!root)
      throw new CheckpointError(
        "invalid",
        `${hostNamesOf([next.hostId])[0] ?? "unknown host"} serves no directory.`,
      );
    const wipDir = posix.join(root, WIP_DIR);
    await newHost.fs.mkdir(wipDir, { recursive: true });
    const patchFile = posix.join(wipDir, `${nextId}.bring-over.patch`);
    await newHost.fs.writeFile(patchFile, Buffer.from(patch, "utf8"));
    try {
      const git = gitIn(newHost, next.worktree.path);
      try {
        await git(["apply", "--check", patchFile]);
      } catch (err) {
        return { applied: false, files: 0, conflicts: conflictsOf(errorText(err)) };
      }
      await git(["apply", patchFile]);
    } finally {
      await newHost.fs.rm(patchFile, { force: true }).catch(() => undefined);
    }
    const files = (patch.match(/^diff --git /gm) ?? []).length;
    this.markResolved(old, repl.from, toTree);
    void checkpointService.take(nextId, "manual").catch((err) => {
      log.debug({ nextId, err: errorText(err) }, "no checkpoint after bringing changes over");
    });
    return { applied: true, files, conflicts: [] };
  }

  private markResolved(old: Located, from: ContinuedFrom, treeSha: string): void {
    this.repos.setDivergence(old.repo.name, old.worktree.name, old.hostId, {
      state: "resolved",
      checkedAt: Date.now(),
      treeSha,
      checkpointId: from.checkpointId,
    });
  }

  /**
   * "Discard" for a superseded default-branch copy: the folder stays, and the branch goes back to
   * the latest of its remote, with local changes and untracked files dropped. The superseded mark
   * is cleared, because the folder is the repo's checkout again.
   */
  private async resetDefaultBranch(old: Located): Promise<void> {
    const host = hostRegistry.hostById(old.hostId);
    const git = gitIn(host, old.worktree.path);
    const branch = old.repo.defaultBranch;
    // What the folder holds is kept under a backup ref before it is reset.
    const [root] = (await host.info()).roots;
    if (root) {
      const oldId = idOf(old);
      const snap = await buildSnapshot(
        host,
        old.worktree.path,
        posix.join(root, WIP_DIR),
        `${oldId}.discard`,
        `band: backup of ${old.worktree.path} before it is reset`,
        true,
      );
      await git(["update-ref", `refs/band/backup/${oldId}/${Date.now()}`, snap.snapshotSha]);
    }
    await git(["fetch", "origin", branch]).catch(() => undefined);
    const target =
      (await git(["rev-parse", "--verify", "--quiet", `origin/${branch}`]).catch(() => "")) ||
      undefined;
    await git(["checkout", "-q", "-f", "-B", branch, ...(target ? [target] : [])]);
    await git(["reset", "-q", "--hard", ...(target ? [target] : [])]);
    await git(["clean", "-q", "-fd"]);
    this.repos.setSupersededBy(old.repo.name, old.worktree.name, old.hostId, null);
    await workerLeaseService.pushBlockedPaths(old.hostId);
    this.repos.setDivergence(old.repo.name, old.worktree.name, old.hostId, null);
    this.repos.setContinuedFrom(old.repo.name, old.worktree.name, old.hostId, null);
  }

  /**
   * Removes the old copy. Only after `confirm` is true: this deletes files on its host. A host
   * that is offline removes the checkout the next time it connects.
   */
  async discardOld(oldId: string, confirm: boolean, discardChanges = false): Promise<{ ok: true }> {
    if (!confirm) {
      throw new CheckpointError(
        "invalid",
        `Removing ${oldId} deletes its files on the old host. Confirm to go on.`,
      );
    }
    const repl = this.replacementOf(oldId);
    const old = this.locate(oldId);
    if (!repl || !old)
      throw new CheckpointError("invalid", `${oldId} was not continued elsewhere.`);
    // A copy with changes the continuation lacks is refused unless the caller says it accepts losing them.
    if (!discardChanges) {
      let divergence = old.worktree.divergence;
      if (checkpointService.isHostOnline(old.hostId)) {
        divergence = (await this.compare(oldId).catch(() => null))?.divergence ?? divergence;
      }
      if (divergence?.state === "diverged") {
        const count = divergence.files;
        throw new CheckpointError(
          "invalid",
          `${oldId} has changes${count ? ` in ${count} file${count === 1 ? "" : "s"}` : ""} that the continued worktree lacks, and removing it loses them. Bring them over first, or pass discardChanges: true to delete them.`,
        );
      }
    }
    if (old.worktree.name === old.repo.defaultBranch) {
      // The default branch is the repo's own folder, and other worktrees depend on it: reset it.
      await this.resetDefaultBranch(old);
      return { ok: true };
    }
    await worktreeService.remove({
      repo: old.repo.name,
      name: old.worktree.name,
      hostId: old.hostId,
    });
    return { ok: true };
  }
}

const idOf = (at: Located) => toWorktreeId(at.repo.name, at.worktree.name, at.worktree.hostId);

/** The files a failed `git apply --check` names, with its message. */
function conflictsOf(message: string): Array<{ path: string; message: string }> {
  const out = new Map<string, string>();
  for (const line of message.split("\n")) {
    const failed = /patch failed: (.+?):\d+/.exec(line);
    if (failed) out.set(failed[1], "the file changed on the new copy where the patch changes it");
    const other = /^error: (.+?): (.*)$/.exec(line.trim());
    if (other && !other[1].startsWith("patch failed")) out.set(other[1], other[2]);
  }
  if (out.size === 0)
    out.set("(patch)", message.trim().split("\n")[0] ?? "the patch does not apply");
  return [...out].map(([path, msg]) => ({ path, message: msg }));
}

export const followService = new FollowService();
