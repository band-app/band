import { describe, expect, it } from "vitest";
import { parseGitRemoteUrl } from "../src/server/services/git";
import {
  buildBatchedCIQuery,
  parseBatchedCIResponse,
  statePriority,
} from "../src/server/services/github-graphql";

// ---------------------------------------------------------------------------
// parseGitRemoteUrl
// ---------------------------------------------------------------------------

describe("parseGitRemoteUrl", () => {
  it("parses SSH remote URL", () => {
    const result = parseGitRemoteUrl("git@github.com:owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses SSH remote URL without .git suffix", () => {
    const result = parseGitRemoteUrl("git@github.com:owner/repo");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses HTTPS remote URL", () => {
    const result = parseGitRemoteUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses HTTPS remote URL without .git suffix", () => {
    const result = parseGitRemoteUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses HTTP remote URL", () => {
    const result = parseGitRemoteUrl("http://github.com/owner/repo.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses GitHub Enterprise SSH URL", () => {
    const result = parseGitRemoteUrl("git@github.acme.com:team/project.git");
    expect(result).toEqual({
      host: "github.acme.com",
      owner: "team",
      repo: "project",
    });
  });

  it("parses GitHub Enterprise HTTPS URL", () => {
    const result = parseGitRemoteUrl("https://github.acme.com/team/project.git");
    expect(result).toEqual({
      host: "github.acme.com",
      owner: "team",
      repo: "project",
    });
  });

  it("returns null for unrecognized URL format", () => {
    expect(parseGitRemoteUrl("/local/path/to/repo")).toBeNull();
    expect(parseGitRemoteUrl("")).toBeNull();
    expect(parseGitRemoteUrl("not-a-url")).toBeNull();
  });

  it("handles repo names with hyphens and dots", () => {
    const result = parseGitRemoteUrl("git@github.com:my-org/my-repo.name.git");
    expect(result).toEqual({
      host: "github.com",
      owner: "my-org",
      repo: "my-repo.name",
    });
  });
});

// ---------------------------------------------------------------------------
// buildBatchedCIQuery
// ---------------------------------------------------------------------------

describe("buildBatchedCIQuery", () => {
  it("builds a query for a single workspace", () => {
    const query = buildBatchedCIQuery([
      {
        alias: "ws_0",
        branch: "feature-branch",
        repoInfo: { host: "github.com", owner: "acme", repo: "app" },
      },
    ]);

    expect(query).toContain("query {");
    expect(query).toContain('ws_0: repository(owner: "acme", name: "app")');
    expect(query).toContain(
      'pullRequests(headRefName: "feature-branch", first: 1, states: [OPEN, MERGED]',
    );
    expect(query).toContain('ref(qualifiedName: "refs/heads/feature-branch")');
    expect(query).toContain("checkSuites(first: 20)");
    expect(query).toContain("workflowRun {");
  });

  it("builds a query for multiple workspaces", () => {
    const query = buildBatchedCIQuery([
      {
        alias: "ws_0",
        branch: "feature-a",
        repoInfo: { host: "github.com", owner: "acme", repo: "app" },
      },
      {
        alias: "ws_1",
        branch: "feature-b",
        repoInfo: { host: "github.com", owner: "acme", repo: "lib" },
      },
    ]);

    expect(query).toContain('ws_0: repository(owner: "acme", name: "app")');
    expect(query).toContain('ws_1: repository(owner: "acme", name: "lib")');
    expect(query).toContain('headRefName: "feature-a"');
    expect(query).toContain('headRefName: "feature-b"');
  });

  it("escapes special characters in branch names", () => {
    const query = buildBatchedCIQuery([
      {
        alias: "ws_0",
        branch: 'feat/"quoted"',
        repoInfo: { host: "github.com", owner: "o", repo: "r" },
      },
    ]);

    expect(query).toContain('headRefName: "feat/\\"quoted\\""');
  });
});

// ---------------------------------------------------------------------------
// statePriority
// ---------------------------------------------------------------------------

describe("statePriority", () => {
  it("ranks failure highest", () => {
    expect(statePriority("failure")).toBeGreaterThan(statePriority("running"));
    expect(statePriority("failure")).toBeGreaterThan(statePriority("success"));
  });

  it("ranks running above pending", () => {
    expect(statePriority("running")).toBeGreaterThan(statePriority("pending"));
  });

  it("ranks pending above cancelled", () => {
    expect(statePriority("pending")).toBeGreaterThan(statePriority("cancelled"));
  });

  it("ranks cancelled above success", () => {
    expect(statePriority("cancelled")).toBeGreaterThan(statePriority("success"));
  });

  it("returns -1 for unknown states", () => {
    expect(statePriority("unknown")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// parseBatchedCIResponse
// ---------------------------------------------------------------------------

describe("parseBatchedCIResponse", () => {
  it("returns merged status when PR is merged on a feature branch", () => {
    const data = {
      ws_0: {
        pullRequests: {
          nodes: [
            {
              state: "MERGED",
              url: "https://github.com/o/r/pull/1",
            },
          ],
        },
        ref: null,
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")).toEqual({
      state: "merged",
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("ignores merged PR on default branch", () => {
    const data = {
      ws_0: {
        pullRequests: {
          nodes: [
            {
              state: "MERGED",
              url: "https://github.com/o/r/pull/1",
            },
          ],
        },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const defaultBranches = new Map([["ws_0", "main"]]);
    const result = parseBatchedCIResponse(data, ["ws_0"], defaultBranches);
    expect(result.get("ws_0")?.state).toBe("success");
  });

  it("returns none when no PR and no check suites", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: { nodes: [] },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")).toEqual({ state: "none", url: null });
  });

  it("returns none with PR URL when PR exists but no workflow runs", () => {
    const data = {
      ws_0: {
        pullRequests: {
          nodes: [{ state: "OPEN", url: "https://github.com/o/r/pull/1" }],
        },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  // Non-GitHub-Actions check suite (no workflowRun)
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: null,
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")).toEqual({
      state: "none",
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("returns success when all workflows pass", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "Lint" },
                    url: "https://github.com/o/r/actions/runs/2",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    const ci = result.get("ws_0");
    expect(ci?.state).toBe("success");
  });

  it("returns failure when any workflow fails", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
                {
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "Lint" },
                    url: "https://github.com/o/r/actions/runs/2",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    const ci = result.get("ws_0");
    expect(ci?.state).toBe("failure");
    expect(ci?.url).toBe("https://github.com/o/r/actions/runs/2");
  });

  it("returns running when a workflow is in progress", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
                {
                  status: "IN_PROGRESS",
                  conclusion: null,
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "Lint" },
                    url: "https://github.com/o/r/actions/runs/2",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")?.state).toBe("running");
  });

  it("returns pending when a workflow is queued", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "QUEUED",
                  conclusion: null,
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")?.state).toBe("pending");
  });

  it("prefers PR URL over workflow run URL", () => {
    const data = {
      ws_0: {
        pullRequests: {
          nodes: [{ state: "OPEN", url: "https://github.com/o/r/pull/42" }],
        },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/99",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")?.url).toBe("https://github.com/o/r/pull/42");
  });

  it("deduplicates workflows by name keeping the latest", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
                {
                  // Later run of same workflow that failed
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  updatedAt: "2024-01-02T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/2",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    const ci = result.get("ws_0");
    expect(ci?.state).toBe("failure");
    expect(ci?.url).toBe("https://github.com/o/r/actions/runs/2");
  });

  it("handles multiple workspaces in one response", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
              ],
            },
          },
        },
      },
      ws_1: {
        pullRequests: {
          nodes: [
            {
              state: "MERGED",
              url: "https://github.com/o/r/pull/5",
            },
          ],
        },
        ref: null,
      },
      ws_2: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "Tests" },
                    url: "https://github.com/o/r/actions/runs/3",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0", "ws_1", "ws_2"]);
    expect(result.get("ws_0")?.state).toBe("success");
    expect(result.get("ws_1")?.state).toBe("merged");
    expect(result.get("ws_2")?.state).toBe("failure");
  });

  it("returns none for missing aliases in the response", () => {
    const data = {};
    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")).toEqual({ state: "none" });
  });

  it("handles null ref (branch not on remote)", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: null,
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")).toEqual({ state: "none", url: null });
  });

  it("returns cancelled state when workflow is cancelled", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "COMPLETED",
                  conclusion: "CANCELLED",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")?.state).toBe("cancelled");
  });

  it("failure takes priority over running", () => {
    const data = {
      ws_0: {
        pullRequests: { nodes: [] },
        ref: {
          target: {
            checkSuites: {
              nodes: [
                {
                  status: "IN_PROGRESS",
                  conclusion: null,
                  updatedAt: "2024-01-01T01:00:00Z",
                  workflowRun: {
                    workflow: { name: "Deploy" },
                    url: "https://github.com/o/r/actions/runs/1",
                  },
                },
                {
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  updatedAt: "2024-01-01T00:00:00Z",
                  workflowRun: {
                    workflow: { name: "CI" },
                    url: "https://github.com/o/r/actions/runs/2",
                  },
                },
              ],
            },
          },
        },
      },
    };

    const result = parseBatchedCIResponse(data, ["ws_0"]);
    expect(result.get("ws_0")?.state).toBe("failure");
  });
});
