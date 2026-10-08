export const CHAT_ID_HEADER = "x-band-chat-id";
export const WORKTREE_ID_HEADER = "x-band-worktree-id";

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) || undefined;
  }
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first || undefined;
}

/**
 * The caller's context. A call from an agent names the chat and worktree
 * it runs in (headers `x-band-chat-id` and `x-band-worktree-id`, from the
 * agent's `BAND_CHAT_ID` and `BAND_WORKTREE_ID`), so procedures like
 * `subscriptions.create` can default to them. Calls from the UI carry neither.
 *
 * `admin` says whether the token that authenticated the call is an admin
 * device token (or auth is off, in dev). The MCP endpoint never sets it.
 * `tokenId` is that token's id, so the UI can tell which device it is.
 */
export function createContext(opts?: {
  req?: { headers: HeaderBag };
  admin?: boolean;
  tokenId?: string;
}) {
  return {
    chatId: readHeader(opts?.req?.headers, CHAT_ID_HEADER),
    worktreeId: readHeader(opts?.req?.headers, WORKTREE_ID_HEADER),
    admin: opts?.admin === true,
    tokenId: opts?.tokenId,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
