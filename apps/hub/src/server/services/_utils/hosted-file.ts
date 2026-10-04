import { basename, join } from "node:path";
import { hostRegistry } from "../../infra/host/registry";

export interface HostedFile {
  size: number;
  stream: AsyncIterable<Uint8Array>;
}

/**
 * Opens a file the hub keeps on a remote workspace's worker: a chat upload or
 * a file the agent shared. Returns null when the workspace is local (the hub
 * serves its own disk), the host declares no such directory, or the file is
 * missing. Only the file's own name counts, so a name cannot leave the
 * workspace's directory.
 */
export async function openHostedFile(
  kind: "uploads" | "shared",
  workspaceId: string,
  rawName: string,
): Promise<HostedFile | null> {
  const host = hostRegistry.hostFor(workspaceId);
  if (host.id === hostRegistry.local.id) return null;
  let name: string;
  try {
    name = basename(decodeURIComponent(rawName));
  } catch {
    return null;
  }
  if (!name || name === "." || name === "..") return null;
  try {
    const dirs = (await host.info()).dirs;
    if (!dirs) return null;
    const path = join(dirs[kind], workspaceId, name);
    const stat = await host.fs.stat(path, { followSymlinks: true });
    if (stat.kind !== "file") return null;
    return { size: stat.size, stream: host.fs.readStream(path) };
  } catch {
    return null;
  }
}
