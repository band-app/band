/**
 * Page object for the chat pane inside a workspace.
 *
 * Owns the locators for the prompt textarea, the conversation's message
 * bubbles, the thinking indicator, and the session-history Clock menu.
 * The test body NEVER calls `page.goto()` / `page.getByRole()` /
 * `page.getByTestId()` directly — actions go through methods here.
 *
 * Locator priority:
 *   1. `getByRole({ name })` — used for the textarea via its placeholder
 *      (a constant prop in `ChatView.tsx`, not localised user copy).
 *   2. `getByTestId("page__element")` — used for the thinking indicator,
 *      where role alone is ambiguous (lots of decorative loaders in
 *      ai-elements). Also used to ROLE-SCOPE the user/assistant message
 *      bubble containers via
 *      `getByTestId("chat-pane__user-message").filter({ hasText })` /
 *      `getByTestId("chat-pane__assistant-message").filter({ hasText })`,
 *      so a future change rendering user text inside an assistant
 *      bubble (or vice versa) fails the locator instead of silently
 *      passing.
 *   3. `getByText(value)` — only when the value is genuinely
 *      role-agnostic test data (rarely needed since the role-scoped
 *      `.filter({ hasText: ... })` form above is preferred).
 */

import { expect, type Locator, type Page, test } from "@playwright/test";
import { FindWidget } from "./FindWidget";

/** Bounding boxes of the composer's parts, in CSS px. */
export interface ComposerGeometry {
  /** The bordered field around the textarea and the send button. */
  body: Box;
  prompt: Box;
  submit: Box;
  modeMenu: Box;
  modelMenu: Box;
  contextMeter: Box;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The chat find's painted highlights (CSS Custom Highlight API). */
export interface ChatFindHighlights {
  /** Matches highlighted in the mounted messages. */
  total: number;
  /** Text of the current match, or null when none is painted. */
  current: string | null;
  /** The current match lies inside the conversation's visible area. */
  currentInView: boolean;
}

export class ChatPanePage {
  /** The prompt textarea — placeholder is stable, hard-coded in
   *  `ChatView.tsx` and not user-localised. */
  readonly promptInput: Locator;
  /** The `<form>` around the prompt textarea and its toolbar. */
  readonly promptForm: Locator;
  /** The "Thinking…" indicator that surfaces while a task is in flight.
   *  Targeted by `data-testid` so the test doesn't depend on the user-
   *  visible copy. */
  readonly thinkingIndicator: Locator;
  /** The Clock icon that opens the session-history dropdown. */
  readonly sessionHistoryButton: Locator;
  /** "New session" item inside the session-history dropdown. */
  readonly newSessionMenuItem: Locator;
  /** The "No sessions yet" empty state inside the session-history
   *  dropdown. Targeted by testid, not by its English copy. */
  readonly sessionHistoryEmpty: Locator;
  /** The conversation's empty state, shown once the stream is connected
   *  and the chat has no messages (a fresh chat, or after "New session"). */
  readonly emptyConversation: Locator;
  /** The pinned todo list above the prompt, fed by the agent's ACP
   *  `plan` updates (Claude Code's TodoWrite arrives this way). */
  readonly taskListWidget: Locator;
  /** Inline notices in the transcript (a stopped turn, an agent error).
   *  Each carries `data-level` (`info` / `warning` / `error`). */
  readonly notices: Locator;
  /** Permission cards (ACP `session/request_permission`), one per request.
   *  Each carries `data-answered="true"` once the user picked an option. */
  readonly permissionCards: Locator;
  /** Elicitation forms (ACP form `elicitation/create`, e.g. Claude Code's
   *  AskUserQuestion). Same `data-answered` attribute as the cards. */
  readonly elicitationForms: Locator;
  /** The chat pane's root; the find widget opens inside it. */
  readonly root: Locator;
  /** The chat's find widget (Cmd/Ctrl+F). */
  readonly find: FindWidget;
  /** The bordered field holding the prompt and the send button. */
  readonly promptBody: Locator;
  /** The execution mode trigger in the settings row. */
  readonly modeMenuButton: Locator;
  /** The items of the open execution mode menu. */
  readonly modeMenuItems: Locator;
  /** The context window ring next to the model, always shown. */
  readonly contextMeter: Locator;
  /** The popover the ring opens on hover: context used and cost. */
  readonly contextMeterDetails: Locator;
  /** The popover's "used / size (percent)" row. */
  readonly contextMeterUsage: Locator;
  /** The popover's cost row, shown when the agent reports a cost. */
  readonly contextMeterCost: Locator;
  /** The composer textarea by test id. Its placeholder changes while a
   *  question card waits, so `promptInput` can't find it then. */
  readonly composer: Locator;
  /** The model settings trigger on the right of the composer: model name
   *  plus effort, opening the model / effort / fast mode menu. */
  readonly modelMenuButton: Locator;
  /** The model name shown in the model settings trigger. */
  readonly modelMenuModel: Locator;
  /** The effort value shown in the model settings trigger. */
  readonly modelMenuEffort: Locator;
  /** The open model settings menu. */
  readonly modelMenuContent: Locator;
  /** The "Effort" row in the model settings menu (opens a submenu). */
  readonly effortSubmenu: Locator;
  /** The "Fast mode" row in the model settings menu. */
  readonly fastModeItem: Locator;
  /** The switch inside the "Fast mode" row (`data-state` checked /
   *  unchecked). */
  readonly fastModeSwitch: Locator;
  /** The "More models" row in the model settings menu (opens a submenu). */
  readonly moreModelsSubmenu: Locator;
  /** The open "More models" submenu, listing the other models. */
  readonly moreModelsContent: Locator;
  /** The first row of the open model settings menu: the selected model. */
  readonly selectedModelItem: Locator;
  /** The rows of the open "More models" submenu. For OpenCode these are
   *  providers, each opening its own submenu. */
  readonly moreModelsRows: Locator;
  /** The open "Effort" submenu. */
  readonly effortSubmenuContent: Locator;
  /** Stop / cancel button — only present while the current task is in
   *  the streaming phase (post-`text-start`, pre-`task-completed`) and the
   *  prompt is empty. */
  readonly stopButton: Locator;
  /** Send button. The composer shows either this or Stop, never both. */
  readonly submitButton: Locator;
  /** Queued messages (sent while a turn runs), in queue order. */
  readonly queuedMessages: Locator;
  /** The "Queued · sent when the agent finishes" divider above them. */
  readonly queueDivider: Locator;
  /** The inline editor a queued message turns into while it is edited. */
  readonly queuedEditor: Locator;
  /** All rendered tool-call rows in the conversation (one per ACP
   *  `tool_call`). A call inside a collapsed group isn't rendered until
   *  the group is expanded. Each carries a `data-status` attribute
   *  (`in-progress` / `complete` / `error`); tests assert against that
   *  rather than the underlying Tailwind classes. */
  readonly toolCallContainers: Locator;
  /** Groups of consecutive tool calls, each collapsed to one summary
   *  line until clicked. */
  readonly toolGroups: Locator;
  /** The `@`-mention file dropdown — opens when the user types `@` in
   *  the prompt. ARIA name is system-controlled in
   *  `file-mention-suggestions.tsx`. */
  readonly fileMentionDropdown: Locator;
  /** The `/`-command dropdown above the prompt. */
  readonly slashCommandDropdown: Locator;
  /** The StickToBottom scroll container — the element whose `scrollTop`
   *  drives the chat virtualizer. The testid is attached in
   *  `ChatView.tsx` via the `stickyContextRef.scrollRef.current` since
   *  `use-stick-to-bottom` doesn't expose a prop for scroller
   *  attributes. Used for programmatic scrolling in virtualization
   *  tests. */
  readonly scroller: Locator;
  /** Sized wrapper rendered by `VirtualizedMessageList` whose explicit
   *  height equals the virtualizer's `totalSize`. Tests assert on its
   *  visibility as a proxy for "messages are mounted". */
  readonly virtualList: Locator;
  /** Each currently-mounted message row inside the virtualizer. Use
   *  `messageRowCount()` to get the windowed count without inlining
   *  `await this.messageRows.count()` in the test body. */
  readonly messageRows: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.promptInput = page.getByPlaceholder("Type a message...");
    this.promptForm = page.getByTestId("prompt-input__form").filter({ visible: true });
    this.root = page.getByTestId("chat-pane").filter({ visible: true });
    this.find = new FindWidget(this.root);
    this.promptBody = page.getByTestId("prompt-input__body").filter({ visible: true });
    this.modeMenuButton = page.getByTestId("chat-pane__mode-menu").filter({ visible: true });
    this.modeMenuItems = page.getByRole("menu").getByRole("menuitem");
    this.contextMeter = page.getByTestId("chat-pane__context-meter").filter({ visible: true });
    this.contextMeterDetails = page.getByTestId("chat-pane__context-meter-details");
    this.contextMeterUsage = page.getByTestId("chat-pane__context-meter-usage");
    this.contextMeterCost = page.getByTestId("chat-pane__context-meter-cost");
    this.thinkingIndicator = page.getByTestId("chat-pane__thinking-indicator");
    // System-controlled aria-label set in `ChatView.tsx::SessionHistoryMenu` —
    // doctrine-preferred locator (role + name).
    this.sessionHistoryButton = page.getByRole("button", { name: "Session history" });
    this.newSessionMenuItem = page.getByRole("menuitem", { name: /New session/ });
    this.sessionHistoryEmpty = page.getByTestId("chat-pane__session-history-empty");
    this.emptyConversation = page.getByTestId("chat-pane__empty-state");
    this.taskListWidget = page.getByTestId("task-list-widget__container");
    this.notices = page.getByTestId("chat-pane__notice");
    this.permissionCards = page.getByTestId("chat-pane__permission");
    this.elicitationForms = page.getByTestId("chat-pane__elicitation");
    this.composer = page.getByTestId("chat__composer").filter({ visible: true });
    this.modelMenuButton = page.getByTestId("chat-pane__model-menu");
    this.modelMenuModel = page.getByTestId("chat-pane__model-menu-model");
    this.modelMenuEffort = page.getByTestId("chat-pane__model-menu-effort");
    this.modelMenuContent = page.getByTestId("chat-pane__model-menu-content");
    this.effortSubmenu = page.getByTestId("chat-pane__model-menu-effort-submenu");
    this.fastModeItem = page.getByTestId("chat-pane__model-menu-fast");
    this.fastModeSwitch = this.fastModeItem.getByRole("switch", { includeHidden: true });
    this.moreModelsSubmenu = page.getByTestId("chat-pane__model-menu-more-models");
    this.moreModelsContent = page.getByTestId("chat-pane__model-menu-more-models-content");
    this.selectedModelItem = page.getByTestId("chat-pane__model-menu-current");
    this.moreModelsRows = this.moreModelsContent.getByRole("menuitem");
    this.effortSubmenuContent = page.getByTestId("chat-pane__model-menu-effort-submenu-content");
    this.stopButton = page.getByTestId("prompt-input__stop-button");
    this.submitButton = page.getByTestId("prompt-input__submit-button").filter({ visible: true });
    this.queuedMessages = page.getByTestId("chat-pane__queued-message");
    this.queueDivider = page.getByTestId("chat-pane__queue-divider");
    this.queuedEditor = page.getByTestId("chat-pane__queued-editor");
    this.toolCallContainers = page.getByTestId("tool-call__container");
    this.toolGroups = page.getByTestId("tool-group__container");
    this.fileMentionDropdown = page.getByRole("listbox", { name: "File mentions" });
    this.slashCommandDropdown = page.getByRole("listbox", { name: "Slash commands" });
    this.scroller = page.getByTestId("chat-pane__scroller");
    this.virtualList = page.getByTestId("chat-pane__virtual-list");
    this.messageRows = page.getByTestId("chat-pane__message-row");
  }

  /** Navigate to the workspace's chat view. The only place URLs are
   *  constructed in this page object. */
  async goto(workspaceId: string): Promise<void> {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}?token=${this.token}`;
    await test.step(`Navigate to workspace ${workspaceId}`, async () => {
      await this.page.goto(url);
    });
  }

  /** Reload the page, as a user pressing Cmd+R would. */
  async reload(): Promise<void> {
    await test.step("Reload the page", async () => {
      await this.page.reload();
    });
  }

  /** Wait for the chat pane to be interactive (prompt textarea visible).
   *
   *  The center dockview's default layout is a single TERMINAL tab (no chat),
   *  so this first ensures a chat leaf exists + is the active tab: if a chat is
   *  already present (a seeded live chat surfaced by the default layout, just
   *  not the active tab) it's activated; otherwise a fresh chat is created via
   *  the "+" new-tab menu — the same way a user opens one. Then it waits for the
   *  prompt. */
  async waitForReady(): Promise<void> {
    // The dockview is ready once its "+" new-tab button renders.
    const addBtn = this.page
      .getByTestId("workspace-center__new-tab-button")
      .filter({ visible: true })
      .first();
    await addBtn.waitFor({ state: "visible", timeout: 15_000 });

    const chatTab = this.page
      .getByTestId(/^center-chat-tab--/)
      .filter({ visible: true })
      .first();
    const hasChat = await chatTab
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasChat) {
      // No chat leaf (the default layout is a single terminal) — create one
      // with the default agent, which opens as a chat in the default mode.
      await this.openNewTabMenu();
      await this.openNewChatAgentMenu();
      await this.newChatAgentItems.first().click();
      await chatTab.waitFor({ state: "visible", timeout: 15_000 });
    }
    // Activate the chat tab so its pane (and prompt) is the shown content — a
    // just-created / surfaced chat sits behind the active terminal tab.
    await chatTab.click();

    await this.focusPromptAfterMenuCloses();
  }

  /** Wait for the "+" new-tab menu to finish closing, then put focus in the
   *  prompt. Radix returns focus to the "+" button when the menu's 150 ms exit
   *  animation ends. If that lands after a test fills the prompt, its Enter
   *  reopens the menu instead of sending the message. The menu unmounts only
   *  after its exit animation, so once it is gone focus has been returned and
   *  nothing moves it again. */
  private async focusPromptAfterMenuCloses(): Promise<void> {
    await expect(this.page.getByTestId("workspace-center__new-tab-menu")).toHaveCount(0);
    await this.promptInput.waitFor({ state: "visible", timeout: 15_000 });
    await this.promptInput.focus();
    await expect(this.promptInput).toBeFocused();
  }

  /** Open the "+" new-tab menu of the visible center dockview. */
  async openNewTabMenu(): Promise<void> {
    await test.step("Open the new-tab menu", async () => {
      const addBtn = this.page
        .getByTestId("workspace-center__new-tab-button")
        .filter({ visible: true })
        .first();
      await addBtn.waitFor({ state: "visible", timeout: 15_000 });
      await addBtn.focus();
      await this.page.keyboard.press("Enter");
      await this.page
        .getByTestId("workspace-center__new-tab-menu")
        .filter({ visible: true })
        .first()
        .waitFor({ state: "visible" });
    });
  }

  /** The agent rows in the open "New agent" submenu, top to bottom. */
  get newChatAgentItems(): Locator {
    return this.page
      .getByTestId("workspace-center__new-agent-menu")
      .filter({ visible: true })
      .getByTestId(/^workspace-center__new-agent(--.+)?$/);
  }

  /** Open the "New agent" submenu of the open new-tab menu (issue #682). */
  async openNewChatAgentMenu(): Promise<void> {
    await test.step("Open the New agent submenu", async () => {
      await this.page
        .getByTestId("workspace-center__new-tab--agent")
        .filter({ visible: true })
        .first()
        .click();
      await expect(this.newChatAgentItems.first()).toBeVisible();
    });
  }

  /** Start a new chat with the given coding agent from the open agent
   *  submenu, then show its tab and wait for its prompt. The workspace must
   *  have no other chat tab, and this browser's agent mode must be unset or
   *  `gui`. The leaf opens once the server has created the chat. */
  async startChatWithAgent(agentId: string): Promise<void> {
    await test.step(`Start a new chat with ${agentId}`, async () => {
      await this.newChatAgentItems
        .and(this.page.getByTestId(`workspace-center__new-agent--${agentId}`))
        .click();
      const chatTab = this.page
        .getByTestId(/^center-chat-tab--/)
        .filter({ visible: true })
        .first();
      await expect(chatTab).toBeVisible({ timeout: 15_000 });
      await chatTab.click();
      await this.focusPromptAfterMenuCloses();
    });
  }

  /** A row in the open model settings menu naming a coding agent (its label
   *  from settings, i.e. test data). The menu must not offer any. */
  modelMenuAgentOption(label: string): Locator {
    return this.modelMenuContent.getByText(label);
  }

  /** Open the model settings menu. */
  async openModelMenu(): Promise<void> {
    await test.step("Open the model settings menu", async () => {
      await this.modelMenuButton.click();
      await expect(this.modelMenuContent).toBeVisible();
    });
  }

  /** Open the "More models" submenu of the open model settings menu. */
  async openMoreModels(): Promise<void> {
    await test.step("Open the More models submenu", async () => {
      await this.moreModelsSubmenu.click();
      await expect(this.moreModelsContent).toBeVisible();
    });
  }

  /** A model row in the open "More models" submenu, by display name (agent
   *  test data). */
  moreModelsOption(name: string): Locator {
    return this.moreModelsContent.getByRole("menuitem", { name, exact: true });
  }

  /** A provider row in the open "More models" submenu (OpenCode), by the
   *  provider part of the model ids (agent test data). */
  providerSubmenu(providerId: string): Locator {
    return this.moreModelsContent.getByTestId(`chat-pane__model-menu-provider--${providerId}`);
  }

  /** The open submenu of one provider's models. */
  providerModelsContent(providerId: string): Locator {
    return this.page.getByTestId(`chat-pane__model-menu-provider--${providerId}-content`);
  }

  /** A model row in one provider's open submenu, by display name. */
  providerModelOption(providerId: string, name: string): Locator {
    return this.providerModelsContent(providerId).getByRole("menuitem", { name, exact: true });
  }

  /** The check mark inside a model or provider row, shown on the selected
   *  model and on its provider. */
  selectedCheck(row: Locator): Locator {
    return row.getByTestId("chat-pane__model-menu-check");
  }

  /** Open one provider's submenu from the open "More models" submenu. */
  async openProvider(providerId: string): Promise<void> {
    await test.step(`Open the ${providerId} provider submenu`, async () => {
      await this.providerSubmenu(providerId).click();
      await expect(this.providerModelsContent(providerId)).toBeVisible();
    });
  }

  /** Click a model in a provider's open submenu. The menu closes. */
  async clickProviderModel(providerId: string, name: string): Promise<void> {
    await test.step(`Click model "${name}" of ${providerId}`, async () => {
      await this.providerModelOption(providerId, name).click();
      await expect(this.modelMenuContent).toBeHidden();
    });
  }

  /** Move keyboard focus to the last row (a model, or OpenCode's last
   *  provider) of the open "More models" submenu, the way a keyboard user
   *  reaches it: into the submenu, then End. */
  async focusLastMoreModel(): Promise<void> {
    await test.step("Focus the last model with the keyboard", async () => {
      await this.moreModelsContent.getByRole("menuitem").first().focus();
      await this.page.keyboard.press("End");
    });
  }

  /** Move keyboard focus to the last model of one provider's open submenu:
   *  into the submenu, then End. */
  async focusLastProviderModel(providerId: string): Promise<void> {
    await test.step(`Focus the last ${providerId} model with the keyboard`, async () => {
      await this.providerModelsContent(providerId).getByRole("menuitem").first().focus();
      await this.page.keyboard.press("End");
    });
  }

  /** Open the "Effort" submenu of the open model settings menu. */
  async openEffortSubmenu(): Promise<void> {
    await test.step("Open the Effort submenu", async () => {
      await this.effortSubmenu.click();
      await expect(this.effortSubmenuContent).toBeVisible();
    });
  }

  /** Scroll the open "More models" submenu to its end with the mouse wheel. */
  async wheelMoreModelsToEnd(): Promise<void> {
    await test.step("Scroll the More models submenu with the wheel", async () => {
      await this.wheelToEnd(this.moreModelsContent, this.moreModelsSubmenu);
    });
  }

  /** Scroll one provider's open submenu to its end with the mouse wheel. */
  async wheelProviderModelsToEnd(providerId: string): Promise<void> {
    await test.step(`Scroll the ${providerId} provider submenu with the wheel`, async () => {
      await this.wheelToEnd(
        this.providerModelsContent(providerId),
        this.providerSubmenu(providerId),
      );
    });
  }

  private async wheelToEnd(menu: Locator, trigger: Locator): Promise<void> {
    // Enter the menu the way a pointer does: onto its trigger row, then
    // straight across. Radix keeps a submenu open while the pointer heads
    // toward it, judged by the last moves inside the parent menu; a jump
    // (`hover()` is one move) or a diagonal over other rows closes it.
    const from = await trigger.boundingBox();
    const to = await menu.boundingBox();
    if (!from || !to) throw new Error("menu or trigger has no layout box");
    const y = from.y + from.height / 2;
    await this.page.mouse.move(from.x + from.width / 2, y);
    await this.page.mouse.move(to.x + to.width / 2, y, { steps: 10 });
    const atEnd = () =>
      menu.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
    for (let i = 0; i < 50 && !(await atEnd()); i++) {
      await this.page.mouse.wheel(0, 200);
    }
    await expect.poll(atEnd).toBe(true);
  }

  /** Click a model in the open "More models" submenu. The menu closes. */
  async clickMoreModel(name: string): Promise<void> {
    await test.step(`Click model "${name}"`, async () => {
      await this.moreModelsOption(name).click();
      await expect(this.modelMenuContent).toBeHidden();
    });
  }

  /** Scroll the open "More models" submenu back to its top. */
  async scrollMoreModelsToTop(): Promise<void> {
    await test.step("Scroll the More models submenu to the top", async () => {
      await this.moreModelsContent.evaluate((el) => {
        el.scrollTop = 0;
      });
    });
  }

  /** Scroll one provider's open submenu back to its top. */
  async scrollProviderModelsToTop(providerId: string): Promise<void> {
    await test.step(`Scroll the ${providerId} provider submenu to the top`, async () => {
      await this.providerModelsContent(providerId).evaluate((el) => {
        el.scrollTop = 0;
      });
    });
  }

  /** Close an open menu with Escape. */
  async closeMenu(): Promise<void> {
    await test.step("Close the menu", async () => {
      await this.page.keyboard.press("Escape");
      await expect(this.modelMenuContent).toBeHidden();
    });
  }

  /** Pick an effort level in the model settings menu, by its name (agent
   *  test data). The menu must be open. */
  async selectEffort(name: string): Promise<void> {
    await test.step(`Select effort "${name}"`, async () => {
      await this.effortSubmenu.click();
      await this.page.getByRole("menuitem", { name, exact: true }).click();
      await expect(this.modelMenuContent).toBeHidden();
    });
  }

  /** Flip the fast mode switch in the open model settings menu. The menu
   *  stays open. */
  async toggleFastMode(): Promise<void> {
    await test.step("Toggle fast mode", async () => {
      await this.fastModeItem.click();
    });
  }

  /** Type into the prompt textarea. Doesn't submit. */
  async typeMessage(text: string): Promise<void> {
    await test.step(`Type "${text}" into the prompt`, async () => {
      await this.promptInput.fill(text);
    });
  }

  /** Read the current value of the prompt textarea. Used to assert that an
   *  "Add to Chat" file reference was appended to the chat input. */
  async promptValue(): Promise<string> {
    return await this.promptInput.inputValue();
  }

  /** All prompt textareas currently mounted for the active workspace — one per
   *  open chat pane. Used by the last-focused-routing test, where a split
   *  produces two panes and the reference must land in exactly one of them. */
  get promptInputs(): Locator {
    return this.page.getByPlaceholder("Type a message...");
  }

  /** Number of open chat panes (prompt textareas) in the active workspace. */
  async promptCount(): Promise<number> {
    return await this.promptInputs.count();
  }

  /** Click into the Nth chat pane's prompt so it becomes the focused (active)
   *  pane — this is what the container reports to the server as the workspace's
   *  last-focused chat. Click (not `focus()`) so dockview's focusin tracking
   *  fires and the active panel actually switches. */
  async focusPromptAt(index: number): Promise<void> {
    await test.step(`Focus chat pane #${index}`, async () => {
      await this.promptInputs.nth(index).click();
    });
  }

  /** Type text into the Nth chat pane's prompt (replacing its content). */
  async fillPromptAt(index: number, text: string): Promise<void> {
    await test.step(`Fill chat pane #${index} with "${text}"`, async () => {
      await this.promptInputs.nth(index).fill(text);
    });
  }

  /** Snapshot every open pane's prompt value. Order-independent assertions
   *  (which pane received the reference) sort these rather than depending on
   *  dockview's DOM ordering of split groups. */
  async allPromptValues(): Promise<string[]> {
    return await this.promptInputs.evaluateAll((els) =>
      els.map((el) => (el as HTMLTextAreaElement).value),
    );
  }

  /** Clear the prompt textarea. Most submit paths empty the textarea
   *  already, but the draft-persistence logic in `PromptInput` can
   *  leave whitespace behind — call this before tests that need a
   *  guaranteed-empty input (e.g. typing `@` or `/` at position 0). */
  async clearPrompt(): Promise<void> {
    await test.step("Clear the prompt", async () => {
      await this.promptInput.fill("");
    });
  }

  /** Submit the typed message via Enter (mirrors the keyboard path users
   *  take). The form's submit handler triggers `useChatSubscription.send`
   *  which dispatches the optimistic user-message + task-started events. */
  async submit(): Promise<void> {
    await test.step("Submit the prompt with Enter", async () => {
      await this.promptInput.press("Enter");
    });
  }

  /** Submit the typed message with the send button, the way a phone user
   *  does: there, Enter inserts a newline. */
  async tapSend(): Promise<void> {
    await test.step("Tap the send button", async () => {
      await this.submitButton.tap();
    });
  }

  /** Attach a file to the prompt through the composer's file input, the
   *  input the paperclip button opens. Scoped to the visible composer, since
   *  other visited workspaces keep their chats mounted. */
  async attachFile(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await test.step(`Attach ${file.name}`, async () => {
      await this.page
        .getByTestId("chat-pane__composer")
        .filter({ visible: true })
        .getByTestId("prompt-input__file-input")
        .setInputFiles(file);
    });
  }

  /** Open the full-screen preview of the first image in a message. */
  async openImagePreview(message: Locator): Promise<void> {
    await test.step("Open the image preview", async () => {
      await message.getByTestId("message__image-preview-button").first().click();
      await expect(this.filePreviewContent).toBeVisible();
    });
  }

  /** The content area of the open full-screen file preview. */
  get filePreviewContent(): Locator {
    return this.page.getByTestId("file-preview-overlay__content");
  }

  /** Start recording the chat event streams the page opens
   *  (`/api/chats/<id>/events`). The getter returns the streams that started
   *  from the beginning of the log, with no `lastEventId` cursor: a chat view
   *  mounted from scratch opens one and replays every message, a view that
   *  stayed mounted resumes from its cursor. Call BEFORE `goto`. */
  trackFullReplays(): () => string[] {
    const urls: string[] = [];
    this.page.on("request", (req) => {
      const url = new URL(req.url());
      if (!/^\/api\/chats\/[^/]+\/events$/.test(url.pathname)) return;
      if (!url.searchParams.has("lastEventId")) urls.push(url.pathname);
    });
    return () => [...urls];
  }

  /** Locator for a user-role message bubble carrying the given text.
   *  Scoped to the `chat-pane__user-message` data-testid container so a
   *  future change that renders user text inside an assistant bubble
   *  (or vice versa) trips this locator instead of silently passing. */
  userMessage(text: string): Locator {
    return this.page.getByTestId("chat-pane__user-message").filter({ hasText: text });
  }

  /** Locator for an assistant-role message bubble carrying the given
   *  text. Same role-scoping rationale as `userMessage`. */
  assistantMessage(text: string): Locator {
    return this.page.getByTestId("chat-pane__assistant-message").filter({ hasText: text });
  }

  /** Count of currently-mounted message rows in the virtualized list.
   *  Used by the windowing test to assert the row count is bounded. */
  async messageRowCount(): Promise<number> {
    return await this.messageRows.count();
  }

  /** Wait for the virtualized list container to mount — this is the
   *  signal that the chat-events subscription has resolved the session
   *  and the reducer has at least one message to render. Encapsulates
   *  the raw locator behind a page-object action so the test body
   *  never touches the locator field directly. */
  async waitForVirtualList(timeout = 15_000): Promise<void> {
    await test.step("Wait for chat virtualized list", async () => {
      await expect(this.virtualList).toBeVisible({ timeout });
    });
  }

  /** Scroll the chat container to the top — drives the virtualizer's
   *  on-demand mount path so earlier-message rows appear in the DOM.
   *  Uses the scroller locator (same pattern as
   *  `ChangesPanelPage.scrollTo`) so a missing scroller surfaces as a
   *  Playwright locator timeout rather than a silent no-op. */
  async scrollToTop(): Promise<void> {
    await test.step("Scroll chat to top", async () => {
      await this.scroller.evaluate((el) => {
        (el as HTMLDivElement).scrollTop = 0;
      });
    });
  }

  /** The visible chat transcript's `scrollTop`, in CSS px. */
  async readScrollTop(): Promise<number> {
    return await this.scroller.filter({ visible: true }).evaluate((el) => el.scrollTop);
  }

  /** Scroll the chat container to the bottom — used to verify stick-to-bottom
   *  still reaches the latest message after older pages have prepended. */
  async scrollToBottom(): Promise<void> {
    await test.step("Scroll chat to bottom", async () => {
      await this.scroller.evaluate((el) => {
        (el as HTMLDivElement).scrollTop = (el as HTMLDivElement).scrollHeight;
      });
    });
  }

  /** Install a per-animation-frame sampler that records the on-screen `top`
   *  (viewport px) of the message row containing `anchorText`, until the row
   *  unmounts or the buffer fills. Drives the scroll-back "no jump" assertion:
   *  a correctly-anchored prepend keeps the anchor row's screen position stable
   *  (a few px of measurement jitter), while a broken prepend moves it by the
   *  full height of the inserted page (thousands of px). May be installed BEFORE
   *  the anchor row is on screen — recording begins only once the row mounts
   *  (`findRow()` returns non-null) — and before triggering `loadOlder`. Read
   *  the samples back with `readAnchorTopSamples()`. */
  async installAnchorTopSampler(anchorText: string): Promise<void> {
    await this.page.evaluate((text) => {
      const win = window as unknown as { __anchorTops: number[] };
      win.__anchorTops = [];
      const MAX_SAMPLES = 600;
      const findRow = (): HTMLElement | null => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid="chat-pane__message-row"]'),
        ) as HTMLElement[];
        return rows.find((r) => r.innerText.includes(text)) ?? null;
      };
      const sample = () => {
        if (win.__anchorTops.length >= MAX_SAMPLES) return;
        const row = findRow();
        if (row) win.__anchorTops.push(Math.round(row.getBoundingClientRect().top));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, anchorText);
  }

  /** Read the anchor-row `top` samples recorded by `installAnchorTopSampler()`. */
  async readAnchorTopSamples(): Promise<number[]> {
    return await this.page.evaluate(
      () => (window as unknown as { __anchorTops?: number[] }).__anchorTops ?? [],
    );
  }

  /** Click the Stop button to cancel the in-flight task. The button is
   *  only rendered while a task is streaming and the prompt is empty. */
  async clickStop(): Promise<void> {
    await test.step("Click Stop to cancel the in-flight task", async () => {
      await this.stopButton.click();
    });
  }

  /** Open the session-history dropdown. */
  async openSessionHistory(): Promise<void> {
    await test.step("Open session-history dropdown", async () => {
      await this.sessionHistoryButton.click();
    });
  }

  /** Click "New session" inside the session-history dropdown. The menu
   *  must be open first — call `openSessionHistory()`. */
  async clickNewSession(): Promise<void> {
    await test.step("Click New session", async () => {
      await this.newSessionMenuItem.click();
    });
  }

  /** A past session in the open session-history dropdown, by its summary
   *  (the session's first prompt, which is test data). */
  sessionHistoryItem(summary: string): Locator {
    return this.page.getByRole("menuitem", { name: new RegExp(escapeRegExp(summary)) });
  }

  /** Pick a past session from the open session-history dropdown. */
  async selectPastSession(summary: string): Promise<void> {
    await test.step(`Select past session "${summary}"`, async () => {
      await this.sessionHistoryItem(summary).click();
    });
  }

  /** The summary line of the tool group at `index`, the button that
   *  expands it. */
  toolGroupSummary(index: number): Locator {
    return this.toolGroups.nth(index).getByTestId("tool-group__summary");
  }

  /** How long the tool group at `index` took, beside its summary.
   *  Transparent until the row is hovered. */
  toolGroupDuration(index: number): Locator {
    return this.toolGroups.nth(index).getByTestId("tool-group__duration");
  }

  async hoverToolGroup(index: number): Promise<void> {
    await test.step(`Hover tool group ${index}`, async () => {
      await this.toolGroupSummary(index).hover();
    });
  }

  /** Expands the tool group at `index`; a no-op when it's already open. */
  async expandToolGroup(index: number): Promise<void> {
    const summary = this.toolGroupSummary(index);
    if ((await summary.getAttribute("aria-expanded")) !== "true") await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
  }

  /** The description of each rendered tool-call row, without the
   *  duration beside it. */
  toolCallLabels(): Locator {
    return this.toolCallContainers.getByTestId("tool-call__label");
  }

  /** How long the tool-call row whose description contains `text` took.
   *  Transparent until the row is hovered. */
  toolCallDuration(text: string): Locator {
    return this.toolCall(text).getByTestId("tool-call__duration");
  }

  async hoverToolCall(text: string): Promise<void> {
    await test.step(`Hover tool call "${text}"`, async () => {
      await this.toolCall(text).getByTestId("tool-call__label").hover();
    });
  }

  /** The rendered tool-call row whose description contains `text`. */
  toolCall(text: string): Locator {
    return this.toolCallContainers.filter({ hasText: text });
  }

  async expandToolCall(text: string): Promise<void> {
    const trigger = this.toolCall(text).getByRole("button").first();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
  }

  /** The `$ command` block of an expanded shell call. */
  toolCallCommand(text: string): Locator {
    return this.toolCall(text).getByTestId("tool-call__command");
  }

  /** The "Exit code N" line of an expanded shell call. */
  toolCallExitCode(text: string): Locator {
    return this.toolCall(text).getByTestId("tool-call__exit-code");
  }

  /** The output of an expanded shell call. */
  toolCallOutput(text: string): Locator {
    return this.toolCall(text).getByTestId("tool-call__output");
  }

  /** Hovers a message so its copy action and timestamp show. */
  async hoverMessage(message: Locator): Promise<void> {
    await message.hover();
  }

  /** A message's hover row (copy action and time sent). */
  messageActions(message: Locator): Locator {
    return message.getByTestId("message-actions");
  }

  messageTime(message: Locator): Locator {
    return message.getByTestId("message-actions__time");
  }

  async copyMessage(message: Locator): Promise<void> {
    await this.hoverMessage(message);
    await message.getByRole("button", { name: "Copy message" }).click();
  }

  /** Hovers a message's time and returns the tooltip with the exact time. */
  async openMessageTimeTooltip(message: Locator): Promise<Locator> {
    await this.hoverMessage(message);
    await this.messageTime(message).hover();
    return this.page.getByRole("tooltip");
  }

  /** The queued message with this text (test data). */
  queuedMessage(text: string): Locator {
    return this.queuedMessages.filter({ hasText: text });
  }

  /** The attachment chips inside a queued message. */
  queuedAttachments(message: Locator): Locator {
    return message.getByTestId("chat-pane__queued-attachment");
  }

  /** A queued message's hover row: edit and delete. */
  queuedActions(message: Locator): Locator {
    return message.getByTestId("chat-pane__queued-actions");
  }

  /** The text of every queued message, top to bottom. */
  async queuedMessageTexts(): Promise<string[]> {
    const texts = this.queuedMessages.getByTestId("chat-pane__queued-text");
    return (await texts.allInnerTexts()).map((t) => t.trim());
  }

  async deleteQueuedMessage(text: string): Promise<void> {
    await test.step(`Delete queued message "${text}"`, async () => {
      const message = this.queuedMessage(text);
      await message.hover();
      await message.getByRole("button", { name: "Delete queued message" }).click();
    });
  }

  /** Opens the inline editor of a queued message and replaces its text. */
  async editQueuedMessage(text: string, next: string): Promise<void> {
    await test.step(`Edit queued message "${text}" to "${next}"`, async () => {
      const message = this.queuedMessage(text);
      await message.hover();
      await message.getByRole("button", { name: "Edit queued message" }).click();
      await this.queuedEditor.getByRole("textbox", { name: "Edit queued message" }).fill(next);
    });
  }

  /** Presses a key in the open queued-message editor (Enter, Shift+Enter, Escape). */
  async pressInQueuedEditor(key: string): Promise<void> {
    await test.step(`Press ${key} in the queued-message editor`, async () => {
      await this.queuedEditor.getByRole("textbox", { name: "Edit queued message" }).press(key);
    });
  }

  /** Clicks the editor's send button (aria-label "Save", a constant in
   *  `QueuedMessages.tsx`). */
  async saveQueuedEdit(): Promise<void> {
    await test.step("Click Save in the queued-message editor", async () => {
      await this.queuedEditor.getByRole("button", { name: "Save", exact: true }).click();
    });
  }

  /** Clicks into the composer, moving focus out of the queued-message editor. */
  async clickOutsideQueuedEditor(): Promise<void> {
    await test.step("Click outside the queued-message editor", async () => {
      await this.promptInput.click();
    });
  }

  /** Drags a queued message's bubble onto another one. */
  async dragQueuedMessage(text: string, ontoText: string): Promise<void> {
    await test.step(`Drag queued message "${text}" onto "${ontoText}"`, async () => {
      await this.queuedMessage(text).getByTestId("chat-pane__queued-bubble").hover();
      await this.page.mouse.down();
      const target = await this.queuedMessage(ontoText).boundingBox();
      if (!target) throw new Error(`queued message "${ontoText}" has no box`);
      await this.page.mouse.move(target.x + target.width / 2, target.y + target.height / 4, {
        steps: 12,
      });
      await this.page.mouse.up();
    });
  }

  /** Answer the Nth permission card by clicking the option the agent
   *  offered. Option names come from the agent (test data), so the button's
   *  role name is the stable locator. */
  async answerPermission(index: number, optionName: string): Promise<void> {
    await test.step(`Answer permission #${index} with "${optionName}"`, async () => {
      await this.permissionCards
        .nth(index)
        .getByRole("button", { name: optionName, exact: true })
        .click();
    });
  }

  /** The Nth elicitation form's pager position ("2 of 3"). Absent on a
   *  form with a single question. */
  elicitationPager(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-step");
  }

  /** The pager's ‹ (previous question) button of the Nth elicitation form. */
  elicitationPrevButton(index: number): Locator {
    return this.elicitationForms
      .nth(index)
      .getByRole("button", { name: "Previous question", exact: true });
  }

  /** The pager's › (next question) button of the Nth elicitation form. */
  elicitationNextQuestionButton(index: number): Locator {
    return this.elicitationForms
      .nth(index)
      .getByRole("button", { name: "Next question", exact: true });
  }

  /** The X in the Nth elicitation form's header, which declines the form. */
  elicitationCloseButton(index: number): Locator {
    return this.elicitationForms
      .nth(index)
      .getByRole("button", { name: "Dismiss questions", exact: true });
  }

  /** The number badges of the Nth elicitation form's option rows. */
  elicitationChoiceNumbers(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-choice-number");
  }

  /** The dividers between the Nth elicitation form's option rows. */
  elicitationDividers(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-divider");
  }

  /** The Nth elicitation form's bottom row: the "Something else" box (when
   *  the question has one), Skip, and Next / Submit when needed. Carries
   *  `data-highlighted="true"` while the keyboard highlight is on it. */
  elicitationOtherRow(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-other");
  }

  /** The pencil badge at the start of the "Something else" row. */
  elicitationOtherIcon(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-other-icon");
  }

  /** The Nth elicitation form's free-text box ("Something else"). */
  elicitationNote(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-note");
  }

  /** A button in the Nth elicitation form's bottom row by its constant
   *  label, for asserting whether it is shown. */
  elicitationButton(index: number, name: "Next" | "Skip" | "Submit"): Locator {
    return this.elicitationOtherRow(index).getByRole("button", { name, exact: true });
  }

  /** The key hint under the Nth elicitation form, shown while it waits. */
  elicitationHint(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-hint");
  }

  /** The question the Nth elicitation form shows right now. */
  elicitationQuestion(index: number): Locator {
    return this.elicitationForms.nth(index).getByTestId("chat-pane__elicitation-question");
  }

  /** An option row of the Nth elicitation form, by its title (agent-supplied
   *  test data). A toggle button: `aria-pressed="true"` once picked, and
   *  `data-highlighted="true"` while the keyboard highlight is on it. */
  elicitationChoice(index: number, choiceTitle: string): Locator {
    return this.elicitationForms.nth(index).getByRole("button", { name: choiceTitle, exact: true });
  }

  /** Pick a choice in the Nth elicitation form by clicking its row. */
  async pickElicitationChoice(index: number, choiceTitle: string): Promise<void> {
    await test.step(`Pick "${choiceTitle}" in elicitation #${index}`, async () => {
      await this.elicitationChoice(index, choiceTitle).click();
    });
  }

  /** Type into the Nth elicitation form's free-text row. */
  async typeElicitationNote(index: number, text: string): Promise<void> {
    await test.step(`Type a note in elicitation #${index}`, async () => {
      await this.elicitationNote(index).fill(text);
    });
  }

  /** Press a key wherever focus is. The question card takes focus when it
   *  appears, so this is how its shortcuts (1-9, ↑↓, Enter, Esc) get exercised. */
  async pressKeyInPage(key: string): Promise<void> {
    await test.step(`Press "${key}"`, async () => {
      await this.page.keyboard.press(key);
    });
  }

  /** Click one of the Nth elicitation form's bottom-row buttons: "Next",
   *  "Skip" or "Submit" (constant labels in `elicitation-form.tsx`). */
  async clickElicitationButton(index: number, name: "Next" | "Skip" | "Submit"): Promise<void> {
    await test.step(`Click "${name}" in elicitation #${index}`, async () => {
      await this.elicitationButton(index, name).click();
    });
  }

  /** Go to the previous question of the Nth elicitation form (pager ‹). */
  async clickElicitationPrev(index: number): Promise<void> {
    await test.step(`Previous question in elicitation #${index}`, async () => {
      await this.elicitationPrevButton(index).click();
    });
  }

  /** Go to the next question of the Nth elicitation form (pager ›). */
  async clickElicitationNextQuestion(index: number): Promise<void> {
    await test.step(`Next question in elicitation #${index}`, async () => {
      await this.elicitationNextQuestionButton(index).click();
    });
  }

  /** Dismiss the Nth elicitation form with the X in its header. */
  async closeElicitation(index: number): Promise<void> {
    await test.step(`Dismiss elicitation #${index}`, async () => {
      await this.elicitationCloseButton(index).click();
    });
  }

  /** Open the model settings menu and choose another model from its
   *  "More models" submenu, by display name (the agent's `model` config
   *  option, i.e. test data). */
  async selectModel(modelName: string): Promise<void> {
    await test.step(`Select model "${modelName}"`, async () => {
      await this.openModelMenu();
      await this.openMoreModels();
      await this.clickMoreModel(modelName);
    });
  }

  /** A level in the open "Effort" submenu, by display name. */
  effortOption(name: string): Locator {
    return this.effortSubmenuContent.getByRole("menuitem", { name, exact: true });
  }

  /** Type a single key in the focused prompt textarea. The prompt
   *  must already be focused — call `focusPrompt()` first. Used by the
   *  mention/slash-dropdown tests where `fill()` would replace the whole
   *  value and lose the `@`/`/` trigger context. */
  async pressKey(key: string): Promise<void> {
    await test.step(`Press "${key}" in the prompt`, async () => {
      await this.promptInput.press(key);
    });
  }

  /** The command names in the slash dropdown, top to bottom, with their
   *  leading `/`. */
  async slashCommandNames(): Promise<string[]> {
    return this.slashCommandDropdown
      .getByTestId("slash-command-suggestions__name")
      .allTextContents()
      .then((names) => names.map((n) => n.trim()));
  }

  /** Open the execution mode menu. */
  async openModeMenu(): Promise<void> {
    await test.step("Open the execution mode menu", async () => {
      await this.modeMenuButton.click();
      await expect(this.modeMenuItems.first()).toBeVisible();
    });
  }

  /** The icons (`svg`) inside `locator`. */
  icons(locator: Locator): Locator {
    return locator.locator("svg");
  }

  /** Hover the context ring so its details popover opens. */
  async hoverContextMeter(): Promise<void> {
    await test.step("Hover the context window ring", async () => {
      await this.contextMeter.hover();
      await expect(this.contextMeterDetails).toBeVisible();
    });
  }

  /** Where the composer's parts sit. */
  async composerGeometry(): Promise<ComposerGeometry> {
    const box = async (locator: Locator): Promise<Box> => {
      const b = await locator.boundingBox();
      if (!b) throw new Error("composer part has no bounding box");
      return b;
    };
    return {
      body: await box(this.promptBody),
      prompt: await box(this.promptInput),
      submit: await box(this.submitButton),
      modeMenu: await box(this.modeMenuButton),
      modelMenu: await box(this.modelMenuButton),
      contextMeter: await box(this.contextMeter),
    };
  }

  /** Type text with Shift+Enter line breaks, as a user writing several
   *  lines would. */
  async typeLines(lines: string[]): Promise<void> {
    await test.step(`Type ${lines.length} lines into the prompt`, async () => {
      await this.promptInput.click();
      for (const [i, line] of lines.entries()) {
        if (i > 0) await this.promptInput.press("Shift+Enter");
        await this.promptInput.pressSequentially(line);
      }
    });
  }

  /** Press Cmd/Ctrl+F in the prompt to open the chat's find widget. */
  async openFind(): Promise<void> {
    await test.step("Open find in chat with Cmd/Ctrl+F", async () => {
      const prompt = this.promptInput.filter({ visible: true });
      await prompt.click();
      await prompt.press("ControlOrMeta+f");
      await expect(this.find.input).toBeFocused();
    });
  }

  /** Click `message` in the conversation, then press Cmd/Ctrl+F. */
  async openFindFromMessage(message: Locator): Promise<void> {
    await test.step("Click a message and press Cmd/Ctrl+F", async () => {
      await message.click();
      await this.page.keyboard.press("ControlOrMeta+f");
      await expect(this.find.input).toBeFocused();
    });
  }

  /** The highlights the chat find painted, read from `CSS.highlights`. */
  async findHighlights(): Promise<ChatFindHighlights> {
    const scroller = this.scroller.filter({ visible: true });
    return await scroller.evaluate((el) => {
      const all = CSS.highlights.get("chat-find");
      const current = CSS.highlights.get("chat-find-current");
      const range = current ? ([...current][0] as Range | undefined) : undefined;
      let currentInView = false;
      if (range) {
        const box = range.getBoundingClientRect();
        const view = el.getBoundingClientRect();
        currentInView = box.height > 0 && box.top >= view.top && box.bottom <= view.bottom;
      }
      return { total: all?.size ?? 0, current: range?.toString() ?? null, currentInView };
    });
  }

  /** Focus the prompt textarea so subsequent `pressKey()` calls land
   *  there. Click is used instead of `focus()` so the textarea also
   *  becomes the document's `activeElement` for keydown dispatch. */
  async focusPrompt(): Promise<void> {
    await test.step("Focus the prompt", async () => {
      await this.promptInput.click();
    });
  }

  /** Locate a `band-file:` anchor by its visible accessible name —
   *  the inline-code path the rendered link wraps (e.g. the
   *  pattern `src/main.rs:42`). Kept around for tests that need to
   *  assert visibility before clicking; prefer the action method
   *  `clickFileLinkAnchor()` for the click itself. */
  fileLinkAnchor(name: RegExp | string): Locator {
    return this.page.getByRole("link", { name });
  }

  /** Click a `band-file:` anchor in the rendered chat by its visible
   *  accessible name. Encapsulates the locate + click so the test
   *  body doesn't hold a raw locator variable. */
  async clickFileLinkAnchor(name: RegExp | string): Promise<void> {
    await test.step(`Click band-file link "${name}"`, async () => {
      await this.fileLinkAnchor(name).click();
    });
  }

  /** Install a window-event listener for `band:open-file` that
   *  captures the dispatched event details into a page-global
   *  array, runnable BEFORE any chat message renders.
   *  `addInitScript` is the right primitive — the script runs in
   *  the page on every navigation, before any other script. The
   *  captured array is read back via `capturedOpenFileEvents()`. */
  async installOpenFileCapture(): Promise<void> {
    await this.page.addInitScript(() => {
      const win = window as unknown as { __dispatchedOpenFile: unknown[] };
      win.__dispatchedOpenFile = [];
      window.addEventListener("band:open-file", (e) => {
        win.__dispatchedOpenFile.push((e as CustomEvent).detail);
      });
    });
  }

  /** Read the `band:open-file` event details captured by
   *  `installOpenFileCapture()`. Returns an empty array if the
   *  capture wasn't installed or no events fired. */
  async capturedOpenFileEvents(): Promise<unknown[]> {
    return await this.page.evaluate(
      () => (window as unknown as { __dispatchedOpenFile?: unknown[] }).__dispatchedOpenFile ?? [],
    );
  }

  /** Install a per-animation-frame sampler that records, from page load,
   *  whether the virtualized message list is visually shown and whether
   *  its mounted rows overlap on screen. Must run BEFORE `goto`
   *  (`addInitScript` runs before any page script on every navigation),
   *  so it captures the very first frames the list paints — exactly the
   *  window where the first-load flicker would otherwise be visible.
   *
   *  Each frame samples:
   *    - `visible`: the list's computed `visibility` is not `hidden`
   *      (the first-paint reveal gate sets `visibility:hidden` until the
   *      dynamic-height convergence settles).
   *    - `overlap`: any two mounted rows' bounding boxes overlap
   *      vertically by more than 1px — the on-screen symptom of rows
   *      laid out at a mix of estimated and measured offsets.
   *    - `bottomOffset`: how far the scroller is from the bottom, in px
   *      (`scrollHeight - clientHeight - scrollTop`, rounded). 0 means
   *      pinned to the latest message; a large value means the viewport
   *      jumped away from the bottom (the visible-scroll-thrash symptom).
   *    - `rowCount`: number of non-zero-height mounted rows.
   *
   *  The sampler is deliberately framework-agnostic — it only reads the
   *  `chat-pane__virtual-list` / `chat-pane__scroller` testids and
   *  `data-index` rows, all of which predate the reveal-gate fix — so the
   *  spec also fails on the pre-fix build (where the list is visible
   *  during the overlapping frames). */
  async installFirstPaintObserver(): Promise<void> {
    await this.page.addInitScript(() => {
      interface FlickerSample {
        visible: boolean;
        overlap: boolean;
        bottomOffset: number;
        rowCount: number;
      }
      const win = window as unknown as { __flickerSamples: FlickerSample[] };
      win.__flickerSamples = [];
      const MAX_SAMPLES = 1000;
      const sample = () => {
        // Stop the loop once the buffer is full — otherwise the rAF tail
        // call keeps walking the DOM every frame for the page's lifetime
        // without recording anything.
        if (win.__flickerSamples.length >= MAX_SAMPLES) return;
        const list = document.querySelector('[data-testid="chat-pane__virtual-list"]');
        if (list) {
          const visible = getComputedStyle(list).visibility !== "hidden";
          const rows = Array.from(list.querySelectorAll("[data-index]"))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, height: r.height };
            })
            .filter((r) => r.height > 0)
            .sort((a, b) => a.top - b.top);
          let overlap = false;
          for (let i = 1; i < rows.length; i++) {
            // >1px tolerance absorbs sub-pixel rounding; contiguous rows
            // satisfy rows[i].top === rows[i-1].bottom, so a genuine
            // overlap is the only thing that trips this.
            if (rows[i].top < rows[i - 1].bottom - 1) {
              overlap = true;
              break;
            }
          }
          const scroller = document.querySelector(
            '[data-testid="chat-pane__scroller"]',
          ) as HTMLElement | null;
          const bottomOffset = scroller
            ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
            : Number.POSITIVE_INFINITY;
          win.__flickerSamples.push({ visible, overlap, bottomOffset, rowCount: rows.length });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }

  /** Read the per-frame samples recorded by `installFirstPaintObserver()`.
   *  Returns an empty array if the observer wasn't installed. */
  async readFirstPaintSamples(): Promise<
    { visible: boolean; overlap: boolean; bottomOffset: number; rowCount: number }[]
  > {
    return await this.page.evaluate(
      () =>
        (
          window as unknown as {
            __flickerSamples?: {
              visible: boolean;
              overlap: boolean;
              bottomOffset: number;
              rowCount: number;
            }[];
          }
        ).__flickerSamples ?? [],
    );
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
