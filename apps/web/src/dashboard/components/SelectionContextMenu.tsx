import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@band-app/ui";
import { EditorView } from "@codemirror/view";
import type { Terminal } from "@xterm/xterm";
import {
  ClipboardPaste,
  Copy,
  Link2,
  MessageSquare,
  Scissors,
  SquareTerminal,
  TextSelect,
} from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { readClipboardText, writeClipboardText } from "../../lib/clipboard";
import { formatShortcut, isMacPlatform } from "../lib/command-registry";
import {
  addSelectionToChat,
  addSelectionToTerminal,
  copySelectionReference,
  readSelectionReference,
  type SelectionToChatDetail,
} from "../lib/selection-to-chat";

/**
 * Right-click menus for text selections: CodeMirror (file editor, file viewer,
 * both sides of a diff) and the terminal. They replace the floating selection
 * tooltip. Both share the `selection-menu` test ids so one page object drives
 * either.
 */

function MenuAction({
  testId,
  icon: Icon,
  label,
  shortcut,
  onSelect,
}: {
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <ContextMenuItem onClick={onSelect} data-testid={`selection-menu__${testId}`}>
      <Icon className="size-4" />
      {label}
      {shortcut && (
        <ContextMenuShortcut data-testid={`selection-menu__${testId}-shortcut`}>
          {formatShortcut(shortcut)}
        </ContextMenuShortcut>
      )}
    </ContextMenuItem>
  );
}

/**
 * Keep a right-click from moving the caret: CodeMirror ignores non-left
 * buttons, but the browser's own mousedown would collapse the selection on
 * Windows and Linux before the menu reads it.
 */
function keepSelectionOnRightClick(e: React.MouseEvent) {
  if (e.button === 2) e.preventDefault();
}

/** What the code menu acts on, captured when it opens. */
interface CodeMenuTarget {
  view: EditorView;
  /** Null when the view has no selection or no file behind it. */
  reference: SelectionToChatDetail | null;
  selectedText: string;
  editable: boolean;
}

function selectedTextOf(view: EditorView): string {
  return view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join(view.state.lineBreak);
}

/**
 * Wrap the element that hosts one or more CodeMirror views (a `MergeView`
 * hosts two). On right-click the menu finds the view under the pointer, so the
 * reference uses that side's line numbers. The views must carry
 * `selectionReferenceExtension` for the file actions to appear.
 */
export function CodeSelectionContextMenu({ children }: { children: React.ReactElement }) {
  const [target, setTarget] = useState<CodeMenuTarget | null>(null);
  // The element under the pointer. The menu opens on `contextmenu` (mouse) or
  // after a touch long-press (Radix's timer, no `contextmenu`), so the target
  // is resolved when it opens, from whichever of the two events came last.
  const pointerTargetRef = useRef<Element | null>(null);

  const viewAt = (el: EventTarget | null) => {
    const editorDom = el instanceof Element ? el.closest<HTMLElement>(".cm-editor") : null;
    return editorDom ? EditorView.findFromDOM(editorDom) : null;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    pointerTargetRef.current = e.target as Element;
    // Padding outside any editor: nothing to act on, and no browser menu.
    if (!viewAt(e.target)) e.preventDefault();
  };

  const onOpenChange = (open: boolean) => {
    // Keep the last target while closing so the items don't vanish mid-fade.
    if (!open) return;
    const view = viewAt(pointerTargetRef.current);
    setTarget(
      view && {
        view,
        reference: readSelectionReference(view),
        selectedText: selectedTextOf(view),
        editable: view.state.facet(EditorView.editable) && !view.state.readOnly,
      },
    );
  };

  const view = target?.view;
  const reference = target?.reference;
  const hasSelection = !!target?.selectedText;

  const cut = () => {
    if (!view || !target) return;
    void writeClipboardText(target.selectedText);
    view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
    view.focus();
  };
  const copy = () => {
    if (!view || !target) return;
    void writeClipboardText(target.selectedText);
    view.focus();
  };
  const paste = () => {
    if (!view) return;
    void readClipboardText().then((text) => {
      if (!text) return;
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      view.focus();
    });
  };
  const selectAll = () => {
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  };

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger
        asChild
        onContextMenu={onContextMenu}
        onPointerDown={(e) => {
          pointerTargetRef.current = e.target as Element;
        }}
        onMouseDownCapture={keepSelectionOnRightClick}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="selection-menu"
        // Each action focuses what it acts on (the editor, or the chat or
        // terminal it hands the reference to); restoring focus to the wrapper
        // would undo that.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {reference && (
          <>
            <MenuAction
              testId="add-to-chat"
              icon={MessageSquare}
              label="Add to Chat"
              onSelect={() => addSelectionToChat(reference)}
            />
            <MenuAction
              testId="add-to-terminal"
              icon={SquareTerminal}
              label="Add to Terminal"
              onSelect={() => addSelectionToTerminal(reference)}
            />
            <MenuAction
              testId="copy-reference"
              icon={Link2}
              label="Copy reference"
              onSelect={() => void copySelectionReference(reference)}
            />
            <ContextMenuSeparator />
          </>
        )}
        {hasSelection && target?.editable && (
          <MenuAction testId="cut" icon={Scissors} label="Cut" shortcut="Cmd+X" onSelect={cut} />
        )}
        {hasSelection && (
          <MenuAction testId="copy" icon={Copy} label="Copy" shortcut="Cmd+C" onSelect={copy} />
        )}
        {target?.editable && (
          <MenuAction
            testId="paste"
            icon={ClipboardPaste}
            label="Paste"
            shortcut="Cmd+V"
            onSelect={paste}
          />
        )}
        {(hasSelection || target?.editable) && <ContextMenuSeparator />}
        {view && (
          <MenuAction
            testId="select-all"
            icon={TextSelect}
            label="Select All"
            shortcut="Cmd+A"
            onSelect={selectAll}
          />
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Right-click menu for a terminal. A terminal selection has no file behind it,
 * so "Add to Chat" sends the selected text itself, and there is no reference to
 * copy or type into a terminal.
 */
export function TerminalSelectionContextMenu({
  getTerminal,
  disabled = false,
  children,
}: {
  getTerminal: () => Terminal | null;
  /** Off on touch screens, where a long-press starts the terminal's own
   *  selection mode and its keyboard toolbar has Copy and Paste. */
  disabled?: boolean;
  children: React.ReactElement;
}) {
  const [selectedText, setSelectedText] = useState("");
  // ⌘C / ⌘V are the terminal's copy and paste only on macOS. Elsewhere Ctrl+C
  // and Ctrl+V go to the shell, so there is no shortcut to show.
  const mac = isMacPlatform();

  // xterm's own contextmenu listener runs first (it sits deeper in the DOM), so
  // on macOS a right-click outside the selection has already selected the word
  // under the pointer by the time this reads it.
  const onContextMenu = () => setSelectedText(getTerminal()?.getSelection() ?? "");

  const withTerminal = (fn: (term: Terminal) => void) => () => {
    const term = getTerminal();
    if (term) fn(term);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled} onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="selection-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        {selectedText && (
          <>
            <MenuAction
              testId="add-to-chat"
              icon={MessageSquare}
              label="Add to Chat"
              onSelect={() => addSelectionToChat({ text: selectedText })}
            />
            <ContextMenuSeparator />
            <MenuAction
              testId="copy"
              icon={Copy}
              label="Copy"
              shortcut={mac ? "Cmd+C" : undefined}
              onSelect={withTerminal((term) => {
                void writeClipboardText(selectedText);
                term.focus();
              })}
            />
          </>
        )}
        <MenuAction
          testId="paste"
          icon={ClipboardPaste}
          label="Paste"
          shortcut={mac ? "Cmd+V" : undefined}
          onSelect={withTerminal((term) => {
            void readClipboardText().then((text) => {
              // `paste` wraps the text in bracketed-paste markers when the
              // running program asked for them, like a real ⌘V.
              if (text) term.paste(text);
              term.focus();
            });
          })}
        />
        <ContextMenuSeparator />
        <MenuAction
          testId="select-all"
          icon={TextSelect}
          label="Select All"
          onSelect={withTerminal((term) => term.selectAll())}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
