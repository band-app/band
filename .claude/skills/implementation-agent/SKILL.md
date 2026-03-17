---
name: implementation-agent
description: Workspace-level implementation agent that picks up work from a GitHub issue, tracks progress via issue comments, creates PRs, handles review feedback, and merges when approved. Designed to be invoked repeatedly by the backlog-burner orchestrator or manually via band tasks. Use when an agent needs to implement a GitHub issue end-to-end in a Band workspace.
---

# Implementation Agent

Implements a GitHub issue in a Band workspace. Each run does one piece of work: reads progress from the GitHub issue comment, picks the next task, implements it, commits, pushes, and updates progress. Designed to be called repeatedly — each invocation gets fresh context and picks up where the last one left off.

## Prerequisites

- Inside a Band workspace (git worktree managed by Band)
- `gh` CLI authenticated with GitHub
- `band` CLI available
- Branch name encodes the issue number: `<issue-number>-<summary>` (e.g., `99-task-loop-mode`)

## Steps

### 1. Detect Issue and Repo

```sh
BRANCH=$(git branch --show-current)
ISSUE_NUMBER=$(echo "$BRANCH" | grep -oE '^[0-9]+')
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

If no issue number is found in the branch name, check the task prompt for a `#<number>` reference. If still not found, skip issue tracking and just work from the prompt.

Fetch the issue:

```sh
gh issue view $ISSUE_NUMBER --repo $REPO
```

### 2. Read Progress State

Check for an existing progress comment on the issue:

```sh
gh api repos/$REPO/issues/$ISSUE_NUMBER/comments \
  --jq '.[] | select(.body | contains("## Implementation Progress")) | {id, body}'
```

Also check the workspace state:

```sh
git log --oneline main..HEAD       # What's been committed
git status --porcelain              # Any uncommitted work
gh pr list --head $BRANCH --repo $REPO --json number,state,reviewDecision  # Existing PR?
```

### 3. Route by Current State

Based on what you find, take the appropriate action:

**State A — PR exists and is approved:**
Go to step 8 (Merge and Clean Up).

**State B — PR exists with review feedback:**
Go to step 7 (Handle PR Feedback).

**State C — PR exists, CI failing:**
Go to step 7 (Handle PR Feedback — fix CI).

**State D — PR exists, waiting for review:**
Nothing to do. Print "PR #N is waiting for review" and exit.

**State E — No PR, progress comment exists with unchecked items:**
Go to step 5 (Implement Next Task).

**State F — No PR, progress comment exists, all items checked:**
Go to step 6 (Create PR).

**State G — No progress comment (first run):**
Go to step 4 (Create Plan).

### 4. Create Plan (First Run Only)

Read the issue description carefully. Analyze the codebase to understand what needs to change. Break the work into concrete, independently implementable tasks.

Create the progress comment on the issue:

```sh
gh issue comment $ISSUE_NUMBER --repo $REPO --body '## Implementation Progress

### Plan
- [ ] 1. <first task — specific file changes and what they do>
- [ ] 2. <second task>
- [ ] 3. <third task>
- [ ] 4. Run tests and fix any failures
- [ ] 5. Final verification

### Status
In Progress

### Log
- <timestamp>: Created implementation plan'
```

Guidelines for the plan:
- Each task should be completable in a single agent run
- Be specific: name the files, functions, and patterns involved
- Order by dependency — foundational work first
- Always end with a test/verification task
- Keep it to 3-8 tasks (split large issues into multiple GitHub issues instead)

After creating the plan, proceed to implement the first task (step 5).

### 5. Implement Next Task

From the progress comment, find the first unchecked `- [ ]` item.

1. Read the relevant source files
2. Implement the change
3. Follow existing code patterns and conventions
4. Run the project's tests:
   - Check for test scripts: `cat package.json | jq '.scripts | keys[]'` or `Makefile`, `Cargo.toml`, etc.
   - Run tests and fix failures before proceeding
5. Stage and commit:

```sh
git add <specific files — not git add -A>
git commit -m "<type>: <description> (#<issue-number>)"
```

Commit message types: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

6. Push:

```sh
git push -u origin $BRANCH
```

7. Update the progress comment — check off the completed task and add a log entry:

```sh
COMMENT_ID=$(gh api repos/$REPO/issues/$ISSUE_NUMBER/comments \
  --jq '.[] | select(.body | contains("## Implementation Progress")) | .id')

gh api repos/$REPO/issues/comments/$COMMENT_ID -X PATCH -f body='## Implementation Progress

### Plan
- [x] 1. <completed task>
- [ ] 2. <next task>
...

### Status
In Progress — completed task 1

### Log
- <previous entries>
- <timestamp>: Completed task 1 — <brief description of what was done>'
```

### 6. Create PR

When all checklist items are checked, create a PR:

```sh
gh pr create --repo $REPO --base main \
  --title "<type>: <description> (#$ISSUE_NUMBER)" \
  --body "## Summary
Closes #$ISSUE_NUMBER

<2-3 bullet points summarizing what was implemented>

## Test Plan
<how to verify the changes work>

---
Automated by Band"
```

Update the progress comment status:

```
### Status
PR Created — waiting for review
```

### 7. Handle PR Feedback

If a PR exists, check its state:

```sh
PR_NUMBER=$(gh pr list --head $BRANCH --repo $REPO --json number -q '.[0].number')
gh pr view $PR_NUMBER --repo $REPO --json reviewDecision,reviews,statusCheckRollup
```

**CI failing:**

```sh
gh pr checks $PR_NUMBER --repo $REPO
```

Read the failing check output, fix the code, commit, and push.

**Changes requested:**

```sh
gh pr view $PR_NUMBER --repo $REPO --comments
```

Read review comments, address each one, commit with a message like `fix: address review feedback (#<issue>)`, and push. Update the progress comment log.

**Approved:**
Go to step 8.

### 8. Merge and Clean Up

Verify approval:

```sh
DECISION=$(gh pr view $PR_NUMBER --repo $REPO --json reviewDecision -q .reviewDecision)
HAS_APPROVED_LABEL=$(gh pr view $PR_NUMBER --repo $REPO --json labels -q '[.labels[].name] | any(. == "approved")')
```

Only proceed if `DECISION == "APPROVED"` or `HAS_APPROVED_LABEL == "true"`.

```sh
# Wait for CI to be green
gh pr checks $PR_NUMBER --repo $REPO --watch --fail-fast

# Squash merge
gh pr merge $PR_NUMBER --repo $REPO --squash --delete-branch

# Close the issue
gh issue close $ISSUE_NUMBER --repo $REPO
```

Update the progress comment:

```
### Status
Merged
```

Detect current project and branch from Band workspace list, then clean up:

```sh
PROJECT=$(band workspaces list --output json | jq -r '.workspaces[] | select(.branch == "'"$BRANCH"'") | .project')

# Must leave the workspace directory before deleting it
cd $(band projects list --output json | jq -r '.projects[] | select(.name == "'"$PROJECT"'") | .path')

band workspaces remove $PROJECT $BRANCH
```

## Rules

- **One task per run** — implement one checklist item, commit, push, update progress, exit. The next run picks up the next item.
- **Always push** — work must be on the remote so other agents and humans can see it.
- **Always update the progress comment** — this is how the next run knows what to do. Without it, the next fresh-context invocation has no memory.
- **Never merge without approval** — only merge when `reviewDecision == "APPROVED"` or the `approved` label is present.
- **Run tests before committing** — never push broken code.
- **Small, focused commits** — one logical change per commit with a descriptive message.
- **Follow existing patterns** — read neighboring code before writing new code. Match the project's style, naming, and architecture.
- **Don't modify production code to fix tests** — if a test fails, either the implementation is wrong or the test needs updating. Never add test-only branches to production code.
