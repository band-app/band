/**
 * Sync the CLI-shipped skills (`band`, `band-chat`, `band-terminal`,
 * `band-browser`, `band-start`, `band-loop`) into the local host's shared
 * skills directory and link each detected coding agent to it. The host does
 * the work (`host.agentEnv.installSkills`, in `packages/host-local/src/agents/skills-install.ts`);
 * this module logs what it reports.
 */

import type { InstallSkillsResult } from "@band-app/host-api";
import { hostRegistry } from "../infra/host/registry";

interface InstallSkillsOptions {
  /** Override $HOME (test-only; production callers leave it unset). */
  home?: string;
  /** Pino-compatible logger for write, update, skip and conflict decisions. */
  log?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
  };
}

export async function installSkills(opts: InstallSkillsOptions = {}): Promise<InstallSkillsResult> {
  const result = await hostRegistry.local.agentEnv.installSkills({ home: opts.home });
  const log = opts.log;
  if (log) {
    for (const warning of result.warnings) log.warn(warning);
    for (const path of result.written) log.info("Installed skill at %s", path);
    for (const path of result.updated) {
      log.info("Updated skill at %s (content differed — shipped version reinstalled)", path);
    }
    for (const conflict of result.conflicts) {
      log.warn("Skill symlink conflict — %s (left as-is; remove it manually to re-link)", conflict);
    }
  }
  return result;
}
