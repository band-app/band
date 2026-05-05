---
name: backlog-burner
description: Master orchestrator that burns through a project backlog. Runs as a project-scoped cronjob on main branch — scans GitHub issues, manages workspaces, submits tasks to idle agents, merges approved PRs, and cleans up completed work. Use when setting up automated backlog processing, orchestrating multiple agents, or supervising workspace-level work across a project.
---

# Backlog Burner — Master Orchestrator

Supervises all workspaces in a project. On every run: checks what's idle, what's approved, what needs attention, and what's next in the backlog. Dispatches work via `band chat` and cleans up finished workspaces.

This skill is designed to run as a **project-scoped cronjob on the main branch**. Set it up with:

```sh
band cronjobs create <project> \
  --name "Backlog Burner" \
  --prompt "Run /backlog-burner" \
  --cron "*/10 * * * *" \
  --scope project
```

## Prerequisites

- Band server running
- `gh` CLI authenticated with GitHub
- `band` CLI available
- Project registered with Band (`band projects list`)

## Steps

### 1. Gather State

Detect project and repo from the current working directory:

```sh
PROJECT=$(band projects list --output json | jq -r '.projects[] | select(.path == "'"$(pwd)"'") | .name')
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

Collect the full picture:

```sh
# All workspaces for this project
band workspaces list --output json | jq '[.workspaces[] | select(.project == "'"$PROJECT"'")]'

# All tasks (running and recent)
band tasks list --output json

# Open GitHub issues (the backlog)
gh issue list --repo $REPO --state open --json number,title,labels,body --limit 50

# Open PRs
gh pr list --repo $REPO --state open --json number,title,headRefName,labels,reviewDecision
```

### 2. Merge Approved PRs

For each open PR where `reviewDecision == "APPROVED"` or has an `approved` label:

1. Find the workspace matching the PR's `headRefName` (branch name)
2. Check if that workspace already has a running task — skip if so
3. Submit a merge task:

```sh
band chat <workspace_id> --message "The PR #<number> has been approved. Merge it and clean up:

1. Wait for CI: gh pr checks <number> --watch --fail-fast
2. If CI passes, squash merge: gh pr merge <number> --squash --delete-branch
3. Close the linked issue if the PR body references one
4. Remove the workspace: band workspaces remove <project> <branch>"
```

### 3. Re-activate Idle Workspaces

A workspace is idle when it has no task with `status: "running"`.

For each idle workspace (skip the main branch workspace):

Extract the issue number from the branch name. Branch format: `<issue-number>-<summary>` (e.g., `99-task-loop-mode` is issue #99).

**If a PR exists for this branch:**

```sh
gh pr view --json number,state,reviewDecision,statusCheckRollup --head <branch> --repo $REPO
```

- CI failed → submit task: `"CI is failing on PR #<number>. Run gh pr checks <number> to see what failed. Fix the issues, commit, and push."`
- Changes requested → submit task: `"PR #<number> has review feedback. Run gh pr view <number> --comments to read it. Address the feedback, commit, and push."`
- Waiting for review → skip, nothing to do
- Approved → handled in step 2

**If no PR exists but commits are ahead of main:**

```sh
# Check if branch has commits ahead
git -C <worktree_path> rev-list --count main..HEAD
```

Submit task to continue work:

```sh
band chat <workspace_id> --message "Continue implementing issue #<number>. Read the progress comment on the GitHub issue for context on what has been done. Pick up where the last agent left off. When implementation is complete, create a PR."
```

**If workspace is fresh (no commits ahead, no PR):**

Fetch the issue and submit the full implementation prompt:

```sh
ISSUE_BODY=$(gh issue view <number> --repo $REPO --json title,body -q '.title + "\n\n" + .body')
band chat <workspace_id> --message "Implement GitHub issue #<number>:\n\n$ISSUE_BODY\n\nTrack progress by maintaining a comment on the issue with a checklist. Create a PR when done."
```

### 4. Pick Up New Issues from the Backlog

Find open issues that do NOT have a matching workspace. Match by checking if any workspace branch starts with `<issue-number>-`.

For the **highest priority unassigned issue** (by label priority, then lowest issue number):

```sh
band workspaces create $PROJECT <issue-number>-<short-summary> \
  --prompt "Implement GitHub issue #<number>: <title>

<issue body>

Track your progress by maintaining a comment on the GitHub issue with the header '## Implementation Progress' and a checklist of tasks. Update it after each piece of work. Create a PR when all tasks are complete."
```

**Limit: create at most 1 new workspace per run.** Let existing work finish before starting more.

### 5. Clean Up Stale Workspaces

For workspaces whose branch has been merged and deleted on the remote:

```sh
# Check if remote branch still exists
git -C <worktree_path> ls-remote --heads origin <branch>
```

If the remote branch is gone and no open PR exists, remove the workspace:

```sh
band workspaces remove $PROJECT <branch>
```

### 6. Report Summary

Print a summary of all actions taken:

```
Backlog Burner Summary:
- Submitted merge task for PR #149 (workspace: band/batch-ci-polling)
- Submitted implementation task to idle workspace: band/99-task-loop-mode
- Created new workspace for issue #141: band/141-fix-ci-status
- Cleaned up stale workspace: band/145-todos-render
- Skipped 2 workspaces with running tasks
- Remaining open issues without workspaces: 2
```

## Rules

- **Never create more than 1 new workspace per run** — avoid overloading
- **Never submit a task to a workspace with a running task** — check first
- **Prioritize finishing work over starting new work** — idle workspaces get tasks before new issues get workspaces
- **Never merge without approval** — only dispatch merge tasks for approved PRs
- **Skip the main branch workspace** — that's where this skill runs, don't submit tasks to yourself
- **Always print a summary** — makes the cronjob output useful for debugging
