// Integration test for Band-managed coding agent logins. A real hub (the
// production bundle on a random port, auth on) keeps logins in its vault. The coding agent is the
// scripted ACP stub, which records the credential variables it finds in its own environment. The
// TUI case runs a shell script as the agent's CLI and prints its environment.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  type StubRequest,
  startAcpServer,
  stubRequests,
  TEST_TOKEN,
  trpc,
  turnEnded,
} from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const SETUP_TOKEN = "sk-ant-oat01-SETUPTOKEN-plaintext-1111";
const OTHER_TOKEN = "sk-ant-oat01-OTHERTOKEN-plaintext-2222";
const API_KEY = "sk-ant-api03-APIKEY-plaintext-3333";
const CODEX_KEY = "sk-proj-CODEXKEY-plaintext-4444";
const HUB_ENV_KEY = "sk-ant-api03-HUB-ENV-KEY-5555";
const ROTATED_KEY = "sk-ant-api03-ROTATED-plaintext-6666";
const REPAIRED_TOKEN = "sk-ant-oat01-REPAIRED-plaintext-9999";
const SECRETS = [SETUP_TOKEN, OTHER_TOKEN, API_KEY, CODEX_KEY, ROTATED_KEY, REPAIRED_TOKEN];

const NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "DEFAULT_AUTH_REQUEST",
];

const ALPHA = testWorktreeId("alpha", "main");
const BETA = testWorktreeId("beta", "main");

interface Login {
  id: string;
  agentType: string;
  label: string;
  kind: string;
  vaultItemId: string;
  missingSecret: boolean;
}
interface LoginList {
  logins: Login[];
  defaults: Record<string, string>;
  repoOverrides: { agentType: string; repo: string; loginId: string }[];
}

let home: string;
let server: ServerHandle;

const authHeaders = { Cookie: `band_token=${TEST_TOKEN}` };

async function sendMessage(worktreeId: string, chatId: string, text: string) {
  const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

/** Starts a chat's agent and returns the environment the stub saw, for the chat's first session. */
async function agentEnvOf(
  worktreeId: string,
  chatId: string,
  opts: { agent?: string; loginId?: string } = {},
): Promise<StubRequest["env"]["NAMED"]> {
  await trpc(server.url, "chats.create", { worktreeId, id: chatId, agent: opts.agent });
  if (opts.loginId) await trpc(server.url, "chats.update", { chatId, loginId: opts.loginId });
  await sendMessage(worktreeId, chatId, "hello");
  const request = await waitFor(
    () => stubRequests(home, "session/new").find((r) => r.env.BAND_CHAT_ID === chatId),
    { label: `agent of ${chatId} started` },
  );
  return request.env.NAMED;
}

const create = (input: object) =>
  trpc<{ login: Login }>(server.url, "agentLogins.create", input).then((r) => r.login);
const list = () => trpc<LoginList>(server.url, "agentLogins.list", undefined, "query");

function writeEnvCli(dir: string): string {
  const path = join(dir, "env-cli.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'LOGIN:%s|%s|\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "\${ANTHROPIC_API_KEY-unset}"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

beforeAll(async () => {
  home = createTmpHome("band-agent-logins-");
  const alpha = join(home, "alpha");
  const beta = join(home, "beta");
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  seedState(home, {
    repos: [
      {
        name: "alpha",
        path: alpha,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: alpha }],
      },
      {
        name: "beta",
        path: beta,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: beta }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: writeEnvCli(home) },
      { id: "codex", type: "codex", label: "Codex" },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startAcpServer({
    home,
    // An agent that fails on its credential and prints it to stderr.
    turns: [
      {
        match: "^echo-key",
        steps: [{ stderr: `auth failed: the key ${SETUP_TOKEN} was rejected` }, { exit: 1 }],
      },
    ],
    env: {
      // The hub's own environment holds an API key, which a Claude setup-token login must override.
      ANTHROPIC_API_KEY: HUB_ENV_KEY,
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_LOG_ENV: NAMES.join(","),
    },
  });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("agent logins", () => {
  it("gives agents the machine's own environment while no login exists", async () => {
    const named = await agentEnvOf(ALPHA, "chat-plain");
    expect(named).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: null,
      ANTHROPIC_API_KEY: HUB_ENV_KEY,
      CODEX_API_KEY: null,
      DEFAULT_AUTH_REQUEST: null,
    });
  });

  let setupLogin: Login;
  let otherLogin: Login;
  let keyLogin: Login;

  it("adds a login with a secret and shows it without the secret", async () => {
    setupLogin = await create({
      agentType: "claude-code",
      kind: "setup-token",
      label: "Team subscription",
      secret: SETUP_TOKEN,
    });
    otherLogin = await create({
      agentType: "claude-code",
      kind: "setup-token",
      label: "Second subscription",
      secret: OTHER_TOKEN,
    });
    keyLogin = await create({
      agentType: "claude-code",
      kind: "api-key",
      label: "API key",
      secret: API_KEY,
    });

    const listed = await list();
    expect(listed.logins.map((l) => l.label)).toEqual([
      "Team subscription",
      "Second subscription",
      "API key",
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/plaintext/);

    // The secret is in the vault, as an item that `vault.list` describes without it.
    const vault = await trpc<{ items: { id: string; name: string }[] }>(
      server.url,
      "vault.list",
      undefined,
      "query",
    );
    expect(vault.items.map((i) => i.id)).toContain(setupLogin.vaultItemId);
    expect(JSON.stringify(vault)).not.toMatch(/plaintext/);

    // A bad kind is refused.
    await expect(
      create({ agentType: "claude-code", kind: "nonsense", label: "x", secret: "y" }),
    ).rejects.toThrow(/\(400\)/);
  });

  it("injects the default login and removes the competing key", async () => {
    await trpc(server.url, "agentLogins.setDefault", {
      agentType: "claude-code",
      loginId: setupLogin.id,
    });
    const named = await agentEnvOf(ALPHA, "chat-default");
    expect(named?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SETUP_TOKEN);
    expect(named?.ANTHROPIC_API_KEY).toBeNull();
  });

  it("scrubs the login's secret from an agent's stderr before it reaches the failure card", async () => {
    const chatId = "chat-leak";
    await trpc(server.url, "chats.create", { worktreeId: ALPHA, id: chatId });
    const stream = await openStream(server.url, chatId, {
      until: (e) => turnEnded(e),
      timeoutMs: 20_000,
    });
    await sendMessage(ALPHA, chatId, "echo-key");
    const events = await stream.events;
    const ended = events.find((e) => e.type === "turn-ended");
    const failure = ended?.type === "turn-ended" ? ended.failure : undefined;
    expect(failure?.stderrTail).toContain("[redacted]");
    expect(JSON.stringify(events)).not.toContain(SETUP_TOKEN);
  });

  it("uses a repo override in that repo, the default elsewhere, and a chat's pick over both", async () => {
    await trpc(server.url, "agentLogins.setRepoOverride", {
      agentType: "claude-code",
      repo: "beta",
      loginId: otherLogin.id,
    });
    expect((await agentEnvOf(BETA, "chat-beta"))?.CLAUDE_CODE_OAUTH_TOKEN).toBe(OTHER_TOKEN);
    expect((await agentEnvOf(ALPHA, "chat-alpha"))?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SETUP_TOKEN);

    const picked = await agentEnvOf(BETA, "chat-picked", { loginId: keyLogin.id });
    expect(picked?.ANTHROPIC_API_KEY).toBe(API_KEY);
    expect(picked?.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
  });

  it("refuses a chat pick that belongs to another agent", async () => {
    await trpc(server.url, "chats.create", { worktreeId: ALPHA, id: "chat-bad-pick" });
    await expect(
      trpc(server.url, "chats.update", { chatId: "chat-bad-pick", loginId: "al-nope" }),
    ).rejects.toThrow(/\(400\)/);
  });

  it("starts a TUI agent with the login in its environment, outside the saved layout", async () => {
    const terminalId = "7d2a5b8c-3e4f-4a71-9c1d-2e3f4a5b6c7d";
    await trpc(server.url, "agentSessions.launch", {
      worktreeId: BETA,
      mode: "tui",
      terminalId,
    });
    const output = await waitFor(
      async () => {
        const data = await trpc<{ output: string }>(
          server.url,
          "terminal.output",
          { terminalId },
          "query",
        ).catch(() => undefined);
        return data?.output.match(/LOGIN:.*\|.*\|/)?.[0];
      },
      { label: "agent CLI printed its login" },
    );
    expect(output).toBe(`LOGIN:${OTHER_TOKEN}|unset|`);

    // The layout rows (panel states) hold no secret.
    const db = readFileSync(join(home, ".band", "band.db"));
    const wal = join(home, ".band", "band.db-wal");
    for (const secret of SECRETS) {
      expect(db.includes(secret)).toBe(false);
      if (existsSync(wal)) expect(readFileSync(wal).includes(secret)).toBe(false);
    }
    await trpc(server.url, "terminal.kill", { terminalId });
  });

  it("sets OPENAI_API_KEY, CODEX_API_KEY and the default auth request for a Codex key login", async () => {
    const login = await create({
      agentType: "codex",
      kind: "api-key",
      label: "Codex key",
      secret: CODEX_KEY,
    });
    await trpc(server.url, "agentLogins.setDefault", { agentType: "codex", loginId: login.id });
    const named = await agentEnvOf(ALPHA, "chat-codex", { agent: "codex" });
    expect(named).toMatchObject({
      OPENAI_API_KEY: CODEX_KEY,
      CODEX_API_KEY: CODEX_KEY,
      DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}',
    });
  });

  it("marks a login whose vault item is gone and falls back to the machine login", async () => {
    await trpc(server.url, "vault.delete", { id: otherLogin.vaultItemId });
    const listed = await list();
    expect(listed.logins.find((l) => l.id === otherLogin.id)?.missingSecret).toBe(true);
    // beta's override is unusable, so beta falls back to the default login.
    expect((await agentEnvOf(BETA, "chat-missing"))?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SETUP_TOKEN);
  });

  it("renames a login, replaces its secret and repairs a missing one", async () => {
    // keyLogin's secret is replaced in place, so the same vault item serves the new value.
    const renamed = await trpc<{ login: Login }>(server.url, "agentLogins.update", {
      id: keyLogin.id,
      label: "API key (rotated)",
      secret: ROTATED_KEY,
    });
    expect(renamed.login).toMatchObject({ id: keyLogin.id, label: "API key (rotated)" });
    expect(renamed.login.missingSecret).toBe(false);
    expect(
      (await agentEnvOf(ALPHA, "chat-rotated", { loginId: keyLogin.id }))?.ANTHROPIC_API_KEY,
    ).toBe(ROTATED_KEY);

    // otherLogin lost its vault item earlier. A new secret gives it a new item and clears the flag.
    const repaired = await trpc<{ login: Login }>(server.url, "agentLogins.update", {
      id: otherLogin.id,
      secret: REPAIRED_TOKEN,
    });
    expect(repaired.login.missingSecret).toBe(false);
    expect(
      (await agentEnvOf(ALPHA, "chat-repaired", { loginId: otherLogin.id }))
        ?.CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe(REPAIRED_TOKEN);
  });

  it("clears a default and an override when the login is removed", async () => {
    await trpc(server.url, "agentLogins.remove", { id: setupLogin.id });
    const listed = await list();
    expect(listed.defaults["claude-code"]).toBeUndefined();
    expect(listed.logins.map((l) => l.id)).not.toContain(setupLogin.id);
    // Its vault item went with it.
    const vault = await trpc<{ items: { id: string }[] }>(
      server.url,
      "vault.list",
      undefined,
      "query",
    );
    expect(vault.items.map((i) => i.id)).not.toContain(setupLogin.vaultItemId);
  });

  it("keeps every secret out of the hub's output and settings file", () => {
    const settings = readFileSync(join(home, ".band", "settings.json"), "utf8");
    for (const secret of SECRETS) {
      expect(server.output()).not.toContain(secret);
      expect(settings).not.toContain(secret);
    }
  });

  it("answers a call with no token with 401", async () => {
    const query = await fetch(`${server.url}/trpc/agentLogins.list`);
    const mutation = await fetch(`${server.url}/trpc/agentLogins.setDefault`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentType: "claude-code", loginId: null }),
    });
    expect(query.status).toBe(401);
    expect(mutation.status).toBe(401);
  });

  it("answers a non-admin device token with 403 on every procedure", async () => {
    const created = await trpcMutate(
      server.url,
      "tokens.createDevice",
      { label: "viewer" },
      TEST_TOKEN,
    );
    const { token } = await trpcData<{ token: string }>(created);
    const attempts = [
      trpcQuery(server.url, "agentLogins.list", undefined, token),
      trpcMutate(
        server.url,
        "agentLogins.create",
        { agentType: "claude-code", kind: "api-key", label: "x", secret: "y" },
        token,
      ),
      trpcMutate(server.url, "agentLogins.update", { id: keyLogin.id, label: "z" }, token),
      trpcMutate(server.url, "agentLogins.remove", { id: keyLogin.id }, token),
      trpcMutate(
        server.url,
        "agentLogins.setDefault",
        { agentType: "claude-code", loginId: keyLogin.id },
        token,
      ),
      trpcMutate(
        server.url,
        "agentLogins.setRepoOverride",
        { agentType: "claude-code", repo: "alpha", loginId: keyLogin.id },
        token,
      ),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect((await list()).logins.map((l) => l.id)).toContain(keyLogin.id);
  });
});
