import { describe, expect, it } from "vitest";
import { parseGitRemoteUrl } from "../src/lib/git";
import { buildCIQuery, parseCIResponse, statePriority } from "../src/lib/github-graphql";

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
// buildCIQuery
// ---------------------------------------------------------------------------
//
// Regression coverage for issue #457: the previous implementation built a
// query with multiple aliased top-level `repository` selections
// (`ws_0: repository(...)`, `ws_1: repository(...)`, …), which older `gh`
// builds rejected with `Field 'repository' doesn't exist on type 'Query'`.
// The new shape is a plain single-`repository` selection per query, so we
// assert that aliases are NOT present.

describe("buildCIQuery", () => {
  it("builds a non-aliased single-repository query", () => {
    const query = buildCIQuery({
      branch: "feature-branch",
      repoInfo: { host: "github.com", owner: "acme", repo: "app" },
    });

    expect(query).toContain("query {");
    expect(query).toContain('repository(owner: "acme", name: "app")');
    expect(query).toContain(
      'pullRequests(headRefName: "feature-branch", first: 1, states: [OPEN, MERGED]',
    );
    expect(query).toContain('ref(qualifiedName: "refs/heads/feature-branch")');
    expect(query).toContain("checkSuites(first: 20)");
    expect(query).toContain("workflowRun {");
  });

  it("does NOT emit aliased top-level fields (issue #457)", () => {
    const query = buildCIQuery({
      branch: "main",
      repoInfo: { host: "github.com", owner: "o", repo: "r" },
    });
    // The bug was a top-level alias like `ws_0: repository(...)`. The new
    // shape has no top-level alias.
    expect(query).not.toMatch(/\bws_\d+:\s*repository/);
    expect(query).not.toMatch(/^\s*\w+:\s*repository\(/m);
  });

  it("escapes special characters in branch names", () => {
    const query = buildCIQuery({
      branch: 'feat/"quoted"',
      repoInfo: { host: "github.com", owner: "o", repo: "r" },
    });

    expect(query).toContain('headRefName: "feat/\\"quoted\\""');
    expect(query).toContain('refs/heads/feat/\\"quoted\\"');
  });

  it("escapes backslashes and quotes in owner/repo", () => {
    const query = buildCIQuery({
      branch: "main",
      repoInfo: { host: "github.com", owner: 'o\\"', repo: 'r"x' },
    });

    expect(query).toContain('owner: "o\\\\\\""');
    expect(query).toContain('name: "r\\"x"');
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
// parseCIResponse
// ---------------------------------------------------------------------------

describe("parseCIResponse", () => {
  it("returns merged status when PR is merged on a feature branch", () => {
    const repo = {
      pullRequests: {
        nodes: [
          {
            state: "MERGED",
            url: "https://github.com/o/r/pull/1",
          },
        ],
      },
      ref: null,
    };

    const result = parseCIResponse(repo, false);
    expect(result).toEqual({
      state: "merged",
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("ignores merged PR on default branch", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, true);
    expect(result.state).toBe("success");
  });

  it("returns none when no PR and no check suites", () => {
    const repo = {
      pullRequests: { nodes: [] },
      ref: {
        target: {
          checkSuites: { nodes: [] },
        },
      },
    };

    const result = parseCIResponse(repo, false);
    expect(result).toEqual({ state: "none", url: null });
  });

  it("returns none with PR URL when PR exists but no workflow runs", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result).toEqual({
      state: "none",
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("returns success when all workflows pass", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("success");
  });

  it("returns failure when any workflow fails", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("failure");
    expect(result.url).toBe("https://github.com/o/r/actions/runs/2");
  });

  it("returns running when a workflow is in progress", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("running");
  });

  it("returns pending when a workflow is queued", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("pending");
  });

  it("prefers PR URL over workflow run URL", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.url).toBe("https://github.com/o/r/pull/42");
  });

  it("deduplicates workflows by name keeping the latest", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("failure");
    expect(result.url).toBe("https://github.com/o/r/actions/runs/2");
  });

  it("returns none for null repo (workspace missing on remote)", () => {
    expect(parseCIResponse(null, false)).toEqual({ state: "none" });
  });

  it("handles null ref (branch not on remote)", () => {
    const repo = {
      pullRequests: { nodes: [] },
      ref: null,
    };

    const result = parseCIResponse(repo, false);
    expect(result).toEqual({ state: "none", url: null });
  });

  it("returns cancelled state when workflow is cancelled", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("cancelled");
  });

  it("failure takes priority over running", () => {
    const repo = {
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
    };

    const result = parseCIResponse(repo, false);
    expect(result.state).toBe("failure");
  });
});
