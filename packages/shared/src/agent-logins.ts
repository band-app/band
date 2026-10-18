/**
 * Which environment variables a Band-managed coding agent login sets.
 *
 * A login has a `kind`. The kind decides the variable that carries the secret, any fixed variables
 * that go with it, and the variables of the same agent that would compete with it. The hub sets
 * `env` and removes `clears` from the one process it starts. The UI reads the same table to offer
 * the kinds of an agent.
 */

export interface AgentLoginKind {
  /** Stored on the login. Unique within an agent type. */
  id: string;
  label: string;
  /** The variable that carries the secret. */
  secretVar: string;
  /** More variables that take the secret's value (an agent that reads either of two names). */
  alsoSecretVars?: string[];
  /** Variables with a fixed value that the agent needs to use the secret. */
  fixedEnv?: Record<string, string>;
  /** Inherited variables of the same agent that would win over the secret, removed from the child. */
  clears: string[];
  /** One line for the Add form. */
  note?: string;
}

export const AGENT_LOGIN_KINDS: Record<string, AgentLoginKind[]> = {
  "claude-code": [
    {
      id: "setup-token",
      label: "Setup token (claude setup-token)",
      secretVar: "CLAUDE_CODE_OAUTH_TOKEN",
      clears: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
      note: "A setup token cannot use Remote Control or claude.ai connectors.",
    },
    {
      id: "api-key",
      label: "Anthropic API key",
      secretVar: "ANTHROPIC_API_KEY",
      clears: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
    },
  ],
  codex: [
    {
      id: "api-key",
      label: "OpenAI API key",
      secretVar: "OPENAI_API_KEY",
      // The Codex ACP adapter reads CODEX_API_KEY first. DEFAULT_AUTH_REQUEST makes it sign in with
      // the key when the machine holds no Codex login. A ChatGPT login already on the machine
      // keeps winning until phase 2 gives each login its own CODEX_HOME.
      alsoSecretVars: ["CODEX_API_KEY"],
      fixedEnv: { DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}' },
      clears: [],
    },
  ],
  opencode: [
    {
      id: "anthropic-api-key",
      label: "Anthropic API key",
      secretVar: "ANTHROPIC_API_KEY",
      clears: [],
    },
    { id: "openai-api-key", label: "OpenAI API key", secretVar: "OPENAI_API_KEY", clears: [] },
    {
      id: "openrouter-api-key",
      label: "OpenRouter API key",
      secretVar: "OPENROUTER_API_KEY",
      clears: [],
    },
    { id: "gemini-api-key", label: "Gemini API key", secretVar: "GEMINI_API_KEY", clears: [] },
  ],
  "gemini-cli": [
    {
      id: "api-key",
      label: "Gemini API key",
      secretVar: "GEMINI_API_KEY",
      clears: ["GOOGLE_API_KEY"],
    },
  ],
  "cursor-cli": [
    { id: "api-key", label: "Cursor API key", secretVar: "CURSOR_API_KEY", clears: [] },
  ],
  amp: [{ id: "api-key", label: "Amp API key", secretVar: "AMP_API_KEY", clears: [] }],
  copilot: [{ id: "token", label: "GitHub token", secretVar: "COPILOT_GITHUB_TOKEN", clears: [] }],
};

export function loginKindsFor(agentType: string): AgentLoginKind[] {
  return AGENT_LOGIN_KINDS[agentType] ?? [];
}

export function findLoginKind(agentType: string, kind: string): AgentLoginKind | undefined {
  return loginKindsFor(agentType).find((k) => k.id === kind);
}

/** What one login adds to, and removes from, the environment of an agent process. */
export interface LoginEnv {
  env: Record<string, string>;
  unsetEnv: string[];
}

/** The environment a login with this kind and secret gives a process. */
export function loginEnvFor(kind: AgentLoginKind, secret: string): LoginEnv {
  const env: Record<string, string> = { ...kind.fixedEnv, [kind.secretVar]: secret };
  for (const name of kind.alsoSecretVars ?? []) env[name] = secret;
  const unsetEnv = kind.clears.filter((name) => !(name in env));
  return { env, unsetEnv };
}

const LOGIN_SECRET_VARS = new Set(
  Object.values(AGENT_LOGIN_KINDS).flatMap((kinds) =>
    kinds.flatMap((k) => [k.secretVar, ...(k.alsoSecretVars ?? [])]),
  ),
);

/**
 * A function that replaces the values of login secret variables found in `env` with `[redacted]`.
 * For text that may echo an agent's credential, such as its stderr or an error it raised.
 */
export function loginSecretScrubber(env: Record<string, string>): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => LOGIN_SECRET_VARS.has(name) && value.length >= 4)
    .map(([, value]) => value);
  if (secrets.length === 0) return (text) => text;
  return (text) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/** The most a vault item for a login may hold. */
export const MAX_LOGIN_SECRET_LENGTH = 8 * 1024;
