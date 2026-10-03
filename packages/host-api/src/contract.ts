/**
 * The behaviour every `Host` implementation must have. A host's own test file
 * calls {@link runHostContract} with the test framework's functions and a way
 * to create the host, so the same suite runs against `LocalHost` and, later,
 * a remote host over a loopback link.
 *
 * The suite uses the real thing for each method: real git, a real file
 * system, a real PTY and a real process. It stays on the host through the
 * `Host` interface, so a remote host runs it unchanged.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { FileChange, Host, TerminalExitEvent } from "./index";

/** The slice of the test framework the suite needs. Vitest's exports fit. */
export interface ContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  beforeAll(fn: () => Promise<void> | void): void;
  afterAll(fn: () => Promise<void> | void): void;
}

export interface HostFixture {
  host: Host;
  /** An empty directory on the host the suite may fill. */
  workDir: string;
  /** Called once after the suite. Removes `workDir` and stops anything started. */
  dispose(): Promise<void>;
}

export interface HostContractOptions {
  api: ContractTestApi;
  create(): Promise<HostFixture>;
}

const TIMEOUT_MS = 10_000;

async function waitFor<T>(what: string, read: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export function runHostContract(name: string, { api, create }: HostContractOptions): void {
  const { describe, it, beforeAll, afterAll } = api;

  describe(`Host contract: ${name}`, () => {
    let fixture: HostFixture;
    let host: Host;
    let repo: string;

    /** `git` with an identity, so commits work on a machine with no git config. */
    const git = (args: string[], cwd: string) =>
      host.git.exec(["-c", "user.name=Band", "-c", "user.email=band@example.com", ...args], cwd);

    beforeAll(async () => {
      fixture = await create();
      host = fixture.host;
      repo = join(fixture.workDir, "repo");
      await host.fs.mkdir(repo, { recursive: true });
      await git(["init", "-b", "main"], repo);
      await host.fs.writeFile(join(repo, "hello.txt"), "hello contract\n");
      await git(["add", "."], repo);
      await git(["commit", "-m", "initial"], repo);
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    it("describes itself", async () => {
      const info = await host.info();
      assert.equal(info.id, host.id);
      assert.equal(info.capabilities.git, true);
      assert.equal(info.capabilities.pty, true);
      assert.ok(info.os);
      assert.ok(info.versions.node);
    });

    it("runs git and reports its failures", async () => {
      const { stdout } = await host.git.exec(["rev-parse", "--is-inside-work-tree"], repo);
      assert.equal(stdout.trim(), "true");
      await assert.rejects(host.git.exec(["not-a-git-command"], repo));
    });

    it("creates, lists and removes worktrees", async () => {
      const path = join(fixture.workDir, "wt", "feature-one");
      const created = await host.worktree.create({ repoPath: repo, path, branch: "feature-one" });
      assert.equal(created.branch, "feature-one");
      assert.equal(created.path, path);

      const listed = await host.worktree.list(repo);
      assert.ok(
        listed.some((wt) => wt.branch === "feature-one" && wt.path.endsWith("feature-one")),
      );
      assert.ok(listed.some((wt) => wt.branch === "main"));
      assert.equal((await host.fs.stat(join(path, "hello.txt"))).kind, "file");

      await host.fs.writeFile(join(path, "dirty.txt"), "uncommitted\n");
      await host.worktree.remove({ repoPath: repo, path });
      const after = await host.worktree.list(repo);
      assert.ok(!after.some((wt) => wt.branch === "feature-one"));
      await assert.rejects(host.fs.stat(path));
    });

    it("branches a worktree from a base", async () => {
      const path = join(fixture.workDir, "wt", "from-base");
      await host.worktree.create({ repoPath: repo, path, branch: "from-base", base: "main" });
      const { stdout } = await host.git.exec(["rev-parse", "--abbrev-ref", "HEAD"], path);
      assert.equal(stdout.trim(), "from-base");
      await host.worktree.remove({ repoPath: repo, path });
    });

    it("reads, writes and lists files", async () => {
      const dir = join(fixture.workDir, "fs");
      await host.fs.mkdir(join(dir, "nested", "deep"), { recursive: true });
      await host.fs.writeFile(join(dir, "a.txt"), "alpha");
      await host.fs.writeFile(join(dir, "bin.dat"), new Uint8Array([0, 1, 2, 255]));

      assert.equal(text(await host.fs.readFile(join(dir, "a.txt"))), "alpha");
      assert.deepEqual([...(await host.fs.readFile(join(dir, "bin.dat")))], [0, 1, 2, 255]);

      const stat = await host.fs.stat(join(dir, "a.txt"));
      assert.equal(stat.kind, "file");
      assert.equal(stat.size, 5);
      assert.ok(stat.mtimeMs > 0);
      assert.equal((await host.fs.stat(join(dir, "nested"))).kind, "directory");

      const entries = await host.fs.list(dir);
      const byName = new Map(entries.map((entry) => [entry.name, entry.kind]));
      assert.equal(byName.get("a.txt"), "file");
      assert.equal(byName.get("nested"), "directory");

      await assert.rejects(host.fs.readFile(join(dir, "missing.txt")));
      await assert.rejects(host.fs.stat(join(dir, "missing.txt")));
    });

    it("renames, copies, sizes and removes paths", async () => {
      const dir = join(fixture.workDir, "fs-ops");
      await host.fs.mkdir(join(dir, "tree", "sub"), { recursive: true });
      await host.fs.writeFile(join(dir, "tree", "sub", "f.txt"), "x".repeat(2048));

      await host.fs.rename(join(dir, "tree"), join(dir, "moved"));
      await assert.rejects(host.fs.stat(join(dir, "tree")));

      await host.fs.copy(join(dir, "moved"), join(dir, "copied"), { recursive: true });
      assert.equal(text(await host.fs.readFile(join(dir, "copied", "sub", "f.txt"))).length, 2048);

      assert.ok((await host.fs.du(join(dir, "copied"))) >= 2048);

      await assert.rejects(host.fs.rm(join(dir, "moved")), "a directory needs recursive");
      await host.fs.rm(join(dir, "moved"), { recursive: true });
      await assert.rejects(host.fs.rm(join(dir, "moved")));
      await host.fs.rm(join(dir, "moved"), { force: true });
    });

    it("streams file changes and stops on abort", async () => {
      const dir = join(fixture.workDir, "watched");
      await host.fs.mkdir(dir, { recursive: true });
      const controller = new AbortController();
      const seen: FileChange[] = [];
      const done = (async () => {
        for await (const change of host.fs.watch(dir, { signal: controller.signal })) {
          seen.push(change);
        }
      })();

      // The watcher may start after the first write, so keep writing until it reports.
      let n = 0;
      await waitFor("a file change", async () => {
        await host.fs.writeFile(join(dir, "changed.txt"), `v${n++}`);
        return seen.some((change) => change.path === "changed.txt") ? true : undefined;
      });

      controller.abort();
      await done;
    });

    it("streams search matches and lists files", async () => {
      const dir = join(fixture.workDir, "search");
      await host.fs.mkdir(dir, { recursive: true });
      await host.fs.writeFile(join(dir, "one.txt"), "first line\nneedle-in-haystack here\n");
      await host.fs.writeFile(join(dir, "two.txt"), "nothing to see\n");

      const matches = [];
      for await (const match of host.search.stream({ query: "needle-in-haystack" }, dir)) {
        matches.push(match);
      }
      assert.deepEqual(matches, [{ file: "one.txt", line: 2, content: "needle-in-haystack here" }]);

      const none = [];
      for await (const match of host.search.stream({ query: "NEEDLE", caseSensitive: true }, dir)) {
        none.push(match);
      }
      assert.equal(none.length, 0);

      const files = await host.search.listFiles(dir);
      assert.deepEqual([...files].sort(), ["one.txt", "two.txt"]);
    });

    it("runs a binary and reports its failures", async () => {
      const { stdout } = await host.exec("git", ["--version"], { cwd: fixture.workDir });
      assert.match(stdout, /^git version /);
      const withEnv = await host.exec("git", ["config", "--get", "contract.value"], {
        cwd: repo,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "contract.value",
          GIT_CONFIG_VALUE_0: "42",
        },
      });
      assert.equal(withEnv.stdout.trim(), "42");
      await assert.rejects(host.exec("git", ["not-a-git-command"], { cwd: repo }));
    });

    it("spawns a PTY, takes input, and reports its exit", async () => {
      const exits: TerminalExitEvent[] = [];
      const unsubscribe = host.pty.onExit((event) => exits.push(event));
      try {
        const entry = await host.pty.spawn({
          workspaceId: "contract-ws",
          terminalId: "contract-term",
          workspaceRoot: repo,
          options: { command: "echo contract-ready" },
        });
        assert.equal(entry.terminalId, "contract-term");
        assert.ok(entry.pid > 0);
        assert.equal((await host.pty.info("contract-term"))?.terminalId, "contract-term");
        assert.equal((await host.pty.list("contract-ws")).length, 1);

        await waitFor("the command's output", async () =>
          (await host.pty.getScrollback("contract-term"))?.includes("contract-ready")
            ? true
            : undefined,
        );

        assert.equal(await host.pty.write("contract-term", "echo typed-$((20+22))\r"), true);
        await waitFor("the typed command's output", async () =>
          (await host.pty.getScrollback("contract-term"))?.includes("typed-42") ? true : undefined,
        );

        await host.pty.write("contract-term", "exit\r");
        const exit = await waitFor("the exit event", () =>
          exits.find((event) => event.terminalId === "contract-term"),
        );
        assert.equal(exit.workspaceId, "contract-ws");
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.killed, false);
        assert.equal(await host.pty.write("contract-term", "x"), false);
      } finally {
        unsubscribe();
        await host.pty.killWorkspace("contract-ws");
      }
    });

    it("resolves an agent launch and runs the agent process", async () => {
      const launch = await host.acp.resolveLaunch({ type: "claude-code" });
      if (typeof launch === "string") {
        assert.ok(launch.length > 0, "a refusal says why");
        return;
      }
      assert.ok(launch.command);
      assert.ok(Array.isArray(launch.args));

      const agent = await host.acp.spawn(launch, fixture.workDir);
      assert.ok(agent.pid === undefined || agent.pid > 0);
      agent.stdin.write("{}\n");
      agent.kill();
      const exit = await agent.exit;
      assert.ok(exit.code !== null || exit.signal !== null);
    });

    it("finds no setup script in a project without one", async () => {
      assert.equal(
        await host.scripts.prepare({ projectPath: repo, worktreePath: repo, label: "setup" }),
        null,
      );
    });

    it("prepares a project's setup script", async () => {
      const project = join(fixture.workDir, "scripted");
      await host.fs.mkdir(join(project, ".band"), { recursive: true });
      await host.fs.writeFile(
        join(project, ".band", "config.json"),
        JSON.stringify({ setup: "echo from-setup" }),
      );
      const plan = await host.scripts.prepare({
        projectPath: project,
        worktreePath: project,
        label: "setup",
      });
      assert.ok(plan);
      assert.match(plan.command, /bash/);
      plan.dispose();
    });
  });
}
