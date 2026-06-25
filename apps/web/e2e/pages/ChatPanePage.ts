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
    this.thinkingIndicator = page.getByTestId("chat-pane__thinking-indicator");
    // System-controlled aria-label set in `ChatView.tsx::SessionHistoryMenu` —
    // doctrine-preferred locator (role + name).
    this.sessionHistoryButton = page.getByRole("button", { name: "Session history" });
    this.newSessionMenuItem = page.getByRole("menuitem", { name: /New session/ });
    this.stopButton = page.getByTestId("prompt-input__stop-button");
    this.toolCallContainers = page.getByTestId("tool-call__container");
    this.toolCallStatusDots = page.getByTestId("tool-call__status-dot");
    this.fileMentionDropdown = page.getByRole("listbox", { name: "File mentions" });
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
