import type { ElicitationValues } from "@band-app/client/elicitation";
import * as Haptics from "expo-haptics";
import { useEffect } from "react";
import type { RequestEntry } from "../../lib/chat/pending-request";
import { ElicitationCard } from "./elicitation-card";
import { PermissionCard } from "./permission-card";

/**
 * The agent's open permission request or question, pinned above the composer so it cannot
 * scroll out of sight. A haptic tap marks its arrival; the user may not be looking at the phone.
 */
export function PendingRequest({
  entry,
  onAnswerPermission,
  onAnswerElicitation,
}: {
  entry: RequestEntry;
  onAnswerPermission: (requestId: string, optionId: string | null) => Promise<void>;
  onAnswerElicitation: (
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: ElicitationValues,
  ) => Promise<void>;
}) {
  const id = entry.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request id is the trigger
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [id]);

  return entry.kind === "permission" ? (
    <PermissionCard
      key={id}
      entry={entry}
      onAnswer={(optionId) => onAnswerPermission(id, optionId)}
    />
  ) : (
    <ElicitationCard
      key={id}
      entry={entry}
      onAnswer={(action, content) => onAnswerElicitation(id, action, content)}
    />
  );
}
