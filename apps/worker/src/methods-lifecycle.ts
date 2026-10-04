import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import type { SessionFile } from "@band-app/link";
import type { Registrar, WorkerContext } from "./context.ts";
import { type Params, str, strArray } from "./rpc-util.ts";

/** The most file data one `exportSessions` call returns. Past it the file is left out. */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
/** How deep under an agent's session directory a session file may sit. */
const MAX_DEPTH = 4;

/**
 * Where coding agents keep their sessions on this machine, by the name the hub
 * stores them under. `BAND_AGENT_SESSION_DIRS` adds directories (separated like
 * `PATH`), for an agent that keeps sessions somewhere else.
 */
export function sessionRoots(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env.HOME ?? homedir();
  const roots: Record<string, string> = {
    claude: join(home, ".claude", "projects"),
    codex: join(home, ".codex", "sessions"),
  };
  (env.BAND_AGENT_SESSION_DIRS ?? "")
    .split(delimiter)
    .filter(Boolean)
    .forEach((dir, i) => {
      roots[`extra${i}`] = dir;
    });
  return roots;
}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** The files of one session: those whose name holds its id (`<id>.jsonl`, `rollout-...-<id>.jsonl`, `<id>.json`). */
async function filesOf(sessionId: string): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  let total = 0;
  const needle = sessionId.replace(/[^\w-]/g, "_");
  for (const [root, dir] of Object.entries(sessionRoots())) {
    for (const file of await walk(dir)) {
      const name = file.slice(file.lastIndexOf(sep) + 1);
      if (!name.includes(sessionId) && !name.includes(needle)) continue;
      const size = (await stat(file)).size;
      if (total + size > MAX_EXPORT_BYTES) continue;
      total += size;
      out.push({
        root,
        rel: relative(dir, file).split(sep).join("/"),
        data: (await readFile(file)).toString("base64"),
      });
    }
  }
  return out;
}

/**
 * Methods an ephemeral worker adds for the hub's sleep and wake handshake
 * (plan step 3.5). The hub reads a session's files before the worker exits and
 * writes them back on a new worker, which is how a chat resumes there.
 */
export function registerLifecycleMethods(r: Registrar, ctx: WorkerContext): void {
  r.json("lifecycle.exportSessions", async (a) => {
    const files: SessionFile[] = [];
    for (const id of strArray(a, "sessionIds")) files.push(...(await filesOf(id)));
    return { files };
  });

  // The hub stages files with `fs.writeFile` under `dir` as `<root>/<rel>`, then asks for them to be moved.
  r.json("lifecycle.importSessions", async (a: Params) => {
    const stage = await ctx.policy.resolve(str(a, "dir"));
    const roots = sessionRoots();
    let moved = 0;
    for (const rootName of await readdir(stage).catch(() => [])) {
      const target = roots[rootName];
      if (!target) continue;
      const base = join(stage, rootName);
      for (const file of await walk(base)) {
        const dest = join(target, relative(base, file));
        await mkdir(dirname(dest), { recursive: true });
        await cp(file, dest);
        moved++;
      }
    }
    await rm(stage, { recursive: true, force: true });
    return { moved };
  });
}
