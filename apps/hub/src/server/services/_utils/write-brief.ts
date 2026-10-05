/** Writes `.am/BRIEF.md` into a worktree through its host and keeps it out of git (plan step 6.3). */

import { join, posix } from "node:path";
import type { Host } from "@band-app/host-api";
import { BRIEF_DIR, BRIEF_FILE, BRIEF_PATH } from "./dispatch-brief";

export async function writeBrief(
  host: Host,
  worktreePath: string,
  brief: string,
  remote: boolean,
): Promise<void> {
  const p = remote ? posix : { join };
  const dir = p.join(worktreePath, BRIEF_DIR);
  await host.fs.mkdir(dir, { recursive: true });
  await host.fs.writeFile(p.join(dir, BRIEF_FILE), brief);
  // A worktree's `info/exclude` lives in the shared git dir, so ask git where it is.
  const { stdout } = await host.git.exec(
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    worktreePath,
  );
  const excludePath = stdout.trim();
  let current = "";
  try {
    current = new TextDecoder().decode(await host.fs.readFile(excludePath));
  } catch {
    await host.fs.mkdir(remote ? posix.dirname(excludePath) : join(excludePath, ".."), {
      recursive: true,
    });
  }
  const entry = `${BRIEF_DIR}/`;
  if (current.split("\n").some((line) => line.trim() === entry)) return;
  await host.fs.writeFile(
    excludePath,
    `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`,
  );
}

export { BRIEF_PATH };
