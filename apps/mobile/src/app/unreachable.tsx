import { Redirect, router } from "expo-router";
import { Body, Button, Centered, ErrorText, Title } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";

/** The active hub did not answer, or refused its token (like the desktop's `hub-unreachable.ts`). */
export default function Unreachable() {
  const { active, connection, recheck } = useHubs();
  if (!active) return <Redirect href="/connect" />;

  const retry = async () => {
    const c = await recheck();
    if (c.state === "connected") resetTo("/home");
  };

  return (
    <Centered>
      <Title testID="unreachable__title">Can't reach your hub</Title>
      <Body>
        Band is set to use {active.label} at {active.url}.
      </Body>
      {connection.state === "unreachable" ? (
        <ErrorText testID="unreachable__reason">{connection.reason}</ErrorText>
      ) : null}
      <Button
        label="Retry"
        busy={connection.state === "checking"}
        onPress={() => void retry()}
        testID="unreachable__retry"
      />
      <Button
        label="Switch hub"
        variant="secondary"
        onPress={() => router.push("/hubs")}
        testID="unreachable__switch"
      />
      <Button
        label="Edit hub"
        variant="secondary"
        onPress={() =>
          router.push({ pathname: "/manual", params: { url: active.url, replaces: active.id } })
        }
        testID="unreachable__edit"
      />
    </Centered>
  );
}
