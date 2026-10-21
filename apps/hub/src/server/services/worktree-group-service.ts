/**
 * Worktree groups: a user-made set of worktrees across repos and hosts, shown together in the
 * sidebar. A worktree is in at most one group (`worktrees.group_id`, written by
 * `RepoQueries.setGroup`). This service owns the groups themselves and the one-time conversion of
 * the old repo labels in `~/.band/settings.json`.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@band-app/logger";
import { WorktreeGroupNotFoundError } from "../errors";
import { SettingsQueries } from "../infra/db/queries/settings";
import { WorktreeGroupQueries, type WorktreeGroupRow } from "../infra/db/queries/worktree-groups";
import { emit } from "../infra/events/status-event-bus";

const log = createLogger("worktree-group-service");

export type WorktreeGroup = Pick<WorktreeGroupRow, "id" | "name" | "color">;

/** The color a group gets when the caller names none. User data, not a theme token. */
export const DEFAULT_GROUP_COLOR = "#6366f1"; // theme-lint-ignore-line: group colors are user data

function toGroup(row: WorktreeGroupRow): WorktreeGroup {
  return { id: row.id, name: row.name, color: row.color };
}

export class WorktreeGroupService {
  constructor(
    private readonly queries: WorktreeGroupQueries = new WorktreeGroupQueries(),
    private readonly settings: SettingsQueries = new SettingsQueries(),
  ) {}

  list(): WorktreeGroup[] {
    return this.queries.list().map(toGroup);
  }

  exists(id: string): boolean {
    return this.queries.find(id) !== undefined;
  }

  /** Throws `WorktreeGroupNotFoundError` for an id that names no group. */
  require(id: string): WorktreeGroup {
    const row = this.queries.find(id);
    if (!row) throw new WorktreeGroupNotFoundError(id);
    return toGroup(row);
  }

  /** Looks a group up by id, else by name ignoring case. Used by the CLI's `--group`. */
  resolve(idOrName: string): WorktreeGroup {
    const rows = this.queries.list();
    const hit =
      rows.find((g) => g.id === idOrName) ??
      rows.find((g) => g.name.toLowerCase() === idOrName.trim().toLowerCase());
    if (!hit) throw new WorktreeGroupNotFoundError(idOrName);
    return toGroup(hit);
  }

  create(input: { name: string; color?: string }): WorktreeGroup {
    const next = this.queries.list().reduce((max, g) => Math.max(max, g.sortOrder + 1), 0);
    const row: WorktreeGroupRow = {
      id: `g-${randomBytes(6).toString("hex")}`,
      name: input.name,
      color: input.color ?? DEFAULT_GROUP_COLOR,
      sortOrder: next,
      createdAt: Date.now(),
    };
    this.queries.insert(row);
    emit({ kind: "worktree-origin-changed", worktreeId: "" });
    return toGroup(row);
  }

  update(id: string, patch: { name?: string; color?: string }): WorktreeGroup {
    this.require(id);
    this.queries.update(id, patch);
    emit({ kind: "worktree-origin-changed", worktreeId: "" });
    return this.require(id);
  }

  /** Deletes the group. Its worktrees stay and show under Ungrouped. */
  remove(id: string): void {
    this.require(id);
    this.queries.remove(id);
    emit({ kind: "worktree-origin-changed", worktreeId: "" });
  }

  reorder(ids: string[]): void {
    for (const id of ids) this.require(id);
    this.queries.reorder(ids);
    emit({ kind: "worktree-origin-changed", worktreeId: "" });
  }

  /**
   * Turns the repo labels of an older install into groups with the same ids, names, colors and
   * order, then drops `labels` from settings.json. The SQL migration already copied each repo's
   * label id into its worktrees' `group_id`. Safe to run on every boot: a group that exists is
   * left alone, no `labels` key means nothing to convert, and ids that name no group are cleared.
   */
  convertLegacyLabels(): void {
    const settings = this.settings.load() as { labels?: unknown };
    const labels = Array.isArray(settings.labels) ? settings.labels : undefined;
    if (labels) {
      const base = this.queries.list().length;
      labels.forEach((raw, i) => {
        const l = raw as { id?: unknown; name?: unknown; color?: unknown };
        if (typeof l?.id !== "string" || typeof l.name !== "string") return;
        this.queries.insert({
          id: l.id,
          name: l.name,
          color: typeof l.color === "string" ? l.color : DEFAULT_GROUP_COLOR,
          sortOrder: base + i,
          createdAt: Date.now(),
        });
      });
    }
    // Only after the labels were read: a settings file that failed to parse loads as `{}`, and
    // clearing then would drop every group id the SQL migration copied from the repo labels.
    if (labels) {
      const cleared = this.queries.clearDangling();
      if (cleared > 0) log.info({ cleared }, "cleared group ids that name no group");
    }
    if (settings.labels !== undefined) this.settings.removeKey("labels");
  }
}

export const worktreeGroupService = new WorktreeGroupService();
