import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { extractVersion } from "@band-app/environment";
import {
  type AgentCapability,
  agentIsUsable,
  type CapabilityReport,
  type ToolCapability,
} from "@band-app/host-api";
import { prependBinDirs } from "./path";

interface AgentProbe {
  type: string;
  bin: string;
  /** Arguments of a command that exits 0 when logged in. Null when the agent has no such command. */
  login: string[] | null;
  /** Environment variables that count as being logged in. */
  envKeys: string[];
  install: string;
  loginFix: string;
}

const AGENT_PROBES: AgentProbe[] = [
  {
    type: "claude-code",
    bin: "claude",
    login: ["auth", "status"],
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    install: "npm install -g @anthropic-ai/claude-code",
    loginFix: "claude auth login",
  },
  {
    type: "codex",
    bin: "codex",
    login: ["login", "status"],
    envKeys: ["OPENAI_API_KEY"],
    install: "npm install -g @openai/codex",
    loginFix: "codex login",
  },
  {
    type: "opencode",
    bin: "opencode",
    login: null,
    envKeys: [],
    install: "npm install -g opencode-ai",
    loginFix: "opencode auth login",
  },
  {
    type: "gemini-cli",
    bin: "gemini",
    login: null,
    envKeys: ["GEMINI_API_KEY"],
    install: "npm install -g @google/gemini-cli",
    loginFix: "gemini",
  },
  {
    type: "cursor-cli",
    bin: "cursor-agent",
    login: null,
    envKeys: ["CURSOR_API_KEY"],
    install: "curl https://cursor.com/install -fsS | bash",
    loginFix: "cursor-agent login",
  },
];

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Where the probes look for CLIs. `BAND_AGENT_BIN_DIRS` (a PATH-style list, read on every call) is
 * searched first, for a machine whose agents live outside its PATH.
 */
function searchPath(): string {
  const extra = process.env.BAND_AGENT_BIN_DIRS?.trim();
  // Where agent installers put their CLI under the home directory, which a service's PATH lacks.
  const home = homedir();
  const installDirs = [
    ".local/bin",
    ".opencode/bin",
    ".claude/local",
    ".bun/bin",
    ".npm-global/bin",
  ].map((d) => join(home, d));
  return [...(extra ? [extra] : []), prependBinDirs(process.env.PATH), ...installDirs].join(
    delimiter,
  );
}

interface Ran {
  ok: boolean;
  found: boolean;
  out: string;
}

function run(bin: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        env: { ...process.env, PATH: searchPath() },
        timeout: PROBE_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        const notFound = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
        resolve({ ok: !err, found: !notFound, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

async function probeAgent(probe: AgentProbe): Promise<AgentCapability> {
  const version = await run(probe.bin, ["--version"]);
  if (!version.found) {
    return {
      type: probe.type,
      installed: false,
      version: null,
      loggedIn: null,
      fix: probe.install,
    };
  }
  let loggedIn: boolean | null = null;
  if (probe.envKeys.some((k) => Boolean(process.env[k]))) loggedIn = true;
  else if (probe.login) loggedIn = (await run(probe.bin, probe.login)).ok;
  return {
    type: probe.type,
    installed: true,
    version: extractVersion(version.out),
    loggedIn,
    fix: loggedIn === false ? probe.loginFix : "",
  };
}

async function probeGh(): Promise<ToolCapability> {
  const v = await run("gh", ["--version"]);
  if (!v.found) {
    return {
      tool: "gh",
      installed: false,
      version: null,
      loggedIn: null,
      fix: "install the GitHub CLI from https://cli.github.com",
    };
  }
  const auth =
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      ? { ok: true }
      : await run("gh", ["auth", "status"]);
  return {
    tool: "gh",
    installed: true,
    version: extractVersion(v.out),
    loggedIn: auth.ok,
    fix: auth.ok ? "" : "gh auth login",
  };
}

async function probeGit(): Promise<ToolCapability> {
  const v = await run("git", ["--version"]);
  return {
    tool: "git",
    installed: v.found && v.ok,
    version: v.found ? extractVersion(v.out) : null,
    loggedIn: null,
    fix: v.found ? "" : "install git",
  };
}

/** Runs each probe on this machine, in parallel. Never throws: a probe that fails reports not installed. */
export async function probeCapabilities(agentTypes?: readonly string[]): Promise<CapabilityReport> {
  const probes = agentTypes
    ? AGENT_PROBES.filter((p) => agentTypes.includes(p.type))
    : AGENT_PROBES;
  const [agents, gh, git] = await Promise.all([
    Promise.all(probes.map(probeAgent)),
    probeGh(),
    probeGit(),
  ]);
  return { agents, tools: [git, gh], checkedAt: Date.now() };
}

/** The report as lines for `band-worker doctor`, with a fix command under each gap. */
export function formatReport(report: CapabilityReport): string {
  const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");
  const lines: string[] = [];
  for (const a of report.agents) {
    const state = !a.installed
      ? "not installed"
      : a.loggedIn === false
        ? "installed, not logged in"
        : a.loggedIn === null
          ? "installed, login not checkable"
          : "installed, logged in";
    lines.push(`${mark(agentIsUsable(a))} ${a.type.padEnd(12)} ${a.version ?? "-"}  ${state}`);
    if (a.fix) lines.push(`       fix: ${a.fix}`);
  }
  for (const t of report.tools) {
    const state = !t.installed
      ? "not installed"
      : t.loggedIn === false
        ? "installed, not logged in"
        : t.loggedIn === true
          ? "installed, logged in"
          : "installed";
    lines.push(
      `${mark(t.installed && t.loggedIn !== false)} ${t.tool.padEnd(12)} ${t.version ?? "-"}  ${state}`,
    );
    if (t.fix) lines.push(`       fix: ${t.fix}`);
  }
  return `${lines.join("\n")}\n`;
}
