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
 *      ai-elements).
 *   3. `getByText(value)` — used for assertions on values the TEST itself
 *      supplied (the user-message text we just typed).
 */

import { type Locator, type Page, test } from "@playwright/test";

export class ChatPanePage {
  /** The prompt textarea — placeholder is stable, hard-coded in
   *  `ChatView.tsx` and not user-localised. */
  readonly promptInput: Locator;
  /** The "Thinking…" indicator that surfaces while a task is in flight.
   *  Targeted by `data-testid` so the test doesn't depend on the user-
   *  visible copy. */
  readonly thinkingIndicator: Locator;
  /** The Clock icon that opens the session-history dropdown. */
  readonly sessionHistoryButton: Locator;
  /** "New session" item inside the session-history dropdown. */
  readonly newSessionMenuItem: Locator;
  /** Stop / cancel button — only present while the current task is in
   *  the streaming phase (post-`text-start`, pre-`task-completed`). */
  readonly stopButton: Locator;
  /** All tool-call container rows in the conversation (one per
   *  `tool-input-available` event). Each carries a `data-status`
   *  attribute mirroring the StatusDot branch
   *  (`in-progress` / `complete` / `error`) — tests assert against
   *  that rather than the underlying Tailwind classes. */
  readonly toolCallContainers: Locator;
  /** Status dots inside each tool-call row. Same `data-status` shape
   *  as `toolCallContainers`; both surfaces are pinned in the issue
   *  #509 regression spec so a future change that updates one and
   *  forgets the other still trips the test. */
  readonly toolCallStatusDots: Locator;
  /** The `@`-mention file dropdown — opens when the user types `@` in
   *  the prompt. ARIA name is system-controlled in
   *  `file-mention-suggestions.tsx`. */
  readonly fileMentionDropdown: Locator;

  constructor(
    private readonly page: Page,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    this.promptInput = page.getByPlaceholder("Type a message...");
    this.thinkingIndicator = page.getByTestId("chat-pane__thinking-indicator");
    // System-controlled aria-label set in `ChatView.tsx::SessionHistoryMenu` —
    // doctrine-preferred locator (role + name).
    this.sessionHistoryButton = page.getByRole("button", { name: "Session history" });
    this.newSessionMenuItem = page.getByRole("menuitem", { name: /New session/ });
    this.stopButton = page.getByTestId("prompt-input__stop-button");
    this.toolCallContainers = page.getByTestId("tool-call__container");
    this.toolCallStatusDots = page.getByTestId("tool-call__status-dot");
    this.fileMentionDropdown = page.getByRole("listbox", { name: "File mentions" });
  }

  /** Navigate to the workspace's chat view. The only place URLs are
   *  constructed in this page object. */
  async goto(workspaceId: string): Promise<void> {
    const url = `${this.baseUrl}/workspace/${encodeURIComponent(workspaceId)}?token=${this.token}`;
    await test.step(`Navigate to workspace ${workspaceId}`, async () => {
      await this.page.goto(url);
    });
  }

  /** Wait for the chat pane to be interactive (prompt textarea
   *  visible). */
  async waitForReady(): Promise<void> {
    await this.promptInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  /** Type into the prompt textarea. Doesn't submit. */
  async typeMessage(text: string): Promise<void> {
    await test.step(`Type "${text}" into the prompt`, async () => {
      await this.promptInput.fill(text);
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

  /** Locator for a user-role message bubble carrying the given text.
   *  Asserts use this directly with `await expect(locator).toBeVisible()`. */
  userMessage(text: string): Locator {
    // The conversation's `MessageContent` renders user text inside a
    // `MessageResponse` element. We anchor on the text the test seeded
    // — explicitly allowed by the doctrine for runtime-test-data. */
    return this.page.getByText(text, { exact: false });
  }

  /** Click the Stop button to cancel the in-flight task. The button is
   *  only rendered while `status === "streaming"`. */
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

  /** Type a single key in the focused prompt textarea. The prompt
   *  must already be focused — call `focusPrompt()` first. Used by the
   *  mention/slash-dropdown tests where `fill()` would replace the whole
   *  value and lose the `@`/`/` trigger context. */
  async pressKey(key: string): Promise<void> {
    await test.step(`Press "${key}" in the prompt`, async () => {
      await this.promptInput.press(key);
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
}
