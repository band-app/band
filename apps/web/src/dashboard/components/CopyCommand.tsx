import { Button } from "@band-app/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";

interface Props {
  command: string;
  /** Prefix of the test ids: `<testId>-command` for the text and `<testId>-copy` for the button. */
  testId: string;
  label: string;
}

/** A command to run by hand, with a button that copies it. */
export function CopyCommand({ command, testId, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (await writeClipboardText(command)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="flex items-start gap-2">
      <code
        data-testid={`${testId}-command`}
        className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs"
      >
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        data-testid={`${testId}-copy`}
        onClick={() => void copy()}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </div>
  );
}
