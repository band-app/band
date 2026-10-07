/**
 * The scheduled retro of a project (plan step 6.5).
 *
 * A project's policy holds `retro: { enabled, cron }`, off by default. When it is on, a timer
 * (croner, as the cronjob service uses) starts a run on the schedule. `run` also starts one by hand.
 * A run reads the project context (notes.md, recent learnings and handoffs, the user context's
 * skills) and the project's task groups, then sends them as a prompt to a retro chat in the
 * project folder, like the coordinator's. That chat runs on the reviewer model lane and has one tool,
 * `retro_propose` on the hub's `band-retro` server (`api/mcp-proxy/retro.ts`).
 *
 * The tool stores the proposal in `retro_proposals`: a list of items, each a file edit with a
 * diff and a rationale. Nothing applies until the user decides on an item. Accepting a context
 * edit commits it through `ContextBrowserService.writeMany` (credential scan, compare against the
 * commit the item was proposed on), as the coordinator for notes.md. Accepting an edit to a repo
 * hands it to the dispatch service as a `worktrees_create` call, so it follows the project's
 * policy: pending approval in steer mode, at once in autonomous mode, refused in observe mode.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { Cron } from "croner";
import { ProjectConflictError, ProjectInputError } from "../errors";
import type { ProjectRow } from "../infra/db/queries/projects";
import { RetroProposalQueries, type RetroProposalRow } from "../infra/db/queries/retro-proposals";
import { subscribeChatLifecycle } from "../infra/events/chat-lifecycle-bus";
import { projectScopeId } from "../infra/project-scope";
import { scanForSecrets } from "./_utils/context-redaction";
import { COORDINATOR_LABEL, RETRO_LABEL, RETRO_SERVER } from "./_utils/project-policy";
import {
  type RetroItem,
  type RetroProposeInput,
  type RetroStatus,
  retroProposeInput,
} from "./_utils/retro-items";
import { type RetroFile, renderRetroPrompt, retroCharter } from "./_utils/retro-prompt";
import { unifiedDiff } from "./_utils/unified-diff";
import { chatService } from "./chat-service";
import { contextBrowserService } from "./context-browser-service";
import { contextService, USER_CONTEXT_NAME } from "./context-service";
import { projectDispatchService } from "./project-dispatch-service";
import { projectService } from "./project-service";
import { submitOrQueueTask } from "./task-service";

const log = createLogger("project-retro");

const DEFAULT_AGENT = "claude-code";
const MAX_LEARNINGS = 40;
const MAX_HANDOFFS = 20;
const MAX_USER_FILES = 12;
/** A run that has not proposed by then is marked failed. */
const RUN_TIMEOUT_MS = 30 * 60_000;

export class RetroToolError extends Error {}

export interface RetroProposalView {
  id: string;
  projectId: string;
  createdAt: number;
  status: RetroStatus;
  summary: string | null;
  error: string | null;
  chatId: string | null;
  items: RetroItem[];
}

export interface RetroStatusView {
  enabled: boolean;
  cron: string;
  /** The next scheduled run, or null while the retro is off. */
  nextRunAt: number | null;
  running: boolean;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("\\") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg === ".git")
  );
}

function view(row: RetroProposalRow): RetroProposalView {
  return {
    id: row.id,
    projectId: row.projectId,
    createdAt: row.createdAt,
    status: row.status as RetroStatus,
    summary: row.summary,
    error: row.error,
    chatId: row.chatId,
    items: row.items as RetroItem[],
  };
}

/** One run or decision of a project at a time. */
const lanes = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (lanes.get(key) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  lanes.set(key, tail);
  void tail.then(() => {
    if (lanes.get(key) === tail) lanes.delete(key);
  });
  return next;
}

export class ProjectRetroService {
  private readonly queries = new RetroProposalQueries();
  private readonly timers = new Map<string, Cron>();
  private unsubscribe: (() => void) | null = null;

  // ---- lifecycle ---------------------------------------------------------------------

  /** Schedules every project that has the retro on, and fails runs a restart interrupted. */
  start(): void {
    if (this.unsubscribe) return;
    for (const row of this.queries.withStatus("running")) {
      this.queries.update(row.id, { status: "failed", error: "The hub restarted during the run." });
    }
    this.unsubscribe = subscribeChatLifecycle((event) => {
      if (event.kind === "waiting") return;
      this.onChatEvent(event.chatId, event.kind, event.error);
    });
    for (const row of projectService.rows()) this.reschedule(row.id);
    log.info({ scheduled: this.timers.size }, "retro scheduler started");
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
  }

  /** Re-reads the project's policy: starts, moves or stops its timer. */
  reschedule(projectId: string): void {
    this.timers.get(projectId)?.stop();
    this.timers.delete(projectId);
    const row = projectService.find(projectId);
    if (!row) return;
    const { retro } = projectService.get(row.id).effectivePolicy;
    if (!retro.enabled) return;
    try {
      this.timers.set(
        projectId,
        new Cron(retro.cron, () => {
          void this.run(projectId).catch((err) => {
            log.warn({ projectId, err }, "scheduled retro did not start");
          });
        }),
      );
    } catch (err) {
      log.error({ projectId, cron: retro.cron, err }, "invalid retro schedule, not scheduled");
    }
  }

  unschedule(projectId: string): void {
    this.timers.get(projectId)?.stop();
    this.timers.delete(projectId);
  }

  status(ref: string): RetroStatusView {
    const row = projectService.row(ref);
    const { retro } = projectService.get(row.id).effectivePolicy;
    const next = this.timers.get(row.id)?.nextRun();
    return {
      enabled: retro.enabled,
      cron: retro.cron,
      nextRunAt: retro.enabled && next ? next.getTime() : null,
      running: this.expire(this.queries.listOf(row.id, 1)).some((p) => p.status === "running"),
    };
  }

  // ---- the run -----------------------------------------------------------------------

  /** Starts a retro now. Refused while one is running, or when the project has no coordinator. */
  run(ref: string): Promise<RetroProposalView> {
    const row = projectService.row(ref);
    return serialized(`run:${row.id}`, () => this.runNow(row));
  }

  private async runNow(row: ProjectRow): Promise<RetroProposalView> {
    if (this.expire(this.queries.listOf(row.id, 1)).some((p) => p.status === "running")) {
      throw new ProjectConflictError(`A retro of project "${row.name}" is already running.`);
    }
    if (!row.coordinatorChatId) {
      throw new ProjectInputError(
        `Project "${row.name}" has no coordinator yet. Add a repo to the project first.`,
      );
    }
    const scope = projectScopeId(row.id);
    const prompt = renderRetroPrompt(await this.gather(row));
    const policy = projectService.get(row.id).effectivePolicy;
    // Each run starts a clean chat, so an old run's context does not carry over.
    for (const old of chatService.listForProject(row.id)) {
      if (old.labels[RETRO_LABEL] === row.id) chatService.remove(old.id);
    }
    const chat = chatService.createForProject(row.id, {
      name: "Retro",
      agent: row.coordinatorAgent ?? DEFAULT_AGENT,
      model: policy.models.reviewer,
      labels: { [RETRO_LABEL]: row.id },
      allowReservedLabels: true,
    });
    const proposal: RetroProposalRow = {
      id: newId("rp"),
      projectId: row.id,
      createdAt: Date.now(),
      status: "running",
      summary: null,
      error: null,
      chatId: chat.id,
      items: [],
    };
    this.queries.insert(proposal);
    try {
      submitOrQueueTask({ worktreeId: scope, chatId: chat.id, prompt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.queries.update(proposal.id, { status: "failed", error: message });
      throw err;
    }
    log.info({ projectId: row.id, proposalId: proposal.id }, "retro started");
    return view(proposal);
  }

  /** What the agent reads: notes, recent learnings and handoffs, the user's skills, task groups. */
  private async gather(row: ProjectRow) {
    const read = async (context: string, path: string): Promise<RetroFile | null> => {
      try {
        const f = await contextBrowserService.file(context, path);
        return f.binary ? null : { path, content: f.content };
      } catch {
        return null;
      }
    };
    const filesUnder = async (context: string, prefix: string, limit: number, skip?: string) => {
      const { entries } = await contextBrowserService.tree(context);
      const paths = entries
        .map((e) => e.path)
        .filter(
          (p) => p.startsWith(prefix) && !p.endsWith(".gitkeep") && !(skip && p.startsWith(skip)),
        )
        .sort()
        .reverse()
        .slice(0, limit);
      const out: RetroFile[] = [];
      for (const path of paths) {
        const f = await read(context, path);
        if (f) out.push(f);
      }
      return out;
    };
    const view = projectService.get(row.id);
    const userContext = contextService.find(USER_CONTEXT_NAME) !== undefined;
    const groups = projectDispatchService.groupsOf(row).map((g) => ({
      title: g.title,
      branch: g.branch,
      members: g.members.map((m) => ({
        repo: m.repo,
        pr: m.prNumber ? `PR #${m.prNumber}` : "no PR yet",
      })),
    }));
    return {
      project: view.name,
      repos: view.repos.map((r) => r.repo),
      notes: await read(row.contextName, "notes.md"),
      learnings: await filesUnder(
        row.contextName,
        "learnings/",
        MAX_LEARNINGS,
        "learnings/archive/",
      ),
      handoffs: await filesUnder(row.contextName, "handoffs/", MAX_HANDOFFS),
      groups,
      userFiles: userContext ? await filesUnder(USER_CONTEXT_NAME, "skills/", MAX_USER_FILES) : [],
      userContext,
    };
  }

  /** Fails runs that have waited past the timeout. Returns the rows as they stand. */
  private expire(rows: RetroProposalRow[]): RetroProposalRow[] {
    return rows.map((r) => {
      if (r.status === "running" && Date.now() - r.createdAt > RUN_TIMEOUT_MS) {
        const error = "The retro agent did not propose anything in time.";
        this.queries.update(r.id, { status: "failed", error });
        return { ...r, status: "failed", error };
      }
      return r;
    });
  }

  private onChatEvent(chatId: string, kind: "failed" | "finished", error?: string): void {
    const chat = chatService.get(chatId);
    if (!chat?.labels[RETRO_LABEL]) return;
    const running = this.queries
      .listOf(chat.labels[RETRO_LABEL] as string, 5)
      .find((p) => p.chatId === chatId && p.status === "running");
    if (!running) return;
    this.queries.update(running.id, {
      status: "failed",
      error:
        kind === "failed"
          ? (error ?? "The retro agent failed.")
          : "The retro agent finished without calling retro_propose.",
    });
  }

  // ---- the tool ----------------------------------------------------------------------

  /** The project a retro chat belongs to, or undefined for any other chat. */
  projectOfChat(chatId: string): ProjectRow | undefined {
    const chat = chatService.get(chatId);
    const id = chat?.labels[RETRO_LABEL];
    if (!id || chat?.labels[COORDINATOR_LABEL]) return undefined;
    return projectService.find(id);
  }

  charter(row: ProjectRow): string {
    return `${retroCharter(row.name)}\n\nYour tools are on the ${RETRO_SERVER} server.`;
  }

  /** The `retro_propose` call: checks the items, computes their diffs and stores them. */
  async propose(row: ProjectRow, chatId: string, raw: unknown): Promise<{ stored: number }> {
    const parsed = retroProposeInput.safeParse(raw);
    if (!parsed.success) {
      throw new RetroToolError(
        `Invalid retro_propose call: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
      );
    }
    const input = parsed.data;
    const proposal = this.queries
      .listOf(row.id, 5)
      .find((p) => p.chatId === chatId && p.status === "running");
    if (!proposal) {
      throw new RetroToolError(
        "No retro is waiting for a proposal from this chat. It was already stored, or it timed out.",
      );
    }
    for (const text of [input.summary ?? "", ...input.items.map((i) => i.rationale)]) {
      if (scanForSecrets(text).length > 0) {
        throw new RetroToolError("A summary or rationale looks like it holds a credential.");
      }
    }
    const items: RetroItem[] = [];
    for (const [index, raw] of input.items.entries()) {
      items.push(await this.prepare(row, raw, `i${index + 1}`));
    }
    this.queries.update(proposal.id, {
      status: items.length === 0 ? "reviewed" : "pending",
      summary: input.summary?.trim() || null,
      items,
    });
    log.info({ projectId: row.id, proposalId: proposal.id, items: items.length }, "retro proposed");
    return { stored: items.length };
  }

  private contextOf(row: ProjectRow, target: string): string {
    return target === "user-context" ? USER_CONTEXT_NAME : row.contextName;
  }

  private async prepare(
    row: ProjectRow,
    raw: RetroProposeInput["items"][number],
    id: string,
  ): Promise<RetroItem> {
    const where = `Item ${id} (${raw.path})`;
    if (!validPath(raw.path)) throw new RetroToolError(`${where}: not a valid path.`);
    const base: RetroItem = { ...raw, id, diff: "", base: null, status: "pending" };
    if (raw.target === "repo") {
      if (!raw.repo) throw new RetroToolError(`${where}: target repo needs repo.`);
      if (!raw.change) throw new RetroToolError(`${where}: target repo needs change.`);
      if (raw.content !== undefined || raw.moveTo) {
        throw new RetroToolError(`${where}: target repo takes change, not content or moveTo.`);
      }
      if (!projectService.get(row.id).repos.some((r) => r.repo === raw.repo)) {
        throw new RetroToolError(`${where}: repo "${raw.repo}" is not in project "${row.name}".`);
      }
      if (scanForSecrets(raw.change).length > 0) {
        throw new RetroToolError(`${where}: the change looks like it holds a credential.`);
      }
      return { ...base, diff: raw.change };
    }
    if (raw.repo || raw.change) {
      throw new RetroToolError(
        `${where}: a context target takes content or moveTo, not repo or change.`,
      );
    }
    if ((raw.content === undefined) === (raw.moveTo === undefined)) {
      throw new RetroToolError(`${where}: pass exactly one of content (null deletes) or moveTo.`);
    }
    const context = this.contextOf(row, raw.target);
    if (!contextService.find(context)) {
      throw new RetroToolError(`${where}: there is no ${raw.target} to edit.`);
    }
    if (
      raw.target === "user-context" &&
      raw.path !== "preferences.md" &&
      !raw.path.startsWith("skills/")
    ) {
      throw new RetroToolError(`${where}: the user context takes only preferences.md and skills/.`);
    }
    const { head } = await contextBrowserService.tree(context);
    let before: string | null = null;
    try {
      const f = await contextBrowserService.file(context, raw.path);
      if (f.binary) throw new RetroToolError(`${where}: a binary file cannot be edited.`);
      before = f.content;
    } catch (err) {
      if (err instanceof RetroToolError) throw err;
    }
    if (raw.moveTo !== undefined) {
      if (before === null) throw new RetroToolError(`${where}: the file does not exist.`);
      if (
        !raw.path.startsWith("learnings/") ||
        raw.path.startsWith("learnings/archive/") ||
        !raw.moveTo.startsWith("learnings/archive/") ||
        !validPath(raw.moveTo)
      ) {
        throw new RetroToolError(
          `${where}: moveTo archives a file of learnings/ into learnings/archive/.`,
        );
      }
      let taken = true;
      try {
        await contextBrowserService.file(context, raw.moveTo);
      } catch {
        taken = false;
      }
      if (taken) throw new RetroToolError(`${where}: ${raw.moveTo} already exists.`);
      return { ...base, base: head, diff: `rename from ${raw.path}\nrename to ${raw.moveTo}` };
    }
    if (raw.content === null) {
      if (before === null) throw new RetroToolError(`${where}: the file does not exist.`);
      return { ...base, base: head, diff: unifiedDiff(raw.path, before, "") };
    }
    const content = raw.content as string;
    if (scanForSecrets(content).length > 0) {
      throw new RetroToolError(`${where}: the content looks like it holds a credential.`);
    }
    const diff = unifiedDiff(raw.path, before ?? "", content);
    if (!diff) throw new RetroToolError(`${where}: the content equals the current file.`);
    return { ...base, base: head, diff };
  }

  // ---- review ------------------------------------------------------------------------

  list(ref: string, limit = 10): RetroProposalView[] {
    const row = projectService.row(ref);
    return this.expire(this.queries.listOf(row.id, Math.min(Math.max(limit, 1), 50))).map(view);
  }

  /** Accepts or rejects one item. A failed accept leaves the item `failed`, and the user can try again. */
  decide(
    proposalId: string,
    itemId: string,
    decision: "accept" | "reject",
  ): Promise<RetroProposalView> {
    const found = this.queries.find(proposalId);
    if (!found) throw new ProjectInputError(`No retro proposal "${proposalId}"`);
    return serialized(`decide:${proposalId}`, () => this.decideNow(proposalId, itemId, decision));
  }

  private async decideNow(
    proposalId: string,
    itemId: string,
    decision: "accept" | "reject",
  ): Promise<RetroProposalView> {
    const proposal = this.queries.find(proposalId);
    if (!proposal) throw new ProjectInputError(`No retro proposal "${proposalId}"`);
    const items = proposal.items as RetroItem[];
    const index = items.findIndex((i) => i.id === itemId);
    const item = items[index];
    if (!item) throw new ProjectInputError(`No item "${itemId}" in proposal ${proposalId}`);
    if (item.status === "accepted" || item.status === "rejected") {
      throw new ProjectInputError(`Item ${itemId} was already ${item.status}.`);
    }
    const row = projectService.row(proposal.projectId);
    let next: RetroItem;
    if (decision === "reject") {
      const { error: _error, ...rest } = item;
      next = { ...rest, status: "rejected" };
    } else {
      try {
        const result = await this.apply(row, proposal.id, item);
        const { error: _error, ...rest } = item;
        next = { ...rest, status: "accepted", result };
      } catch (err) {
        next = {
          ...item,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const updated = items.map((i, n) => (n === index ? next : i));
    const open = updated.some((i) => i.status === "pending" || i.status === "failed");
    this.queries.update(proposal.id, { items: updated, status: open ? "pending" : "reviewed" });
    return view({ ...proposal, items: updated, status: open ? "pending" : "reviewed" });
  }

  private async apply(
    row: ProjectRow,
    proposalId: string,
    item: RetroItem,
  ): Promise<NonNullable<RetroItem["result"]>> {
    if (item.target === "repo") {
      const repo = item.repo as string;
      const suffix = proposalId.replace(/^rp-/, "");
      const outcome = await projectDispatchService.dispatch(row, {
        repo,
        branch: `retro-${suffix}-${item.id}-${newId("a").slice(-4)}`,
        title: `Retro: ${item.path}`,
        brief: [
          `A retro of project "${row.name}" proposed this edit to \`${item.path}\` in repo ${repo}, and the user accepted it.`,
          `## Why\n\n${item.rationale}`,
          `## Change\n\n${item.change}`,
          "Make exactly this change, run the repo's checks, and open a pull request.",
        ].join("\n\n"),
        scenarios: [
          `\`${item.path}\` has the change described in the brief and nothing else changed.`,
        ],
      });
      if (outcome.status === "pending approval") {
        return { dispatch: "pending approval", requestId: outcome.requestId };
      }
      return { dispatch: "dispatched", worktreeIds: outcome.worktrees.map((w) => w.worktreeId) };
    }
    const context = this.contextOf(row, item.target);
    const changes =
      item.moveTo !== undefined
        ? await this.moveChanges(context, item)
        : [{ path: item.path, content: item.content ?? null }];
    const first = item.rationale.split("\n")[0]?.trim() ?? "";
    const message = `retro: ${first.slice(0, 150) || item.path}`;
    const saved = await contextBrowserService.writeMany(context, changes, message, {
      ...(item.base ? { base: item.base, guard: item.path } : {}),
      author: item.path === "notes.md" ? "coordinator" : "retro",
    });
    return { commit: saved.commit };
  }

  private async moveChanges(context: string, item: RetroItem) {
    const f = await contextBrowserService.file(context, item.path);
    if (f.binary) throw new ProjectInputError(`"${item.path}" is a binary file.`);
    const { entries } = await contextBrowserService.tree(context);
    if (entries.some((e) => e.path === item.moveTo)) {
      throw new ProjectInputError(`"${item.moveTo}" exists already.`);
    }
    return [
      { path: item.moveTo as string, content: f.content },
      { path: item.path, content: null },
    ];
  }
}

export const projectRetroService = new ProjectRetroService();
