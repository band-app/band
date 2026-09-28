# Coding Criteria

The source of truth for what a Band PR review checks on **source-code changes** under `apps/web/src/server/**`. Each criterion has a stable ID (`CODE-N`) — cite the ID when you flag a violation so the author can look it up.

This file is loaded by:

- `.claude/agents/coding-reviewer.md` (the coding specialist that applies these rules)
- `.claude/skills/review-changes/SKILL.md` (the orchestrator that dispatches the coding-reviewer)
- `.github/workflows/claude-review.yml` (CI)

`docs/web-architecture.md` is the narrative that explains *why* these rules exist (the 3-tier model, examples, rationale). It is reference material — when this file and the narrative disagree, **this file wins** and the narrative is stale; flag it.

Output format and severity vocabulary are defined inline in `.claude/agents/coding-reviewer.md`. Don't restate them here.

## 1. Structural placement

Server code lives under `apps/web/src/server/{api,services,infra}/`. The canonical tRPC entry point is `apps/web/src/server/api/router.ts`. `apps/web/src/lib/` is browser-side only.

- **CODE-1** *(blocker)* — New server code is placed under `apps/web/src/server/{api,services,infra}/`. New code under `apps/web/src/trpc/` or under `apps/web/src/lib/` (for server logic) is a blocker.
- **CODE-2** *(blocker)* — Tier imports go in one direction only:
  - Routers (`api/**`) may import from `services/**`. They may **not** import from `infra/**` (no DB, no git, no tunnels, no PTY).
  - Services (`services/**`) may import from `infra/**` and other services. They may **not** import from `api/**`.
  - Infra (`infra/**`) may import from external libraries only. It may **not** import from `services/**` or `api/**`.
  Any reverse or cross-tier-skipping import is a blocker.
- **CODE-3** *(blocker)* — A router never queries the DB directly, never spawns a child process, never touches the filesystem outside of forwarding paths to a service. `db.select(...)`, `execFile(...)`, `fs.*` inside a router file is a blocker.

## 2. Tier 1 — API (routers)

Routers are the entry point for client requests. Their entire job is: validate input, call one or more services, return the response.

- **CODE-4** *(nit)* — Each router file lives at `apps/web/src/server/api/<domain>/router.ts` — one sub-router per domain (`projects/router.ts`, `workspaces/router.ts`). New top-level files in `api/` other than the merge file `api/router.ts` are a nit.
- **CODE-5** *(suggestion)* — Router domains mirror the CLI command structure (projects, workspaces, chats, tasks, cronjobs, terminals, browsers, sessions, settings, tunnel, editor, browser-host, cli, hooks, skills, prereqs, statuses, modes, models, system). A new domain that doesn't correspond to a CLI surface is a suggestion — surface it so the human can decide.
- **CODE-6** *(nit)* — Procedures use Zod for input validation. A new procedure with no `.input(z.…)` and a non-trivial argument shape is a nit.
- **CODE-7** *(blocker)* — Cross-domain operations compose services in the router (e.g. `projects.delete` calls `TaskService.abortAllForProject`, `WorkspaceService.removeAllForProject`, then `ProjectService.delete`). A router that orchestrates business logic via raw query/client calls instead of services is a blocker.
- **CODE-8** *(nit)* — Routers contain no business logic. "Business logic" means: branching on entity state, computing derived values, enforcing invariants, coordinating side effects. If the procedure body does more than `validate → call service(s) → return`, flag it as a nit (or as a blocker under CODE-7 if it bypasses a service).

## 3. Tier 2 — Services (business logic)

Services are classes with explicit constructor dependencies on infra adapters and other services. All business logic lives here.

- **CODE-9** *(nit)* — Each service is `apps/web/src/server/services/<domain>-service.ts` exporting a class named `<Domain>Service` (e.g. `workspace-service.ts` → `WorkspaceService`). New services that break this naming pattern are a nit.
- **CODE-10** *(nit)* — Dependencies are injected via the constructor with default `new …()` arguments — e.g. `constructor(private workspaceQueries = new WorkspaceQueries(), private git = new GitClient()) {}`. A service that does `import { db } from "..."` or instantiates infra inside a method (instead of declaring it as a constructor field) is a nit — the explicit constructor list is how reviewers see the dependency surface.
- **CODE-11** *(blocker)* — Services may depend on infra (queries, clients) and on other services. A service that imports from `api/**` is a blocker.
- **CODE-12** *(nit)* — Method names are actions: `create`, `delete`, `duplicate`, `list`, `listByProject`, `removeAllForProject`. Names like `handleCreateWorkspace`, `processWorkspaceDeletion`, `doWorkspaceWork` are a nit.
- **CODE-13** *(nit)* — Stateful services that own long-lived resources (PTY processes, agent instances, cron timers, sockets) belong in **`infra/`**, not `services/`. A new singleton in `services/` that owns processes or connections is misplaced — flag as a nit (or as a blocker under CODE-2 if it also imports from a router).

## 4. Tier 3 — Infra (data access & external systems)

Infra is the lowest level: DB queries, git, file system, tunnels, terminals, LSP, CDP proxies, agent pools. No business logic.

- **CODE-14** *(nit)* — DB query classes live at `apps/web/src/server/infra/db/queries/<domain>.ts` exporting `<Domain>Queries` (`workspaces.ts` → `WorkspaceQueries`). Schema lives at `infra/db/schema.ts`. The DB singleton is `infra/db/connection.ts`. A new top-level `infra/db/<file>.ts` outside of `queries/` (for non-schema/non-connection content) is a nit.
- **CODE-15** *(blocker)* — Query classes are **thin**: Drizzle operations only, no business logic, no validation beyond what Drizzle does, no orchestration of multiple tables for an invariant. Branching on entity state, derived values, or enforcement logic inside a query method is a blocker — push it into the service.
- **CODE-16** *(nit)* — External-system clients live at `infra/<system>/<system>-client.ts` exporting a `<System>Client` class (`infra/git/git-client.ts` → `GitClient`). For pools/managers the suffix is `Pool` or `Manager` (`TerminalPool`, `AgentPool`, `LspManager`). Scattered top-level `execGit()`/`execGh()` functions are a nit — group related operations into a class.
- **CODE-17** *(blocker)* — Infra files import only from `node:*`, npm packages, and other `infra/**` files. An import from `services/**` or `api/**` is a blocker.
- **CODE-18** *(suggestion)* — A single query class may serve multiple services (the mapping is not 1:1). Don't introduce a parallel query class just because a new service needs the same table — flag duplication as a suggestion.

## 5. Naming conventions (summary)

| What | Pattern | Example |
|---|---|---|
| Service file | `{domain}-service.ts` | `workspace-service.ts` |
| Service class | `{Domain}Service` | `WorkspaceService` |
| Service method | verb / verb + noun | `create`, `listByProject` |
| Query file | `{domain}.ts` under `db/queries/` | `workspaces.ts` |
| Query class | `{Domain}Queries` | `WorkspaceQueries` |
| Client file | `{system}-client.ts` | `git-client.ts` |
| Client class | `{System}Client` / `{System}Pool` / `{System}Manager` | `GitClient`, `AgentPool` |
| Router file | `api/<domain>/router.ts` | `api/workspaces/router.ts` |

Naming violations are at minimum a `nit` (CODE-4, CODE-9, CODE-14, CODE-16). If the wrong name hides a tier-direction violation (a "service" named `*Client` that actually does DB work, etc.) escalate to the blocker under CODE-2/CODE-11/CODE-17.

## 6. Dependency direction — at-a-glance

```
api/<domain>/router.ts
  --> services/<domain>-service.ts
  --> services/<other>-service.ts
        --> infra/db/queries/<domain>.ts
        --> infra/<system>/<system>-client.ts
```

The rule is one-way: higher tier may depend on lower; lower may not depend on higher. Tier-skipping (router → infra directly) is the same violation — CODE-2.

## 7. Comments and documentation references

- **CODE-19** *(nit)* — **No documentation references in source-code comments.** Source files (`.ts`, `.tsx`, test files, page-object files, etc.) must not cite `docs/*.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.claude/skills/**`, or `.claude/*-criteria.md` to justify why the code looks the way it does. The doctrine lives in those files; the code lives in the source. When a doc moves, gets renamed, or is restructured, every comment that names it goes stale and forces a code-wide sweep to fix. If a comment needs rationale, state it inline ("system-controlled aria-label, so `getByRole({ name })` is safe") — don't point at the doc that explains why.
