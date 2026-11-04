import type { ResourceKind, ResourceProcess } from "@band-app/host-api";
import type { ProcRow } from "./process-table";

export interface ClassifyOptions {
  selfPid: number;
  /** What the process running this code is: the hub or a worker. */
  selfKind: "hub" | "worker";
  /** The terminal daemon's run dir. The agent daemon's is `<runDir>/agents`. */
  runDir: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh"]);
const LSP_NAMES =
  /(typescript-language-server|tsserver|rust-analyzer|gopls|pyright|basedpyright|jdtls|clangd|lua-language-server|vscode-[a-z]+-language-server|yaml-language-server)/;
const AGENT_NAMES =
  /(claude-agent-acp|claude-code-acp|codex-acp|gemini|opencode|cursor-agent|-acp\b)/;
const BROWSER = /(chrom(e|ium)|headless_shell).*--remote-debugging-port/i;
const SIMULATOR = /(serve-sim|simctl|Simulator\.app|CoreSimulator)/;

function baseName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const name = first.split("/").pop() ?? first;
  return name.replace(/^-/, "");
}

function hasRunDir(command: string, runDir: string): boolean {
  const tokens = command.split(/\s+/);
  const at = tokens.indexOf("--run-dir");
  return at >= 0 && tokens[at + 1] === runDir;
}

/** Groups a process table into the Band processes of one machine. Pure, so it is easy to test. */
export interface Classified {
  /** Root pid, its kind and display name. */
  roots: { pid: number; kind: ResourceKind; name: string; subtree: boolean }[];
  children: Map<number, number[]>;
}

export function classify(rows: ProcRow[], opts: ClassifyOptions): Classified {
  const children = new Map<number, number[]>();
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const roots: Classified["roots"] = [];
  const seen = new Set<number>();
  const add = (pid: number, kind: ResourceKind, name: string, subtree: boolean) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    roots.push({ pid, kind, name, subtree });
  };

  if (byPid.has(opts.selfPid))
    add(opts.selfPid, opts.selfKind, opts.selfKind === "hub" ? "Hub server" : "band-worker", false);

  for (const row of rows) {
    if (/terminal-daemon/.test(row.command) && hasRunDir(row.command, opts.runDir)) {
      add(row.pid, "terminal-daemon", "terminal daemon", false);
      for (const child of children.get(row.pid) ?? []) {
        const c = byPid.get(child);
        if (c) add(child, "terminal", baseName(c.command), true);
      }
    } else if (
      /agent-daemon/.test(row.command) &&
      hasRunDir(row.command, `${opts.runDir}/agents`)
    ) {
      add(row.pid, "agent-daemon", "agent daemon", false);
      for (const child of children.get(row.pid) ?? []) {
        const c = byPid.get(child);
        if (c) add(child, "agent", agentName(c.command), true);
      }
    }
  }

  // Direct children of this process: in-process terminals and agents, language servers,
  // browsers, simulators and stdio MCP servers.
  for (const child of children.get(opts.selfPid) ?? []) {
    const c = byPid.get(child);
    if (!c || seen.has(child)) continue;
    const name = baseName(c.command);
    if (SHELLS.has(name)) add(child, "terminal", name, true);
    else if (LSP_NAMES.test(c.command)) add(child, "lsp", lspName(c.command), true);
    else if (BROWSER.test(c.command)) add(child, "browser", "Chromium", true);
    else if (SIMULATOR.test(c.command)) add(child, "simulator", "Simulator", true);
    else if (AGENT_NAMES.test(c.command)) add(child, "agent", agentName(c.command), true);
    else if (/mcp/i.test(c.command)) add(child, "mcp", name, true);
    else if (name !== "ps" && name !== "lsof" && name !== "du" && name !== "df")
      add(child, "other", name, true);
  }
  // Language servers and browsers can also sit under a shell or an intermediate node process.
  const subtreeRoots = new Set(roots.filter((r) => r.subtree).map((r) => r.pid));
  for (const row of rows) {
    if (seen.has(row.pid)) continue;
    // A process inside a terminal or agent subtree is already counted in that root.
    if (hasAncestorIn(row.pid, subtreeRoots, byPid)) continue;
    if (LSP_NAMES.test(row.command) && isUnder(row.pid, opts.selfPid, byPid)) {
      add(row.pid, "lsp", lspName(row.command), true);
    } else if (BROWSER.test(row.command) && isUnder(row.pid, opts.selfPid, byPid)) {
      add(row.pid, "browser", "Chromium", true);
    }
  }
  return { roots, children };
}

function hasAncestorIn(pid: number, set: Set<number>, byPid: Map<number, ProcRow>): boolean {
  let cur = byPid.get(pid)?.ppid;
  for (let i = 0; cur !== undefined && i < 64; i++) {
    if (set.has(cur)) return true;
    cur = byPid.get(cur)?.ppid;
  }
  return false;
}

function isUnder(pid: number, ancestor: number, byPid: Map<number, ProcRow>): boolean {
  let cur = byPid.get(pid)?.ppid;
  for (let i = 0; cur !== undefined && i < 64; i++) {
    if (cur === ancestor) return true;
    cur = byPid.get(cur)?.ppid;
  }
  return false;
}

function lspName(command: string): string {
  return LSP_NAMES.exec(command)?.[1] ?? "language server";
}

function agentName(command: string): string {
  if (/claude/i.test(command)) return "Claude Code";
  if (/codex/i.test(command)) return "Codex";
  if (/gemini/i.test(command)) return "Gemini";
  if (/opencode/i.test(command)) return "OpenCode";
  if (/cursor/i.test(command)) return "Cursor";
  return baseName(command);
}

/** Pids of `root` and every descendant. */
export function subtreeOf(root: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < 5000) {
    const pid = stack.pop() as number;
    out.push(pid);
    for (const c of children.get(pid) ?? []) stack.push(c);
  }
  return out;
}

/** Sums the memory and CPU of each root over two samples taken `windowMs` apart. */
export function sumRoots(
  classified: Classified,
  first: Map<number, ProcRow>,
  second: Map<number, ProcRow>,
  windowMs: number,
): ResourceProcess[] {
  const out: ResourceProcess[] = [];
  for (const root of classified.roots) {
    const pids = root.subtree ? subtreeOf(root.pid, classified.children) : [root.pid];
    let rss = 0;
    let cpuMs = 0;
    let count = 0;
    for (const pid of pids) {
      const b = second.get(pid);
      if (!b) continue;
      count++;
      rss += b.rssBytes;
      const a = first.get(pid);
      cpuMs += Math.max(0, a ? b.cpuMs - a.cpuMs : b.cpuMs);
    }
    const self = second.get(root.pid);
    if (!self) continue;
    out.push({
      pid: root.pid,
      kind: root.kind,
      name: root.name,
      command: self.command.slice(0, 200),
      rssBytes: rss,
      cpuPercent: windowMs > 0 ? Math.round((cpuMs / windowMs) * 1000) / 10 : 0,
      processCount: count,
    });
  }
  return out;
}
