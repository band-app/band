import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostRegistry } from "../../infra/host/registry";
import { bandHome } from "../state";

/** The directory a chat's agent drops files in to share them with the user. */
export interface SharedDir {
  /** Absolute path on the machine the worktree lives on. */
  path: string;
  /** File names now in the directory. Synchronous for a local worktree, a call to the worker for a remote one. */
  list(): Set<string> | Promise<Set<string>>;
}

/** Creates the chat's shared directory on its host, if it is missing, and returns it. */
export async function openSharedDir(worktreeId: string, chatId: string): Promise<SharedDir> {
  const host = hostRegistry.hostFor(worktreeId);
  if (host.id === hostRegistry.local.id) {
    const path = join(bandHome(), "shared", worktreeId, chatId);
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
  if (!dirs) throw new Error(`Worker ${host.id} has no directory for shared files`);
  const path = join(dirs.shared, worktreeId, chatId);
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

/** The directories an agent in this worktree may read besides its worktree. */
export async function agentExtraDirs(worktreeId: string): Promise<string[]> {
  const host = hostRegistry.hostFor(worktreeId);
  if (host.id === hostRegistry.local.id) {
    return [join(bandHome(), "uploads"), join(bandHome(), "shared")];
  }
  const dirs = (await host.info()).dirs;
  return dirs ? [dirs.uploads, dirs.shared] : [];
}

/** The URL a chat renders one of its shared files from. */
export function sharedFileUrl(worktreeId: string, chatId: string, filename: string): string {
  return `/api/shared/${encodeURIComponent(worktreeId)}/${encodeURIComponent(chatId)}/${encodeURIComponent(filename)}`;
}

/**
 * Splits the part of a shared-file URL after `/api/shared/` into its decoded
 * segments: `<worktreeId>/<chatId>/<name>`, or the older `<worktreeId>/<name>`.
 * Returns null for anything else, including a segment that is empty, `.`,
 * `..` or holds a path separator after decoding.
 */
export function parseSharedPath(
  rest: string,
): { worktreeId: string; chatId?: string; name: string } | null {
  const raw = rest.split("?")[0].split("/");
  if (raw.length !== 2 && raw.length !== 3) return null;
  const parts: string[] = [];
  for (const segment of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) return null;
    parts.push(decoded);
  }
  return parts.length === 3
    ? { worktreeId: parts[0], chatId: parts[1], name: parts[2] }
    : { worktreeId: parts[0], name: parts[1] };
}
