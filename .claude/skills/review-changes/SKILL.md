---
name: review-changes
description: Run Band's four-specialist PR review on a branch or open PR. Gathers context (changed files, linked GitHub issue acceptance criteria, PR details, repo conventions), dispatches the coding/testing/security/performance reviewers in parallel, and returns findings organized by section plus a single overall Verdict line (`approved 👍` or `request changes 👎`). Read-only — never modifies files; the caller decides what to do with the findings (the `review-and-apply` skill applies them, the CI workflow posts them as comments). Use when the user asks for a code review, a pre-push review, or asks to vet a PR against Band conventions.
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git symbolic-ref:*), Bash(git rev-parse:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh issue view:*), Agent, Read, Glob, Grep
---

# Review Changes

This skill orchestrates Band's four-specialist PR review. It is **read-only** — the caller decides what to do with the output.

You are the orchestrator. Your job is to:

1. **Gather context** (changed files, linked issues, PR details, repo conventions).
2. **Dispatch four specialist sub-reviewers in parallel** with that context bundle.
3. **Aggregate findings per section** (one section per specialist).
4. **Emit a single overall Verdict line** (`approved 👍` if no blocker anywhere, else `request changes 👎`).

You never modify files yourself. You never paraphrase findings. You never compose findings — the specialists do; you orchestrate and aggregate.

## Specialists

| Specialist | Criteria | Scope |
|---|---|---|
| `coding-reviewer`      | `.claude/coding-criteria.md`      (`CODE-1`…`CODE-19`) | production source code |
| `testing-reviewer`     | `.claude/testing-criteria.md`     (`TEST-1`…`TEST-35`) | tests, fixtures, page objects |
| `security-reviewer`    | `.claude/security-criteria.md`    (`SEC-1`…`SEC-15`)   | source, tests, config, scripts |
| `performance-reviewer` | `.claude/performance-criteria.md` (`PERF-1`…`PERF-10`) | production source, hot paths |

Each specialist also applies cross-cutting concerns (correctness, pattern drift) inside its scope, tagged `correctness:` / `pattern:` instead of a rule ID. Specialists do not compose the Verdict — that's your job.

## Step 1 — Gather context

The caller supplies, at minimum, `REPO` and one of (`PR NUMBER`) or (`BASE` + `HEAD` refs).

### Diff

- **Open PR**: `gh pr diff <num>` for the diff; `gh pr view <num> --json title,body,headRefName,baseRefName` for metadata.
- **No PR yet** (local pre-push): `git diff <base>...<head>` (three-dot form — matches what GitHub will show on a future PR); `git log <base>..<head> --format='%h %s%n%b'` for commit history.

Do not truncate.

### Linked issues

Look for, in order:

1. `closes #<n>` / `fixes #<n>` / `resolves #<n>` in PR body or commit messages.
2. A leading number in the branch name (`123-fix-foo` → issue 123).

For each match, run `gh issue view <num>` and include the body in the context bundle you pass to each specialist — the linked-issue acceptance criteria are useful context for the specialists when they evaluate scope, naming, and test coverage. The bundle is the only place the linked-issue text appears; you do not emit a separate verdict on it.

### Repo conventions

Read `CLAUDE.md` and `CONTRIBUTING.md` at the repo root — they define repo conventions the criteria files reference.

### File inventory

Categorize touched files so the specialists know which subset to focus on first:

- **source**: production code under `apps/**/src/**`, `packages/**/src/**` (excluding tests).
- **test**: anything matching `**/tests/**`, `**/e2e/**`, `*.test.ts`, `*.spec.ts`.
- **config**: `package.json`, lockfiles, `.github/workflows/**`, `.env*`, `.husky/*`, scripts.

Capture everything as a single **context bundle**.

## Step 2 — Dispatch four specialists in parallel

Non-negotiable: the four specialists run **concurrently** via four `Agent` calls in a **single message**. Sequential dispatch wastes latency; the specialists are independent.

```
Agent(subagent_type="coding-reviewer",      prompt=<bundle>)
Agent(subagent_type="testing-reviewer",     prompt=<bundle>)
Agent(subagent_type="security-reviewer",    prompt=<bundle>)
Agent(subagent_type="performance-reviewer", prompt=<bundle>)
```

Bundle prompt template (identical for all four):

> **Context bundle for your review:**
>
> - Base / Head: `<refs>`
> - PR: `#<num>` *(or "local pre-push" if no PR yet)*
> - Diff:
>   ```
>   <full diff text — do NOT truncate>
>   ```
> - Linked issue(s):
>   - `#<n>`: <body of gh issue view>
>   *(repeat per issue, or "none" if no linked issues)*
> - Touched files:
>   - source: `<list>`
>   - test:   `<list>`
>   - config: `<list>`
>
> Apply your criteria to the in-scope files. Emit findings in your standard format. Return `NO_FINDINGS` if you have none.

Each specialist's persona file (`.claude/agents/<name>.md`) declares its own scope rules, criteria pointer, and output format. You don't need to repeat them in the bundle.

## Step 3 — Aggregate per section

Once all four return:

1. **Drop `NO_FINDINGS` envelopes.** A specialist with nothing to say contributes no section.
2. **De-duplicate across sections.** A cross-section duplicate is a finding with the same `path:line` *and* the same underlying rule (e.g. coding-reviewer flags `CODE-19` and testing-reviewer also flags it under its `CODE-19` cross-cutting pass). Keep it in the section whose specialist owns the rule; drop the other copy.
3. **Number globally.** `[1]`, `[2]`, … run sequentially across the whole report so the caller can reference each finding uniquely. Within each section, order by severity: blockers → nits → suggestions.

## Step 4 — Emit the report

The report has **four domain sections in fixed order** (Coding → Testing → Security → Performance), each introduced by a one-line header, followed by a single overall **Verdict** line.

### Domain header format

```
<Coding|Testing|Security|Performance> <emoji>
```

The status emoji is computed from the findings in that domain:

- `🚨` — has at least one `blocker`
- `⚠️` — has `nit`s or `suggestion`s but no blockers
- `✅` — has zero findings

All four domain headers always appear, even with status `✅` — the `✅` line is itself a useful signal that the domain was reviewed.

### Findings under each header

Below each header, list the findings (if any) in the standard format:

```
[N] severity:<blocker|nit|suggestion>  <path>:<line>
    <one-sentence description — cite rule ID (CODE-N / TEST-N / SEC-N / PERF-N) or cross-cutting tag (correctness: / pattern:)>
    Fix: <specific, actionable change>
```

For a domain with status `✅`, the header line stands alone — no list follows it.

Findings are **globally numbered** `[1]`, `[2]`, … across all domains so the caller can reference each one uniquely. Within a domain, order by severity: blockers → nits → suggestions.

### Worked example

```
Coding 🚨

[1] severity:blocker  apps/web/src/server/api/projects/router.ts:42
    CODE-2: router imports from infra/db/queries
    Fix: move the DB call into ProjectService.delete and call that from the router

[2] severity:nit  apps/web/src/server/services/workspace-service.ts:88
    correctness: null reference on workspace.id when findById returns undefined
    Fix: add an early-return guard before line 88

Testing ⚠️

[3] severity:nit  apps/web/e2e/new-feature.spec.ts:34
    TEST-4: uses page.route('**/trpc/...') on the app's own route
    Fix: replace with an Express stub fixture; set CATALOG_SERVICE_URL on startServer

Security ✅

Performance 🚨

[4] severity:blocker  apps/web/src/server/services/project-service.ts:55
    PERF-1: N+1 query — one Drizzle call per workspace in a loop over workspaces.length
    Fix: use a single workspaces.listByProject(id) batch fetch

Verdict: request changes 👎
```

### Verdict semantics

Computed mechanically from the aggregated findings — walk every finding across all four sections:

- **`Verdict: approved 👍`** — no `blocker` finding exists in any domain.
- **`Verdict: request changes 👎`** — at least one `blocker` finding exists in some domain.

Nits and suggestions never trigger `👎` — they're advisory by definition. The verdict line is the entire wrap-up; do not editorialise, do not add a `Take:` paragraph, do not list totals.

### Notes

- **All four domain headers are always emitted**, even if every domain is `✅`.
- **If every domain is `✅`** (zero findings overall), the four headers and `Verdict: approved 👍` are the entire output.
- **The verdict is yours alone.** Specialists do not compose it — they only emit findings. You read the findings list and emit the appropriate verdict.

## Severity vocabulary

The specialists use these tags; you preserve them verbatim:

- `blocker` — ship-stopper (bug, security issue, broken test, violates a non-negotiable convention, fails linked-issue acceptance criteria).
- `nit` — should fix, low effort, no real risk if it shipped.
- `suggestion` — optional improvement, judgement call.

## Cross-cutting and Band-specific checks

All cross-cutting and Band-specific concerns live inside the specialists:

- **Correctness, pattern drift** — every specialist applies these inside its scope, tagged `correctness:` / `pattern:`.
- **Web vs desktop**, **`--no-verify` bypass**, **skills sync** — covered by `coding-reviewer`.

You do not own any cross-cutting check yourself — you orchestrate, aggregate, and emit the verdict.

## What you must never do

- **Never modify any file.** You are read-only. The same constraint binds the specialists.
- **Never dispatch the specialists sequentially.** Four calls, one message, every time.
- **Never paraphrase, summarize, or filter a specialist's findings.** Forward them verbatim into the right section.
- **Never compose findings yourself.** Findings come from specialists; you orchestrate and aggregate.
- **Never let a specialist compose the overall Verdict.** That's yours, and it is mechanical: blocker present → `👎`, otherwise `👍`.
- **Never truncate the diff.** Each specialist must see the whole thing — independent context is the whole reason they exist as separate agents.
