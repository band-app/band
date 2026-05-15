import type { CodingAgentConfig } from "./config.js";
import type { CodingAgent } from "./types.js";

export async function createCodingAgent(config: CodingAgentConfig): Promise<CodingAgent> {
  switch (config.type) {
    case "claude-code": {
      const { ClaudeCodeAdapter } = await import("./adapters/claude-code.js");
      return new ClaudeCodeAdapter(config);
    }
    case "cursor-cli": {
      const { CursorCliAdapter } = await import("./adapters/cursor-cli.js");
      return new CursorCliAdapter(config);
    }
    case "codex": {
      const { CodexAdapter } = await import("./adapters/codex.js");
      return new CodexAdapter(config);
    }
    case "gemini-cli": {
      const { GeminiCliAdapter } = await import("./adapters/gemini-cli.js");
      return new GeminiCliAdapter(config);
    }
    case "opencode": {
      const { OpenCodeAdapter } = await import("./adapters/opencode.js");
      return new OpenCodeAdapter(config);
    }
    default:
      throw new Error(`Unknown agent type: ${(config as { type: string }).type}`);
  }
}
