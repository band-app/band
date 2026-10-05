import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ClaudeCliArgs, ExecOptions, ScriptLabel, ScriptPlan } from "@band-app/host-api";
import { RpcError } from "@band-app/link";
import { describeHost, type Registrar, type WorkerContext } from "./context.ts";
import {
  compact,
  num,
  optBool,
  optNum,
  optObj,
  optStr,
  type Params,
  RPC_INVALID_PARAMS,
  str,
  strArray,
  strRecord,
} from "./rpc-util.ts";

const invalid = (message: string) => new RpcError(RPC_INVALID_PARAMS, message);

/** The permission bits only, so a call cannot set setuid or setgid. */
function optMode(a: Params): number | undefined {
  const mode = optNum(a, "mode");
  if (mode === undefined) return undefined;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw invalid("mode must be 0 to 0o777");
  return mode;
}

function label(a: Params): ScriptLabel {
  const v = str(a, "label");
  if (v !== "setup" && v !== "teardown") throw invalid("label must be setup or teardown");
  return v;
}

/** The part of a glob that could climb out of its `cwd`. */
function checkGlobPattern(pattern: string): void {
  // Braces expand to alternatives, so `{..,x}/*` would climb out without a `..` segment.
  if (isAbsolute(pattern) || /[{}]/.test(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw invalid("pattern must stay inside the directory it is searched in");
  }
}

/**
 * The host copies with `dereference`, so a symlink inside a copied tree would
 * pull in the bytes of whatever it points at. Refuses a tree holding one that
 * leaves the roots.
 */
async function checkTreeLinks(policy: WorkerContext["policy"], dir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return;
    throw err;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) await policy.resolve(child);
    else if (entry.isDirectory()) await checkTreeLinks(policy, child);
  }
}

/**
 * The request and response methods: info, git, worktrees, files, exec,
 * scripts and the agent environment. Every path a call names goes through the
 * path policy first, and the host sees the canonical path it returns.
 * Returns a function that disposes what these methods left running.
 */
export function registerBasicMethods(r: Registrar, ctx: WorkerContext): () => void {
  const { host, policy, session } = ctx;
  const path = (a: Params, key: string, follow = true) => policy.resolve(str(a, key), follow);

  r.json("host.info", () => describeHost(ctx));

  r.json("exec", async (a) => {
    const options = optObj(a, "options");
    const execOptions: ExecOptions = {
      cwd: options?.cwd === undefined ? policy.rootPaths[0] : await path(options, "cwd"),
      env: options?.env === undefined ? undefined : strRecord(options, "env"),
      timeoutMs: options ? optNum(options, "timeoutMs") : undefined,
    };
    return host.exec(str(a, "bin"), strArray(a, "args"), execOptions);
  });

  // ---- git and worktrees --------------------------------------------------

  r.json("git.exec", async (a) => host.git.exec(strArray(a, "args"), await path(a, "cwd")));
  r.json("git.gh", async (a) => host.git.gh(strArray(a, "args"), await path(a, "cwd")));

  r.json("worktree.create", async (a) =>
    host.worktree.create({
      repoPath: await path(a, "repoPath"),
      path: await path(a, "path"),
      branch: str(a, "branch"),
      base: optStr(a, "base"),
    }),
  );
  r.json("worktree.remove", async (a) =>
    host.worktree.remove({ repoPath: await path(a, "repoPath"), path: await path(a, "path") }),
  );
  r.json("worktree.list", async (a) => host.worktree.list(await path(a, "repoPath")));

  // ---- fs -----------------------------------------------------------------

  r.json("fs.stat", async (a) => {
    const followSymlinks = optBool(a, "followSymlinks") ?? false;
    return host.fs.stat(await path(a, "path", followSymlinks), { followSymlinks });
  });
  r.json("fs.realpath", async (a) => host.fs.realpath(await path(a, "path")));
  r.bytes("fs.readFile", async (a) => host.fs.readFile(await path(a, "path")));
  r.json("fs.writeFile", async (a) => {
    const target = await path(a, "path");
    const data = await readWriteData(ctx, a.data);
    await host.fs.writeFile(target, data, {
      exclusive: optBool(a, "exclusive"),
      mode: optMode(a),
    });
  });
  r.json("fs.glob", async (a) => {
    checkGlobPattern(str(a, "pattern"));
    return host.fs.glob(str(a, "pattern"), await path(a, "cwd"));
  });
  r.json("fs.mkdtemp", async (a) => {
    const prefix = optStr(a, "prefix") ?? "";
    if (!/^[A-Za-z0-9._-]*$/.test(prefix)) throw invalid("prefix may not hold a path separator");
    const dir = await host.fs.mkdtemp(prefix);
    // The directory is private to this worker, so later calls may use it.
    policy.allow(await host.fs.realpath(dir));
    return dir;
  });
  r.json("fs.list", async (a) => host.fs.list(await path(a, "path")));
  r.json("fs.mkdir", async (a) =>
    host.fs.mkdir(await path(a, "path"), { recursive: optBool(a, "recursive") }),
  );
  r.json("fs.rm", async (a) =>
    host.fs.rm(
      await policy.resolveEntry(str(a, "path")),
      compact({ recursive: optBool(a, "recursive"), force: optBool(a, "force") }),
    ),
  );
  r.json("fs.rename", async (a) =>
    host.fs.rename(
      await policy.resolveEntry(str(a, "from")),
      await policy.resolveEntry(str(a, "to")),
    ),
  );
  r.json("fs.copy", async (a) => {
    const from = await path(a, "from");
    const to = await path(a, "to");
    const recursive = optBool(a, "recursive");
    if (recursive) await checkTreeLinks(policy, from);
    return host.fs.copy(from, to, { recursive, exclusive: optBool(a, "exclusive") });
  });
  r.json("fs.du", async (a) => host.fs.du(await path(a, "path")));

  // ---- scripts ------------------------------------------------------------

  const plans = new Map<string, ScriptPlan>();
  const worktreePaths = async (a: Params) => ({
    repoPath: await path(a, "repoPath"),
    worktreePath: await path(a, "worktreePath"),
  });

  r.json("scripts.command", async (a) =>
    host.scripts.command({ ...(await worktreePaths(a)), label: label(a) }),
  );
  r.json("scripts.environment", async (a) => host.scripts.environment(await worktreePaths(a)));
  r.json("scripts.runHidden", async (a) =>
    host.scripts.runHidden(str(a, "script"), await path(a, "cwd"), optNum(a, "timeoutMs")),
  );
  r.json("scripts.copyFiles", async (a) => {
    const { repoPath, worktreePath } = await worktreePaths(a);
    return host.scripts.copyFiles(repoPath, worktreePath);
  });
  // A plan lives on the worker until `scripts.dispose`. Its exit comes back as a `scripts.exited` notification.
  r.json("scripts.prepare", async (a) => {
    const plan = await host.scripts.prepare({ ...(await worktreePaths(a)), label: label(a) });
    if (!plan) return null;
    const planId = randomUUID();
    plans.set(planId, plan);
    void plan.exited.then((code) => session.notify("scripts.exited", { planId, code }));
    return { planId, command: plan.command };
  });
  r.json("scripts.dispose", (a) => {
    const planId = str(a, "planId");
    plans.get(planId)?.dispose();
    plans.delete(planId);
  });

  // ---- agent environment --------------------------------------------------

  const agent = (a: Params) => ({
    agentType: str(a, "agentType"),
    command: optStr(a, "command"),
  });
  const cliArgs = (a: Params): ClaudeCliArgs | undefined => {
    const cli = optObj(a, "cli");
    if (!cli) return undefined;
    return {
      settings: strArray(cli, "settings"),
      model: optStr(cli, "model"),
      effort: optStr(cli, "effort"),
    };
  };

  r.json("agentEnv.claudeDefaults", async (a) =>
    host.agentEnv.claudeDefaults(
      a.cwd === undefined ? undefined : await path(a, "cwd"),
      cliArgs(a),
    ),
  );
  r.json("agentEnv.reportedClaudeDefaults", async (a) =>
    host.agentEnv.reportedClaudeDefaults({
      cwd: await path(a, "cwd"),
      sessionId: str(a, "sessionId"),
      since: optNum(a, "since"),
    }),
  );
  r.json("agentEnv.claudeCliArgs", (a) =>
    host.agentEnv.claudeCliArgs(num(a, "adapterPid"), str(a, "sessionId")),
  );
  r.json("agentEnv.latestClaudeSession", async (a) =>
    host.agentEnv.latestClaudeSession(await path(a, "cwd")),
  );
  // The usage reader is an object, so its two methods are calls of their own.
  r.json(
    "agentEnv.hasUsageReader",
    async (a) => (await host.agentEnv.usageReader(agent(a))) !== undefined,
  );
  r.json("agentEnv.usageListSessions", async (a) => {
    const reader = await host.agentEnv.usageReader(agent(a));
    return reader ? reader.listSessions(await path(a, "dir")) : [];
  });
  r.json("agentEnv.usageSession", async (a) => {
    const reader = await host.agentEnv.usageReader(agent(a));
    return reader ? reader.getSessionUsage(str(a, "sessionId"), await path(a, "dir")) : null;
  });
  // The `home` override is for tests, so the hub may not set it.
  r.json("agentEnv.installSkills", () => host.agentEnv.installSkills());
  r.json("agentEnv.hooksStatus", () => host.agentEnv.hooksStatus());
  r.json("agentEnv.installHooks", () => host.agentEnv.installHooks());

  return () => {
    for (const plan of plans.values()) plan.dispose();
    plans.clear();
  };
}

/**
 * The bytes of a `writeFile` call: text, base64 in `{ base64 }`, or the whole
 * of a channel the hub opened, which is how data over the message limit
 * arrives. The hub ends its side after the last chunk.
 */
async function readWriteData(ctx: WorkerContext, data: unknown): Promise<string | Uint8Array> {
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null) {
    const d = data as Params;
    if (typeof d.base64 === "string") return Buffer.from(d.base64, "base64");
    if (typeof d.chan === "number") {
      const ch = ctx.session.getChannel(d.chan);
      // The hub is the server on this link and opens even-numbered channels.
      if (!ch || ch.id % 2 !== 0) throw invalid(`channel ${d.chan} is not open from the hub`);
      const bytes = await ch.readAll();
      ch.end();
      return bytes;
    }
  }
  throw invalid("data must be a string, { base64 } or { chan }");
}
