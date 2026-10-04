export const CHAT_ID_HEADER = "x-band-chat-id";
export const WORKSPACE_ID_HEADER = "x-band-workspace-id";

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
 * The caller's context. A call from an agent names the chat and workspace
 * it runs in (headers `x-band-chat-id` and `x-band-workspace-id`, from the
 * agent's `BAND_CHAT_ID` and `BAND_WORKSPACE_ID`), so procedures like
 * `subscriptions.create` can default to them. Calls from the UI carry neither.
 *
 * `admin` says whether the token that authenticated the call is an admin
 * device token (or auth is off, in dev). The MCP endpoint never sets it.
 */
export function createContext(opts?: { req?: { headers: HeaderBag }; admin?: boolean }) {
  return {
    chatId: readHeader(opts?.req?.headers, CHAT_ID_HEADER),
    workspaceId: readHeader(opts?.req?.headers, WORKSPACE_ID_HEADER),
    admin: opts?.admin === true,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
