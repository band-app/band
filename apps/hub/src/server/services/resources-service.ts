import type { ResourceProcess, ResourceSnapshot, ResourceStorage } from "@band-app/host-api";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { hostRegistry } from "../infra/host/registry";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { loadState } from "./state";
import { hasRunningTask } from "./task-service";
import { tokenService } from "./token-service";

const LOCAL_HOST_ID = "local";
/** A worker that does not answer in this time shows as unavailable instead of holding up the page. */
const SNAPSHOT_TIMEOUT_MS = 8_000;
/** An agent that has sent nothing for this long, and runs no turn, is flagged as idle. */
const IDLE_AGENT_MS = 60 * 60_000;

export interface ResourceWorktreeRef {
  id: string;
  repo: string;
  branch: string;
  title: string | null;
}

export interface ResourceChatRef {
  id: string;
  name: string;
  agent: string;
  running: boolean;
  /** Milliseconds since the agent last sent anything. Null when unknown. */
  idleMs: number | null;
  /** True when the agent has been quiet for an hour and runs no turn. */
  idle: boolean;
}

/** The command line and working directory stay on the worker: argv can carry tokens. */
export interface ResourceProcessView extends Omit<ResourceProcess, "command" | "cwd"> {
  worktree?: ResourceWorktreeRef;
  chat?: ResourceChatRef;
}

export interface ResourceMachine {
  /** `local` for the hub's own machine, else the worker id. */
  id: string;
  /** `hub` for the hub's machine (its built-in worker included), `worker` for any other. */
  role: "hub" | "worker";
  name: string;
  version: string | null;
  /** Whether the hub's machine also runs the built-in `local` worker. */
  builtInWorker: boolean;
  onBattery: boolean | null;
  status: "ok" | "unavailable";
  /** Why a machine shows no numbers. */
  reason: "offline" | "no-answer" | null;
  snapshot: (Omit<ResourceSnapshot, "processes"> & { processes: ResourceProcessView[] }) | null;
}

export interface ResourcesReport {
  takenAt: number;
  machines: ResourceMachine[];
}

export interface ResourceStorageWorktree extends ResourceWorktreeRef {
  sizeBytes: number;
  error?: string;
}

export interface ResourceStorageView {
  worktrees: ResourceStorageWorktree[];
  state: ResourceStorage["state"];
  disk: ResourceStorage["disk"];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface KnownWorktree extends ResourceWorktreeRef {
  hostId: string;
  path: string;
}

function knownWorktrees(): KnownWorktree[] {
  const out: KnownWorktree[] = [];
  for (const repo of loadState().repos) {
    for (const wt of repo.worktrees) {
      const hostId = wt.hostId ?? LOCAL_HOST_ID;
      out.push({
        id: toWorktreeId(repo.name, wt.name, wt.hostId),
        repo: repo.name,
        branch: wt.branch,
        title: wt.title ?? null,
        hostId,
        path: wt.path,
      });
    }
  }
  return out;
}

function refOf(w: KnownWorktree): ResourceWorktreeRef {
  return { id: w.id, repo: w.repo, branch: w.branch, title: w.title };
}

/** The worktree a process belongs to: its environment id, else the deepest worktree folder holding its cwd. */
function worktreeOf(
  proc: ResourceProcess,
  hostId: string,
  worktrees: KnownWorktree[],
): ResourceWorktreeRef | undefined {
  if (proc.worktreeId) {
    const byId = worktrees.find((w) => w.id === proc.worktreeId);
    if (byId) return refOf(byId);
  }
  if (!proc.cwd) return undefined;
  const cwd = proc.cwd;
  let best: KnownWorktree | undefined;
  for (const w of worktrees) {
    if (w.hostId !== hostId || !w.path) continue;
    if (cwd === w.path || cwd.startsWith(`${w.path}/`)) {
      if (!best || w.path.length > best.path.length) best = w;
    }
  }
  return best ? refOf(best) : undefined;
}

function chatOf(chatId: string | undefined, now: number): ResourceChatRef | undefined {
  if (!chatId) return undefined;
  const chat = chatService.get(chatId);
  if (!chat) return undefined;
  const running = hasRunningTask(chatId);
  const last = agentSessionService.lastActivityAt(chatId);
  const idleMs = last === null ? null : Math.max(0, now - last);
  return {
    id: chat.id,
    name: chat.name,
    agent: chat.agent,
    running,
    idleMs,
    idle: !running && idleMs !== null && idleMs >= IDLE_AGENT_MS,
  };
}

/** Which chat an agent process serves: its environment id, else the pid the hub started it with. */
function chatIdOf(
  p: ResourceProcess,
  hostId: string,
  pids: { chatId: string; worktreeId: string; pid: number }[],
): string | undefined {
  if (p.chatId) return p.chatId;
  if (p.kind !== "agent") return undefined;
  return pids.find(
    (a) =>
      a.pid === p.pid && (hostRegistry.hostIdOfScope(a.worktreeId) ?? LOCAL_HOST_ID) === hostId,
  )?.chatId;
}

async function readMachine(
  host: { id: string; name: string; version: string | null; status: string },
  builtInWorker: boolean,
  worktrees: KnownWorktree[],
  now: number,
  agentPids: { chatId: string; worktreeId: string; pid: number }[],
): Promise<ResourceMachine> {
  const isLocal = host.id === LOCAL_HOST_ID;
  const base = {
    id: host.id,
    role: isLocal ? ("hub" as const) : ("worker" as const),
    name: isLocal ? "Hub" : host.name,
    version: host.version,
    builtInWorker: isLocal && builtInWorker,
    onBattery: null as boolean | null,
  };
  if (!isLocal && host.status !== "online") {
    return { ...base, status: "unavailable", reason: "offline", snapshot: null };
  }
  try {
    const target = hostRegistry.hostById(host.id);
    const snap = await withTimeout(target.resources.snapshot(), SNAPSHOT_TIMEOUT_MS);
    const processes: ResourceProcessView[] = snap.processes.map((p) => {
      const chatId = chatIdOf(p, host.id, agentPids);
      const worktree = worktreeOf(
        chatId && !p.worktreeId
          ? { ...p, worktreeId: chatService.get(chatId)?.worktreeId ?? p.worktreeId }
          : p,
        host.id,
        worktrees,
      );
      const chat = chatOf(chatId, now);
      const { command: _command, cwd: _cwd, ...rest } = p;
      return { ...rest, ...(worktree ? { worktree } : {}), ...(chat ? { chat } : {}) };
    });
    return { ...base, status: "ok", reason: null, snapshot: { ...snap, processes } };
  } catch {
    return { ...base, status: "unavailable", reason: "no-answer", snapshot: null };
  }
}

/** Memory and CPU of the hub's machine and of every online worker. A worker that fails shows as unavailable. */
export async function listResources(): Promise<ResourcesReport> {
  const now = Date.now();
  const worktrees = knownWorktrees();
  const agentPids = agentSessionService.agentPids();
  const hosts = tokenService.listHosts();
  const builtIn = hosts.find((h) => h.id === LOCAL_HOST_ID)?.usable ?? false;
  const wanted = hosts.filter((h) => h.id !== LOCAL_HOST_ID);
  const local = hosts.find((h) => h.id === LOCAL_HOST_ID) ?? {
    id: LOCAL_HOST_ID,
    name: "Hub",
    version: null,
    status: "online",
  };
  const machines = await Promise.all(
    [local, ...wanted].map((h) =>
      readMachine(
        { id: h.id, name: h.name, version: h.version ?? null, status: h.status },
        builtIn,
        worktrees,
        now,
        agentPids,
      ),
    ),
  );
  return { takenAt: now, machines };
}

/** Disk use of one machine: its worktrees and its state folder, measured on the machine itself. */
export async function resourceStorage(hostId: string): Promise<ResourceStorageView> {
  const worktrees = knownWorktrees().filter((w) => w.hostId === hostId && w.path);
  const host = hostRegistry.hostById(hostId);
  const result = await host.resources.storage({
    worktrees: worktrees.map((w) => ({ id: w.id, path: w.path })),
  });
  const byId = new Map(worktrees.map((w) => [w.id, w]));
  return {
    worktrees: result.worktrees.flatMap((r) => {
      const w = byId.get(r.id);
      return w
        ? [{ ...refOf(w), sizeBytes: r.sizeBytes, ...(r.error ? { error: r.error } : {}) }]
        : [];
    }),
    state: result.state,
    disk: result.disk,
  };
}
