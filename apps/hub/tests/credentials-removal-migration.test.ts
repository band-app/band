// The removal of agent logins and the `git` vault kind, against an install from before it: the
// migrations up to `drop_agent_logins`, then seeded agent logins, `git` items, a chat that picked a
// login and a settings file whose worker profile uses `credentials`, then a real boot. A second
// boot checks that nothing changes again.

import { createCipheriv, randomBytes } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";

const migrationsDir = join(import.meta.dirname, "../src/server/infra/db/migrations");
const MIGRATION = "20261113084052_drop_agent_logins";
const TOKEN = "credentials-removal-migration-secret";
const VAULT_KEY = randomBytes(32);

let home: string;
let server: ServerHandle | undefined;
const dbPath = () => join(home, ".band", "band.db");
const settingsPath = () => join(home, ".band", "settings.json");

/** The vault's blob format: `v1:` + base64(nonce || ciphertext || tag), the item id as AAD. */
function encrypt(id: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", VAULT_KEY, nonce);
  cipher.setAAD(Buffer.from(id, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64")}`;
}

const boot = () =>
  startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_LOCAL_HOST: "off",
      BAND_SERVE_UI: "false",
      BAND_VAULT_KEY: VAULT_KEY.toString("base64"),
    },
  });

const q = async <T>(procedure: string, input?: unknown) => {
  const res = await trpcQuery((server as ServerHandle).url, procedure, input, TOKEN);
  expect(res.status).toBe(200);
  return trpcData<T>(res);
};

const encryptedBefore: Record<string, string> = {};

beforeAll(async () => {
  home = createTmpHome("band-credentials-removal-migration-");
  seedSettings(home, { tokenSecret: TOKEN });
  const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
  settings.workerProfiles = [
    {
      name: "agents",
      trust: "restricted",
      credentials: { git: ["gh-org"], gh: "gh-org", agentLogins: ["claude-team", "login-codex"] },
    },
    { name: "plain", trust: "standard" },
  ];
  writeFileSync(settingsPath(), JSON.stringify(settings));

  const before = join(home, "migrations-before");
  cpSync(migrationsDir, before, { recursive: true });
  const names = readdirSync(before).filter((n) => /^\d/.test(n));
  expect(names).toContain(MIGRATION);
  for (const name of names.filter((n) => n >= MIGRATION)) {
    rmSync(join(before, name), { recursive: true });
  }
  const sqlite = new DatabaseSync(dbPath());
  migrate(drizzle({ client: sqlite }), { migrationsFolder: before });

  const items = [
    {
      id: "v-org",
      name: "gh-org",
      kind: "git",
      metadata: { host: "github.com", pathPattern: "acme/**", username: "x-access-token" },
      value: "org-value",
    },
    {
      id: "v-all",
      name: "gh-all",
      kind: "git",
      metadata: { host: "github.com", pathPattern: "**", username: "x-access-token" },
      value: "all-value",
    },
    {
      id: "v-gitlab",
      name: "gitlab",
      kind: "git",
      metadata: { host: "gitlab.com", pathPattern: "**", username: "oauth2" },
      value: "gitlab-value",
    },
    { id: "v-claude", name: "claude-login", kind: "api_key", metadata: {}, value: "claude-value" },
    { id: "v-codex", name: "codex-login", kind: "api_key", metadata: {}, value: "codex-value" },
  ];
  const insertItem = sqlite.prepare(
    "INSERT INTO vault_items (id, name, kind, scope, encrypted, metadata, created_at, updated_at) VALUES (?, ?, ?, 'global', ?, ?, 1, 1)",
  );
  for (const item of items) {
    encryptedBefore[item.id] = encrypt(item.id, item.value);
    insertItem.run(
      item.id,
      item.name,
      item.kind,
      encryptedBefore[item.id],
      JSON.stringify(item.metadata),
    );
  }
  sqlite.exec(`
    INSERT INTO agent_logins (id, agent_type, label, kind, vault_item_id, created_at, updated_at) VALUES
      ('login-claude', 'claude-code', 'claude-team', 'setup-token', 'v-claude', 1, 1),
      ('login-codex', 'codex', 'codex-team', 'api-key', 'v-codex', 1, 1);
    INSERT INTO agent_login_choices (agent_type, repo, login_id) VALUES ('claude-code', '', 'login-claude');
  `);
  // A chat whose state picked a login, written with whatever columns panel_states has here.
  const columns = sqlite.prepare("PRAGMA table_info(panel_states)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const values: Record<string, unknown> = {
    id: "chat-1",
    worktree_id: "r-main",
    panel_type: "chat",
    state: JSON.stringify({ agentType: "claude-code", loginId: "login-claude", label: "kept" }),
    created_at: 1,
    updated_at: 1,
  };
  const used = columns.filter((c) => c.name in values || (c.notnull && c.dflt_value === null));
  sqlite
    .prepare(
      `INSERT INTO panel_states (${used.map((c) => c.name).join(", ")}) VALUES (${used.map(() => "?").join(", ")})`,
    )
    .run(...used.map((c) => (values[c.name] ?? "") as string | number));
  sqlite.close();

  server = await boot();
}, 120_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface VaultRow {
  name: string;
  kind: string;
  metadata?: Record<string, unknown>;
}
interface ProfileRow {
  name: string;
  secrets?: Array<{ item: string; env?: string; file?: string }>;
  credentials?: unknown;
}

describe("removing agent logins and the git vault kind", () => {
  it("turns each git item into an api_key item and keeps its value", async () => {
    const { items } = await q<{ items: VaultRow[] }>("vault.list");
    for (const name of ["gh-org", "gh-all", "gitlab"]) {
      const item = items.find((i) => i.name === name);
      expect(item?.kind).toBe("api_key");
      expect(JSON.stringify(item?.metadata ?? {})).not.toMatch(/pathPattern|"host"|username/);
    }
    const sqlite = new DatabaseSync(dbPath(), { readOnly: true });
    try {
      const rows = sqlite.prepare("SELECT id, encrypted FROM vault_items").all() as Array<{
        id: string;
        encrypted: string;
      }>;
      for (const row of rows) expect(row.encrypted).toBe(encryptedBefore[row.id]);
      const tables = (
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_login%'",
          )
          .all() as Array<{ name: string }>
      ).map((t) => t.name);
      expect(tables).toEqual([]);
      const state = (
        sqlite.prepare("SELECT state FROM panel_states WHERE id = 'chat-1'").get() as {
          state: string;
        }
      ).state;
      expect(JSON.parse(state)).toEqual({ agentType: "claude-code", label: "kept" });
    } finally {
      sqlite.close();
    }
  });

  it("rewrites the profile's credentials into secret mappings", async () => {
    const { profiles, invalid } = await q<{ profiles: ProfileRow[]; invalid: unknown[] }>(
      "workerProfiles.list",
    );
    expect(invalid).toEqual([]);
    const agents = profiles.find((p) => p.name === "agents");
    expect(agents?.credentials).toBeUndefined();
    expect(agents?.secrets).toEqual([
      { item: "gh-org", env: "GH_TOKEN" },
      { item: "claude-login", env: "CLAUDE_CODE_OAUTH_TOKEN" },
      { item: "codex-login", env: "OPENAI_API_KEY" },
    ]);
    expect(profiles.find((p) => p.name === "plain")?.secrets).toBeUndefined();
  });

  it("sets the Hub GitHub token to the broadest github.com item", async () => {
    const settings = await q<{ hubGithubToken?: string | null }>("settings.get");
    expect(settings.hubGithubToken).toBe("gh-all");
  });

  it("changes nothing on a second boot", async () => {
    // Other boot steps may write the file too; the converter's fields must stay as they are.
    const converted = () => {
      const { workerProfiles, hubGithubToken } = JSON.parse(readFileSync(settingsPath(), "utf8"));
      return { workerProfiles, hubGithubToken };
    };
    const before = converted();
    await server?.close();
    server = await boot();
    expect(converted()).toEqual(before);
    const { profiles } = await q<{ profiles: ProfileRow[] }>("workerProfiles.list");
    expect(profiles.find((p) => p.name === "agents")?.secrets).toHaveLength(3);
  }, 60_000);
});
