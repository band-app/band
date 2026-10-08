/**
 * The project folder on the coordinator host (plan step T.1).
 *
 * Every project has a folder on its coordinator host: the working copy of its context repo with
 * a checkout of each git repo's default branch under `repos/<repo>/`. The host does the git work
 * (`host.project`). This service names the repos' clones on that host, remembers the state the
 * host reported so the project page and the coordinator's tools can show it, and fetches when a
 * member pull request merges.
 *
 * A repo's clone on a host comes from the existing way to find one (`hostRegistry.repoPathOn`):
 * the repo's own path on the local host, and the `repo_hosts` row on a worker.
 */

import type {
  Host,
  ProjectCheckout,
  ProjectCommit,
  ProjectEnsureResult,
  ProjectReadResult,
  ProjectSearchMatch,
  ProjectStatus,
} from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { ProjectInputError } from "../errors";
import type { ProjectRow } from "../infra/db/queries/projects";
import { hostRegistry } from "../infra/host/registry";
import { projectService } from "./project-service";
import { loadState } from "./state";

const log = createLogger("project-folder");

export type FetchMode = "throttled" | "force" | "never";

/** What the host last reported about a project's folder, with when and why a repo has none. */
export interface ProjectFolderState {
  hostId: string;
  folder: string;
  checkedAt: number;
  context: ProjectEnsureResult["context"];
  checkouts: ProjectCheckout[];
  /** Repos of the project that cannot have a checkout on this host, with the reason. */
  skipped: Array<{ repo: string; reason: string }>;
}

/** The agent instructions file in a project folder, and the Claude Code file that imports it. */
export const INSTRUCTIONS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";
const CLAUDE_TEXT = `<!-- Written by Band. Claude Code reads this file; it imports the project's instructions. -->\n@${INSTRUCTIONS_FILE}\n`;

export class ProjectFolderService {
  private readonly states = new Map<string, ProjectFolderState>();
  private readonly inflight = new Map<string, Promise<ProjectFolderState>>();
  /** The coordinator's charter of a project. Set by `ProjectCoordinatorService`, which imports this file. */
  private instructionsOf: ((row: ProjectRow) => string) | null = null;

  setInstructions(fn: (row: ProjectRow) => string): void {
    this.instructionsOf = fn;
  }

  /**
   * Writes the project's agent instructions into its folder: `AGENTS.md` holds the coordinator's
   * charter (Codex, OpenCode and most agents read it) and `CLAUDE.md` imports it for Claude Code. So
   * any agent started in the folder, in a chat or a terminal, works from the same text. Band
   * rewrites both whenever the folder is prepared or the project changes, and the context sync
   * leaves them out, so each host keeps its own copy and an edit never spreads. A file is only
   * written when its text changed. Never throws.
   */
  async writeInstructions(row: ProjectRow, folder?: string): Promise<void> {
    const charter = this.instructionsOf?.(row);
    const dir = folder ?? this.states.get(row.id)?.folder;
    if (!charter || !dir) return;
    const host = this.hostOf(row);
    // Placeholders such as `repos/<repo>/` would read as HTML tags in a markdown view, so each path
    // that holds one goes in a code span. An agent reads the same words either way.
    const body = charter.replace(/(?<![`\w])([\w./-]*<[\w-]+>[\w./<>-]*)/g, "`$1`");
    const agents = `<!-- Written by Band from the project's settings, repos and policy. Edits are overwritten: change the project in Settings > Projects instead. -->\n\n${body}\n`;
    for (const [name, text] of [
      [INSTRUCTIONS_FILE, agents],
      [CLAUDE_FILE, CLAUDE_TEXT],
    ] as const) {
      const path = `${dir.replace(/\/+$/, "")}/${name}`;
      try {
        const current = await host.fs
          .readFile(path)
          .then((b) => new TextDecoder().decode(b))
          .catch(() => null);
        if (current !== text) await host.fs.writeFile(path, text);
      } catch (err) {
        log.warn(
          { project: row.name, file: name, err },
          "could not write the project's agent instructions",
        );
      }
    }
  }
  /** `project:host` folders a view prepared without checkouts, so the next view asks nothing. */
  private readonly prepared = new Set<string>();

  /** The host the project's folder is on. */
  hostOf(row: ProjectRow): Host {
    return hostRegistry.hostById(row.coordinatorHostId ?? hostRegistry.local.id);
  }

  /**
   * The project's git repos with their clone on `host`, and the repos that have none. A repo with a
   * remote URL goes through `host.repos.ensure`: the folder the host maps for the URL while it
   * exists, else a fresh clone in the host's default location. A repo with no remote can only use
   * a folder the hub already knows on that host.
   */
  private async reposOn(row: ProjectRow, host: Host) {
    const state = loadState();
    const specs: Array<{ name: string; clonePath: string; defaultBranch: string }> = [];
    const skipped: ProjectFolderState["skipped"] = [];
    for (const { repo } of projectService.get(row.id).repos) {
      const entry = state.repos.find((r) => r.name === repo);
      if (!entry) {
        skipped.push({ repo, reason: "the repo is not registered" });
        continue;
      }
      if (entry.kind === "plain") {
        skipped.push({ repo, reason: "a plain folder has no default branch to check out" });
        continue;
      }
      let clonePath: string | null = null;
      if (entry.remoteUrl) {
        try {
          clonePath = (
            await host.repos.ensure({
              remoteUrl: entry.remoteUrl,
              defaultBranch: entry.defaultBranch,
            })
          ).path;
          hostRegistry.setRepoPathOn(entry.name, host.id, clonePath);
        } catch (err) {
          skipped.push({
            repo,
            reason: `host "${host.id}" could not provide a clone: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
      } else {
        clonePath = hostRegistry.repoPathOn(entry.name, host.id, entry.path) || null;
      }
      if (!clonePath) {
        skipped.push({
          repo,
          reason: `the repo has no remote URL and no checkout on host "${host.id}"`,
        });
        continue;
      }
      specs.push({ name: entry.name, clonePath, defaultBranch: entry.defaultBranch });
    }
    return { specs, skipped };
  }

  /**
   * Brings the folder up to date: pulls the context, creates missing checkouts and
   * fast-forwards the clean ones. Calls for one project share a running ensure.
   */
  async ensure(row: ProjectRow, fetch: FetchMode = "throttled"): Promise<ProjectFolderState> {
    const running = this.inflight.get(row.id);
    if (running && fetch !== "force") return running;
    const work = (async () => {
      const host = this.hostOf(row);
      const { specs, skipped } = await this.reposOn(row, host);
      const result = await host.project.ensure({ project: row.name, repos: specs, fetch });
      const state: ProjectFolderState = {
        hostId: host.id,
        folder: result.folder,
        checkedAt: Date.now(),
        context: result.context,
        checkouts: result.checkouts,
        skipped,
      };
      this.states.set(row.id, state);
      await this.writeInstructions(row, state.folder);
      return state;
    })().finally(() => {
      if (this.inflight.get(row.id) === work) this.inflight.delete(row.id);
    });
    this.inflight.set(row.id, work);
    return work;
  }

  /**
   * Makes sure the project folder exists on `host` with a current copy of the context, and
   * returns it. It makes no repo checkouts, so a worktree agent on any host can use it without
   * cloning the project's repos. The state the project's view shows is the coordinator host's, so it is not
   * touched here.
   */
  async ensureOn(row: ProjectRow, host: Host): Promise<{ folder: string }> {
    const result = await host.project.ensure({ project: row.name, repos: [], fetch: "never" });
    return { folder: result.folder };
  }

  /**
   * Makes sure the folder exists on the coordinator host, for the project's view. A folder already
   * prepared on that host answers from memory. Otherwise `checkouts` makes the repo checkouts too
   * (which can clone), and without it only the folder and its context are made and the answer is
   * null until something prepares the checkouts.
   */
  async prepare(row: ProjectRow, opts: { checkouts: boolean }): Promise<ProjectFolderState | null> {
    const host = this.hostOf(row);
    const known = this.states.get(row.id);
    if (known?.hostId === host.id) return known;
    if (opts.checkouts) return this.ensure(row, "never");
    const key = `${row.id}:${host.id}`;
    if (!this.prepared.has(key)) {
      await this.ensureOn(row, host);
      this.prepared.add(key);
    }
    return null;
  }

  /**
   * Ensures every project's folder on its coordinator host once, without fetching, so a project's
   * view resolves its files after a hub restart. A host that is offline is skipped and logged; the
   * view or the next coordinator turn ensures it later. Never throws.
   */
  async warmAll(): Promise<void> {
    for (const row of projectService.rows()) {
      await this.ensure(row, "never").catch((err) =>
        log.warn({ project: row.name, err }, "could not prepare the project folder"),
      );
    }
  }

  /** The project folder on its host: the last known one, else the folder after a first ensure. */
  async folder(row: ProjectRow): Promise<string> {
    return this.states.get(row.id)?.folder ?? (await this.ensure(row, "never")).folder;
  }

  /** The state of the last ensure, or undefined before the first. */
  state(projectId: string): ProjectFolderState | undefined {
    return this.states.get(projectId);
  }

  forget(projectId: string): void {
    this.states.delete(projectId);
    for (const key of this.prepared) if (key.startsWith(`${projectId}:`)) this.prepared.delete(key);
  }

  /** Fetches after a member pull request merged. Never throws. */
  refreshAfterMerge(row: ProjectRow): void {
    if (!row.coordinatorChatId) return;
    void this.ensure(row, "force").catch((err) => {
      log.warn({ projectId: row.id, err }, "could not refresh the project checkouts after a merge");
    });
  }

  /** Whether the project has a git repo of that name. Throws a refusal naming the repos it has. */
  private requireRepo(row: ProjectRow, repo: string): void {
    const names = projectService.get(row.id).repos.map((r) => r.repo);
    if (!names.includes(repo)) {
      throw new ProjectInputError(
        `Repo "${repo}" is not in project "${row.name}". Its repos: ${names.join(", ") || "none"}.`,
      );
    }
  }

  async read(row: ProjectRow, repo: string, path: string): Promise<ProjectReadResult> {
    this.requireRepo(row, repo);
    return this.hostOf(row).project.read({ project: row.name, repo, path });
  }

  async search(row: ProjectRow, repo: string, query: string): Promise<ProjectSearchMatch[]> {
    this.requireRepo(row, repo);
    return this.hostOf(row).project.search({ project: row.name, repo, query });
  }

  async log(row: ProjectRow, repo: string, n: number): Promise<ProjectCommit[]> {
    this.requireRepo(row, repo);
    return this.hostOf(row).project.log({ project: row.name, repo, n });
  }

  async status(row: ProjectRow, repo: string): Promise<ProjectStatus> {
    this.requireRepo(row, repo);
    return this.hostOf(row).project.status({ project: row.name, repo });
  }

  async diff(
    row: ProjectRow,
    repo: string,
    target: { kind: "working" } | { kind: "commit"; sha: string },
    path?: string,
  ) {
    this.requireRepo(row, repo);
    return this.hostOf(row).project.diff({ project: row.name, repo, target, path });
  }

  async commit(row: ProjectRow, repo: string, message: string, paths?: string[]) {
    this.requireRepo(row, repo);
    const result = await this.hostOf(row).project.commit({
      project: row.name,
      repo,
      message,
      paths,
    });
    await this.refreshState(row);
    return result;
  }

  async push(row: ProjectRow, repo: string) {
    this.requireRepo(row, repo);
    const result = await this.hostOf(row).project.push({ project: row.name, repo });
    await this.refreshState(row);
    return result;
  }

  async pull(row: ProjectRow, repo: string) {
    this.requireRepo(row, repo);
    const result = await this.hostOf(row).project.pull({ project: row.name, repo });
    await this.refreshState(row);
    return result;
  }

  /** Re-reads the checkouts' ahead, behind and dirty state without fetching, so the folder section follows a write. */
  private async refreshState(row: ProjectRow): Promise<void> {
    await this.ensure(row, "never").catch((err) => {
      log.warn({ projectId: row.id, err }, "could not re-read the project checkouts");
    });
  }

  /** The project's worktrees of one repo with their pull request. Their diffs come from the worktree Changes calls. */
  openWork(row: ProjectRow, repo: string) {
    this.requireRepo(row, repo);
    return projectService
      .workersOf(row)
      .filter((w) => w.repoName === repo)
      .map((w) => {
        const worktreeId = toWorktreeId(w.repoName, w.name);
        const status = projectService.branchStatus(worktreeId);
        return {
          worktreeId,
          name: w.name,
          branch: w.branch,
          hostId: w.hostId ?? null,
          ciState: status?.ciState ?? null,
          pr: status?.ciPr ?? null,
        };
      });
  }

  /** Creates the checkout of a repo that joined the project, when the project has a folder already. */
  async addRepo(row: ProjectRow): Promise<void> {
    if (!row.coordinatorChatId) return;
    await this.ensure(row, "throttled");
  }

  /**
   * Removes a repo's checkout from the project folder. Rejects while the checkout has
   * uncommitted changes or unpushed commits. A project that never got a folder has nothing to remove.
   */
  async removeRepo(row: ProjectRow, repo: string): Promise<void> {
    const host = this.hostOf(row);
    const entry = loadState().repos.find((r) => r.name === repo);
    const clonePath = entry ? hostRegistry.repoPathOn(entry.name, host.id, entry.path) : null;
    // The checkout is only there when a clone was found for this host, so an unknown clone has nothing to remove.
    if (!entry || !clonePath || entry.kind === "plain") return;
    await host.project.removeRepo({ project: row.name, repo, clonePath });
    const state = this.states.get(row.id);
    if (state) {
      this.states.set(row.id, {
        ...state,
        checkouts: state.checkouts.filter((c) => c.repo !== repo),
      });
    }
  }
}

export const projectFolderService = new ProjectFolderService();
