---
name: backlog-burner
description: Master orchestrator that burns through a project backlog. Runs as a project-scoped cronjob on the main branch — scans GitHub issues labeled `backlog-burner`, manages one workspace per issue, dispatches implementation work via `band chats send`, and merges PRs itself (from outside the workspace) once CI is green and there are no outstanding reviewer remarks. Use when setting up automated backlog processing, orchestrating multiple agents, or supervising workspace-level work across a project.
---

# Backlog Burner — Master Orchestrator

Supervises all workspaces in a project. On every run: scans the backlog, checks each workspace's chat state, dispatches work to idle agents, merges PRs that are ready, and cleans up finished workspaces.

This skill is designed to run as a **project-scoped cronjob on the main branch**. Set it up with:

```sh
band cronjobs create <project> \
  --name "Backlog Burner" \
  --prompt "Run /backlog-burner" \
  --cron "*/10 * * * *" \
  --scope project
```

## What the burner picks up

Only GitHub issues with the **`backlog-burner`** label are in scope. Every other issue is invisible to this skill. Add the label to opt an issue into automated processing; remove it to take an issue back under manual control.

## Division of labor

**Workspace agent** (inside each per-issue workspace) — narrow job:

1. Implement the issue.
2. Run **`/review-and-apply`** to lint/clippy/test and apply any fixes it surfaces.
3. Commit and push.
4. Create the PR (`gh pr create --base main --fill --body "Closes #$N"`).
5. Stop. Wait for the next nudge.

**Burner** (this skill, running as a cronjob) — orchestration:

- Creates the workspace and the initial chat (no `/band-start` needed — the burner already has all the context).
- On every tick: scans PR state, nudges the agent when there's `blocker`-severity feedback or CI failures, and **merges directly** (from outside the workspace) once CI is green and no blocker remarks remain.
- Cleans up the workspace after merging.

The agent never invokes `/finish-pr`. PR creation is the agent's last step before it stops; everything after that — CI watching, feedback dispatch, merge, cleanup — happens at cron cadence from the burner.

There is **no human approval gate**. A PR is mergeable as long as there are **no `blocker`-severity remarks** and CI is green. Findings tagged `nit` or `suggestion` are **advisory** — they never block the merge. Even nits are capped: the burner dispatches at most **3 non-blocker iteration rounds** before merging anyway (see step 3 case (d) and the `review-round` chat label).

## How the burner finds its workspaces

Each chat the burner creates in a workspace is tagged with two labels so the next run can find it without parsing branch names:

| Label             | Value                   | Why                                                                 |
| ----------------- | ----------------------- | ------------------------------------------------------------------- |
| `backlog-burner`  | `true`                  | "this chat is owned by the burner; don't ignore it"                 |
| `issue`           | `<github-issue-number>` | which issue this chat is implementing                               |
| `review-round`    | `<integer>` (default 0) | how many non-blocker feedback rounds the burner has dispatched      |

All three keys conform to the user-writable label syntax (`^[a-zA-Z0-9_:-]{1,64}$`) and avoid the reserved `band:` prefix (which is held for server-managed labels like `band:cronId` on the burner's own scheduled chat). The `review-round` counter caps the nit/suggestion polishing loop at 3 — see step 3 case (d).

A chat without the `backlog-burner=true` label is **invisible** to this skill — never act on it, never preempt it.

## Prerequisites

- Band server running
- `gh` CLI authenticated with GitHub
- `band` CLI available
- Project registered with Band (`band projects list`)
- `/review-and-apply` skill available to the workspace agent (checked into this repo under `.claude/skills/review-and-apply/`)

## Steps

### 1. Gather state

Detect project and repo from the current working directory:

```sh
PROJECT=$(band projects list --output json | jq -r '.projects[] | select(.path == "'"$(pwd)"'") | .name')
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

Collect the full picture:

```sh
# All workspaces for this project
WORKSPACES=$(band workspaces list --output json \
  | jq '[.workspaces[] | select(.project == "'"$PROJECT"'")]')

# Burner-managed chats: each chat this skill created carries
# `backlog-burner=true` plus `issue=<N>` labels (see step 4b). The chat
# is the source of truth — it tells us which workspace maps to which
# issue without parsing branch names.
MANAGED=$(for ws_id in $(echo "$WORKSPACES" | jq -r '.[].workspaceId'); do
  band chats list "$ws_id" --output json \
    | jq -c --arg ws "$ws_id" \
        '.chats[] | select(.labels."backlog-burner" == "true") |
         {workspace_id: $ws, chat_id: .id, status: .status,
          issue: (.labels.issue // ""),
          review_round: ((.labels."review-round" // "0") | tonumber)}'
done | jq -s '.')

# Open backlog-burner-labeled GitHub issues (the only backlog this skill cares about)
ISSUES=$(gh issue list --repo "$REPO" --state open --label backlog-burner \
  --json number,title,labels,body,url --limit 50)
```

`$MANAGED` is the source of truth for steps 2 and 3.

### 2. Check each managed chat's state

The chat's `status` field tells you whether the agent is busy:

- `status == "running"` → the agent is actively processing a task. **Do nothing** — let it work.
- **anything else** (`idle`, `stopped`, `error`) → the agent is free; proceed to the dispatch/merge logic in step 3.

`ChatStatus` is a closed enum: `running | idle | stopped | error` (`apps/web/src/lib/chat-manager.ts`). Treat `stopped` and `error` the same as `idle` — step 3 picks the right action based on git + PR state regardless of why the previous task ended.

### 3. Dispatch or merge based on git + PR state

For each non-`running` entry in `$MANAGED`, destructure the per-chat fields and then look up the workspace's branch and worktree path:

```sh
# Per-entry fields captured by the $MANAGED query in step 1.
# (Treat these as already-set when iterating; the loop binding is omitted here for readability.)
workspace_id=$(echo "$entry" | jq -r .workspace_id)
chat_id=$(echo      "$entry" | jq -r .chat_id)
N=$(echo            "$entry" | jq -r .issue)
REVIEW_ROUND=$(echo "$entry" | jq -r .review_round)

BRANCH=$(echo "$WORKSPACES" | jq -r --arg id "$workspace_id" \
  '.[] | select(.workspaceId == $id) | .branch')
WT_PATH=$(echo "$WORKSPACES" | jq -r --arg id "$workspace_id" \
  '.[] | select(.workspaceId == $id) | .path')

# PR state for this branch. `gh pr view` doesn't accept --head; use list + first.
# `mergeStateStatus` and `mergeable` are needed by case (g) to detect a branch
# that's behind main and needs a rebase before CI can usefully run. GitHub
# computes these asynchronously after a push, so they may be `UNKNOWN` for a
# few seconds — case (g) treats `UNKNOWN` as "not yet conflicting" and waits.
PR=$(gh pr list --head "$BRANCH" --repo "$REPO" --state all \
  --json number,state,reviewDecision,reviews,comments,statusCheckRollup,mergeStateStatus,mergeable \
  | jq -c '.[0] // empty')
PR_MERGEABLE=$(echo      "$PR" | jq -r '.mergeable // "UNKNOWN"')
PR_MERGE_STATE=$(echo    "$PR" | jq -r '.mergeStateStatus // "UNKNOWN"')

# Inline review comments (NOT the same as the top-level `PR.comments` above —
# inline comments live on a different endpoint). These are where CI's
# `pr-reviewer` posts severity-tagged findings via
# `mcp__github_inline_comment__create_inline_comment`.
#
# IMPORTANT: Do NOT round-trip the comment JSON through a shell variable
# (e.g. `INLINE=$(gh api ...); echo "$INLINE" | jq ...`). PR review bodies
# contain literal newlines and `\n` escapes that some shells (`dash`, POSIX
# `sh`, even `bash` under some quoting) corrupt during `echo` re-expansion,
# producing `jq: parse error: Invalid string: control characters from
# U+0000 through U+001F must be escaped`. Let `gh api --jq` do the filtering
# in one shot so the shell only ever sees the resulting integer.
PR_NUM=$(echo "$PR" | jq -r '.number // empty')

# The reviewer's output format (see `.claude/pr-review-criteria.md`) prefixes
# every finding with one of `blocker`, `nit`, or `suggestion`. Common shapes:
#   `[N] severity:blocker  <path>:<line>`
#   `**severity:nit**`
#   `**[3] nit**`
#   `**suggestion**`
#   `[blocker]`
#
# We use GraphQL `reviewThreads` (not the REST `pulls/N/comments` endpoint)
# because it exposes `isResolved` — the single source of truth for "the
# reviewer has acknowledged this is dealt with". The case (d) dispatch
# instructs the agent to call the `resolveReviewThread` mutation after
# every fix or wontfix decision, so any thread the agent has finished with
# is excluded from these counts on the next tick. A "Fixed in <sha>" reply
# alone is NOT enough — only `isResolved: true` clears the thread.
if [ -n "$PR_NUM" ]; then
  OWNER=$(echo "$REPO" | cut -d/ -f1)
  REPO_NAME=$(echo "$REPO" | cut -d/ -f2)

  # Two separate `gh api graphql --jq … | length` calls, each emitting only an
  # integer. Same anti-round-trip rule as elsewhere in the skill: the shell
  # must never see the raw comment bodies — embedded control characters in
  # review prose corrupt the JSON during `echo`/`printf` re-expansion in some
  # shells. Letting `gh` pipe the JSON straight into its bundled jq avoids it.
  THREADS_QUERY='
    query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { isResolved comments(first: 1) { nodes { body } } }
          }
        }
      }
    }'

  UNRESOLVED_BLOCKERS=$(gh api graphql \
    -f query="$THREADS_QUERY" \
    -F owner="$OWNER" -F name="$REPO_NAME" -F number="$PR_NUM" \
    --jq '[ .data.repository.pullRequest.reviewThreads.nodes[]
            | select(.isResolved == false)
            | select(.comments.nodes[0].body
                     | test("severity[ :]*blocker|\\[blocker\\]|\\*\\*[ ]*\\[?[0-9]*\\]?[ ]*blocker"; "i"))
          ] | length')

  UNRESOLVED_NITS=$(gh api graphql \
    -f query="$THREADS_QUERY" \
    -F owner="$OWNER" -F name="$REPO_NAME" -F number="$PR_NUM" \
    --jq '[ .data.repository.pullRequest.reviewThreads.nodes[]
            | select(.isResolved == false)
            | select(.comments.nodes[0].body
                     | test("severity[ :]*(nit|suggestion)|\\[(nit|suggestion)\\]|\\*\\*[ ]*\\[?[0-9]*\\]?[ ]*(nit|suggestion)"; "i"))
          ] | length')
else
  UNRESOLVED_BLOCKERS=0
  UNRESOLVED_NITS=0
fi

# Local git state inside the worktree
DIRTY=$(git -C "$WT_PATH" status --porcelain)
AHEAD=$(git -C "$WT_PATH" rev-list --count main..HEAD)
```

`$N` (issue number) and `$REVIEW_ROUND` are read from the chat's labels in the per-entry destructure above. `$UNRESOLVED_BLOCKERS` is the only severity bucket that gates the merge — nits and suggestions are advisory regardless of count. `$UNRESOLVED_NITS` is used by case (d) to decide whether non-blocker dispatch is still useful at the current `$REVIEW_ROUND`.

**Case evaluation order** (first match wins):

1. **(a)** no PR, no commits ahead → kickoff
2. **(b)** commits ahead, no PR → finish + open PR
3. **(g)** PR exists AND `mergeable == "CONFLICTING"` → **rebase first** (cuts the loop before waiting on CI that won't usefully land)
4. **(c)** PR exists, `UNRESOLVED_BLOCKERS == 0`, CI green → merge (or merge via iteration-cap escape hatch)
5. **(d)** PR exists, blocker remarks OR non-blocker feedback within cap → dispatch
6. **(e)** PR exists, CI failing → dispatch CI fix
7. **(f)** PR exists, CI still pending → wait

(g) before (e)/(f) is the important invariant: a `CONFLICTING` branch will fail CI for an irrelevant reason (the merge can't even be computed), so dispatching CI-fix or waiting on it would burn time on the wrong problem.

#### Case (a) — no PR, no commits ahead

The agent died before doing anything. Resend the kickoff prompt:

```sh
band chats send --workspace "$workspace_id" --message "Implement GitHub issue #$N: <issue-url>.

Run /review-and-apply before pushing. Commit, push, and then create the PR:
  gh pr create --base main --fill --body 'Closes #$N'

After the PR is open, stop. The orchestrator will watch CI, dispatch any feedback, and merge when ready.

Track progress with a '## Implementation Progress' comment on the issue."
```

#### Case (b) — commits ahead, no PR yet

Implementation is partway done but the agent stopped before opening a PR. Nudge it to finish and open the PR:

```sh
band chats send --workspace "$workspace_id" --message "Continue implementing issue #$N. When done: /review-and-apply, commit, push, then 'gh pr create --base main --fill --body \"Closes #$N\"'. Stop after the PR is open."
```

(If `$DIRTY` is empty *and* `$AHEAD > 0`, the agent may have already pushed without opening a PR — the same nudge above will trigger them to run `gh pr create`.)

#### Case (c) — PR exists, no blocker remarks, CI green → **merge directly**

The merge gate is **blocker-severity only**. Nits and suggestions are advisory and never block. The iteration counter caps the polishing loop separately (see case (d)).

All of these must hold:

- `PR.reviewDecision != "CHANGES_REQUESTED"`
- Every entry in `PR.reviews[]` either has `state != "CHANGES_REQUESTED"` or has been dismissed
- `UNRESOLVED_BLOCKERS == 0` (no unresolved inline comment is tagged as `blocker` severity — nit and suggestion comments do **not** count)
- `PR.statusCheckRollup` is all `SUCCESS` (no `FAILURE`, no `PENDING`)

Also merge under the **iteration-cap escape hatch**: if `REVIEW_ROUND >= 3` AND `UNRESOLVED_BLOCKERS == 0` AND CI is green, merge regardless of how many nit/suggestion comments remain. After 3 dispatch rounds the marginal value of further polishing has run out — see case (d).

The burner merges. No agent wake-up — this happens at cron cadence:

```sh
PR_NUM=$(echo "$PR" | jq -r .number)
gh pr merge "$PR_NUM" --repo "$REPO" --squash --delete-branch

# Close the issue if the "Closes #N" link didn't already do it
gh issue close "$N" --repo "$REPO" 2>/dev/null || true

# Remove the workspace
band workspaces remove "$PROJECT" "$BRANCH"
```

#### Case (d) — PR exists, blocker remarks OR fresh non-blocker feedback (within cap)

Dispatch the agent only if there's work that actually gates the merge or we're still under the non-blocker iteration cap. The cap stops the death-by-nits cycle where each "address feedback" commit triggers a fresh review that surfaces a different set of nits.

`$UNRESOLVED_BLOCKERS` and `$UNRESOLVED_NITS` were computed in the step-3 state lookup above (via `gh api --jq` — never round-trip JSON through a shell variable).

The agent **must** mark every inline comment thread it addresses as `resolved` via the GitHub GraphQL mutation `resolveReviewThread`. Posting a "Fixed in <sha>" reply is not enough — the merge gate in case (c) checks `in_reply_to_id == null`, so a thread with a reply still counts as unresolved unless the thread itself is also marked resolved. (And the GitHub UI's red "Unresolved" badge is what most reviewers look at anyway.)

The how-to for the agent — list threads, then resolve by ID — is below in the message body. Keep this block in sync with the message text.

```sh
if [ "$UNRESOLVED_BLOCKERS" -gt 0 ]; then
  # Blockers always dispatch — no iteration cap on shipping correctness fixes.
  band chats send --workspace "$workspace_id" --message "PR #$PR_NUM has $UNRESOLVED_BLOCKERS unresolved BLOCKER finding(s).

1. Read the findings:
   gh api repos/$REPO/pulls/$PR_NUM/comments --jq '.[] | select(.in_reply_to_id == null) | {id, path, line, body: .body[:200]}'

2. Fix every blocker. Nits and suggestions on this PR are advisory; ignore them.

3. After each fix, RESOLVE THE INLINE THREAD on GitHub. A reply alone is not enough —
   you must mark the thread itself as resolved or the burner's merge gate will keep
   re-flagging it. List thread IDs and their first comment's databaseId:

   gh api graphql -f query='
     query(\$owner: String!, \$name: String!, \$number: Int!) {
       repository(owner: \$owner, name: \$name) {
         pullRequest(number: \$number) {
           reviewThreads(first: 100) {
             nodes { id isResolved comments(first: 1) { nodes { databaseId path } } }
           }
         }
       }
     }' -F owner=$(echo $REPO | cut -d/ -f1) -F name=$(echo $REPO | cut -d/ -f2) -F number=$PR_NUM

   Match each comment.id from step 1 to the thread whose first-comment databaseId
   equals it, then resolve that thread:

   gh api graphql -f query='
     mutation(\$threadId: ID!) {
       resolveReviewThread(input: { threadId: \$threadId }) { thread { isResolved } }
     }' -F threadId=<THREAD_ID>

4. Run /review-and-apply, commit, push. Stop after pushing.

The orchestrator will only merge once every blocker thread is marked resolved AND CI is green."
elif [ "$UNRESOLVED_NITS" -gt 0 ] && [ "$REVIEW_ROUND" -lt 3 ]; then
  # Non-blocker feedback within the cap. Increment the counter BEFORE dispatch
  # so a same-tick crash doesn't undercount.
  NEW_ROUND=$((REVIEW_ROUND + 1))
  band chats label "$chat_id" "review-round=$NEW_ROUND"
  band chats send --workspace "$workspace_id" --message "PR #$PR_NUM has nit/suggestion feedback (round $NEW_ROUND of 3).

1. Read the findings:
   gh api repos/$REPO/pulls/$PR_NUM/comments --jq '.[] | select(.in_reply_to_id == null) | {id, path, line, body: .body[:200]}'

2. Fix only the nits whose fix is genuinely worth a CI cycle (typos, dead code,
   obvious bugs in comments). Skip suggestions — they are optional and the
   orchestrator will merge after round 3 regardless.

3. For EVERY thread you touched — whether you fixed it or decided not to — mark
   the thread resolved on GitHub. For 'wontfix' decisions, post a brief reply
   stating the reason FIRST, then resolve the thread.

   List threads (returns the GraphQL thread.id you need + the first comment's
   databaseId which matches the comment.id from step 1):

   gh api graphql -f query='
     query(\$owner: String!, \$name: String!, \$number: Int!) {
       repository(owner: \$owner, name: \$name) {
         pullRequest(number: \$number) {
           reviewThreads(first: 100) {
             nodes { id isResolved comments(first: 1) { nodes { databaseId path } } }
           }
         }
       }
     }' -F owner=$(echo $REPO | cut -d/ -f1) -F name=$(echo $REPO | cut -d/ -f2) -F number=$PR_NUM

   Resolve a thread:

   gh api graphql -f query='
     mutation(\$threadId: ID!) {
       resolveReviewThread(input: { threadId: \$threadId }) { thread { isResolved } }
     }' -F threadId=<THREAD_ID>

   Optional pre-resolve reply for wontfix (otherwise reviewers won't know why):

   gh api repos/$REPO/pulls/$PR_NUM/comments/<COMMENT_ID>/replies \\
       -f body='wontfix: <one-line reason>'

4. Run /review-and-apply, commit, push. Stop after pushing.

Threads you leave unresolved count against the next-round budget. After round 3
the orchestrator merges regardless — but if you resolved everything, it merges
this round."
else
  # Either no unresolved non-blocker comments, or REVIEW_ROUND >= 3. The merge
  # gate in case (c) will pick this up on the next tick once CI is green.
  : # no-op
fi
```

Note: case (c) and case (d) can both apply on the same tick — if `UNRESOLVED_BLOCKERS == 0` and CI is green, case (c) merges immediately and we never enter case (d). Evaluate case (c) first.

#### Case (e) — PR exists, CI failing

```sh
band chats send --workspace "$workspace_id" --message "CI is failing on PR #$PR_NUM. Run 'gh pr checks $PR_NUM' to see what failed. Fix it, /review-and-apply, commit, push. Stop after pushing."
```

#### Case (f) — PR exists, CI still pending

Do nothing. Wait for the next tick.

If a PR has been `CI pending` for more than ~10 minutes with **zero** workflow runs in `gh api repos/$REPO/actions/runs?branch=$BRANCH` (not just zero completed runs — zero runs of any status), that's not a "pending" state, it's a workflow that never fired. The most common cause is a `mergeable: CONFLICTING` branch (case (g) handles it); the second most common cause is a transient GitHub Actions outage or a hit billing quota — those are out of scope for the burner. Print the situation in the summary so a human can investigate.

#### Case (g) — PR exists, branch conflicts with main → **rebase**

GitHub computes `mergeable` asynchronously; treat `UNKNOWN` as "not yet conflicting" and let the next tick decide. Only act on the definitive negative.

Trigger:

- `$PR_MERGEABLE == "CONFLICTING"` (definitive — GitHub finished the check and the branch can't be merged), OR
- `$PR_MERGE_STATE == "DIRTY"` (same signal, surfaced through a different field on older API responses)

Why evaluate this **before** (e) and (f): a conflicting branch produces a no-op `pull_request` event (GitHub can't compute the merge commit), so CI either never fires or fires against a stale tree. Waiting on case (f) is futile; dispatching a CI-fix in case (e) wastes a round on the wrong problem.

```sh
band chats send --workspace "$workspace_id" --message "PR #$PR_NUM is mergeable=CONFLICTING against main. Your branch was forked before recent merges to main landed.

Run inside the workspace:
  git fetch origin main
  git rebase origin/main

Resolve conflicts. For the 3-tier refactor series the conflict pattern is usually in 'apps/web/src/trpc/router.ts' (drop the moved domain's key) and 'apps/web/src/server/api/router.ts' (add the new sub-router to mergeRouters). Re-run tests for the affected domain to confirm the rebase didn't break behavior.

Then: /review-and-apply, 'git push --force-with-lease', stop. The orchestrator will re-check on the next tick and case (c)/(d)/(e) will pick up from there."
```

Case (g) does **not** increment `review-round` — a rebase is a structural fix, not a polish round. The non-blocker iteration cap should not be consumed by mechanical conflict resolution.

### 4. Pick up new backlog-burner-labeled issues

Find open `backlog-burner`-labeled issues that have **no managed chat** (no entry in `$MANAGED` whose `issue` label equals the issue number):

```sh
UNCLAIMED=$(echo "$ISSUES" | jq -c --argjson managed "$MANAGED" \
  '[.[] | select(.number as $n | ($managed | map(.issue | tonumber) | index($n)) == null)]')
```

#### 4a. Filter out issues with unmet dependencies

Issue bodies declare prerequisites in a `## Dependencies` section as a bulleted list of `#<N>` references — one dependency per line, each line starting with `- #<N>`. Before considering an issue eligible, every referenced dependency must be **closed**. `#<N>` mentions in prose, links, or non-bullet form inside the Dependencies section are ignored — keep dependencies on their own bullet lines so the parser picks them up.

For each candidate issue, parse its body and resolve each dependency:

```sh
# Pull the body and extract only `- #<N>` bullet lines from the Dependencies section
ISSUE_BODY=$(gh issue view <N> --repo "$REPO" --json body -q .body)
DEP_NUMS=$(echo "$ISSUE_BODY" \
  | awk '/^## Dependencies/{flag=1; next} /^## /{flag=0} flag' \
  | grep -oE '^[[:space:]]*-[[:space:]]*#[0-9]+' \
  | grep -oE '[0-9]+' | sort -u)

# Confirm every dependency is closed
for dep in $DEP_NUMS; do
  state=$(gh issue view "$dep" --repo "$REPO" --json state -q .state)
  if [ "$state" != "CLOSED" ]; then
    echo "  skipping #<N>: dependency #$dep is still $state"
    # Mark this candidate ineligible and move on
  fi
done
```

An issue is **eligible** only if `DEP_NUMS` is empty OR every dependency resolves to `state == "CLOSED"`. Issues with one or more open dependencies stay in the backlog untouched until those dependencies close — they show up as `blocked` lines in the summary (step 6), not as new workspaces.

#### 4b. Create the workspace and label its chat

From the **eligible** candidates, pick the highest-priority one (lowest issue number, ties broken by created-at). The burner picks its own branch name and creates the workspace directly — it already has the issue number, title, and URL, so there's no need to delegate to a separate kickoff skill:

```sh
N=$(echo "$ISSUE" | jq -r .number)
TITLE=$(echo "$ISSUE" | jq -r .title)
URL=$(echo "$ISSUE" | jq -r .url)

# Branch name: <issue-number>-<slug-of-title>, slug capped at 40 chars
SLUG=$(echo "$TITLE" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-40 \
  | sed -E 's/-+$//')
BRANCH="${N}-${SLUG}"

band workspaces create "$PROJECT" "$BRANCH" --prompt "Implement GitHub issue #$N: $URL.

Run /review-and-apply before pushing. Commit, push, then create the PR:
  gh pr create --base main --fill --body 'Closes #$N'

After the PR is open, stop. The backlog burner will monitor CI, dispatch any reviewer feedback, and merge when ready.

Track progress with a '## Implementation Progress' comment on the issue."
```

Immediately after creation, label the workspace's default chat so the next burner run can find it via labels (step 1):

```sh
WORKSPACE_ID=$(band workspaces list --output json \
  | jq -r --arg b "$BRANCH" '.workspaces[] | select(.branch == $b) | .workspaceId')

# The workspace's default chat is the first (and only) chat at creation time
CHAT_ID=$(band chats list "$WORKSPACE_ID" --output json | jq -r '.chats[0].id')

# Tag it — these are the labels the next run's `$MANAGED` query relies on.
# `review-round=0` initializes the non-blocker iteration counter (see step 3 case (d)).
band chats label "$CHAT_ID" backlog-burner=true "issue=$N" review-round=0
```

A workspace whose chat is missing the `backlog-burner=true` label is invisible to subsequent runs — the burner will treat the issue as unclaimed and try to create a second workspace on the next tick, producing a duplicate. **Labeling is part of workspace creation, not an optional follow-up.**

**Limit: create at most 1 new workspace per burner run.** Let existing work finish before starting more.

### 5. Janitor pass — clean up stranded workspaces

Step 3 case (c) removes a workspace right after merging. This step catches edge cases where that didn't fire — interrupted run, network blip mid-cleanup, or a workspace whose branch was deleted by something other than the burner.

```sh
echo "$WORKSPACES" | jq -c '.[]' | while read -r ws; do
  WS_BRANCH=$(echo "$ws" | jq -r .branch)
  WS_PATH=$(echo "$ws" | jq -r .path)

  # Skip the project's main-branch workspace — that's where the burner runs.
  [ "$WS_BRANCH" = "main" ] && continue

  # If the remote head still exists, the branch is live; leave it alone.
  if [ -n "$(git -C "$WS_PATH" ls-remote --heads origin "$WS_BRANCH")" ]; then
    continue
  fi

  band workspaces remove "$PROJECT" "$WS_BRANCH"
done
```

### 6. Report summary

Print a single summary of every action taken this run:

```
Backlog Burner Summary (project: band, repo: band-app/band)
- Created workspace for issue #311 (branch: 311-phase-0-scaffold, review-round=0)
- Merged PR #520 and removed workspace 315-phase-4-cronjobs (issue #315, blockers=0, CI green)
- Merged PR #524 via iteration-cap escape hatch (review-round=3, blockers=0, 4 nits left advisory)
- Nudged 313-phase-2-projects on PR #517: 2 BLOCKERS — dispatched without incrementing counter
- Nudged 316-phase-5-chats-browsers on PR #527: CONFLICTING against main — dispatched rebase (case g, counter unchanged)
- Nudged 318-phase-7-terminals on PR #530: nits-only (review-round 1 → 2)
- Skipped 319-cleanup on PR #531: nits-only at review-round=3 — waiting for case (c) to merge
- Nudged 314-phase-3-tunnel to fix CI on PR #519
- Flagged PR #534: CI pending >10min with 0 workflow runs — likely Actions outage or quota, human investigation needed
- Cleaned up stranded workspace 312-phase-1-settings (branch deleted on remote)
- 2 workspaces busy (status: running) — skipped
- 3 issues blocked by open dependencies: #316 (waiting on #314), #319 (waiting on #311, #317), #322 (waiting on #320)
- 1 eligible open backlog-burner issue still without a workspace
```

## Rules

- **Issue filter is non-negotiable**: only `backlog-burner`-labeled issues are in scope. Never act on an unlabeled issue, even if it has a workspace.
- **Label every chat you create.** Workspace ownership is tracked exclusively by `backlog-burner=true`, `issue=<N>`, and `review-round=<int>` labels on the chat (see step 4b). A chat without those labels is invisible to the next run and will cause a duplicate workspace.
- **Dependencies block.** Never create a workspace for an issue whose `## Dependencies` section references an open issue.
- **One new workspace per run.** Prevents the cronjob from spawning N workspaces on its first tick after a long pause.
- **Never send to a `status: "running"` chat.** That preempts work in flight.
- **Burner owns the merge.** The workspace agent implements + commits + pushes + opens the PR, then stops. CI watching, feedback dispatch, merging, and workspace removal all happen from the burner — never via `/finish-pr` in the workspace.
- **Merge gate = no `blocker`-severity remarks AND green CI.** Nits and suggestions are advisory; they never block. Inline comments are classified by severity-marker in their body (`severity:blocker`, `[blocker]`, `**blocker**`) — see `$UNRESOLVED_BLOCKERS` in step 3.
- **Cap non-blocker iterations at 3.** The `review-round` chat label counts dispatch rounds where the only outstanding feedback is nits/suggestions. On round ≥ 3 the burner merges anyway (step 3 case (c) "iteration-cap escape hatch"). Blocker dispatches never increment this counter — correctness fixes are uncapped.
- **Increment the counter before dispatch, not after.** A same-tick crash would otherwise undercount and let the loop run forever.
- **Rebase before everything else.** A `mergeable: CONFLICTING` branch (case (g)) is dispatched before CI-fix (case (e)) and pending-wait (case (f)) are even considered. CI on a conflicting branch is either no-op or stale, so waiting on it burns ticks for nothing. Case (g) does NOT increment `review-round` — a rebase is structural, not polish.
- **Skip the main-branch workspace.** That's where this skill runs — never send a message to your own chat.
- **Always print the summary.** It's the only audit trail the cronjob produces.
