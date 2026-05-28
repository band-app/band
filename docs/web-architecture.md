# Web App Architecture

> **Status: shipped.** The 3-tier migration completed in Phase 8 (issue #319). Server logic now lives under `apps/web/src/server/{api,services,infra}/`, with the canonical tRPC entry point at `apps/web/src/server/api/router.ts`. The legacy `apps/web/src/trpc/` directory has been removed, and the only remaining content under `apps/web/src/lib/` is browser-side utilities (clipboard helpers, dockview state, the tRPC client wrapper, etc.). New code MUST follow this layout — see the per-tier rules below.

The web server (`apps/web`) is moving toward a 3-tier architecture: **API**, **Services**, and **Infra**. Each tier has a single responsibility and a clear dependency direction.

```
API (routers)  -->  Services (business logic)  -->  Infra (DB, git, external clients)
```

Higher tiers depend on lower tiers. Never the reverse. Infra knows nothing about services. Services know nothing about routers.

## Directory Structure

```
apps/web/src/server/
  api/
    projects/
      router.ts
    workspaces/
      router.ts
    chats/
      router.ts
    browsers/
      router.ts              # browser tabs + browserLayout
    tasks/
      router.ts
    cronjobs/
      router.ts
    terminals/
      router.ts              # terminal + terminalLayout
    sessions/
      router.ts
    settings/
      router.ts
    tunnel/
      router.ts              # cloudflared lifecycle
    editor/
      router.ts              # LSP + file watching + formatter
    browser-host/
      router.ts              # host.* + browserHost.* (CDP proxy)
    cli/
      router.ts              # band-CLI symlink installer
    hooks/
      router.ts              # ~/.claude/settings.json hook editor
    skills/
      router.ts              # agent skills install/list
    prereqs/
      router.ts              # tool/binary prerequisite checks
    statuses/
      router.ts              # statuses.* + status.*
    modes/
      router.ts              # agent mode catalog
    models/
      router.ts              # agent model catalog
    system/
      router.ts              # services.* (health, activity, resources)
    router.ts                # merges all sub-routers
  services/
    project-service.ts
    workspace-service.ts
    chat-service.ts
    browser-service.ts
    task-service.ts
    cronjob-service.ts
    terminal-service.ts
    session-service.ts
    settings-service.ts
    tunnel-service.ts
    editor-service.ts        # LSP + file watch + format orchestration
    browser-host-service.ts  # CDP proxy + target list (wraps infra/browser-host/)
    cli.ts                   # band-CLI binary resolver + symlink installer
    cli-skills.ts            # render + install agent skill templates
    hooks.ts                 # ~/.claude/settings.json read/write
    setup.ts                 # first-time-setup orchestration
    setup-runner.ts          # background runner for setup steps
    file-watcher.ts          # filesystem watch wiring
    formatter.ts             # prettier wrapper
    system-service.ts        # process-utils + disk usage
  infra/
    db/
      schema.ts              # Drizzle schema (all tables)
      connection.ts          # DB singleton
      queries/
        projects.ts
        workspaces.ts
        tasks.ts
        chats.ts
        cronjobs.ts
        panel-states.ts
    git/
      git-client.ts          # git exec wrappers
    agents/
      agent-pool.ts          # coding agent lifecycle
    tunnels/
      tunnel-client.ts       # cloudflared management
    terminals/
      terminal-pool.ts       # PTY lifecycle
    lsp/
      lsp-manager.ts         # language server process management
      lsp-proxy.ts           # raw LSP message proxy
    browser-host/
      cdp-proxy.ts           # Chrome DevTools Protocol proxy
      cdp-targets.ts         # CDP target discovery
      host-state.ts          # bandTabId ↔ cdpTargetId mapping + ensure-view
    process/
      path.ts                # interactive-shell $PATH + which-binary helpers
```

## Tier 1: API (Routers)

Routers are the entry point for all client requests. They handle:

- Input validation (Zod schemas)
- Calling one or more services
- Returning responses

Routers contain **no business logic**. They validate, delegate, and respond.

A router can consume multiple services. This is expected — a project deletion route needs both the project service and the workspace service.

```typescript
// api/projects/router.ts
import { z } from "zod";
import { ProjectService } from "../../services/project-service";
import { WorkspaceService } from "../../services/workspace-service";
import { TaskService } from "../../services/task-service";

const projectService = new ProjectService();
const workspaceService = new WorkspaceService();
const taskService = new TaskService();

export const projectsRouter = t.router({
  delete: t.procedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input }) => {
      await taskService.abortAllForProject(input.projectId);
      await workspaceService.removeAllForProject(input.projectId);
      await projectService.delete(input.projectId);
    }),

  list: t.procedure.query(async () => {
    return projectService.list();
  }),
});
```

### Rules

- One sub-router per domain (`projects/router.ts`, `workspaces/router.ts`, etc.)
- Routers mirror the CLI command structure: projects, workspaces, chats, tasks, etc.
- No direct DB queries or infra access in routers
- Compose services for cross-domain operations (e.g., delete project = abort tasks + remove workspaces + delete project)

## Tier 2: Services (Business Logic)

Services contain all business logic. They are classes with explicit constructor dependencies to infra adapters and other services.

```typescript
// services/workspace-service.ts
import { WorkspaceQueries } from "../infra/db/queries/workspaces";
import { ProjectQueries } from "../infra/db/queries/projects";
import { GitClient } from "../infra/git/git-client";

export class WorkspaceService {
  constructor(
    private workspaceQueries = new WorkspaceQueries(),
    private projectQueries = new ProjectQueries(),
    private git = new GitClient(),
  ) {}

  async create(projectId: string, branch: string): Promise<Workspace> {
    const project = await this.projectQueries.findById(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }
    const worktreePath = await this.git.createWorktree(project.path, branch);
    return this.workspaceQueries.insert({
      projectId,
      branch,
      path: worktreePath,
    });
  }

  async duplicate(workspaceId: string): Promise<Workspace> {
    const source = await this.workspaceQueries.findById(workspaceId);
    if (!source) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    const newBranch = `${source.branch}-copy-${Date.now()}`;
    return this.create(source.projectId, newBranch);
  }

  async removeAllForProject(projectId: string): Promise<void> {
    const workspaces = await this.workspaceQueries.listByProject(projectId);
    for (const ws of workspaces) {
      await this.git.removeWorktree(ws.path);
      await this.workspaceQueries.remove(ws.id);
    }
  }
}
```

### Rules

- One service class per domain
- Dependencies are declared in the constructor — this makes them visible and explicit
- Services can depend on infra (queries, clients) and other services
- Services never import from the API tier
- All business logic lives here — not in routers, not in infra
- Name methods as actions: `create`, `delete`, `duplicate`, `list`, not `handleCreateWorkspace` or `processWorkspaceDeletion`

### Naming Conventions

| What | Pattern | Example |
|---|---|---|
| Service file | `{domain}-service.ts` | `workspace-service.ts` |
| Service class | `{Domain}Service` | `WorkspaceService` |
| Methods | verb or verb + noun | `create`, `delete`, `duplicate`, `listByProject` |

## Tier 3: Infra (Data Access & External Services)

Infra contains all adapters for external dependencies: database, git, file system, tunnels, terminals, LSP servers. These are the lowest-level building blocks.

### Database Queries

Query classes group related database operations. They use Drizzle ORM and operate on the shared schema.

```typescript
// infra/db/queries/workspaces.ts
import { eq } from "drizzle-orm";
import { db } from "../connection";
import { worktrees } from "../schema";

export class WorkspaceQueries {
  async findById(id: string) {
    return db.select().from(worktrees).where(eq(worktrees.id, id)).get();
  }

  async listByProject(projectId: string) {
    return db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, projectId))
      .all();
  }

  async insert(data: { projectId: string; branch: string; path: string }) {
    return db.insert(worktrees).values(data).returning().get();
  }

  async remove(id: string) {
    return db.delete(worktrees).where(eq(worktrees.id, id));
  }
}
```

### Service Clients

Non-DB infrastructure is organized by external system.

```typescript
// infra/git/git-client.ts
import { execFile } from "node:child_process";

export class GitClient {
  async createWorktree(repoPath: string, branch: string): Promise<string> {
    const worktreePath = `${repoPath}/.worktrees/${branch}`;
    await this.exec(["worktree", "add", worktreePath, "-b", branch], repoPath);
    return worktreePath;
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.exec(["worktree", "remove", worktreePath, "--force"]);
  }

  private exec(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }
}
```

### Rules

- Infra knows nothing about services or routers
- Query classes are thin — Drizzle operations, no business logic
- One query class per DB domain (may not map 1:1 to services — multiple services can use the same query class)
- Service clients wrap external processes or APIs (git, cloudflared, node-pty, LSP)
- Prefer classes to group related operations — `GitClient` over scattered `execGit` functions

### Naming Conventions

| What | Pattern | Example |
|---|---|---|
| Query file | `{domain}.ts` in `db/queries/` | `workspaces.ts` |
| Query class | `{Domain}Queries` | `WorkspaceQueries` |
| Client file | `{system}-client.ts` | `git-client.ts` |
| Client class | `{System}Client` or `{System}Pool` | `GitClient`, `AgentPool` |

## Stateful Services

Some services manage long-lived state (agent instances, PTY processes, cron timers). These are classes with lifecycle methods and are kept as singletons.

```typescript
// infra/terminals/terminal-pool.ts
export class TerminalPool {
  private terminals = new Map<string, IPty>();

  create(id: string, shell: string, cwd: string): IPty { ... }
  get(id: string): IPty | undefined { ... }
  destroy(id: string): void { ... }
  destroyAll(): void { ... }
}
```

These are infra-level — they manage external resources (processes, connections), not business logic.

## Dependency Direction

```
api/projects/router.ts
  --> services/project-service.ts
  --> services/workspace-service.ts
        --> infra/db/queries/projects.ts
        --> infra/db/queries/workspaces.ts
        --> infra/git/git-client.ts
```

- Routers depend on services (one or more)
- Services depend on infra (queries, clients) and optionally on other services
- Infra depends on nothing in the app (only external libraries)
- Never skip tiers: routers must not import from infra directly

## Summary

| Tier | Contains | Depends on | Never depends on |
|---|---|---|---|
| **API** | tRPC routers, input validation | Services | Infra |
| **Services** | Business logic, orchestration | Infra, other Services | API |
| **Infra** | DB queries, git/tunnel/terminal clients | External libraries only | API, Services |
