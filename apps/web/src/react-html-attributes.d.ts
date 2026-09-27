import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    /** Browser writing suggestions, such as the inline word predictions iOS
     *  shows in a text field. Not in @types/react yet. */
    writingsuggestions?: "true" | "false";
  }
}
