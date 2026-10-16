import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import type { SessionFile } from "@band-app/link";
import { claudeProjectSlug } from "@band-app/shared/claude-session";
import type { Registrar, WorkerContext } from "./context.ts";
import { optStr, type Params, str, strArray } from "./rpc-util.ts";

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

/** Rewrites `cwd` in one JSON line (Claude's top level, Codex's `payload`). Lines that are not JSON stay as they are. */
function rewriteCwdLine(line: string, fromCwd: string, toCwd: string): string {
  if (!line.includes(fromCwd)) return line;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (obj.cwd === fromCwd) obj.cwd = toCwd;
    if (payload && typeof payload === "object" && payload.cwd === fromCwd) payload.cwd = toCwd;
    return JSON.stringify(obj);
  } catch {
    return line;
  }
}

/**
 * A session file as it should sit on this worker when its worktree moved from `fromCwd` to
 * `toCwd`: Claude's file goes under the slug of the new path, and the recorded `cwd` of both
 * agents reads the new path. The new relative path comes from a slug that holds only letters,
 * digits and `-`, so it cannot leave the session root.
 */
function rehome(
  rootName: string,
  rel: string,
  data: Uint8Array,
  fromCwd: string,
  toCwd: string,
): { rel: string; data: Uint8Array } {
  let newRel = rel;
  if (rootName === "claude") {
    const slash = rel.indexOf("/");
    if (slash > 0 && rel.slice(0, slash) === claudeProjectSlug(fromCwd)) {
      newRel = `${claudeProjectSlug(toCwd)}${rel.slice(slash)}`;
    }
  }
  const text = Buffer.from(data)
    .toString("utf8")
    .split("\n")
    .map((line) => rewriteCwdLine(line, fromCwd, toCwd))
    .join("\n");
  return { rel: newRel, data: Buffer.from(text, "utf8") };
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
 * The agent session files of a chat, for the hub's sleep and wake handshake
 * (plan step 3.5) and its checkpoints. The hub reads a
 * session's files before the worker exits, or with each checkpoint, and writes
 * them back on another worker, which is how a chat resumes there.
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
    const fromCwd = optStr(a, "fromCwd");
    const toCwd = optStr(a, "toCwd");
    const roots = sessionRoots();
    let moved = 0;
    for (const rootName of await readdir(stage).catch(() => [])) {
      const target = roots[rootName];
      if (!target) continue;
      const base = join(stage, rootName);
      for (const file of await walk(base)) {
        const rel = relative(base, file).split(sep).join("/");
        let out: { rel: string; data: Uint8Array } = { rel, data: await readFile(file) };
        if (fromCwd && toCwd && fromCwd !== toCwd) {
          out = rehome(rootName, rel, out.data, fromCwd, toCwd);
        }
        const dest = join(target, out.rel);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, out.data);
        moved++;
      }
    }
    await rm(stage, { recursive: true, force: true });
    return { moved };
  });
}
