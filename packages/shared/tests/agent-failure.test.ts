import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyFailure,
  describeFailure,
  failureFromMessage,
  filterOutput,
} from "../src/agent-failure.ts";

const NOISE = [
  "[session/create] sessionId=cf181bd2 phase=validate-cwd durationMs=3 totalMs=3",
  "[session/query] sessionId=cf181bd2 resume=none apiType=native baseUrl=native",
  "(node:3957134) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked",
  'Unexpected case: {"type":"system","subtype":"vcs_state_changed","kind":"rebase"}',
  "[claude-agent-acp] Session cf181bd2: dropping 3 unpaid trailing-idle debt at the running transition",
];

describe("classifyFailure", () => {
  it("SIGKILL is killed", () => {
    const r = classifyFailure({ exitCode: null, signal: "SIGKILL", stderr: "", message: "" });
    assert.equal(r.cause, "killed");
    const text = describeFailure(
      { cause: "killed", exitCode: null, signal: "SIGKILL", agent: "Claude Code" },
      "contabo",
    );
    assert.equal(text.headline, "Claude Code stopped unexpectedly");
    assert.match(text.line, /Killed by SIGKILL on contabo, likely out of memory/);
  });

  it("SIGTERM is killed without the memory guess", () => {
    const text = describeFailure(
      { cause: "killed", exitCode: null, signal: "SIGTERM", agent: "Claude Code" },
      "mac",
    );
    assert.doesNotMatch(text.line, /memory/);
  });

  it("a non-zero exit quotes the last non-noise line (S2)", () => {
    const stderr = [...NOISE.slice(0, 3), "Error: ENOSPC: no space left on device", NOISE[4]].join(
      "\n",
    );
    const r = classifyFailure({ exitCode: 1, signal: null, stderr, message: "" });
    assert.deepEqual(r, { cause: "exit", detail: "Error: ENOSPC: no space left on device" });
  });

  it("401 and invalid keys are auth (S3)", () => {
    for (const stderr of ["HTTP 401 Unauthorized", "Invalid API key · Please run /login"]) {
      const r = classifyFailure({ exitCode: 1, signal: null, stderr, message: "" });
      assert.equal(r.cause, "auth");
    }
    const text = describeFailure(
      { cause: "auth", exitCode: 1, signal: null, agent: "Claude Code" },
      "contabo",
    );
    assert.equal(text.headline, "Claude Code isn't logged in on contabo");
  });

  it("a number in a noise line does not make a kill an auth failure", () => {
    const stderr = "[session/create] sessionId=x phase=validate-cwd durationMs=401 totalMs=429";
    const r = classifyFailure({ exitCode: null, signal: "SIGKILL", stderr, message: "" });
    assert.equal(r.cause, "killed");
  });

  it("usage limits carry the reset time", () => {
    const r = classifyFailure({
      exitCode: 1,
      signal: null,
      stderr: "Claude usage limit reached. Your limit resets at 6pm",
      message: "",
    });
    assert.deepEqual(r, { cause: "limit", detail: "6pm" });
  });

  it("a lost worker link is disconnected, a request timeout is timeout", () => {
    assert.equal(
      classifyFailure({ exitCode: null, signal: "link-lost", stderr: "", message: "" }).cause,
      "disconnected",
    );
    assert.equal(
      classifyFailure({ exitCode: null, signal: null, stderr: "", message: "x", timedOut: true })
        .cause,
      "timeout",
    );
    assert.equal(
      classifyFailure({ exitCode: null, signal: null, stderr: "", message: "?" }).cause,
      "unknown",
    );
  });
});

describe("filterOutput", () => {
  const stderr = [...NOISE, "Error: ENOSPC: no space left on device", "Killed"].join("\n");

  it("Relevant hides the known noise, counts it and flags error lines", () => {
    const r = filterOutput(stderr, true);
    assert.equal(r.hidden, 5);
    assert.deepEqual(
      r.lines.map((l) => [l.text, l.error]),
      [
        ["Error: ENOSPC: no space left on device", true],
        ["Killed", true],
      ],
    );
  });

  it("All output keeps every line", () => {
    const r = filterOutput(stderr, false);
    assert.equal(r.lines.length, 7);
    assert.equal(r.hidden, 0);
  });
});

describe("failureFromMessage", () => {
  it("makes an unknown failure whose details are the text (S5)", () => {
    const f = failureFromMessage("old text");
    assert.equal(f.cause, "unknown");
    assert.equal(f.stderrTail, "old text");
  });
});
