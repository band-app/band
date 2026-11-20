import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useEffect, useMemo, useRef } from "react";
import { commandDef, registerHandler } from "../../lib/shortcuts";
import { hasUnreadMark } from "../components/AgentStatusIndicator";
import { useCapabilities } from "../context";
import type { PaletteCommand } from "../lib/command-registry";
import { useDashboardStore } from "../stores/index";
import type { RepoInfo, WorktreeInfo } from "../types";
import { usePinnedWorktrees } from "./use-pinned-worktrees";
import { useRepos } from "./use-repos";

interface Target {
  repo: RepoInfo;
  worktree: WorktreeInfo;
  worktreeId: string;
}

interface WorktreeCommand {
  id: string;
  /** False hides the command from the palette and makes its chord do nothing. */
  available: boolean;
  /** Palette label, which can name the current state ("Unpin worktree"). */
  label: string;
  run: () => void;
}

/**
 * The worktree right-click actions, run on the worktree on screen. They are
 * registry commands, so each can have a chord (Settings > Keyboard), appears
 * in the command palette and runs exactly what the menu item runs. Returns the
 * palette entries for the actions that apply to this worktree.
 */
export function useWorktreeCommands(activeWorktreeId: string | null): PaletteCommand[] {
  const { repos } = useRepos();
  const { toggle: togglePinned } = usePinnedWorktrees();
  const capabilities = useCapabilities();
  const gitPull = useDashboardStore((s) => s.gitPull);
  const gitPush = useDashboardStore((s) => s.gitPush);
  const runScript = useDashboardStore((s) => s.runScript);
  const setWorktreeUnread = useDashboardStore((s) => s.setWorktreeUnread);
  const agentStatus = useDashboardStore((s) =>
    activeWorktreeId ? s.statuses.get(activeWorktreeId)?.agent?.status : undefined,
  );

  const target = useMemo<Target | null>(() => {
    if (!activeWorktreeId) return null;
    for (const repo of repos) {
      for (const worktree of repo.worktrees) {
        if (toWorktreeId(repo.name, worktree.name, worktree.hostId) === activeWorktreeId) {
          return { repo, worktree, worktreeId: activeWorktreeId };
        }
      }
    }
    return null;
  }, [repos, activeWorktreeId]);

  const commands = useMemo<WorktreeCommand[]>(() => {
    if (!target) return [];
    const { repo, worktree, worktreeId } = target;
    const isPlain = repo.kind === "plain";
    const canMarkRead = hasUnreadMark(worktree.unread, agentStatus ?? "idle");
    return [
      {
        id: "worktree-git-pull",
        available: !isPlain,
        label: "Git pull",
        run: () => void gitPull(repo.name, worktree.name, worktree.hostId),
      },
      {
        id: "worktree-git-push",
        available: !isPlain,
        label: "Git push",
        run: () => void gitPush(repo.name, worktree.name, worktree.hostId),
      },
      {
        id: "worktree-toggle-pin",
        available: true,
        label: worktree.pinned ? "Unpin worktree" : "Pin worktree",
        run: () => togglePinned(repo.name, worktree.name, worktree.pinned, worktree.hostId),
      },
      {
        id: "worktree-toggle-unread",
        available: true,
        label: canMarkRead ? "Mark worktree as read" : "Mark worktree as unread",
        run: () => setWorktreeUnread(worktreeId, !canMarkRead, worktree.hostId),
      },
      {
        id: "worktree-copy-path",
        available: Boolean(capabilities.copyPath),
        label: "Copy worktree path",
        run: () => void navigator.clipboard.writeText(worktree.path),
      },
      {
        id: "worktree-reveal",
        available: Boolean(capabilities.revealInFinder),
        label: "Open worktree in Finder",
        run: () => capabilities.revealInFinder?.(worktree.path),
      },
      {
        id: "worktree-run-setup",
        available: Boolean(worktree.hasSetup),
        label: "Run setup",
        run: () => void runScript(worktree.path, "setup"),
      },
      {
        id: "worktree-run-teardown",
        available: Boolean(worktree.hasTeardown),
        label: "Run teardown",
        run: () => void runScript(worktree.path, "teardown"),
      },
    ];
  }, [
    target,
    agentStatus,
    capabilities,
    gitPull,
    gitPush,
    runScript,
    setWorktreeUnread,
    togglePinned,
  ]);

  // The chord handlers read the latest list, so they register once.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  useEffect(() => {
    const offs = [
      "worktree-git-pull",
      "worktree-git-push",
      "worktree-toggle-pin",
      "worktree-toggle-unread",
      "worktree-copy-path",
      "worktree-reveal",
      "worktree-run-setup",
      "worktree-run-teardown",
    ].map((id) =>
      registerHandler(id, () => {
        const cmd = commandsRef.current.find((c) => c.id === id);
        if (cmd?.available) cmd.run();
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, []);

  return useMemo(
    () =>
      commands
        .filter((c) => c.available)
        .map((c) => ({
          id: c.id,
          label: c.label,
          shortcut: undefined,
          action: c.run,
          hint: commandDef(c.id)?.contextMenu ? "worktree menu" : undefined,
        })),
    [commands],
  );
}
