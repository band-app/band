import { type CenterTabs, centerTabsKey, parseCenterTabs } from "@band-app/client/center-tabs";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useHubSession } from "../hub-session";
import { pickActiveChat } from "./active-chat";

/** How long to wait for the worktree's shared tabs before opening the first chat anyway. */
const TABS_TIMEOUT_MS = 1500;

function readTabs(raw: string | null): CenterTabs | null {
  if (!raw) return null;
  try {
    return parseCenterTabs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The chat the worktree screen shows: the tab the desktop has active, read from the shared
 * center tabs once they are loaded, else the first chat. `chatId` is null while that is being
 * worked out and when the worktree has no chat.
 */
export function useActiveChat(worktreeId: string) {
  const { client, clientState } = useHubSession();
  const chats = useQuery({
    queryKey: ["chats.list", worktreeId],
    queryFn: async () => (await client.chats.list.query({ worktreeId })).chats,
  });

  const [tabs, setTabs] = useState<CenterTabs | null | undefined>(undefined);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTabs(readTabs(clientState.getItem(centerTabsKey(worktreeId))));
    };
    const timer = setTimeout(finish, TABS_TIMEOUT_MS);
    void clientState.hydrate(worktreeId).then(finish);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [clientState, worktreeId]);

  const ready = chats.data !== undefined && tabs !== undefined;
  return {
    chatId: ready ? pickActiveChat(chats.data, tabs) : null,
    loading: !ready && !chats.isError,
    error: chats.isError,
  };
}
