import type { Page } from "@playwright/test";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../src/trpc/router";

// ---------------------------------------------------------------------------
// Type helpers — map dot-notation paths to procedure input/output types
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Union of all dot-notation procedure paths, e.g. "sessions.list" | "projects.list" | ...
 */
type ProcedurePath = {
  [K in keyof RouterOutputs]: keyof RouterOutputs[K] extends string
    ? `${K & string}.${keyof RouterOutputs[K] & string}`
    : never;
}[keyof RouterOutputs];

type OutputForPath<P extends ProcedurePath> =
  P extends `${infer NS extends string & keyof RouterOutputs}.${infer Proc}`
    ? Proc extends keyof RouterOutputs[NS]
      ? RouterOutputs[NS][Proc]
      : never
    : never;

type InputForPath<P extends ProcedurePath> =
  P extends `${infer NS extends string & keyof RouterInputs}.${infer Proc}`
    ? Proc extends keyof RouterInputs[NS]
      ? RouterInputs[NS][Proc]
      : never
    : never;

type Handler<P extends ProcedurePath> =
  | OutputForPath<P>
  | ((input: InputForPath<P>) => OutputForPath<P>);

// ---------------------------------------------------------------------------
// createTrpcMock
// ---------------------------------------------------------------------------

export function createTrpcMock() {
  const handlers = new Map<string, (input: unknown) => unknown>();

  function query<P extends ProcedurePath>(path: P, handler: Handler<P>): void {
    handlers.set(
      path,
      typeof handler === "function" ? (handler as (input: unknown) => unknown) : () => handler,
    );
  }

  async function install(page: Page): Promise<void> {
    await page.route("**/trpc/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      // Extract procedure names from the URL path after /trpc/
      const trpcPath = url.pathname.replace(/.*\/trpc\//, "");
      const procedures = trpcPath.split(",");

      // Parse inputs — batch uses indexed keys: {"0": ..., "1": ...}
      let inputMap: Record<string, unknown> = {};
      if (request.method() === "GET") {
        const raw = url.searchParams.get("input");
        if (raw) {
          try {
            inputMap = JSON.parse(raw);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          inputMap = await request.postDataJSON();
        } catch {
          // ignore
        }
      }

      const results = procedures.map((proc, idx) => {
        const handler = handlers.get(proc);
        if (!handler) {
          return {
            error: {
              message: `No mock for procedure: ${proc}`,
              code: -32004,
              data: { code: "NOT_FOUND", httpStatus: 404 },
            },
          };
        }
        const input = inputMap[String(idx)] ?? undefined;
        try {
          const data = handler(input);
          return { result: { data } };
        } catch (err) {
          return {
            error: {
              message: err instanceof Error ? err.message : "Mock handler error",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          };
        }
      });

      // Single procedure → still return array (httpBatchLink always expects array)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(results),
      });
    });
  }

  // mutation is the same internally — both queries and mutations go through
  // the same handler map keyed by procedure path. This alias exists for
  // clarity and correct typing at call sites.
  function mutation<P extends ProcedurePath>(path: P, handler: Handler<P>): void {
    query(path, handler);
  }

  /**
   * Register baseline mocks for all HTTP tRPC calls that the dockview-based
   * chat UI makes on load. Without these, any unmocked procedure returns a
   * 404 error from the mock handler, preventing the chat from rendering.
   *
   * Call this after creating the mock and before adding test-specific
   * overrides (test-specific mocks registered later will take precedence
   * because they overwrite the handler in the map).
   */
  function addDockviewMocks(): void {
    // DockviewChatContainer: fetches saved layout (null = no saved layout)
    query("chatLayout.get" as ProcedurePath, (() => ({ tree: null })) as Handler<ProcedurePath>);

    // DockviewChatContainer + ChatPane: agent config
    query(
      "settings.get" as ProcedurePath,
      (() => ({ codingAgents: [], defaultCodingAgent: undefined })) as Handler<ProcedurePath>,
    );

    // ChatPane: chat record for agent info (null = no record)
    query("chats.get" as ProcedurePath, (() => ({ chat: null })) as Handler<ProcedurePath>);

    // DockviewChatContainer: agent list for tab dropdown
    query("chats.list" as ProcedurePath, (() => ({ chats: [] })) as Handler<ProcedurePath>);

    // DockviewChatContainer: persist layout (no-op)
    mutation("chatLayout.save" as ProcedurePath, (() => ({ ok: true })) as Handler<ProcedurePath>);

    // ChatPane: persist active session (no-op)
    mutation(
      "chats.setActiveSession" as ProcedurePath,
      (() => ({ ok: true })) as Handler<ProcedurePath>,
    );

    // DashboardShell sidebar: project list
    query("projects.list" as ProcedurePath, (() => ({ projects: [] })) as Handler<ProcedurePath>);

    // DockviewWorkspaceLayout: diff count badge
    query(
      "workspace.getDiffSummary" as ProcedurePath,
      (() => ({ stats: null })) as Handler<ProcedurePath>,
    );
  }

  /**
   * Override `settings.get` and `chats.get` so the chat pane derives
   * `supportsSessionListing: true` from the agent definition. The chat
   * pane no longer reads `sessions.list` to decide whether to render
   * the history affordance — the capability is computed from the
   * configured agent type. Tests that exercise the session-history UI
   * must call this after `addDockviewMocks` (or override the same two
   * procedures themselves).
   */
  function addSupportedAgentMocks(): void {
    query(
      "settings.get" as ProcedurePath,
      (() => ({
        codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
        defaultCodingAgent: "claude-code",
      })) as Handler<ProcedurePath>,
    );
    query(
      "chats.get" as ProcedurePath,
      (() => ({
        chat: {
          id: "default-chat",
          workspaceId: "test-workspace",
          name: "Chat",
          agent: "claude-code",
          status: "idle",
          activeSessionId: undefined,
          activeSessionSummary: undefined,
          activeSessionLastModified: undefined,
        },
      })) as Handler<ProcedurePath>,
    );
  }

  return { query, mutation, install, addDockviewMocks, addSupportedAgentMocks };
}
