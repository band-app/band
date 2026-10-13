/** Saved browser tabs of a worktree, read and cleared through the real hub's tRPC surface. */

interface SavedBrowserTab {
  id: string;
  url?: string;
}

export async function listBrowserTabs(
  serverUrl: string,
  token: string,
  worktreeId: string,
): Promise<SavedBrowserTab[]> {
  const input = encodeURIComponent(JSON.stringify({ worktreeId }));
  const res = await fetch(`${serverUrl}/trpc/browsers.list?input=${input}`, {
    headers: { Cookie: `band_token=${token}` },
  });
  const body = (await res.json()) as { result: { data: { browsers: SavedBrowserTab[] } } };
  return body.result.data.browsers;
}

/** Delete every saved browser tab of the worktree, so tests sharing a server start with none. */
export async function removeBrowserTabs(
  serverUrl: string,
  token: string,
  worktreeId: string,
): Promise<void> {
  for (const { id } of await listBrowserTabs(serverUrl, token, worktreeId)) {
    await fetch(`${serverUrl}/trpc/browsers.remove`, {
      method: "POST",
      headers: { Cookie: `band_token=${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ browserId: id }),
    });
  }
}
