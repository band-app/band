# PR Review Criteria

The single source of truth for what a Band PR review checks. Loaded verbatim by:

- `.github/workflows/claude-review.yml` (CI runs against the GitHub PR)
- `.claude/agents/pr-reviewer.md` (the subagent invoked by `pr-review-local`)

Edit this file to change what gets checked anywhere. No other prompt should restate criteria — they should reference this file.

## Context — fetch before reviewing

Your caller supplies, at minimum, `REPO` and one of (`PR NUMBER`) or (`BASE` + `HEAD` refs). Use what's available:

- **PR exists** (CI, or `gh pr view` returns a number): `gh pr diff <num>` for the diff, `gh pr view <num> --json title,body,headRefName,baseRefName` for metadata.
- **No PR yet** (local pre-push review): `git diff <base>...<head>` for the diff (three-dot form — matches what GitHub will show), `git log <base>..<head> --format='%h %s%n%b'` for commit history.

**Always also fetch the linked issue.** Look for, in order:

1. `closes #<n>` / `fixes #<n>` / `resolves #<n>` in PR body or commit messages.
2. A leading number in the branch name (`123-fix-foo` → issue 123).

For each GitHub issue found, run `gh issue view <num>` and use the description as the **acceptance criteria** for the change. A PR that doesn't satisfy the linked issue's acceptance criteria is a `blocker`, regardless of code quality.

Also read `CLAUDE.md` and `CONTRIBUTING.md` at the repo root — they define repo conventions you must check the diff against (Band's integration-test doctrine, no `--no-verify`, web-vs-desktop split). If your tool palette doesn't include `Read`, fall back to applying only the Band-specific checks below — but note that the `pr-reviewer` subagent (used by both CI and the local skill) declares `Read` in its tools, so the fallback is rarely needed.

## Focus areas

1. **Correctness and obvious bugs.** Off-by-one, null/undefined paths, wrong async behavior, race conditions, swapped arguments, dead code, copy-paste errors. Read the surrounding code if you can — a "looks fine" line can be wrong in context.
2. **Security and credential handling.** Secrets in code, logs, or commits. SQL/command injection. Unsafe deserialization. Trusting client input. Broadened auth/permission scopes. Changes to GitHub Actions that introduce `pull_request_target` or expand secrets exposure.
3. **Test coverage — Band prefers integration tests over mocked unit tests.** Non-negotiable per `CLAUDE.md`:
   - New user-observable behavior MUST have an integration test (see the `write-integration-test` skill).
   - New tests must NOT mock tRPC, MUST NOT use `page.route()` on the app's own routes, MUST NOT use MSW. External services get Express stubs on a random port + env-var override.
   - Frontend test framework is `vitest` (in `apps/web`); everything else is `node:test` + `node:assert/strict`.
   - Flag any new test that uses `vi.mock`, `jest.mock`, `nock`, or `msw` — those patterns are banned outside the documented exceptions.
4. **Adherence to existing patterns.** Imports, naming, error handling, file layout. If the diff invents a new pattern when an existing one would have worked, flag it.
5. **Performance regressions in hot paths.** Network calls in render paths, N+1 queries, unbounded loops over user input, large synchronous reads in request handlers, missing pagination. Flag with measurement guidance ("this runs per ingested event — check the impact at 10k events/sec").

## Band-specific checks

- **Web server vs desktop app.** Per `CLAUDE.md`, `apps/web` must not invoke macOS-only shell helpers. Those belong in `apps/desktop/src/main/ipc/macos-shell.ts` and are called via the IPC bridge. Flag any new `child_process` / `exec` / `open -a` / `osascript` call in `apps/web`.
- **No `--no-verify` and no hook bypass.** Flag any code that adds `--no-verify` to a `git push` / `git commit` invocation, or `core.hooksPath` overrides.
- **Skills sync.** Changes to `apps/cli/skills/*.md` should be paired with `band generate-skills` output if the schema-driven skills are affected. Changes to `packages/coding-agent/src/install-skills.ts` need to keep `SUPPORTED_AGENT_TYPES` in sync with `cursor-cli` being deliberately excluded.
- **PR scope.** If the linked issue says "add X" and the diff also refactors Y, flag the scope creep. Reviewers can be lenient about this; surface it so the human can decide.

## Output format

Use inline review comments where the tool palette supports it (CI does, via `mcp__github_inline_comment__create_inline_comment`). Otherwise emit the same content as a structured list.

For each finding:

```
[N] severity:<blocker|nit|suggestion>  <path>:<line>
    <one-sentence description>
    Fix: <specific, actionable change>
```

Severity:
- `blocker` — ship-stopper (bug, security, broken test, violates a non-negotiable convention, fails linked-issue acceptance criteria).
- `nit` — should fix, low effort, no real risk if it shipped.
- `suggestion` — optional improvement, reviewer's judgement call.

End with a single `Summary` block:

```
Summary
- Take: <1–2 sentences — does the PR do what the issue asks for, is it safe to merge>
- Findings: <X blockers, Y nits, Z suggestions>
- Linked issue (#<n>): <satisfied | partially satisfied | not satisfied — why>
- Tests: <added | missing | adequate>
```

Cite line numbers from the post-change file. Skip generic praise. If there are zero findings, the Summary alone is the entire output.
