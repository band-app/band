// Which Claude login the usage reader sends. The Keychain is faked by a `security` executable
// first on PATH, so the production code runs unchanged. The Keychain path only exists on macOS.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readClaudeUsage } from "../src/usage/claude-usage.ts";

const HOUR = 3_600_000;
const body = {
  five_hour: { utilization: 10, resets_at: new Date(Date.now() + HOUR).toISOString() },
};

function credentials(token: string, expiresAt?: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: token, subscriptionType: "max", expiresAt },
  });
}

async function scenario(options: {
  file?: string;
  keychain?: string;
  run: (ctx: { tokens: string[]; keychainReads: () => number }) => Promise<void>;
}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "band-claude-login-"));
  const tokens: string[] = [];
  const server = createServer((req, res) => {
    tokens.push((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const saved = { ...process.env };
  try {
    mkdirSync(join(root, "home", ".claude"), { recursive: true });
    mkdirSync(join(root, "bin"));
    if (options.file)
      writeFileSync(join(root, "home", ".claude", ".credentials.json"), options.file);
    const marker = join(root, "keychain-reads");
    const script = options.keychain
      ? `#!/bin/sh\necho x >> '${marker}'\ncat <<'EOT'\n${options.keychain}\nEOT\n`
      : `#!/bin/sh\necho x >> '${marker}'\nexit 44\n`;
    writeFileSync(join(root, "bin", "security"), script);
    chmodSync(join(root, "bin", "security"), 0o755);
    process.env.HOME = join(root, "home");
    process.env.PATH = `${join(root, "bin")}:${saved.PATH}`;
    process.env.BAND_CLAUDE_USAGE_URL = `http://127.0.0.1:${port}/usage`;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.BAND_USAGE_KEYCHAIN;
    const reads = () => {
      try {
        return readFileSync(marker, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    };
    await options.run({ tokens, keychainReads: reads });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    if (saved.BAND_USAGE_KEYCHAIN === undefined) delete process.env.BAND_USAGE_KEYCHAIN;
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const mac = process.platform === "darwin";

test("a fresh Keychain login wins over an expired file", { skip: !mac }, async () => {
  await scenario({
    file: credentials("file-token", Date.now() - HOUR),
    keychain: credentials("keychain-token", Date.now() + HOUR),
    run: async ({ tokens }) => {
      const usage = await readClaudeUsage();
      assert.equal(usage.status, "ok");
      assert.deepEqual(tokens, ["keychain-token"]);
    },
  });
});

test("an unexpired file is used and the Keychain is not read", { skip: !mac }, async () => {
  await scenario({
    file: credentials("file-token", Date.now() + HOUR),
    keychain: credentials("keychain-token", Date.now() + HOUR),
    run: async ({ tokens, keychainReads }) => {
      assert.equal((await readClaudeUsage()).status, "ok");
      assert.deepEqual(tokens, ["file-token"]);
      assert.equal(keychainReads(), 0);
    },
  });
});

test("credentials without expiresAt count as valid", async () => {
  await scenario({
    file: credentials("file-token"),
    run: async ({ tokens }) => {
      assert.equal((await readClaudeUsage()).status, "ok");
      assert.deepEqual(tokens, ["file-token"]);
    },
  });
});

test("only expired logins send nothing and report idle", async () => {
  await scenario({
    file: credentials("file-token", Date.now() - HOUR),
    keychain: mac ? credentials("keychain-token", Date.now() - 2 * HOUR) : undefined,
    run: async ({ tokens }) => {
      const usage = await readClaudeUsage();
      assert.equal(usage.status, "idle");
      assert.deepEqual(tokens, []);
    },
  });
});
