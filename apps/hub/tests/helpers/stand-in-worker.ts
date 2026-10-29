// A worker stand-in for tests that are about what the hub does with a worker's hello (its version,
// its service manager) and with the calls it sends back. It speaks the real link protocol through
// `LinkClient`, the class the `band-worker` binary uses, so the hub cannot tell the difference. It
// does not serve files, git or terminals.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type Channel, LinkClient } from "@band-app/link";

const STUB_AGENT = fileURLToPath(new URL("../fixtures/acp-stub-agent.mjs", import.meta.url));

export interface StandInWorkerOptions {
  /** The hub's URL (`http://127.0.0.1:<port>`). */
  hubUrl: string;
  /** The hub's admin token, to issue the worker's bootstrap token. */
  adminToken: string;
  name: string;
  /** The version in the hello. Omit it to model a worker from before version reporting. */
  version?: string;
  serviceManager?: "launchd" | "systemd";
  /**
   * Runs chat agents (the scripted ACP stub) for the hub's `acp.*` calls, as plain child processes.
   * `held` makes the stand-in say the agents live in an agent daemon, the way a real worker does.
   */
  agents?: { held: boolean };
}

export interface StandInWorker {
  hostId: string;
  client: LinkClient;
  /** Says hello again with another version, as a worker does after its restart. */
  reconnect: (version: string) => Promise<void>;
  close: () => Promise<void>;
}

async function trpcMutation<T>(hubUrl: string, token: string, path: string, input: unknown) {
  const res = await fetch(`${hubUrl}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `band_token=${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

/** Registers a worker host and connects a stand-in for it. `onUpdate` answers `worker.update`. */
export async function connectStandInWorker(
  opts: StandInWorkerOptions,
  onUpdate?: (params: unknown) => unknown,
): Promise<StandInWorker> {
  const issued = await trpcMutation<{ token: string; hostId: string }>(
    opts.hubUrl,
    opts.adminToken,
    "tokens.issueWorkerBootstrap",
    { hostName: opts.name, labels: [] },
  );
  const exchanged = await fetch(`${opts.hubUrl}/api/workers/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: issued.token, workerId: issued.hostId }),
  });
  const { sessionToken } = (await exchanged.json()) as { sessionToken: string };

  const dial = async (version: string | undefined): Promise<LinkClient> => {
    const client = new LinkClient({
      url: `${opts.hubUrl.replace("http", "ws")}/api/workers/connect`,
      token: sessionToken,
      reconnect: false,
      hello: {
        workerId: issued.hostId,
        buildId: version ? `band-worker@${version}` : "stand-in",
        ...(version ? { version } : {}),
        ...(opts.serviceManager ? { serviceManager: opts.serviceManager } : {}),
        mode: "attached",
        capabilities: [],
        labels: {},
        roots: [],
        agents: [],
      },
    });
    if (onUpdate) client.session.handle("worker.update", (params) => onUpdate(params));
    if (opts.agents) serveAgents(client, opts.agents.held);
    await client.connect();
    return client;
  };

  const worker: StandInWorker = {
    hostId: issued.hostId,
    client: await dial(opts.version),
    reconnect: async (version) => {
      await worker.client.close();
      worker.client = await dial(version);
    },
    close: () => worker.client.close(),
  };
  return worker;
}

/** The `acp.*` calls of a chat agent, answered with the stub agent as a child of this process. */
function serveAgents(client: LinkClient, held: boolean): void {
  const { session } = client;
  const children = new Map<string, ChildProcess>();
  let count = 0;
  session.handle("acp.resolveLaunch", () => ({
    json: { command: process.execPath, args: [STUB_AGENT], env: {} },
  }));
  session.handle("relay.register", () => ({ json: { url: "http://127.0.0.1:9" } }));
  session.handle("acp.spawn", (raw) => {
    const params = raw as { cwd: string; env?: Record<string, string> };
    const child = spawn(process.execPath, [STUB_AGENT], {
      cwd: params.cwd,
      env: { ...process.env, ...params.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const agentId = `a-stand-in-${++count}`;
    children.set(agentId, child);
    const stdout: Channel = session.openChannel("acp.stdio", { agentId });
    const stderr: Channel = session.openChannel("acp.stderr", { agentId });
    child.stdout?.on("data", (d: Buffer) => void stdout.send(d).catch(() => undefined));
    child.stderr?.on("data", (d: Buffer) => void stderr.send(d).catch(() => undefined));
    void (async () => {
      try {
        for await (const chunk of stdout) child.stdin?.write(chunk);
      } catch {
        child.kill();
      }
    })();
    child.once("exit", (code, signal) => {
      children.delete(agentId);
      stdout.end();
      stderr.end();
      setImmediate(() => session.notify("acp.exit", { agentId, code, signal }));
    });
    return { agentId, pid: child.pid ?? null, stdio: stdout.id, stderr: stderr.id, held };
  });
  session.handle("acp.kill", (raw) => {
    children.get((raw as { agentId: string }).agentId)?.kill();
    return { json: null };
  });
  session.handle("acp.ack", () => ({ json: { stdin: 0 } }));
  session.handle("acp.reconcile", () => ({ json: { killed: 0 } }));
  session.handle("acp.forget", () => ({ json: null }));
}
