---
name: review-and-apply
description: Run Band's CI PR review locally before pushing, then auto-apply the fixes. Invokes the `review-changes` skill (the orchestrator that dispatches the coding/testing/security/performance specialist reviewers in parallel and returns sectioned findings plus a Verdict line), then applies each finding's `Fix:` with Edit/Write and verifies with lint, clippy, and tests. Use when the user says "review my branch before I push", "review and apply", "pre-flight check", "do a local PR review", "run the CI review locally", or "review my changes and fix them".
allowed-tools: Skill, Agent, Bash, Read, Edit, Write, Glob, Grep
---

# Review and Apply — Review → Fix → Verify

Two-phase flow:

1. **Review** — invoke the `review-changes` skill. It already knows how to gather context, dispatch the four specialist reviewers in parallel, and return sectioned findings plus a single `Verdict:` line. You just tell it *what* to review.
2. **Fix** — read the findings, apply each one's `Fix:` with Edit/Write, verify with lint/clippy/tests. Don't re-review; trust the specialists unless a finding is clearly wrong.

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

If you find no linked issue, pass `issues=none detected`. The reviewer still runs against the diff; linked-issue context is just additional input for the specialists when present.

## Step 2 — Invoke `review-changes`

Use the `Skill` tool to invoke the `review-changes` skill. The skill is self-contained — it loads its specialists, fetches the diff/issue context itself, and produces the sectioned report.

```
Skill(skill="review-changes", args="
Review this change set.

- Base:   <BASE ref>
- Head:   <HEAD short sha>
- PR:     <number, or 'no PR yet'>
- Issues: <comma-separated list of #N, or 'none detected'>
")
```

The skill returns a sectioned report with four fixed-order domain headers (Coding → Testing → Security → Performance), each with a status emoji, followed by a single overall **Verdict** line:

```
Coding 🚨

[N] severity:<...>  <path>:<line>
    <rule-id or tag>: <description>
    Fix: <change>
...

Testing ⚠️

[N] ...

Security ✅

Performance 🚨

[N] ...

Verdict: <approved 👍 | request changes 👎>
```

Status emoji semantics:

- `🚨` — that domain has at least one `blocker`.
- `⚠️` — that domain has `nit`s or `suggestion`s but no blockers.
- `✅` — that domain has zero findings. The header alone is the section; no findings list follows.

All four domain headers always appear, even with `✅` status.

Verdict semantics (computed mechanically by the skill):

- `approved 👍` — no `blocker` in any domain.
- `request changes 👎` — at least one `blocker` somewhere.

## Step 3 — Apply the fixes

Walk the report top-to-bottom — by section, then by severity within each section.

- **Every `blocker`** — apply the `Fix:` with Edit/Write. Group related fixes by file to minimize churn.
- **Every `nit`** — apply unless the user has made the choice the nit objects to.
- **Every `suggestion`** — skip by default. Collect them in a short list for the final report.

Special cases:

- **"Missing test" findings** (`testing-reviewer`, severity blocker, citing the source file): don't write the test inline. Invoke the `write-integration-test` skill — Band's test doctrine is strict and that skill is the source of truth. If the test is meaningful work, surface it to the user and ask before proceeding.
- **Disagreement with a finding.** If a finding looks wrong (specialist misread context, e.g. a `CODE-2` claim that doesn't actually cross a tier), explain why in your final report. Don't silently ignore it.

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

1. **What CI would have flagged** — quote each domain's header line verbatim so the user sees the same status icons CI will (`Coding 🚨`, `Testing ⚠️`, `Security ✅`, `Performance 🚨`), plus a total: `X blockers, Y nits, Z suggestions`.
2. **Skill's verdict** — quote the `Verdict: ...` line verbatim. This is what CI will signal.
3. **What you applied** — list of files changed.
4. **What you skipped and why** — suggestions list, anything contested.
5. **Verification status** — lint, tests, clippy outcomes.
6. **Next step** — usually `git push` (the pre-push hook will pass), or "decide on the skipped suggestions first".

If verification fails and you cannot fix it, stop and surface the failure. Do not push broken code or paper over the failure.
