import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractVersion,
  parseEnvironment,
  satisfies,
  scriptFor,
  unmetRequirements,
  validateEnvironment,
} from "../src/index.ts";

const EXAMPLE = {
  build: { devcontainer: ".devcontainer/devcontainer.json" },
  install: "pnpm install --frozen-lockfile && pnpm prisma generate",
  start: "./scripts/worktree-setup.sh",
  terminals: [{ name: "dev", command: "pnpm dev" }],
  teardown: "./scripts/worktree-teardown.sh",
  secrets: ["DATABASE_URL", "STRIPE_TEST_KEY"],
  isolation: "container",
  resources: { cpu: 4, memory: "8Gi" },
  services: { postgres: "postgres:16" },
  requires: { node: ">=24", python: ">=3.12" },
};

function issuesOf(value: unknown): { path: string; message: string }[] {
  const result = parseEnvironment(JSON.stringify(value));
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
}

describe("parseEnvironment", () => {
  it("accepts the example from the plan", () => {
    const result = parseEnvironment(JSON.stringify(EXAMPLE));
    assert.equal(result.ok, true);
  });

  it("accepts an empty object", () => {
    assert.equal(parseEnvironment("{}").ok, true);
  });

  it("names an unknown key by its path", () => {
    assert.deepEqual(issuesOf({ install: "x", instal: "y" }), [
      { path: "instal", message: "unknown key" },
    ]);
    assert.deepEqual(issuesOf({ terminals: [{ name: "a", command: "b", cmd: "c" }] }), [
      { path: "terminals[0].cmd", message: "unknown key" },
    ]);
    assert.deepEqual(issuesOf({ resources: { cpu: 2, gpus: 1 } }), [
      { path: "resources.gpus", message: "unknown key" },
    ]);
  });

  it("rejects a bad isolation and lists the choices", () => {
    assert.deepEqual(issuesOf({ isolation: "docker" }), [
      { path: "isolation", message: 'must be one of "worktree", "container", "vm" (got "docker")' },
    ]);
  });

  it("requires exactly one way to build", () => {
    assert.match(issuesOf({ build: {} })[0]?.message ?? "", /exactly one of/);
    assert.match(
      issuesOf({ build: { image: "node:24", dockerfile: "Dockerfile" } })[0]?.message ?? "",
      /dockerfile and image/,
    );
  });

  it("rejects wrong types with the path", () => {
    assert.deepEqual(issuesOf({ terminals: [{ name: "dev" }] }), [
      { path: "terminals[0].command", message: "is required" },
    ]);
    assert.deepEqual(issuesOf({ install: 5 }), [{ path: "install", message: "must be a string" }]);
  });

  it("rejects duplicate terminal names", () => {
    assert.deepEqual(
      issuesOf({
        terminals: [
          { name: "dev", command: "a" },
          { name: "dev", command: "b" },
        ],
      }),
      [{ path: "terminals[1].name", message: 'duplicate terminal name "dev"' }],
    );
  });

  it("keeps secrets to names", () => {
    const issues = issuesOf({ secrets: ["TOKEN=abc123"] });
    assert.equal(issues[0]?.path, "secrets[0]");
    assert.doesNotMatch(issues[0]?.message ?? "", /abc123/);
  });

  it("rejects an invalid range in requires", () => {
    const issues = issuesOf({ requires: { node: "latest" } });
    assert.equal(issues[0]?.path, "requires.node");
  });

  it("reports invalid JSON and non-objects", () => {
    const bad = parseEnvironment("{ nope");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.issues[0]?.message ?? "", /not valid JSON/);
    const list = parseEnvironment("[]");
    assert.equal(list.ok, false);
  });

  it("reports every problem at once", () => {
    assert.equal(issuesOf({ isolation: "x", bogus: 1, install: 2 }).length, 3);
  });
});

describe("validateEnvironment", () => {
  const text = JSON.stringify({ build: { devcontainer: ".devcontainer/devcontainer.json" } });

  it("passes when the devcontainer exists", async () => {
    const result = await validateEnvironment(
      text,
      async (p) => p === ".devcontainer/devcontainer.json",
    );
    assert.equal(result.ok, true);
  });

  it("names a missing devcontainer file", async () => {
    const result = await validateEnvironment(text, async () => false);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues, [
        {
          path: "build.devcontainer",
          message: 'file ".devcontainer/devcontainer.json" does not exist in the repository',
        },
      ]);
    }
  });

  it("refuses a path that leaves the repository", async () => {
    for (const file of ["../outside/Dockerfile", "/etc/Dockerfile"]) {
      const result = await validateEnvironment(
        JSON.stringify({ build: { dockerfile: file } }),
        async () => true,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.issues[0]?.message ?? "", /inside the repository/);
    }
  });

  it("does not look for files when the shape is wrong", async () => {
    let asked = false;
    await validateEnvironment("{ nope", async () => {
      asked = true;
      return true;
    });
    assert.equal(asked, false);
  });
});

describe("versions", () => {
  it("reads versions out of tool output", () => {
    assert.equal(extractVersion("v24.14.1"), "24.14.1");
    assert.equal(extractVersion("go version go1.22.1 darwin/arm64"), "1.22.1");
    assert.equal(extractVersion("Docker version 27.3.1, build ce12230"), "27.3.1");
    assert.equal(extractVersion("Python 3.12"), "3.12.0");
    assert.equal(extractVersion("none"), null);
  });

  it("matches ranges", () => {
    assert.equal(satisfies("24.14.1", ">=24"), true);
    assert.equal(satisfies("22.1.0", ">=24"), false);
    assert.equal(satisfies("24.14.1", ">=99"), false);
    assert.equal(satisfies("24.1.0", "24"), true);
    assert.equal(satisfies("25.0.0", "24"), false);
    assert.equal(satisfies("24.3.0", "24.x"), true);
    assert.equal(satisfies("3.12.4", "^3.12"), true);
    assert.equal(satisfies("4.0.0", "^3.12"), false);
    assert.equal(satisfies("0.2.9", "^0.2.3"), true);
    assert.equal(satisfies("0.3.0", "^0.2.3"), false);
    assert.equal(satisfies("1.22.9", "~1.22.1"), true);
    assert.equal(satisfies("1.23.0", "~1.22.1"), false);
    assert.equal(satisfies("21.0.0", ">=20 <23"), true);
    assert.equal(satisfies("23.0.0", ">=20 <23"), false);
    assert.equal(satisfies("18.5.0", "18 || >=20"), true);
    assert.equal(satisfies("19.0.0", "18 || >=20"), false);
    assert.equal(satisfies("25.0.0", ">24"), true);
    assert.equal(satisfies("24.9.0", ">24"), false);
    assert.equal(satisfies("1.0.0", "*"), true);
    assert.equal(satisfies("24.0.0", ">= 24"), true);
  });
});

describe("unmetRequirements", () => {
  it("lists what a host lacks", () => {
    const unmet = unmetRequirements(
      { node: ">=99", python: ">=3.12", go: ">=1.22" },
      { node: "24.14.1", python: "3.9.1" },
    );
    assert.deepEqual(unmet, [
      { tool: "node", range: ">=99", found: "24.14.1" },
      { tool: "python", range: ">=3.12", found: "3.9.1" },
      { tool: "go", range: ">=1.22", found: null },
    ]);
  });

  it("is empty when everything is met or nothing is required", () => {
    assert.deepEqual(unmetRequirements({ node: ">=24" }, { node: "24.0.0" }), []);
    assert.deepEqual(unmetRequirements(undefined, {}), []);
  });

  it("treats python3 as python", () => {
    assert.deepEqual(unmetRequirements({ python3: ">=3.12" }, { python: "3.12.3" }), []);
  });
});

describe("scriptFor", () => {
  it("runs install then start, stopping at the first failure", () => {
    const text = scriptFor({ install: "a", start: "b" }, "setup");
    assert.equal(text, "{\na\n} && {\nb\n}");
  });

  it("uses whichever of install and start exists", () => {
    assert.equal(scriptFor({ install: "a" }, "setup"), "a");
    assert.equal(scriptFor({ start: "b" }, "setup"), "b");
    assert.equal(scriptFor({}, "setup"), null);
  });

  it("reads teardown", () => {
    assert.equal(scriptFor({ teardown: "x" }, "teardown"), "x");
    assert.equal(scriptFor({ install: "a" }, "teardown"), null);
  });
});
