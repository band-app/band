import type { HookAgentType, HooksStatus } from "@band-app/host-api";
import { checkCodexHooks, installCodexHooks, removeCodexHooks } from "./hooks-codex";
import { geminiSpec } from "./hooks-gemini";
import * as claude from "./hooks-install";
import { checkJsonHooks, installJsonHooks, removeJsonHooks } from "./hooks-json-agent";
import { checkOpencodeHooks, installOpencodeHooks, removeOpencodeHooks } from "./hooks-opencode";

/**
 * Band's status hooks per coding agent, on this machine. Each agent keeps its
 * hooks in its own config (`~/.claude/settings.json`, Codex's `hooks.json`
 * plus its trust table in `config.toml`, `~/.gemini/settings.json`, an
 * OpenCode plugin file), and every install keeps the entries it did not write.
 */
export function checkHooks(agent: HookAgentType = "claude-code"): Promise<HooksStatus> {
  switch (agent) {
    case "claude-code":
      return claude.checkHooks();
    case "codex":
      return checkCodexHooks();
    case "gemini-cli":
      return checkJsonHooks(geminiSpec);
    case "opencode":
      return checkOpencodeHooks();
  }
}

export function installHooks(agent: HookAgentType = "claude-code"): Promise<void> {
  switch (agent) {
    case "claude-code":
      return claude.installHooks();
    case "codex":
      return installCodexHooks();
    case "gemini-cli":
      return installJsonHooks(geminiSpec);
    case "opencode":
      return installOpencodeHooks();
  }
}

export function removeHooks(agent: HookAgentType = "claude-code"): Promise<void> {
  switch (agent) {
    case "claude-code":
      return claude.removeHooks();
    case "codex":
      return removeCodexHooks();
    case "gemini-cli":
      return removeJsonHooks(geminiSpec);
    case "opencode":
      return removeOpencodeHooks();
  }
}
