import { sep } from "node:path";
import type { AgentStdio } from "@band-app/host-api";
import { HeldAgentProcess } from "@band-app/host-local/agents/daemon/held-agent";
import type { Channel } from "@band-app/link";
import { agentSpawnEnv } from "./agent-env.ts";
import type { Registrar, WorkerContext } from "./context.ts";
import { num, optStr, str, strArray, strRecord } from "./rpc-util.ts";
import { serve } from "./streams.ts";

/** An agent the hub started and has not seen exit. */
interface RunningAgent {
  stdio: AgentStdio;
  cwd: string;
  /** Set for an agent in the agent daemon. Releasing it leaves the agent running. */
  held: HeldAgentProcess | null;
  /** Its stdio channels are open. A held agent is detached while the link is gone. */
  attached: boolean;
}

export interface AgentControl {
  /** Stops what these methods left running. A held agent keeps running; the daemon has it. */
  dispose(): Promise<void>;
  /** Kills every agent, held ones included. For a revoked worker. */
  killAll(): Promise<void>;
}

/**
 * The `acp.*` methods: agents the hub's chats talk to over ACP.
 *
 * Stdio is one channel (the hub writes stdin, the worker writes stdout) and stderr is another.
 * An agent in the agent daemon outlives them: a channel reset detaches and leaves it running, and
 * `acp.reattach` opens new channels from the offsets the hub last received. Only `acp.kill`, the
 * fence, a blocked folder, a revoked worker and the agent exiting end it. An agent that is the
 * worker's own child dies with the channel, as it always did.
 */
export function registerAgentMethods(r: Registrar, ctx: WorkerContext): AgentControl {
  const { host, policy, session, activity, agentHolder: holder } = ctx;
  const agents = new Map<string, RunningAgent>();
  let counter = 0;

  /** Opens the two channels and connects them to `entry`'s streams. */
  const serveAgent = (agentId: string, entry: RunningAgent) => {
    const { stdio } = entry;
    const stdout = session.openChannel("acp.stdio", { agentId });
    let stderr: Channel;
    try {
      stderr = session.openChannel("acp.stderr", { agentId });
    } catch (err) {
      stdout.reset("no channel for stderr");
      throw err;
    }
    entry.attached = true;
    const closed = (how: "ended" | "reset") => {
      if (how === "ended") {
        stdio.stdin.end();
        return;
      }
      if (entry.held) {
        // The link is gone, not the agent.
        entry.held.release();
        entry.attached = false;
      } else {
        stdio.kill();
      }
    };
    serve(stdout, stdio.stdout, {
      release: activity.hold(),
      stopSourceOn: "reset",
      onInput: (chunk) => stdio.stdin.write(chunk),
      onClosed: closed,
    });
    serve(stderr, stdio.stderr, { release: activity.hold() });
    return { stdio: stdout.id, stderr: stderr.id };
  };

  const watchExit = (agentId: string, entry: RunningAgent) => {
    void entry.stdio.exit.then((exit) => {
      if (agents.get(agentId) === entry) agents.delete(agentId);
      // After the reply, so a process that dies at once is still reported to a caller who has its id.
      setImmediate(() => session.notify("acp.exit", { agentId, ...exit }));
    });
  };

  r.json("acp.resolveLaunch", (a) =>
    host.acp.resolveLaunch({
      type: str(a, "type"),
      label: optStr(a, "label"),
      command: optStr(a, "command"),
    }),
  );

  r.raw("acp.spawn", async (a) => {
    const env = await agentSpawnEnv(ctx, strRecord(a, "env"));
    const launch = {
      command: str(a, "command"),
      args: strArray(a, "args"),
      env,
      unsetEnv: a.unsetEnv === undefined ? undefined : strArray(a, "unsetEnv"),
      specHash: optStr(a, "specHash"),
      adapterVersion: optStr(a, "adapterVersion"),
    };
    const cwd = await policy.resolve(str(a, "cwd"), true);
    ctx.lease.assertMayRun(cwd);
    const stdio = await host.acp.spawn(launch, cwd);
    const held = stdio instanceof HeldAgentProcess ? stdio : null;
    const agentId = held?.record.agentId ?? `a-${stdio.pid ?? "x"}-${++counter}-${Date.now().toString(36)}`;
    const entry: RunningAgent = { stdio, cwd, held, attached: false };
    agents.set(agentId, entry);
    const channels = serveAgent(agentId, entry);
    watchExit(agentId, entry);
    return {
      agentId,
      pid: stdio.pid ?? null,
      ...channels,
      ...(held ? { held: true, ghToken: held.record.ghToken } : {}),
    };
  });

  // The hub is back (a restarted worker, or a link that was gone too long to resume). It names how
  // many bytes of each stream it already has, and the daemon sends the rest.
  r.raw("acp.reattach", async (a) => {
    const agentId = str(a, "agentId");
    if (!holder) throw new Error("This worker does not keep agents across restarts");
    const old = agents.get(agentId);
    old?.held?.release();
    const held = await HeldAgentProcess.attach(holder, agentId, {
      stdout: num(a, "stdout"),
      stderr: num(a, "stderr"),
    });
    if (!held) {
      agents.delete(agentId);
      throw new Error(`no such agent: ${agentId}`);
    }
    // A lease that ran out in the meantime has killed the agent; the exit below says so.
    const entry: RunningAgent = { stdio: held, cwd: held.record.cwd, held, attached: false };
    agents.set(agentId, entry);
    const channels = serveAgent(agentId, entry);
    watchExit(agentId, entry);
    return {
      agentId,
      pid: held.pid ?? null,
      ...channels,
      held: true,
      ghToken: held.record.ghToken,
      specHash: held.record.specHash,
      stdin: held.record.stdinWritten,
    };
  });

  // The hub has these bytes, so the daemon may drop them. Answers with the stdin offset the daemon
  // has written, which is how the hub knows what to send again after a reattach.
  r.json("acp.ack", async (a) => {
    const reply = await holder?.ack(str(a, "agentId"), {
      stdout: num(a, "stdout"),
      stderr: num(a, "stderr"),
    });
    return { stdin: reply?.stdin ?? 0 };
  });

  r.json("acp.kill", async (a) => {
    const agentId = str(a, "agentId");
    const signal = optStr(a, "signal") as NodeJS.Signals | undefined;
    const entry = agents.get(agentId);
    if (entry) entry.stdio.kill(signal);
    else await holder?.kill(agentId, signal);
  });

  // The hub saw the agent exit, so the daemon can drop its record.
  r.json("acp.forget", async (a) => {
    await holder?.forget(str(a, "agentId"));
  });

  // The hub has reattached what it wants. A held agent it does not know (its chat is gone, or the
  // hub restarted) and that nobody is connected to would otherwise run forever.
  r.json("acp.reconcile", async (a) => {
    const keep = new Set(strArray(a, "keep"));
    if (!holder) return { killed: 0 };
    let killed = 0;
    for (const record of await holder.list()) {
      if (keep.has(record.agentId)) continue;
      if (record.exit) {
        await holder.forget(record.agentId);
        continue;
      }
      if (agents.get(record.agentId)?.attached) continue;
      if (await holder.kill(record.agentId)) killed += 1;
    }
    return { killed };
  });

  const killWhere = async (matches: (cwd: string) => boolean) => {
    const done = new Set<string>();
    for (const [agentId, entry] of agents) {
      if (!matches(entry.cwd)) continue;
      entry.stdio.kill();
      done.add(agentId);
    }
    for (const record of (await holder?.list()) ?? []) {
      if (done.has(record.agentId) || record.exit || !matches(record.cwd)) continue;
      await holder?.kill(record.agentId);
    }
  };

  // The lease ran out: nothing this worker runs for the hub may go on.
  ctx.lease.onFence(() => killWhere(() => true));
  // Another host owns the folder now.
  ctx.lease.onBlocked((blocked) =>
    killWhere((cwd) => blocked.some((dir) => cwd === dir || cwd.startsWith(dir + sep))),
  );

  return {
    dispose: async () => {
      for (const entry of agents.values()) {
        if (entry.held) entry.held.release();
        else entry.stdio.kill();
      }
    },
    killAll: () => killWhere(() => true),
  };
}
