import type * as React from "react";

import { cn } from "../utils";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";

interface InputGroupProps extends React.ComponentProps<"div"> {
  children: React.ReactNode;
}

function InputGroup({ className, children, ...props }: InputGroupProps) {
  return (
    <div data-slot="input-group" className={cn("flex items-center", className)} {...props}>
      {children}
    </div>
  );
}

interface InputGroupInputProps extends React.ComponentProps<typeof Input> {}

function InputGroupInput({ className, ...props }: InputGroupInputProps) {
  return (
    <Input
      className={cn(
        "rounded-none first:rounded-l-md last:rounded-r-md",
        "focus-visible:z-10",
        "[&:not(:first-child)]:border-l-0",
        className,
      )}
      {...props}
    />
  );
}

interface InputGroupTextareaProps extends React.ComponentProps<typeof Textarea> {}

function InputGroupTextarea({ className, ...props }: InputGroupTextareaProps) {
  return (
    <Textarea
      className={cn(
        "rounded-none first:rounded-l-md last:rounded-r-md",
        "focus-visible:z-10",
        "[&:not(:first-child)]:border-l-0",
        className,
      )}
      {...props}
    />
  );
}

interface InputGroupButtonProps extends React.ComponentProps<typeof Button> {}

function InputGroupButton({ className, ...props }: InputGroupButtonProps) {
  return (
    <Button
      className={cn(
        "rounded-none first:rounded-l-md last:rounded-r-md",
        "[&:not(:first-child)]:border-l-0",
        className,
      )}
      {...props}
    />
  );
}

interface InputGroupTextProps extends React.ComponentProps<"span"> {}

function InputGroupText({ className, ...props }: InputGroupTextProps) {
  return (
    <span
      data-slot="input-group-text"
      className={cn(
        "flex h-7 items-center border border-input bg-muted px-2 text-xs text-muted-foreground",
        "first:rounded-l-md last:rounded-r-md",
        "[&:not(:first-child)]:border-l-0",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupInput, InputGroupTextarea, InputGroupButton, InputGroupText };
