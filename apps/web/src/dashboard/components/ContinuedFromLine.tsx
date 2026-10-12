import { type ContinuedFrom, formatAge } from "@band-app/shared/continuation";
import { useHostNames } from "../hooks/use-host-names";

/** "Continued from <host> · auto · checkpoint 4 min old": the record a continuation leaves on the new copy. */
export function continuedFromText(from: ContinuedFrom, hostName: string): string {
  return `Continued from ${hostName} · ${from.reason} · checkpoint ${formatAge(from.at - from.checkpointAt)} old`;
}

export function ContinuedFromLine({
  from,
  testId,
  className,
}: {
  from: ContinuedFrom;
  testId: string;
  className?: string;
}) {
  const hostName = useHostNames();
  return (
    <span
      data-testid={testId}
      data-reason={from.reason}
      data-from-host={from.fromHostId}
      className={className}
    >
      {continuedFromText(from, hostName(from.fromHostId))}
    </span>
  );
}
