/**
 * Keyboard-shortcut matrix — the safety net for the `react-hotkeys-hook`
 * migration.
 *
 * Shortcuts are bound through `useAppShortcut` (`hooks/useAppShortcut.ts`), a
 * wrapper over `react-hotkeys-hook` whose defaults exist to preserve what the
 * previous hand-rolled `window` keydown handlers did: capture-phase listening,
 * firing inside form fields, `preventDefault`, and character-vs-physical key
 * matching. Combos live in `lib/shortcuts.ts` (`GLOBAL_SHORTCUTS` /
 * `DOCK_SHORTCUTS`); dock-scoped chords scope via the hook's returned ref.
 *
 * Each of those defaults is one the library does NOT give you: it binds on
 * `document` in bubble phase, skips events originating in form fields
 * (`<textarea>` — i.e. xterm's helper input and the chat prompt) unless
 * `enableOnFormTags` is set, and scopes to a subtree when bound to a ref. So
 * the realistic failure mode here is not "the shortcut stops working" — it is
 * "the shortcut silently becomes focus-scoped and only works when nothing
 * interesting is focused". Every test below therefore drives its key from a
 * NON-default focus anchor deep inside an inner dockview, never from
 * `document.body`.
 *
 * Architecture (matches the repo's integration doctrine):
 *   - The real production binary runs against a fresh tmp `~/.band/`.
 *   - No tRPC mocking, no `page.route()` — the dashboard renders against the
 *     real backend, and the seeded chat layout is written through the real
 *     `chats.create` / `chatLayout.save` mutations over HTTP.
 *   - All UI is driven through `WorkspacePage` / `ChatPanePage`; no raw
 *     `page.goto` / `page.getByRole` / `page.getByTestId` / `page.keyboard`
 *     appears in a test body.
 *
 * Four groups:
 *
 *   A. "Global shortcuts fire regardless of focus" — the tab-activation
 *      chords. Behaviour is unchanged from before the migration.
 *
 *   B. "⌘B always toggles the project sidebar" — an intentional behaviour
 *      change. ⌘B used to be focus-aware: `findFocusedInnerDockview()`
 *      resolved the inner dockview owning `document.activeElement`, and if
 *      that dockview's `edge-left` group held panels, `toggleEdgeGroup`
 *      collapsed THAT edge and the project sidebar was never touched. It now
 *      toggles the project-list sidebar unconditionally. ⌘J has since moved
 *      to the same rule (group D covers it), leaving ⌥⌘B as the only edge
 *      chord that still resolves its target by focus.
 *
 *   C. "Dock-scoped shortcuts act on the focused dock" — the chords owned
 *      by the INNER containers rather than by `SharedDockviewLayout`. Each
 *      container binds them through the ref `useAppShortcut` returns, so a
 *      chord only fires while that container (or a descendant) holds focus
 *      and the same combo means different things per dock: ⌘T in the chat
 *      dock opens a chat pane, ⌘T in the terminal dock opens a terminal.
 *      Ref scoping replaced hand-written `contains(document.activeElement)`
 *      checks, and its realistic failure mode is one dock's binding winning
 *      GLOBALLY while the other's goes dead. Catching that needs both halves
 *      asserted — the dock that should have reacted did, and the rival dock
 *      did not — which
 *      is why every test in the group boots BOTH docks and pins both counts.
 *
 *   D. "Split, physical-key and zoom bindings" — chords whose correctness is
 *      invisible in the chrome groups A–C key off, and each of which was
 *      silently broken (or silently order-dependent) before.
 *      ⌘0 and Ctrl+0 used to be the SAME chord, with "Focus Projects"
 *      winning only because it listened in capture phase and called
 *      `stopPropagation()` ahead of the label filter's bubble-phase
 *      listener; they are separate bindings now, so both halves are pinned
 *      — ⌘0 resets the filter, Ctrl+0 focuses the list and leaves the
 *      filter alone. ⌘⇧] / ⌘⇧[ were dead bindings (Shift turns `]` into
 *      `}`, so a character match never fired) and now match the physical
 *      `BracketRight` / `BracketLeft`. ⌘= / ⌘⇧= / ⌘- bind the physical
 *      `Equal` / `Minus` because the library splits combos on `"+"` (so
 *      `meta++` parsed to nothing) and compares modifiers for exact
 *      equality (so a `meta+=` binding could not fire with Shift held) —
 *      ⌘⇧= is the half that was silently dead. ⌘J is the group's other
 *      intentional behaviour change: it used to resolve its target by
 *      focus (a focused inner dock with a populated `edge-bottom` claimed
 *      the chord and the outer layout was never touched) and now always
 *      toggles the outermost layout's bottom edge, same rule as ⌘B with
 *      the sidebar — leaving ⌥⌘B as the only edge chord still focus-aware.
 *
 * Why group C asserts on the SERVER-persisted layout (`countChatPanels` /
 * `countTerminalPanels`, which hit the real `chatLayout.get` /
 * `terminalLayout.get` procedures) rather than on the DOM: a pane count in
 * the rendered tree can't distinguish "the chat dockview grew a panel" from
 * "the terminal dockview grew one" without re-encoding dockview's internals
 * in a selector, whereas the two layouts are separate rows keyed by
 * container. Reading them back proves WHICH dockview actually mutated, which
 * is the entire property under test. They're read over HTTP and written
 * asynchronously by the layout-change listener, so every such assertion is an
 * `expect.poll`, never a bare `expect`.
 *
 * Why tab-activation is asserted via dockview's `dv-active-tab` class: it's
 * the library's own state marker on the `.dv-tab` wrapper, flipped
 * synchronously by `panel.api.setActive()`. Waiting on panel CONTENT instead
 * (xterm booting, the file tree fetching) would conflate "the shortcut fired"
 * with "the panel finished loading". Same rationale as
 * `workspace-maximize-state.spec.ts`.
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-shortcut-matrix-token";
const PROJECT = "alpha-shortcuts";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

// The ⌘B focus-aware test seeds a two-pane chat layout with one pane docked in
// `edge-left`. That seed is workspace-scoped server state, so it gets its OWN
// project/workspace — otherwise every other test in this file would suddenly
// see two chat prompts (and `ChatPanePage`'s single-prompt locators would trip
// strict mode) depending on execution order.
const PROJECT_EDGE = "alpha-shortcuts-edge";
const WORKSPACE_EDGE = toWorkspaceId(PROJECT_EDGE, "main");

// The dock-scoped tests each MUTATE an inner dockview's persisted layout (⌘T
// adds a pane, ⌘D splits), and they assert on absolute panel counts read back
// from the server. Sharing one workspace between them would make every test
// depend on the execution order of its siblings — and on whether the groups
// above happened to open a terminal in the same workspace first. So each gets
// its own project/workspace, following the `PROJECT_EDGE` precedent: extra
// entries in the single `seedState` call, no extra server boot.
const PROJECT_DOCK_CHAT = "alpha-shortcuts-dock-chat";
const WORKSPACE_DOCK_CHAT = toWorkspaceId(PROJECT_DOCK_CHAT, "main");
const PROJECT_DOCK_TERM = "alpha-shortcuts-dock-term";
const WORKSPACE_DOCK_TERM = toWorkspaceId(PROJECT_DOCK_TERM, "main");
const PROJECT_DOCK_SPLIT = "alpha-shortcuts-dock-split";
const WORKSPACE_DOCK_SPLIT = toWorkspaceId(PROJECT_DOCK_SPLIT, "main");

// Group D, same rationale as the group-C workspaces above.
//
// The ⌘0 / Ctrl+0 pair needs a project that actually carries a label:
// `LABEL_FILTER_SHORTCUT`'s digit-0 arm resolves to "All", and proving it
// RESET something requires a filter to have been applied first, which the
// dropdown only offers for labels that exist in settings. The label is
// therefore added to the single `seedSettings` call and hung on its own
// project — the existing projects stay unlabelled, so the sections the other
// tests' sidebars render are unchanged (none of them reads the project list).
//
// The tab-cycling test MUTATES the terminal dock's persisted layout (it adds a
// second tab) and asserts on the active tab's index within that group, so it
// gets its own workspace exactly like the group-C tests. Zoom mutates nothing
// server-side, but it boots its own terminal as a focus anchor and would
// otherwise inherit whatever tab count a sibling left behind.
const LABEL_D = "lbl_shortcuts";
const PROJECT_LABELLED = "alpha-shortcuts-labelled";
const WORKSPACE_LABELLED = toWorkspaceId(PROJECT_LABELLED, "main");
const PROJECT_TAB_CYCLE = "alpha-shortcuts-tab-cycle";
const WORKSPACE_TAB_CYCLE = toWorkspaceId(PROJECT_TAB_CYCLE, "main");
const PROJECT_ZOOM = "alpha-shortcuts-zoom";
const WORKSPACE_ZOOM = toWorkspaceId(PROJECT_ZOOM, "main");

// The ⌘J test seeds a two-pane chat layout with one pane docked in the inner
// dock's `edge-bottom` — the same kind of workspace-scoped server state as the
// ⌘B `PROJECT_EDGE` seed above, and it needs its own project for the same
// reason: any sibling test landing in this workspace would suddenly see two
// chat prompts and trip `ChatPanePage`'s single-prompt locators depending on
// execution order.
const PROJECT_BOTTOM = "alpha-shortcuts-bottom";
const WORKSPACE_BOTTOM = toWorkspaceId(PROJECT_BOTTOM, "main");

// Chat pane ids are pinned (rather than server-generated) so the seeded
// layout below can reference them — `DockviewChatContainer` prunes restored
// panels whose id isn't in `chats.list`.
const CHAT_CENTER = "chat_e2e_center";
const CHAT_EDGE = "chat_e2e_edge";

// The ⌘J seed's own pair. Chat pane ids are GLOBALLY unique server-side
// (`panel_states.id` is the primary key), not scoped per workspace, so reusing
// the two ids above in a second workspace fails `chats.create` with a UNIQUE
// constraint violation rather than creating a parallel pane.
const CHAT_BOTTOM_CENTER = "chat_e2e_bottom_center";
const CHAT_BOTTOM_EDGE = "chat_e2e_bottom_edge";

// Wide viewport so `useIsDesktop()` reports true and the desktop layout
// (title bar + sidebar + shared dockview) renders (>= 1024px in
// useIsDesktop.ts).
test.use({ viewport: { width: 1280, height: 800 } });

/**
 * Inner CHAT dockview layout with one pane in the central grid and one docked
 * in `edge-left` (visible + expanded, so it actually renders and
 * `toggleEdgeGroup` has something to collapse).
 *
 * Shape mirrors the real serialized dockview snapshot captured in
 * `workspace-maximize-collapses-edges.spec.ts` — grid + flat `panels` map +
 * `edgeGroups` with per-direction `{ size, visible, collapsed, group }`. The
 * panel entries use the `chatTab` content/tab component and the
 * `{ workspaceId, chatId }` params `createDefaultPanel` writes, so the
 * restored panes mount real `ChatPane`s.
 *
 * The three edge groups are all present because `ensureEdgeGroups` expects
 * them; only `left` is populated.
 */
function chatLayoutWithLeftEdgePanel(workspaceId: string) {
  const panel = (id: string, title: string) => ({
    id,
    contentComponent: "chatTab",
    tabComponent: "chatTab",
    title,
    params: { workspaceId, chatId: id },
  });
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { views: [CHAT_CENTER], activeView: CHAT_CENTER, id: "1" },
            size: 500,
          },
        ],
        size: 700,
      },
      width: 500,
      height: 700,
      orientation: "HORIZONTAL",
    },
    panels: {
      [CHAT_CENTER]: panel(CHAT_CENTER, "Center"),
      [CHAT_EDGE]: panel(CHAT_EDGE, "Edge"),
    },
    activeGroup: "1",
    edgeGroups: {
      left: {
        size: 200,
        visible: true,
        collapsed: false,
        group: {
          views: [CHAT_EDGE],
          activeView: CHAT_EDGE,
          id: "edge-left",
          headerPosition: "left",
        },
      },
      right: {
        size: 200,
        visible: false,
        collapsed: true,
        group: { views: [], id: "edge-right", headerPosition: "right" },
      },
      bottom: {
        size: 200,
        visible: false,
        collapsed: true,
        group: { views: [], id: "edge-bottom", headerPosition: "bottom" },
      },
    },
  };
}

/**
 * Same shape as `chatLayoutWithLeftEdgePanel`, but with the second pane docked
 * in `edge-bottom` (left and right left empty) and referencing the ⌘J test's
 * own chat ids.
 *
 * Written out rather than derived from the left-edge factory: the two differ in
 * their panel ids as well as their edge slots — chat ids are globally unique
 * server-side (see `CHAT_BOTTOM_CENTER`) — so a derivation would have to rewrite
 * the grid tree and the `panels` map anyway, which is the whole body.
 *
 * This seed is what makes the ⌘J test non-vacuous. The chord under test now
 * targets the OUTER layout unconditionally; under the old focus-aware handler,
 * a focused inner dock whose `edge-bottom` held panels claimed the chord and
 * the outer edge was never touched. With an EMPTY inner bottom edge (what the
 * default layout gives you) the old code would have fallen straight through to
 * the outer layout and this test would have passed against both
 * implementations — proving nothing. Populating the inner edge separates them.
 */
function chatLayoutWithBottomEdgePanel(workspaceId: string) {
  const panel = (id: string, title: string) => ({
    id,
    contentComponent: "chatTab",
    tabComponent: "chatTab",
    title,
    params: { workspaceId, chatId: id },
  });
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { views: [CHAT_BOTTOM_CENTER], activeView: CHAT_BOTTOM_CENTER, id: "1" },
            size: 500,
          },
        ],
        size: 700,
      },
      width: 500,
      height: 700,
      orientation: "HORIZONTAL",
    },
    panels: {
      [CHAT_BOTTOM_CENTER]: panel(CHAT_BOTTOM_CENTER, "Center"),
      [CHAT_BOTTOM_EDGE]: panel(CHAT_BOTTOM_EDGE, "Edge"),
    },
    activeGroup: "1",
    edgeGroups: {
      left: {
        size: 200,
        visible: false,
        collapsed: true,
        group: { views: [], id: "edge-left", headerPosition: "left" },
      },
      right: {
        size: 200,
        visible: false,
        collapsed: true,
        group: { views: [], id: "edge-right", headerPosition: "right" },
      },
      bottom: {
        size: 200,
        visible: true,
        collapsed: false,
        group: {
          views: [CHAT_BOTTOM_EDGE],
          activeView: CHAT_BOTTOM_EDGE,
          id: "edge-bottom",
          headerPosition: "bottom",
        },
      },
    },
  };
}

/**
 * OUTER (shared) dockview layout with the `terminal` panel docked in
 * `edge-bottom`, visible and expanded — so ⌘J has a populated outer edge to
 * collapse and the collapse is observable as a height change.
 *
 * Captured shape reused verbatim from
 * `workspace-maximize-collapses-edges.spec.ts` (`LAYOUT_WITH_BOTTOM_EDGE_PANEL`
 * — see that file's header for how it was captured off a real app run). Seeding
 * is the only non-flaky way to start with a populated edge: dockview's edge
 * docking is native HTML5 drag-and-drop, which is unreliable to drive through
 * Playwright. Unlike the inner chat layout above this one lives in
 * `localStorage`, so it is installed with `seedGlobalLayout` before the first
 * `goto` rather than through a tRPC mutation.
 */
const OUTER_LAYOUT_WITH_BOTTOM_EDGE_PANEL = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["chat"], activeView: "chat", id: "1" }, size: 519 },
        {
          type: "leaf",
          data: { views: ["changes", "files", "browser"], activeView: "changes", id: "2" },
          size: 518,
        },
      ],
      size: 762,
    },
    width: 1037,
    height: 762,
    orientation: "HORIZONTAL",
  },
  panels: {
    chat: {
      id: "chat",
      contentComponent: "chat",
      tabComponent: "props.defaultTabComponent",
      title: "Chat",
      params: {},
    },
    changes: {
      id: "changes",
      contentComponent: "changes",
      tabComponent: "badge",
      params: {},
      title: "Changes",
    },
    files: {
      id: "files",
      contentComponent: "files",
      tabComponent: "props.defaultTabComponent",
      title: "Files",
      params: {},
    },
    terminal: {
      id: "terminal",
      contentComponent: "terminal",
      tabComponent: "props.defaultTabComponent",
      title: "Terminal",
      params: {},
    },
    browser: {
      id: "browser",
      contentComponent: "browser",
      tabComponent: "props.defaultTabComponent",
      title: "Browser",
      params: {},
    },
  },
  activeGroup: "1",
  edgeGroups: {
    left: {
      size: 200,
      visible: false,
      collapsed: true,
      group: { views: [], id: "edge-left", headerPosition: "left" },
    },
    right: {
      size: 200,
      visible: false,
      collapsed: true,
      group: { views: [], id: "edge-right", headerPosition: "right" },
    },
    bottom: {
      size: 200,
      visible: true,
      collapsed: false,
      group: {
        views: ["terminal"],
        activeView: "terminal",
        id: "edge-bottom",
        headerPosition: "bottom",
      },
    },
  },
};

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT}` }],
      },
      {
        name: PROJECT_EDGE,
        path: `/tmp/fake/${PROJECT_EDGE}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_EDGE}` }],
      },
      ...[
        PROJECT_DOCK_CHAT,
        PROJECT_DOCK_TERM,
        PROJECT_DOCK_SPLIT,
        PROJECT_TAB_CYCLE,
        PROJECT_ZOOM,
        PROJECT_BOTTOM,
      ].map((name) => ({
        name,
        path: `/tmp/fake/${name}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${name}` }],
      })),
      // The only labelled project — see the group-D constants above.
      {
        name: PROJECT_LABELLED,
        path: `/tmp/fake/${PROJECT_LABELLED}`,
        defaultBranch: "main",
        label: LABEL_D,
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT_LABELLED}` }],
      },
    ],
  });
  // One label so the sidebar renders the filter dropdown and ⌘1 / ⌘0 have
  // something to select and reset. Purely additive for the other groups: no
  // test above reads the project list or the dropdown.
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [{ id: LABEL_D, name: "Shortcuts", color: "#8b5cf6" }],
  });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Global shortcuts fire regardless of focus", () => {
  test("Ctrl+` activates the Terminal tab from a focused chat prompt", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE);
    await wp.waitForReady();
    await chat.waitForReady();

    // Anchor: the chat prompt (an editable textarea inside the chat inner
    // dockview), NOT the terminal. The assertion below only means anything
    // while the Terminal tab starts inactive, and an inactive terminal is
    // parked in an `inert` container where its input can't take focus — so
    // the terminal is unusable as the anchor for its own shortcut. See
    // `pressActivateTerminalShortcut`'s doc comment.
    await chat.focusPromptAt(0);
    await wp.pressActivateTerminalShortcut();

    await expect(wp.tabContainer("terminal")).toHaveClass(/dv-active-tab/);
  });

  test("⌘⇧E activates the Files tab from a focused terminal", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();
    // Positive anchor for the starting state: the Terminal tab really is the
    // active view in its group, so the post-shortcut assertion is a genuine
    // transition rather than a coincidence.
    await expect(wp.tabContainer("terminal")).toHaveClass(/dv-active-tab/);

    await wp.activatePanelViaShortcutFromTerminal("files");

    await expect(wp.tabContainer("files")).toHaveClass(/dv-active-tab/);
  });

  test("⌘⇧G activates the Changes tab from a focused terminal", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();
    await expect(wp.tabContainer("terminal")).toHaveClass(/dv-active-tab/);

    await wp.activatePanelViaShortcutFromTerminal("changes");

    await expect(wp.tabContainer("changes")).toHaveClass(/dv-active-tab/);
  });

  test("⌘⇧B activates the Browser tab from a focused terminal", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();
    await expect(wp.tabContainer("terminal")).toHaveClass(/dv-active-tab/);

    await wp.activatePanelViaShortcutFromTerminal("browser");

    await expect(wp.tabContainer("browser")).toHaveClass(/dv-active-tab/);
  });
});

test.describe("⌘B always toggles the project sidebar", () => {
  test("⌘B from a focused terminal (empty inner left edge) toggles the sidebar", async ({
    page,
  }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();

    // Starting state: sidebar shown.
    await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
    await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");

    // The terminal inner dockview's `edge-left` is empty on a default layout,
    // so `toggleEdgeGroup` reports `false` and the handler falls through to
    // the `band:toggle-sidebar` window event. This is the fallback path that
    // works TODAY and must keep working after the migration.
    await wp.toggleSidebarViaShortcutFromTerminal();
    await expect.poll(() => wp.sidebarWidth()).toBeLessThan(5);
    await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");

    // Round trip — the same anchor must bring it back.
    await wp.toggleSidebarViaShortcutFromTerminal();
    await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
    await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");
  });

  // The intentional behaviour change that shipped with the `react-hotkeys-hook`
  // migration. ⌘B used to be focus-aware: the handler asked
  // `findFocusedInnerDockview()` first, and because the focused chat dockview
  // has a populated `edge-left`, `toggleEdgeGroup` collapsed THAT inner edge and
  // returned `true` — `band:toggle-sidebar` was never dispatched and the sidebar
  // kept its full width. It now toggles the project-list sidebar unconditionally.
  //
  // This test was authored as a `test.fail()` against the old behaviour and
  // flipped to a normal test when the migration landed; the assertions are
  // unchanged from that original form.
  //
  // ⌘J (bottom) has since followed ⌘B to the same unconditional rule — group D
  // pins it — so ⌥⌘B (right) is now the only edge chord still resolving its
  // target by focus. See the ⌘B / ⌘J comments in `SharedDockviewLayout.tsx`.
  test("⌘B from a focused chat pane collapses the sidebar, not the inner left edge", async ({
    page,
  }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);

    // Seed BEFORE `goto`: the inner chat dockview fetches its layout once on
    // mount. Chats first (their ids must exist in `chats.list` or the restored
    // panels get pruned as orphans), layout second (`chats.create` appends to
    // the layout row, so seeding first would be overwritten).
    await wp.createChat(WORKSPACE_EDGE, CHAT_CENTER, "Center");
    await wp.createChat(WORKSPACE_EDGE, CHAT_EDGE, "Edge");
    await wp.seedInnerLayout("chat", WORKSPACE_EDGE, chatLayoutWithLeftEdgePanel(WORKSPACE_EDGE));

    await wp.goto(WORKSPACE_EDGE);
    await wp.waitForReady();

    // Round-trip the seed. Both checks guard against a vacuous test: a tree
    // dockview silently rejects makes `onReady` fall back to a single default
    // pane, which would leave `edge-left` empty and turn the ⌘B branch under
    // test into the (already-covered) sidebar fallback path. Polling the pane
    // count also stands in for `ChatPanePage.waitForReady()`, whose
    // single-prompt locator can't be used once two panes are mounted.
    await expect.poll(() => chat.promptCount()).toBe(2);
    // Polled, not read once: the container re-persists its layout asynchronously
    // on mount, so a single-shot read can observe the value we seeded moments
    // earlier and pass even though dockview rejected the tree and `onReady` fell
    // back to a single default pane — leaving `edge-left` empty and silently
    // degrading this test into the sidebar-fallback path group B already covers.
    await expect.poll(() => wp.innerEdgeLeftViews("chat", WORKSPACE_EDGE)).toEqual([CHAT_EDGE]);

    // Starting state: sidebar shown.
    await expect.poll(() => wp.sidebarWidth()).toBeGreaterThan(200);
    await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "true");

    // Focus INSIDE the chat inner dockview — the focus that makes
    // `findFocusedInnerDockview()` return the chat api today.
    await chat.focusPromptAt(0);
    await wp.pressToggleSidebarShortcut();

    // The sidebar collapse is a CSS tween that settles in well under a
    // second; the tightened poll budget keeps the expected-failure fast
    // instead of burning the full 30 s test timeout on every run.
    await expect.poll(() => wp.sidebarWidth(), { timeout: 5_000 }).toBeLessThan(5);
    await expect(wp.sidebarToggle).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("Dock-scoped shortcuts act on the focused dock", () => {
  // Every test here boots a real PTY (`openTerminalTab` + `waitForTerminalReady`)
  // on top of the normal multi-stage app boot, and then waits on a server
  // round-trip for the layout write. The 30 s file default leaves no headroom
  // for that under parallel CI load, so the group opts into a longer budget.
  test.slow();

  /**
   * Bring a workspace up with BOTH inner docks mounted, visible, and their
   * layouts persisted — the precondition for every test in this group.
   *
   * Both docks must be live simultaneously for the negative half of each
   * assertion to mean anything: a container only registers its keydown
   * listener while `visible` is true, so if the terminal dock were never
   * opened, "⌘T did not add a terminal" would pass trivially (nothing was
   * listening) instead of proving the chat binding stayed scoped. The default
   * outer layout puts Chat in its own group and Terminal in the other, so
   * activating the Terminal tab leaves both on screen at once.
   *
   * Returns the settled starting panel counts, polled rather than assumed —
   * they're written asynchronously on mount, and each test uses them as its
   * positive anchor before asserting the transition.
   */
  async function openBothDocks(
    wp: WorkspacePage,
    workspaceId: string,
  ): Promise<{ chat: number; terminal: number }> {
    await wp.goto(workspaceId);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();

    // Positive anchor: both docks have persisted exactly their one default
    // pane. Polling (not a bare read) because the layout row is written by the
    // container's layout-change listener after mount.
    await expect.poll(() => wp.countChatPanels(workspaceId)).toBe(1);
    await expect.poll(() => wp.countTerminalPanels(workspaceId)).toBe(1);
    return { chat: 1, terminal: 1 };
  }

  test("⌘T with the chat dock focused adds a chat pane and no terminal", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    const start = await openBothDocks(wp, WORKSPACE_DOCK_CHAT);

    // Anchor inside the CHAT dock. `focusPromptAt` clicks (rather than
    // `focus()`es) the prompt so dockview's focusin tracking runs and the chat
    // container's `containerRef.contains(document.activeElement)` guard passes
    // — while the terminal container's identical guard fails.
    await chat.focusPromptAt(0);
    await wp.pressNewTabShortcut();

    // Positive half: the chat dockview grew a pane.
    await expect.poll(() => wp.countChatPanels(WORKSPACE_DOCK_CHAT)).toBe(start.chat + 1);
    // Negative half — the one that catches a binding that leaked global. Both
    // containers' handlers were mounted and listening; only the focused one
    // may act. Polled over the same HTTP surface so a late terminal write
    // can't sneak in after a single-shot read.
    await expect.poll(() => wp.countTerminalPanels(WORKSPACE_DOCK_CHAT)).toBe(start.terminal);
    // NOT asserted here: the number of rendered chat prompts. ⌘T adds the new
    // pane as a TAB in the active group, and dockview only renders the active
    // tab's content — so `ChatPanePage.promptCount()` stays at 1 even though
    // the dockview really did grow a panel. (The ⌘B test above sees 2 prompts
    // because its seeded layout puts the panes in two different groups.) The
    // persisted-layout count is the projection that distinguishes the docks.
  });

  test("⌘T with the terminal dock focused adds a terminal and no chat pane", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const start = await openBothDocks(wp, WORKSPACE_DOCK_TERM);

    // Anchor inside the TERMINAL dock — the mirror image of the test above,
    // same combo, same two live listeners, opposite outcome.
    await wp.newTabViaShortcutFromTerminal();

    await expect.poll(() => wp.countTerminalPanels(WORKSPACE_DOCK_TERM)).toBe(start.terminal + 1);
    await expect.poll(() => wp.countChatPanels(WORKSPACE_DOCK_TERM)).toBe(start.chat);
  });

  test("⌘D with the terminal dock focused splits the terminal dock", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const start = await openBothDocks(wp, WORKSPACE_DOCK_SPLIT);

    // ⌘D is the SPLIT branch, not close: `DockviewTerminalContainer`'s
    // `key === "d"` arm splits on `e.metaKey && !e.ctrlKey` and only closes
    // the active tab on `e.ctrlKey && !e.metaKey && !e.shiftKey`. The two are
    // deliberately NOT interchangeable here, unlike every other chord in that
    // handler where `mod = e.metaKey || e.ctrlKey`. Pinning the real
    // behaviour: ⌘D grows the terminal dock.
    await wp.splitRightViaShortcutFromTerminal();

    await expect.poll(() => wp.countTerminalPanels(WORKSPACE_DOCK_SPLIT)).toBe(start.terminal + 1);
    // The chat dock owns ⌘D too (its own handler splits on the same key), so
    // the unchanged chat count is again the half that proves the binding
    // stayed scoped to the focused dock.
    await expect.poll(() => wp.countChatPanels(WORKSPACE_DOCK_SPLIT)).toBe(start.chat);
  });
});

test.describe("Split, physical-key and zoom bindings", () => {
  // Two of the three tests boot a real PTY on top of the multi-stage app boot
  // and then wait on a server round-trip for the layout write, same as group C.
  test.slow();

  test("⌘0 resets the label filter to All", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE_LABELLED);
    await wp.waitForReady();

    // Positive anchor: a filter really is applied before the reset. Selected
    // through the dropdown (the click path) rather than a digit shortcut, so
    // this test's subject is ⌘0 alone and not ⌘1's half of the same binding.
    // Polled because `useLabelFilter` writes the key from a React state
    // update, one micro-task after the click.
    await wp.selectLabelFilter(LABEL_D);
    await expect.poll(() => wp.readLabelFilter()).toBe(LABEL_D);

    await wp.pressLabelShortcut(0);

    // "All" is represented by the ABSENCE of the key — `useLabelFilter`
    // `removeItem`s it rather than storing a sentinel.
    await expect.poll(() => wp.readLabelFilter()).toBeNull();
  });

  test("Ctrl+0 focuses the project list and leaves the label filter alone", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE_LABELLED);
    await wp.waitForReady();

    await wp.selectLabelFilter(LABEL_D);
    await expect.poll(() => wp.readLabelFilter()).toBe(LABEL_D);
    // Second half of the starting state: focus is NOT yet on the project list
    // (the workspace route autofocuses the chat prompt), so the assertion
    // below is a genuine transition rather than a coincidence.
    await expect(wp.projectListRoot()).not.toBeFocused();

    // `focusProjectsViaShortcut` anchors the keypress on the sidebar toggle
    // button — deliberately NOT the project list itself, which would make the
    // focus assertion vacuous.
    await wp.focusProjectsViaShortcut();

    // The half that pins the split. Both used to be one chord, and Focus
    // Projects only won by capture-phase `stopPropagation()` ordering; if
    // Ctrl+0 ever rejoins `LABEL_FILTER_SHORTCUT` this filter reads back null.
    await expect(wp.projectListRoot()).toBeFocused();
    // Read AFTER the focus assertion has settled, so the Ctrl+0 handlers have
    // demonstrably run — a filter reset would already be in localStorage by
    // now and this poll would fail on its first iteration rather than pass
    // before the damage lands.
    await expect.poll(() => wp.readLabelFilter()).toBe(LABEL_D);
  });

  test("⌘⇧] and ⌘⇧[ cycle the focused dock's active tab", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE_TAB_CYCLE);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();

    // Stack a SECOND tab into the same group via the dock's own "+" button.
    // Cycling only means anything with more than one tab in the active group,
    // and the button path keeps the setup independent of ⌘T (which group C
    // already covers).
    await expect.poll(() => wp.countTerminalPanels(WORKSPACE_TAB_CYCLE)).toBe(1);
    await wp.clickTerminalAddTab(WORKSPACE_TAB_CYCLE);
    await expect.poll(() => wp.countTerminalPanels(WORKSPACE_TAB_CYCLE)).toBe(2);

    // Positive anchor: dockview activates a newly added tab, so the active
    // view is the SECOND entry in the group's `views` list. Asserting on the
    // index rather than the panel count is the point — a cycle leaves the
    // count at 2 either way, so the count can't tell a working binding from a
    // dead one.
    await expect.poll(() => wp.innerActiveTabIndex("terminal", WORKSPACE_TAB_CYCLE)).toBe(1);

    // Forward from the last tab wraps to the first — `cycleTabs(1)` is modular.
    await wp.cycleTabViaShortcutFromTerminalDock(WORKSPACE_TAB_CYCLE, "next");
    await expect.poll(() => wp.innerActiveTabIndex("terminal", WORKSPACE_TAB_CYCLE)).toBe(0);

    // …and back. Both directions are asserted because they are separate
    // bindings (`nextTab` / `previousTab`) that were separately dead.
    await wp.cycleTabViaShortcutFromTerminalDock(WORKSPACE_TAB_CYCLE, "previous");
    await expect.poll(() => wp.innerActiveTabIndex("terminal", WORKSPACE_TAB_CYCLE)).toBe(1);
  });

  test("⌘=, ⌘⇧= and ⌘- drive the applied zoom level", async ({ page }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    await wp.goto(WORKSPACE_ZOOM);
    await wp.waitForReady();
    await wp.openTerminalTab();
    await wp.waitForTerminalReady();

    // Positive anchor: the pre-paint init script in `__root.tsx` seeds
    // `--app-zoom` at 1 on a fresh origin, so every step below is a measured
    // delta from a known start rather than an absolute guess.
    await expect.poll(() => wp.appliedZoomLevel()).toBe(1);

    // ⌘= — the unshifted spelling. `ZOOM_STEP` is 0.1 and `applyZoomLevel`
    // rounds to two decimals, so the levels are exact, not floating-point
    // approximations.
    await wp.zoomViaShortcutFromTerminal("in");
    await expect.poll(() => wp.appliedZoomLevel()).toBe(1.1);

    // ⌘⇧= (i.e. ⌘+) — the half that was silently dead. `+` and `=` share one
    // physical key, the old handler accepted both characters, and a `meta+=`
    // binding cannot fire while Shift is held because the library compares
    // modifiers for exact equality. Binding the physical `Equal` with AND
    // without Shift is what makes this line pass.
    await wp.zoomViaShortcutFromTerminal("inShifted");
    await expect.poll(() => wp.appliedZoomLevel()).toBe(1.2);

    // ⌘- — the opposite direction, so a binding that fired on any modifier
    // combination (rather than the one it declares) can't pass the whole test.
    await wp.zoomViaShortcutFromTerminal("out");
    await expect.poll(() => wp.appliedZoomLevel()).toBe(1.1);
  });

  // The group's other intentional behaviour change. ⌘J used to be focus-aware
  // exactly like ⌥⌘B still is: the handler asked `findFocusedInnerDockview()`
  // first, and if that dockview's `edge-bottom` held panels, `toggleEdgeGroup`
  // collapsed THAT inner edge and returned `true` — the outer layout was never
  // touched. It now always toggles the outermost shared-dockview layout's
  // bottom edge, the same rule ⌘B follows with the sidebar, which leaves ⌥⌘B
  // as the only edge chord that still resolves its target by focus.
  //
  // Both edges are seeded populated so the two implementations are actually
  // distinguishable: with an empty inner bottom edge the old handler would
  // have fallen through to the outer layout and this test would pass against
  // it too. See `chatLayoutWithBottomEdgePanel`.
  test("⌘J from a focused chat pane toggles the outer bottom edge, not the inner one", async ({
    page,
  }) => {
    const wp = new WorkspacePage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);

    // Seed BEFORE `goto`, in this order, for two different reasons. The inner
    // chat layout is SERVER state fetched once on mount, and chats must exist
    // in `chats.list` first or the restored panels are pruned as orphans (same
    // ordering constraint the ⌘B test documents). The outer layout is CLIENT
    // state installed via `addInitScript`, which only applies to navigations
    // that happen after it is registered.
    await wp.createChat(WORKSPACE_BOTTOM, CHAT_BOTTOM_CENTER, "Center");
    await wp.createChat(WORKSPACE_BOTTOM, CHAT_BOTTOM_EDGE, "Edge");
    await wp.seedInnerLayout(
      "chat",
      WORKSPACE_BOTTOM,
      chatLayoutWithBottomEdgePanel(WORKSPACE_BOTTOM),
    );
    await wp.seedGlobalLayout(OUTER_LAYOUT_WITH_BOTTOM_EDGE_PANEL);

    await wp.goto(WORKSPACE_BOTTOM);
    await wp.waitForReady();

    // Round-trip the INNER seed, polled for the same reason the ⌘B test polls
    // its own: the container re-persists asynchronously on mount, so a
    // single-shot read can observe what we seeded moments earlier even though
    // dockview rejected the tree and `onReady` fell back to one default pane —
    // which would empty the inner bottom edge and silently turn this into a
    // test that can't tell the two implementations apart.
    await expect.poll(() => chat.promptCount()).toBe(2);
    await expect
      .poll(() => wp.innerEdgeBottomViews("chat", WORKSPACE_BOTTOM))
      .toEqual([CHAT_BOTTOM_EDGE]);

    // Positive anchor: the OUTER bottom edge really is populated and expanded,
    // so there is something observable for the chord to collapse. Expanded is
    // the seeded 200px; a collapsed edge keeps its ~35px header strip (dockview
    // collapses rather than hides here — see `outerBottomEdgeHeight`), so the
    // thresholds sit either side of that gap with room for the tween.
    await expect.poll(() => wp.outerBottomEdgeHeight()).toBeGreaterThan(100);

    // Focus INSIDE the chat inner dockview, whose own `edge-bottom` is
    // populated — the focus that used to retarget this chord away from the
    // outer layout.
    await chat.focusPromptAt(0);
    await wp.pressToggleBottomEdgeShortcut();

    // The outer edge collapsed despite the inner dock holding focus.
    await expect.poll(() => wp.outerBottomEdgeHeight(), { timeout: 5_000 }).toBeLessThan(60);

    // Round trip from the same anchor — proves the binding is a toggle rather
    // than a one-way collapse, and that the second press didn't get retargeted
    // either.
    await chat.focusPromptAt(0);
    await wp.pressToggleBottomEdgeShortcut();
    await expect.poll(() => wp.outerBottomEdgeHeight(), { timeout: 5_000 }).toBeGreaterThan(100);
  });
});
