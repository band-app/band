import { z } from "zod";

const claudeCodeConfigSchema = z.object({
  type: z.literal("claude-code"),
  workspaceDir: z.string().default(process.cwd()),
  maxTurns: z.number().int().positive().default(3),
  options: z
    .object({
      model: z.string().optional(),
      executablePath: z.string().optional(),
    })
    .default({}),
});

const cursorCliConfigSchema = z.object({
  type: z.literal("cursor-cli"),
  workspaceDir: z.string().default(process.cwd()),
  maxTurns: z.number().int().positive().default(3),
  options: z
    .object({
      model: z.string().default("auto"),
    })
    .default({}),
});

const openaiCodexConfigSchema = z.object({
  type: z.literal("openai-codex"),
  workspaceDir: z.string().default(process.cwd()),
  maxTurns: z.number().int().positive().default(3),
  options: z
    .object({
      model: z.string().optional(),
      sandboxMode: z.enum(["docker", "firecracker"]).optional(),
    })
    .default({}),
});

const geminiCliConfigSchema = z.object({
  type: z.literal("gemini-cli"),
  workspaceDir: z.string().default(process.cwd()),
  maxTurns: z.number().int().positive().default(3),
  options: z
    .object({
      model: z.string().optional(),
      executablePath: z.string().optional(),
    })
    .default({}),
});

export const codingAgentConfigSchema = z.discriminatedUnion("type", [
  claudeCodeConfigSchema,
  cursorCliConfigSchema,
  openaiCodexConfigSchema,
  geminiCliConfigSchema,
]);

export type CodingAgentConfig = z.infer<typeof codingAgentConfigSchema>;

export type ClaudeCodeConfig = z.infer<typeof claudeCodeConfigSchema>;
export type CursorCliConfig = z.infer<typeof cursorCliConfigSchema>;
export type OpenAICodexConfig = z.infer<typeof openaiCodexConfigSchema>;
export type GeminiCliConfig = z.infer<typeof geminiCliConfigSchema>;
