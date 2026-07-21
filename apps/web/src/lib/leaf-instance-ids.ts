// ---------------------------------------------------------------------------
// Leaf instance id generators + "freshly created" trackers.
//
// Shared by the unified center dockview (`WorkspaceCenterDockview`) and the
// legacy per-app inner dockviews still used by the mobile layout
// (`DockviewChatContainer` / `DockviewTerminalContainer` /
// `DockviewBrowserContainer`). Extracted here so both worlds mint ids the
// same way and so `ChatPane` / `BrowserPanel` can consume the fresh-flag
// without importing from a specific container.
//
// - chat ids are prefixed `chat_`, browser ids `browser_`, terminal ids are
//   bare uuids (matches the server's `randomUUID()` fallback — see
//   `apps/web/src/server/api/terminals/router.ts`). Don't change the shapes:
//   they are the dockview panel ids AND the server-side record ids.
// - "fresh" trackers let an add-tab action tell the freshly-mounted renderer
//   to skip loading server-side session/history and start blank.
// ---------------------------------------------------------------------------

/** crypto.randomUUID() with a fallback for insecure (non-HTTPS) contexts. */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newChatId(): string {
  return `chat_${uuid()}`;
}

export function newTerminalId(): string {
  return uuid();
}

export function newBrowserId(): string {
  return `browser_${uuid()}`;
}

// ---------------------------------------------------------------------------
// Fresh-id trackers
// ---------------------------------------------------------------------------

const freshChatIds = new Set<string>();

/** Mark a chatId as freshly created (by add-tab) so `ChatPane` starts blank. */
export function markChatFresh(chatId: string): void {
  freshChatIds.add(chatId);
}

/** Check (and consume) whether a chatId is fresh. */
export function consumeChatFresh(chatId: string): boolean {
  return freshChatIds.delete(chatId);
}

const freshBrowserIds = new Set<string>();

/** Mark a browserId as freshly created (by add-tab) so the pane skips server fetch. */
export function markBrowserFresh(browserId: string): void {
  freshBrowserIds.add(browserId);
}

/** Check (and consume) whether a browserId is fresh. */
export function consumeBrowserFresh(browserId: string): boolean {
  return freshBrowserIds.delete(browserId);
}
