---
name: pr-review-local
description: Run Band's CI PR review locally before pushing, then auto-apply the fixes. Calls the `pr-reviewer` subagent (defined in `.claude/agents/pr-reviewer.md`) which gathers full context — linked GitHub issue requirements via `gh issue view`, full diff vs base, surrounding code, repo conventions — and applies criteria from `.claude/pr-review-criteria.md`. The main agent then applies findings with Edit/Write and verifies with lint, clippy, and tests. Use when the user says "review my branch before I push", "pre-flight check", "do a local PR review", "run the CI review locally", or "review my changes and fix them".
allowed-tools: Task, Agent, Bash, Read, Edit, Write, Glob, Grep
---

# PR Review (Local) — Review → Fix → Verify

Two-phase flow:

1. **Review** — call the `pr-reviewer` subagent. It already knows how to review (system prompt in `.claude/agents/pr-reviewer.md`). You just tell it *what* to review.
2. **Fix** — read the findings, apply them with Edit/Write, verify with lint/clippy/tests. Do NOT re-review; trust the subagent unless a finding is clearly wrong.

## Step 1 — Identify the change set

Gather the facts the reviewer needs. Don't make it re-derive them.

```bash
# Refresh remote refs so the base comparison isn't stale.
git fetch origin --quiet

# Base ref (merge target). Default origin/main; fall back if HEAD ref points elsewhere.
BASE=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/||' || echo origin/main)
HEAD=$(git rev-parse --short HEAD)

# Open PR? (If yes, the reviewer will prefer `gh pr diff/view`.)
gh pr view --json number,headRefName,baseRefName 2>/dev/null || echo "no PR yet"

# Linked issues: PR body, commit messages, branch name.
{
  gh pr view --json body --jq .body 2>/dev/null
  git log "$BASE..HEAD" --format='%s%n%b'
  git rev-parse --abbrev-ref HEAD
} | grep -iEoh '(closes|fixes|resolves) +#[0-9]+|#[0-9]+' | sort -u
```

If you find no linked issue, pass `issues=none detected` — the reviewer will still review, but will flag the absence in the Summary.

## Step 2 — Call the reviewer

Use the subagent-dispatch tool (`Task` in current Claude Code; some surfaces alias it as `Agent` — both names are in the allowlist) with `subagent_type: "pr-reviewer"`. Keep the prompt short — the agent's system prompt has all the "how" baked in (it reads `.claude/pr-review-criteria.md` itself, fetches `gh issue view`, reads surrounding code, etc.).

```
Review this change set.

- Base:  <BASE ref>
- Head:  <HEAD short sha>
- PR:    <number, or "no PR yet">
- Issues: <comma-separated list of #N, or "none detected">

Apply `.claude/pr-review-criteria.md` and return findings in the documented format.
```

**Do not paste the criteria into the prompt.** The agent reads the criteria file itself — that's the whole point of the design. Pasting them duplicates the source of truth and lets the two copies drift.

## Step 3 — Apply the fixes

Read the subagent's findings. Then:

- **Every `blocker`** — fix with Edit/Write. Group related fixes by file to minimize churn.
- **Every `nit`** — fix unless the user has explicitly made the choice the nit objects to.
- **Every `suggestion`** — skip by default. Collect them in a short list for the final report.

Special cases:

- **"Missing test" findings.** Don't write the test inline. Invoke the `write-integration-test` skill — Band's test doctrine is strict and that skill is the source of truth. If the test is meaningful work, surface to the user and ask before proceeding.
- **"Doesn't satisfy linked issue."** Scope problem, not a code problem. Surface to the user; don't silently extend the diff.
- **Disagreement with a finding.** If it looks wrong (subagent misread context), explain why in your final report. Don't silently ignore it.

## Step 4 — Verify

Run the same checks the pre-push hook runs. From `CLAUDE.md`: *"Never bypass git hooks — do not use `--no-verify`."*

```bash
# All-in-one check (biome + cargo fmt --check + cargo clippy -D warnings).
# Documented as the canonical entrypoint in CONTRIBUTING.md.
pnpm check
# Tests — for affected package(s), not the whole monorepo.
pnpm --filter <affected-package> test
```

If any check fails after your fixes, fix and re-verify. Do not push.

## Step 5 — Report

Tell the user, in this order:

1. **What CI would have flagged** — N blockers, M nits, K suggestions.
2. **What you applied** — list of files changed.
3. **What you skipped and why** — suggestions list, anything contested.
4. **Linked-issue satisfaction** — quote the reviewer's verdict verbatim.
5. **Verification status** — lint, tests, clippy outcomes.
6. **Next step** — usually `git push` (the pre-push hook will pass), or "decide on the skipped suggestions first".

If verification fails and you cannot fix it, stop and surface the failure. Do not push broken code or paper over the failure.
