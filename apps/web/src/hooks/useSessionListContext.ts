import { createContext, useContext } from "react";

export interface SessionListContextValue {
  showSessionList: boolean;
  setShowSessionList: (show: boolean) => void;
}

export const SessionListContext = createContext<SessionListContextValue>({
  showSessionList: false,
  setShowSessionList: () => {},
});

export function useSessionListContext() {
  return useContext(SessionListContext);
}
