import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostRegistry } from "../../infra/host/registry";
import { bandHome } from "../state";

/** The directory a workspace's agent drops files in to share them with the user. */
export interface SharedDir {
  /** Absolute path on the machine the workspace lives on. */
  path: string;
  /** File names now in the directory. Synchronous for a local workspace, a call to the worker for a remote one. */
  list(): Set<string> | Promise<Set<string>>;
}

/** Creates the workspace's shared directory on its host, if it is missing, and returns it. */
export async function openSharedDir(workspaceId: string): Promise<SharedDir> {
  const host = hostRegistry.hostFor(workspaceId);
  if (host.id === hostRegistry.local.id) {
    const path = join(bandHome(), "shared", workspaceId);
    await mkdir(path, { recursive: true });
    return {
      path,
      list: () => {
        try {
          return new Set(readdirSync(path));
        } catch {
          return new Set();
        }
      },
    };
  }
  const dirs = (await host.info()).dirs;
  if (!dirs) throw new Error(`Host ${host.id} has no directory for shared files`);
  const path = join(dirs.shared, workspaceId);
  await host.fs.mkdir(path, { recursive: true });
  return {
    path,
    list: async () => {
      try {
        return new Set((await host.fs.list(path)).map((e) => e.name));
      } catch {
        return new Set();
      }
    },
  };
}

/** The directories an agent in this workspace may read besides its worktree. */
export async function agentExtraDirs(workspaceId: string): Promise<string[]> {
  const host = hostRegistry.hostFor(workspaceId);
  if (host.id === hostRegistry.local.id) {
    return [join(bandHome(), "uploads"), join(bandHome(), "shared")];
  }
  const dirs = (await host.info()).dirs;
  return dirs ? [dirs.uploads, dirs.shared] : [];
}
