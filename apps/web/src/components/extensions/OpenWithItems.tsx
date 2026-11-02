import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@band-app/ui";
import { AppWindow } from "lucide-react";
import {
  BUILTIN_EDITOR,
  defaultGlobFor,
  getFileEditorChoice,
  openWithOptions,
  resolveEditor,
  setDefaultEditor,
  setFileEditorChoice,
  useExtensionDefaults,
  useExtensions,
} from "../../lib/extensions";

/**
 * "Open With…" for the Explorer and tab context menus: the editors whose selector matches the file,
 * then the built-in viewer. Renders nothing for a file no editor claims. `onOpen` runs after a
 * choice is stored, so the Explorer can open the file and an open tab simply switches editor.
 */
export function OpenWithItems({
  worktreeId,
  filePath,
  testidPrefix,
  onOpen,
}: {
  worktreeId: string;
  filePath: string;
  testidPrefix: string;
  onOpen?: () => void;
}) {
  const { list } = useExtensions();
  const defaults = useExtensionDefaults();
  const options = openWithOptions(list, filePath);
  if (options.length === 0) return null;
  const glob = defaultGlobFor(filePath);
  const current = resolveEditor(
    list,
    filePath,
    getFileEditorChoice(worktreeId, filePath),
    defaults,
  );
  const currentRef = current ? `${current.extensionId}/${current.editor.id}` : BUILTIN_EDITOR;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid={`${testidPrefix}__open-with`}>
        <AppWindow className="size-4" />
        Open With…
      </ContextMenuSubTrigger>
      <ContextMenuSubContent data-testid={`${testidPrefix}__open-with-menu`}>
        {options.map((option) => (
          <ContextMenuItem
            key={option.ref}
            data-testid={`${testidPrefix}__open-with--${option.ref}`}
            onSelect={() => {
              setFileEditorChoice(worktreeId, filePath, option.ref);
              onOpen?.();
            }}
          >
            {option.label}
            {option.ref === currentRef ? " (current)" : ""}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        {options.map((option) => (
          <ContextMenuItem
            key={`default-${option.ref}`}
            data-testid={`${testidPrefix}__set-default--${option.ref}`}
            onSelect={() => {
              setDefaultEditor(filePath, option.ref);
              setFileEditorChoice(worktreeId, filePath, null);
              onOpen?.();
            }}
          >
            Set {option.label} as default for {glob}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
