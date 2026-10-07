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
} from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
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

export class ProjectFolderService {
  private readonly states = new Map<string, ProjectFolderState>();
  private readonly inflight = new Map<string, Promise<ProjectFolderState>>();

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
      return state;
    })().finally(() => {
      if (this.inflight.get(row.id) === work) this.inflight.delete(row.id);
    });
    this.inflight.set(row.id, work);
    return work;
  }

  /**
   * Makes sure the project folder exists on `host` with a current copy of the context, and
   * returns it. It makes no repo checkouts, so a task on any host can use it without cloning the
   * project's repos. The state the project page shows is the coordinator host's, so it is not
   * touched here.
   */
  async ensureOn(row: ProjectRow, host: Host): Promise<{ folder: string }> {
    const result = await host.project.ensure({ project: row.name, repos: [], fetch: "never" });
    return { folder: result.folder };
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
