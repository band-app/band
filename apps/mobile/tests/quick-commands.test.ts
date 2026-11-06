import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandSummary,
  commandsForRepo,
  draftFor,
  draftProblem,
  draftToInput,
  LABEL_MAX,
  type QuickCommand,
  TEXT_MAX,
  terminalStart,
} from "../src/lib/quick-commands.ts";

const terminal = (id: string, repo: string | null, extra: Partial<QuickCommand> = {}) =>
  ({
    id,
    label: id,
    repo,
    lastRunAt: null,
    action: "terminal",
    command: "npm run dev",
    appendEnter: true,
    ...extra,
  }) as QuickCommand;

describe("quick commands", () => {
  it("lists global commands and the worktree's repo, keeping the hub's order", () => {
    const all = [
      terminal("a", "band"),
      terminal("b", null),
      terminal("c", "other"),
      terminal("d", "band"),
    ];
    assert.deepEqual(
      commandsForRepo(all, "band").map((c) => c.id),
      ["a", "b", "d"],
    );
    assert.deepEqual(
      commandsForRepo(all, "none").map((c) => c.id),
      ["b"],
    );
  });

  it("validates the form like the hub does", () => {
    const ok = draftFor(undefined, "claude-code");
    assert.equal(draftProblem({ ...ok, label: "x", body: "ls" }), null);
    assert.match(draftProblem({ ...ok, label: " ", body: "ls" }) ?? "", /label/);
    assert.match(draftProblem({ ...ok, label: "x", body: " " }) ?? "", /command/);
    assert.match(draftProblem({ ...ok, label: "x".repeat(LABEL_MAX + 1), body: "ls" }) ?? "", /80/);
    assert.match(draftProblem({ ...ok, label: "x", body: "a".repeat(TEXT_MAX + 1) }) ?? "", /4000/);
    assert.match(
      draftProblem({ ...ok, label: "x", action: "agent", body: "", agentId: "a" }) ?? "",
      /prompt/,
    );
    assert.match(
      draftProblem({ ...ok, label: "x", action: "agent", body: "hi", agentId: "" }) ?? "",
      /agent/,
    );
  });

  it("builds the create input, scoped to the repo or to every repo", () => {
    const draft = { ...draftFor(undefined, "claude-code"), label: " Dev ", body: "npm run dev" };
    assert.deepEqual(draftToInput(draft, "band"), {
      label: "Dev",
      repo: "band",
      action: "terminal",
      command: "npm run dev",
      appendEnter: true,
    });
    assert.deepEqual(
      draftToInput({ ...draft, thisRepoOnly: false, action: "agent", body: "say hi" }, "band"),
      { label: "Dev", repo: null, action: "agent", agentId: "claude-code", prompt: "say hi" },
    );
  });

  it("starts the form from the command being edited", () => {
    const agent: QuickCommand = {
      id: "q",
      label: "Hi",
      repo: null,
      lastRunAt: 1,
      action: "agent",
      agentId: "codex",
      prompt: "say hi",
    };
    assert.deepEqual(draftFor(agent, "claude-code"), {
      label: "Hi",
      action: "agent",
      body: "say hi",
      appendEnter: true,
      agentId: "codex",
      thisRepoOnly: false,
    });
  });

  it("runs the command as the terminal starts, or types it at the prompt", () => {
    assert.deepEqual(terminalStart({ command: "ls", appendEnter: true }), { command: "ls" });
    assert.deepEqual(terminalStart({ command: "ls", appendEnter: false }), { typeText: "ls" });
  });

  it("summarises on one line", () => {
    const label = (id: string) => (id === "codex" ? "Codex" : id);
    assert.equal(commandSummary(terminal("a", null, { command: "a\n  b" } as never), label), "a b");
    assert.equal(
      commandSummary(
        {
          id: "q",
          label: "q",
          repo: null,
          lastRunAt: null,
          action: "agent",
          agentId: "codex",
          prompt: "hi",
        },
        label,
      ),
      "Codex: hi",
    );
  });
});
