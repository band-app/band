import { useCallback, useState } from "react";
import { Alert } from "react-native";

/** Applies session options one at a time and counts the changes in flight. */
export function useConfigChoice(
  setConfigOption: (configId: string, value: string) => Promise<void>,
) {
  const [pending, setPending] = useState(0);
  const choose = useCallback(
    (configId: string, value: string) => {
      setPending((n) => n + 1);
      setConfigOption(configId, value)
        .catch((err) =>
          Alert.alert(
            "Couldn't change the session",
            err instanceof Error ? err.message : "Try again.",
          ),
        )
        .finally(() => setPending((n) => n - 1));
    },
    [setConfigOption],
  );
  return { choose, pending: pending > 0 };
}
