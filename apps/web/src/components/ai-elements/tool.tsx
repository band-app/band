import { cn } from "@band-app/ui";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <pre className="overflow-auto p-3 text-xs">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: unknown;
  errorText: string | undefined;
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let renderedOutput = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    renderedOutput = (
      <pre className="overflow-auto p-3 text-xs">
        <code>{JSON.stringify(output, null, 2)}</code>
      </pre>
    );
  } else if (typeof output === "string") {
    renderedOutput = (
      <pre className="overflow-auto p-3 text-xs">
        <code>{output}</code>
      </pre>
    );
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div className="p-3">{errorText}</div>}
        {renderedOutput}
      </div>
    </div>
  );
};
