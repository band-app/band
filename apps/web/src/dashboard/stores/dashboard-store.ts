import type { GitOpResult } from "@band-app/shared/git-op-result";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { DashboardAdapter } from "../adapter";
import type {
  CIStatus,
  GitStatus,
  SetupStatus,
  WorktreeBranchStatus,
  WorktreeStatus,
} from "../types";

/**
 * A message shown in the bottom-right toast stack. `info` is an expected
 * outcome the user should know about (a pull git refused because of local
 * changes) and closes itself; `error` is a failure and stays until closed.
 */
export interface Notice {
  id: number;
  tone: "info" | "error";
  message: string;
}

/** How long an `info` notice stays on screen. */
export const INFO_NOTICE_MS = 6000;
/** The most notices shown at once; a new one pushes out the oldest. */
const MAX_NOTICES = 3;

/**
 * The text to show for a thrown value: an `Error`'s own message, so a tRPC
 * failure reads as the server's message instead of "TRPCClientError: …".
 */
export function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.trim() || "Something went wrong.";
}

export interface DashboardState {
  statuses: Map<string, WorktreeStatus>;
  activeWorktreeId: string | null;
  notices: Notice[];
  branchStatuses: Map<string, WorktreeBranchStatus>;
  setupStatuses: Map<string, SetupStatus>;
  /** Worktrees this dashboard asked the server to remove, until the removal settles. */
  deletingWorktrees: ReadonlySet<string>;

  openWorktree: (worktreeId: string) => void;
  clearNeedsAttention: (worktreeId: string) => void;
  /** Ask the server to re-read the worktree's git status now (badge refresh). */
  refreshBranchStatus: (worktreeId: string) => void;
  /** Show `err` as an error notice. */
  setError: (err: unknown) => void;
  notify: (tone: Notice["tone"], message: string) => void;
  dismissNotice: (id: number) => void;
  replaceAllStatuses: (statuses: WorktreeStatus[]) => void;
  updateStatus: (status: WorktreeStatus) => void;
  removeStatus: (worktreeId: string) => void;
  setActiveWorktree: (worktreeId: string | null) => void;
  runScript: (path: string, scriptType: string) => Promise<void>;
  gitPull: (repo: string, name: string, hostId?: string) => Promise<void>;
  gitPush: (repo: string, name: string, hostId?: string) => Promise<void>;
  updateGitStatus: (worktreeId: string, git: GitStatus) => void;
  updateCIStatus: (worktreeId: string, ci: CIStatus) => void;
  updateSetupStatus: (worktreeId: string, status: SetupStatus) => void;
  removeSetupStatus: (worktreeId: string) => void;
  reconcileSetupStatuses: (runningSetups: string[]) => void;
  setDeleting: (worktreeId: string, deleting: boolean) => void;
}

export type DashboardStore = UseBoundStore<StoreApi<DashboardState>>;

/**
 * Whether a worktree is being deleted: from the moment this dashboard sends
 * the removal, or while the server runs its teardown (which also covers a
 * removal started from the CLI or another window).
 */
export function isWorktreeDeleting(
  state: Pick<DashboardState, "deletingWorktrees" | "setupStatuses">,
  worktreeId: string,
): boolean {
  if (state.deletingWorktrees.has(worktreeId)) return true;
  const setup = state.setupStatuses.get(worktreeId);
  return setup?.script === "teardown" && setup.state === "running";
}

/** Show a git refusal (local changes, nothing to push onto) as an info notice. */
function reportRefusal(result: GitOpResult, notify: DashboardState["notify"]): void {
  if (!result.ok) notify("info", result.message);
}

export function createDashboardStore(adapter: DashboardAdapter): DashboardStore {
  let nextNoticeId = 1;

  return create<DashboardState>((set, get) => ({
    statuses: new Map(),
    branchStatuses: new Map(),
    setupStatuses: new Map(),
    deletingWorktrees: new Set(),
    activeWorktreeId: null,
    notices: [],

    openWorktree: (worktreeId: string) => {
      set({ activeWorktreeId: worktreeId });
      get().clearNeedsAttention(worktreeId);
    },

    clearNeedsAttention: (worktreeId: string) => {
      adapter.clearNeedsAttention?.(worktreeId).catch(() => {});
    },

    refreshBranchStatus: (worktreeId: string) => {
      adapter.refreshBranchStatus?.(worktreeId).catch(() => {});
    },

    setError: (err: unknown) => get().notify("error", describeError(err)),

    notify: (tone: Notice["tone"], message: string) => {
      const notice = { id: nextNoticeId++, tone, message };
      set((state) => ({ notices: [...state.notices, notice].slice(-MAX_NOTICES) }));
    },

    dismissNotice: (id: number) => {
      set((state) => ({ notices: state.notices.filter((n) => n.id !== id) }));
    },

    replaceAllStatuses: (list: WorktreeStatus[]) => {
      const statuses = new Map(list.map((s) => [s.worktreeId, s]));
      set({ statuses });
    },

    updateStatus: (status: WorktreeStatus) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.set(status.worktreeId, status);
        return { statuses };
      });
    },

    removeStatus: (worktreeId: string) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.delete(worktreeId);
        // The worktree is gone, so its teardown status goes with it. A new
        // worktree created under the same name must not start as deleting.
        if (!state.setupStatuses.has(worktreeId)) return { statuses };
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.delete(worktreeId);
        return { statuses, setupStatuses };
      });
    },

    setActiveWorktree: (worktreeId: string | null) => {
      if (get().activeWorktreeId === worktreeId) return;
      set({ activeWorktreeId: worktreeId });
      // When the user navigates to a worktree, clear any pending
      // needs-attention indicator — they're now looking at it.
      if (worktreeId) {
        get().clearNeedsAttention(worktreeId);
      }
    },

    runScript: async (path: string, scriptType: string) => {
      try {
        await adapter.runScript(path, scriptType);
      } catch (e) {
        get().setError(e);
      }
    },

    gitPull: async (repo: string, name: string, hostId?: string) => {
      try {
        reportRefusal(await adapter.gitPull(repo, name, hostId), get().notify);
      } catch (e) {
        get().setError(e);
      }
    },

    gitPush: async (repo: string, name: string, hostId?: string) => {
      try {
        reportRefusal(await adapter.gitPush(repo, name, hostId), get().notify);
      } catch (e) {
        get().setError(e);
      }
    },

    updateGitStatus: (worktreeId: string, git: GitStatus) => {
      set((state) => {
        const branchStatuses = new Map(state.branchStatuses);
        const existing = branchStatuses.get(worktreeId);
        branchStatuses.set(worktreeId, {
          git,
          ci: existing?.ci ?? { state: "none" },
        });
        return { branchStatuses };
      });
    },

    updateCIStatus: (worktreeId: string, ci: CIStatus) => {
      set((state) => {
        const branchStatuses = new Map(state.branchStatuses);
        const existing = branchStatuses.get(worktreeId);
        branchStatuses.set(worktreeId, {
          git: existing?.git ?? {
            dirty: false,
            conflict: false,
            ahead: 0,
            behind: 0,
            sync_state: "synced",
          },
          ci,
        });
        return { branchStatuses };
      });
    },

    updateSetupStatus: (worktreeId: string, status: SetupStatus) => {
      set((state) => {
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.set(worktreeId, status);
        return { setupStatuses };
      });
    },

    removeSetupStatus: (worktreeId: string) => {
      set((state) => {
        const setupStatuses = new Map(state.setupStatuses);
        setupStatuses.delete(worktreeId);
        return { setupStatuses };
      });
    },

    reconcileSetupStatuses: (runningSetups: string[]) => {
      set((state) => {
        const runningSet = new Set(runningSetups);
        let changed = false;
        const setupStatuses = new Map(state.setupStatuses);
        for (const [id, status] of setupStatuses) {
          if (status.state === "running" && !runningSet.has(id)) {
            setupStatuses.delete(id);
            changed = true;
          }
        }
        return changed ? { setupStatuses } : state;
      });
    },

    setDeleting: (worktreeId: string, deleting: boolean) => {
      set((state) => {
        if (state.deletingWorktrees.has(worktreeId) === deleting) return state;
        const deletingWorktrees = new Set(state.deletingWorktrees);
        if (deleting) deletingWorktrees.add(worktreeId);
        else deletingWorktrees.delete(worktreeId);
        return { deletingWorktrees };
      });
    },
  }));
}
