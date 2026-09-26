/**
 * How to start each coding agent as an ACP agent subprocess (issue #648).
 *
 * Claude Code and Codex speak ACP through the maintained adapters
 * `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`,
 * which are dependencies of Band and run as Node scripts. They drive the
 * user's own `claude` / `codex` binary (`CLAUDE_CODE_EXECUTABLE`,
 * `CODEX_PATH`), so the desktop bundle doesn't have to ship the vendors'
 * native builds. OpenCode, Gemini CLI and Cursor CLI speak ACP natively and
 * must be installed.
 *
 * `BAND_TEST_ACP_AGENT`, read at launch time, points every agent at one
 * scripted ACP agent so integration tests run with no network and no login.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DISPATCH_ENV } from "@band-app/coding-agent";
import { shellPath } from "../process/path";

export interface AcpLaunch {
  command: string;
  args: string[];
  /** Merged over `process.env` at spawn. */
  env: Record<string, string>;
}

/** The parts of a settings agent definition the launcher reads. */
export interface AcpAgentDefinition {
  type: string;
  label?: string;
  /** User-configured binary path (settings `command`). */
  command?: string;
}

const require = createRequire(import.meta.url);

function findOnPath(name: string, path: string, extra: string[] = []): string | null {
  for (const dir of [...path.split(delimiter), ...extra]) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/**
 * The adapter's entry script. The production server bundle ships each
 * adapter pre-bundled at `dist/agents/<name>.mjs`, next to
 * `start-server.mjs` (see `scripts/build-server.sh`). In dev and tests the
 * package resolves from `node_modules`.
 */
function adapterScript(pkg: string, bundledName: string): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "agents", `${bundledName}.mjs`);
  if (existsSync(bundled)) return bundled;
  return join(dirname(require.resolve(`${pkg}/package.json`)), "dist", "index.js");
}

/**
 * Node for the JS adapters: the user's `node` when there is one, else the
 * runtime this server runs on (Electron's Node in the desktop app).
 */
function nodeFor(path: string): string {
  return findOnPath("node", path) ?? process.execPath;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The agent binary: the settings `command` when it names an executable
 * file (a path, or a name found on PATH), else the first default name on
 * PATH. A `command` that resolves to nothing counts as not installed.
 */
function binary(def: AcpAgentDefinition, names: string[], path: string, extra: string[] = []) {
  if (def.command) {
    if (def.command.includes("/")) {
      const resolved = resolvePath(def.command);
      return isExecutableFile(resolved) ? resolved : null;
    }
    return findOnPath(def.command, path, extra);
  }
  for (const name of names) {
    const found = findOnPath(name, path, extra);
    if (found) return found;
  }
  return null;
}

/**
 * Resolves the launch for an agent definition, or returns a message saying
 * why it can't start (for instance, OpenCode isn't installed).
 */
export async function resolveAcpLaunch(def: AcpAgentDefinition): Promise<AcpLaunch | string> {
  const path = await shellPath();
  const env: Record<string, string> = { ...AGENT_DISPATCH_ENV, PATH: path };

  const testAgent = process.env.BAND_TEST_ACP_AGENT;
  if (testAgent) {
    return { command: process.execPath, args: [testAgent], env };
  }

  switch (def.type) {
    case "claude-code": {
      const claude = binary(def, ["claude"], path);
      if (claude) env.CLAUDE_CODE_EXECUTABLE = claude;
      return {
        command: nodeFor(path),
        args: [adapterScript("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")],
        env,
      };
    }
    case "codex": {
      const codex = binary(def, ["codex"], path);
      if (codex) env.CODEX_PATH = codex;
      return {
        command: nodeFor(path),
        args: [adapterScript("@agentclientprotocol/codex-acp", "codex-acp")],
        env,
      };
    }
    case "opencode": {
      const bin = binary(def, ["opencode"], path, [join(homedir(), ".opencode", "bin")]);
      return bin
        ? { command: bin, args: ["acp"], env }
        : "OpenCode is not installed, or not on your PATH";
    }
    case "gemini-cli": {
      const bin = binary(def, ["gemini"], path);
      // Gemini CLI relaunches itself with a larger heap on start, and the
      // relaunched child loses whatever was written to stdin before it read
      // it, `initialize` included.
      return bin
        ? { command: bin, args: ["--acp"], env: { ...env, GEMINI_CLI_NO_RELAUNCH: "true" } }
        : "Gemini CLI is not installed, or not on your PATH";
    }
    case "cursor-cli": {
      // `cursor-agent` first: `agent` is a generic name another tool on the
      // PATH could own.
      const bin = binary(def, ["cursor-agent", "agent"], path);
      return bin
        ? { command: bin, args: ["acp"], env }
        : "Cursor CLI is not installed, or not on your PATH";
    }
    default:
      return `Unknown agent type: ${def.type}`;
  }
}
