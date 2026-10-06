import { delimiter, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentStdio, McpStdio, SpawnOptions, TerminalAttachment } from "@band-app/host-api";
import { shellPath } from "@band-app/host-local/process/path";
import type { Channel } from "@band-app/link";
import type { Registrar, WorkerContext } from "./context.ts";
import {
  encodeJson,
  num,
  optBool,
  optNum,
  optObj,
  optStr,
  type Params,
  str,
  strArray,
  strRecord,
} from "./rpc-util.ts";
import { ndjson, serve } from "./streams.ts";

/** A viewer further behind than this holds the PTY, and releases it below the low mark. */
const PTY_HOLD_BYTES = 256 * 1024;
const PTY_RELEASE_BYTES = 32 * 1024;

/** Agents the hub started and has not seen exit. */
interface RunningAgent {
  stdio: AgentStdio;
}

interface AttachedPty {
  channel: Channel;
  attachment: TerminalAttachment;
}

/**
 * The methods that open channels: file streams, search, language servers,
 * PTYs and agent stdio. The worker opens each channel and names its id in the
 * reply, so the hub learns of the channel before the reply reaches it. The
 * hub closes a channel to stop what feeds it. Returns a function that stops
 * what these methods left running.
 */
export function registerStreamMethods(r: Registrar, ctx: WorkerContext): () => Promise<void> {
  const { host, policy, session, activity } = ctx;
  const path = (a: Params, key: string, follow = true) => policy.resolve(str(a, key), follow);

  // ---- file and search streams --------------------------------------------

  r.raw("fs.readStream", async (a) => {
    const target = await path(a, "path");
    await host.fs.stat(target, { followSymlinks: true }); // a missing file fails the call, not the stream
    const ch = session.openChannel("fs.read", { path: target });
    serve(ch, host.fs.readStream(target), { release: activity.hold() });
    return { chan: ch.id };
  });

  r.raw("fs.watch", async (a) => {
    const root = await path(a, "root");
    const ch = session.openChannel("fs.watch", { root });
    const changes = host.fs.watch(root, { recursive: optBool(a, "recursive") });
    serve(ch, ndjson(changes), { release: activity.hold() });
    return { chan: ch.id };
  });

  r.raw("search.stream", async (a) => {
    const root = await path(a, "root");
    const q = optObj(a, "query") ?? a;
    const ch = session.openChannel("search", { root });
    const matches = host.search.stream(
      {
        query: str(q, "query"),
        caseSensitive: optBool(q, "caseSensitive"),
        wholeWord: optBool(q, "wholeWord"),
        regex: optBool(q, "regex"),
      },
      root,
    );
    serve(ch, ndjson(matches), { release: activity.hold() });
    return { chan: ch.id };
  });
  r.json("search.listFiles", async (a) => host.search.listFiles(await path(a, "root")));

  // ---- language servers ---------------------------------------------------

  r.raw("lsp.connect", async (a) => {
    const lang = str(a, "lang");
    const duplex = await host.lsp.connect({
      worktreeId: str(a, "worktreeId"),
      lang,
      root: await path(a, "root"),
    });
    let ch: Channel;
    try {
      ch = session.openChannel("lsp", { lang });
    } catch (err) {
      duplex.close();
      throw err;
    }
    serve(ch, duplex.output, {
      release: activity.hold(),
      onInput: (chunk) => duplex.write(chunk),
      onClosed: () => duplex.close(),
    });
    return { chan: ch.id };
  });
  r.json("lsp.killWorktree", (a) => host.lsp.killWorktree(str(a, "worktreeId")));
  r.json("lsp.killAll", () => host.lsp.killAll());

  // ---- desktop ------------------------------------------------------------

  // The channel carries the RFB stream: the hub's viewer writes to x11vnc and x11vnc's output comes back.
  // Closing the channel drops the connection to x11vnc. `host.desktop.open` rejects, and so fails the
  // call, when the host has no display or no x11vnc.
  r.raw("desktop.open", async () => {
    const duplex = await host.desktop.open();
    let ch: Channel;
    try {
      ch = session.openChannel("desktop", {});
    } catch (err) {
      duplex.close();
      throw err;
    }
    serve(ch, duplex.output, {
      release: activity.hold(),
      onInput: (chunk) => duplex.write(chunk),
      onClosed: () => duplex.close(),
    });
    return { chan: ch.id };
  });

  // ---- agents -------------------------------------------------------------

  const agents = new Map<string, RunningAgent>();
  const mcpProcesses = new Set<McpStdio>();

  r.json("acp.resolveLaunch", (a) =>
    host.acp.resolveLaunch({
      type: str(a, "type"),
      label: optStr(a, "label"),
      command: optStr(a, "command"),
    }),
  );

  // Stdio is one channel (hub writes stdin, worker writes stdout) and stderr is another.
  // The hub ending its side closes stdin. Resetting the stdio channel kills the agent.
  r.raw("acp.spawn", async (a) => {
    const env = strRecord(a, "env");
    // The hub's `band` CLI goes first, so an agent's shell tool finds it.
    const cliDir = await ctx.cli?.dir();
    if (cliDir) env.PATH = [cliDir, env.PATH ?? process.env.PATH].filter(Boolean).join(delimiter);
    const launch = {
      command: str(a, "command"),
      args: strArray(a, "args"),
      env,
    };
    const stdio = await host.acp.spawn(launch, await path(a, "cwd"));
    const agentId = `a-${stdio.pid ?? "x"}-${agents.size}-${Date.now().toString(36)}`;
    agents.set(agentId, { stdio });

    const stdout = session.openChannel("acp.stdio", { agentId });
    const stderr = session.openChannel("acp.stderr", { agentId });
    serve(stdout, stdio.stdout, {
      release: activity.hold(),
      stopSourceOn: "reset",
      onInput: (chunk) => stdio.stdin.write(chunk),
      onClosed: (how) => (how === "ended" ? stdio.stdin.end() : stdio.kill()),
    });
    serve(stderr, stdio.stderr, { release: activity.hold() });
    void stdio.exit.then((exit) => {
      agents.delete(agentId);
      // After the reply, so a process that dies at once is still reported to a caller who has its id.
      setImmediate(() => session.notify("acp.exit", { agentId, ...exit }));
    });
    return { agentId, pid: stdio.pid ?? null, stdio: stdout.id, stderr: stderr.id };
  });
  r.json("acp.kill", (a) => {
    const signal = optStr(a, "signal") as NodeJS.Signals | undefined;
    agents.get(str(a, "agentId"))?.stdio.kill(signal);
  });

  // ---- stdio MCP servers --------------------------------------------------

  // One channel carries the server's JSON-RPC lines: the hub writes stdin, the worker writes stdout.
  // The hub resetting the channel kills the process. The hub ending its side closes stdin, and the
  // process gets a grace period to exit before it is killed. `env` may hold vault secrets, so it
  // is passed straight to the process and nothing here logs or stores it.
  const MCP_STDIN_GRACE_MS = 2_000;
  r.raw("mcp.stdio.open", async (a) => {
    const stdio = await host.mcp.openStdio({
      serverId: str(a, "serverId"),
      command: str(a, "command"),
      args: strArray(a, "args"),
      env: strRecord(a, "env"),
      cwd: optStr(a, "cwd") === undefined ? undefined : await path(a, "cwd"),
    });
    mcpProcesses.add(stdio);
    let ch: ReturnType<typeof session.openChannel>;
    try {
      ch = session.openChannel("mcp.stdio", { serverId: str(a, "serverId") });
    } catch (err) {
      stdio.kill();
      mcpProcesses.delete(stdio);
      throw err;
    }
    const output = (async function* () {
      try {
        yield* stdio.stdout;
      } finally {
        mcpProcesses.delete(stdio);
      }
    })();
    serve(ch, output, {
      release: activity.hold(),
      stopSourceOn: "reset",
      onInput: (chunk) => stdio.stdin.write(chunk),
      onClosed: (how) => {
        if (how === "reset") {
          stdio.kill();
          return;
        }
        stdio.stdin.end();
        setTimeout(() => stdio.kill(), MCP_STDIN_GRACE_MS).unref();
      },
    });
    return { chan: ch.id, pid: stdio.pid ?? null };
  });

  // ---- terminals ----------------------------------------------------------

  const pty = host.pty;

  r.json("pty.spawn", async (a) => {
    const worktreeRoot = await path(a, "worktreeRoot");
    const o = optObj(a, "options");
    let options: SpawnOptions | undefined = o && {
      command: optStr(o, "command"),
      cwd: optStr(o, "cwd"),
      env: o.env === undefined ? undefined : strRecord(o, "env"),
    };
    // The hub's `band` CLI goes first. A PATH in `options.env` would replace the pool's
    // login-shell PATH, so this starts from that PATH unless the hub set one.
    const cliDir = await ctx.cli?.dir();
    if (cliDir) {
      const base = options?.env?.PATH ?? (await shellPath());
      options = { ...options, env: { ...options?.env, PATH: [cliDir, base].join(delimiter) } };
    }
    // The pool resolves `cwd` inside the worktree root, so check where that lands.
    if (options?.cwd !== undefined) await policy.resolve(resolve(worktreeRoot, options.cwd));
    return pty.spawn({
      worktreeId: str(a, "worktreeId"),
      terminalId: str(a, "terminalId"),
      worktreeRoot,
      options,
      cleanupOnExit: optBool(a, "cleanupOnExit"),
    });
  });
  r.json("pty.info", (a) => pty.info(str(a, "terminalId")));
  r.json("pty.list", (a) => pty.list(str(a, "worktreeId")));
  r.json("pty.listAll", () => pty.listAll());
  r.json("pty.kill", (a) => pty.kill(str(a, "terminalId")));
  r.json("pty.killWorktree", (a) => pty.killWorktree(str(a, "worktreeId")));
  r.json("pty.getScrollback", (a) => pty.getScrollback(str(a, "terminalId"), optNum(a, "lines")));
  r.json("pty.write", (a) => pty.write(str(a, "terminalId"), str(a, "data")));
  r.json("pty.input", (a) => pty.input(str(a, "terminalId"), str(a, "data")));
  r.json("pty.resize", (a) => pty.resize(str(a, "terminalId"), num(a, "cols"), num(a, "rows")));
  r.json("pty.nudgeResize", (a) => pty.nudgeResize(str(a, "terminalId")));
  r.json("pty.restartDaemon", () => pty.restartDaemon());

  const attached = new Map<string, Set<AttachedPty>>();

  // Output goes down the channel after the reply's snapshot: the hub holds channel data until it has read the reply.
  // Keystrokes come back up the same channel. Closing the channel detaches the viewer, and with
  // `killOnClose` it also kills the terminal.
  r.raw("pty.attach", async (a) => {
    const terminalId = str(a, "terminalId");
    const d = optObj(a, "dims");
    const attachment = await pty.attach(
      terminalId,
      d && { cols: num(d, "cols"), rows: num(d, "rows") },
    );
    if (!attachment) throw new Error(`Terminal is not live: ${terminalId}`);
    const killOnClose = optBool(a, "killOnClose") ?? false;

    const ch = session.openChannel("pty", { terminalId });
    const entry: AttachedPty = { channel: ch, attachment };
    const set = attached.get(terminalId) ?? new Set();
    set.add(entry);
    attached.set(terminalId, set);

    const decoder = new StringDecoder("utf8");
    serve(ch, undefined, {
      release: activity.hold(),
      onInput: (chunk) => {
        const text = decoder.write(chunk);
        if (text !== "") pty.input(terminalId, text);
      },
      onClosed: () => {
        attachment.detach();
        set.delete(entry);
        if (set.size === 0) attached.delete(terminalId);
        if (killOnClose) void pty.kill(terminalId);
        ch.end();
      },
    });

    let unsent = 0;
    let held = false;
    attachment.start((data) => {
      const bytes = Buffer.from(data);
      unsent += bytes.length;
      if (!held && unsent > PTY_HOLD_BYTES) {
        held = true;
        attachment.setOutputHeld(true);
      }
      ch.send(bytes).then(
        () => {
          unsent -= bytes.length;
          if (held && unsent < PTY_RELEASE_BYTES) {
            held = false;
            attachment.setOutputHeld(false);
          }
        },
        () => undefined, // the channel failed, and its close handler detaches
      );
    });
    return { chan: ch.id, snapshot: encodeJson(session, attachment.snapshot) };
  });

  // A terminal that exits ends its viewers' channels, after every chunk it wrote, and tells the hub.
  const unsubscribeExit = pty.onExit((event) => {
    for (const { channel, attachment } of attached.get(event.terminalId) ?? []) {
      attachment.detach();
      channel.end();
    }
    session.notify("pty.exit", event);
  });

  return async () => {
    unsubscribeExit();
    for (const { stdio } of agents.values()) stdio.kill();
    for (const proc of mcpProcesses) proc.kill();
    await pty.close();
    await host.lsp.killAll();
  };
}
