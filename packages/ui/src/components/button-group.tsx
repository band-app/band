import * as React from "react";

import { cn } from "../utils";
import { Separator } from "./separator";

function ButtonGroup({ className, children, ...props }: React.ComponentProps<"div">) {
  const childArray = React.Children.toArray(children);

  return (
    <div
      data-slot="button-group"
      className={cn(
        "inline-flex items-center rounded-md border shadow-xs",
        "[&_[data-slot=button]]:rounded-none [&_[data-slot=button]]:border-0 [&_[data-slot=button]]:shadow-none",
        "first:[&_[data-slot=button]]:rounded-l-md last:[&_[data-slot=button]]:rounded-r-md",
        className,
      )}
      {...props}
    >
      {childArray.map((child, index) => {
        const key = React.isValidElement(child) ? child.key : index;
        return (
          <React.Fragment key={key}>
            {child}
            {index < childArray.length - 1 && (
              <Separator orientation="vertical" className="h-full" />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export { ButtonGroup };
