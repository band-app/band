import { Button, Textarea } from "@band-app/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCommentMessage,
  type CommentTarget,
  patchHtmlText,
  VISUAL_EDIT_MESSAGE,
  type VisualEditCommit,
} from "../lib/html-visual-edit";
import type { SendToChatDetail } from "../lib/selection-to-chat";

interface HtmlVisualEditorProps {
  worktreeId: string;
  filePath: string;
  /**
   * The text a committed range is checked against: the unsaved buffer when
   * there is one, else the file as it is on disk right now. Null when it
   * cannot be read.
   */
  getSource: () => Promise<string | null>;
  /** The file as it is on disk. The preview reloads whenever this changes. */
  diskContent: string;
  canEdit: boolean;
  /** Whether a click on text edits it. Comments work either way. */
  editing: boolean;
  getPreviewUrl: (worktreeId: string, path: string) => Promise<string>;
  /** Make `text` the file's content and save it through the normal save path. */
  onApply: (text: string) => Promise<void>;
}

interface PageMessage extends Partial<VisualEditCommit> {
  type?: string;
  nonce?: string;
  x?: number;
  y?: number;
  active?: boolean;
}

function newNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The page in a sandboxed iframe (scripts only, no same-origin, so it cannot
 * reach Band's cookies, token or storage). Clicking text
 * the hub annotated makes it editable inside the page, and the committed text
 * comes back as a message. This component patches the text range in the source
 * and saves it.
 */
export function HtmlVisualEditor({
  worktreeId,
  filePath,
  getSource,
  diskContent,
  canEdit,
  editing: editingRequested,
  getPreviewUrl,
  onApply,
}: HtmlVisualEditorProps) {
  const nonce = useMemo(newNonce, []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loadCount, setLoadCount] = useState(0);
  const [fetchTick, setFetchTick] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  // Text is editable when it is asked for, the file can be saved and the page was annotated.
  const editing = editingRequested && canEdit && !unavailable;
  const [notice, setNotice] = useState<string | null>(null);
  const getSourceRef = useRef(getSource);
  getSourceRef.current = getSource;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const scrollRef = useRef<{ x: number; y: number } | null>(null);
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  // The page reloads when the file changes on disk, which is also what a save
  // of an edit made here produces. A reload never interrupts an edit in
  // progress: it waits for the commit or the cancel, and the commit is then
  // checked against the new file.
  const pageEditingRef = useRef(false);
  const reloadPendingRef = useRef(false);
  const firstContentRef = useRef(true);
  // The file this editor just saved. The page already shows it, so the change
  // it causes on disk must not reload the page.
  const selfSavedRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: diskContent is the reload trigger
  useEffect(() => {
    if (firstContentRef.current) {
      firstContentRef.current = false;
      return;
    }
    if (selfSavedRef.current === diskContent) {
      selfSavedRef.current = null;
      return;
    }
    if (pageEditingRef.current) reloadPendingRef.current = true;
    else setFetchTick((n) => n + 1);
  }, [diskContent]);

  const flushPendingReload = useCallback(() => {
    pageEditingRef.current = false;
    if (reloadPendingRef.current) {
      reloadPendingRef.current = false;
      setFetchTick((n) => n + 1);
    }
  }, []);

  // A fresh signed URL on mount and on each reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchTick is the reload trigger
  useEffect(() => {
    let cancelled = false;
    getPreviewUrl(worktreeId, filePath)
      .then((url) => {
        if (cancelled) return;
        setUnavailable(false);
        setLoadCount((n) => n + 1);
        setBaseUrl(url);
      })
      .catch(() => {
        if (!cancelled) setNotice("The preview could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [getPreviewUrl, worktreeId, filePath, fetchTick]);

  const sendMode = useCallback(
    (withScroll: boolean) => {
      frameRef.current?.contentWindow?.postMessage(
        {
          type: VISUAL_EDIT_MESSAGE.mode,
          nonce,
          enabled: editingRef.current,
          scroll: withScroll ? scrollRef.current : undefined,
        },
        "*",
      );
    },
    [nonce],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: sendMode reads the mode from a ref
  useEffect(() => {
    sendMode(false);
  }, [editing, sendMode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const data = event.data as PageMessage | null;
      if (!data || typeof data !== "object" || data.nonce !== nonce) return;
      switch (data.type) {
        case VISUAL_EDIT_MESSAGE.ready:
          sendMode(true);
          return;
        case VISUAL_EDIT_MESSAGE.scroll:
          if (typeof data.x === "number" && typeof data.y === "number") {
            scrollRef.current = { x: data.x, y: data.y };
          }
          return;
        case VISUAL_EDIT_MESSAGE.editing:
          if (data.active === true) pageEditingRef.current = true;
          else flushPendingReload();
          return;
        case VISUAL_EDIT_MESSAGE.target: {
          const incoming = data as unknown as CommentTarget;
          if (incoming?.rect && incoming.context) {
            setTarget(incoming);
            setComment("");
          }
          return;
        }
        case VISUAL_EDIT_MESSAGE.unavailable:
          setUnavailable(true);
          setNotice("This file is too large to edit visually. Use the code view.");
          return;
        case VISUAL_EDIT_MESSAGE.commit: {
          flushPendingReload();
          if (!editingRef.current) return;
          if (
            typeof data.start !== "number" ||
            typeof data.end !== "number" ||
            typeof data.oldText !== "string" ||
            typeof data.newText !== "string"
          ) {
            return;
          }
          const commit: VisualEditCommit = {
            start: data.start,
            end: data.end,
            oldText: data.oldText,
            newText: data.newText,
          };
          void (async () => {
            try {
              const current = await getSourceRef.current();
              const result = current === null ? null : patchHtmlText(current, commit);
              if (!result?.ok) {
                setNotice("The file changed since the preview loaded. Nothing was saved.");
                setLoadCount((n) => n + 1);
                return;
              }
              setNotice(null);
              selfSavedRef.current = result.text;
              // Move the page's ranges along with the file, so the next edit lines up.
              frameRef.current?.contentWindow?.postMessage(
                {
                  type: VISUAL_EDIT_MESSAGE.applied,
                  nonce,
                  start: commit.start,
                  end: commit.end,
                  delta: result.delta,
                  text: result.shownText,
                },
                "*",
              );
              await onApplyRef.current(result.text);
            } catch {
              selfSavedRef.current = null;
              setNotice("The change could not be saved.");
              setLoadCount((n) => n + 1);
            }
          })();
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce, sendMode, flushPendingReload]);

  const closeComment = useCallback(() => {
    setTarget(null);
    setComment("");
    frameRef.current?.contentWindow?.postMessage(
      { type: VISUAL_EDIT_MESSAGE.clearTarget, nonce },
      "*",
    );
  }, [nonce]);

  const sendComment = useCallback(async () => {
    if (!target || !comment.trim() || sending) return;
    setSending(true);
    try {
      const text = buildCommentMessage(
        filePath,
        await getSourceRef.current().catch(() => null),
        target,
        comment,
      );
      const ok = await new Promise<boolean>((resolve) => {
        window.dispatchEvent(
          new CustomEvent<SendToChatDetail>("band:send-to-chat", {
            detail: { worktreeId, text, done: resolve },
          }),
        );
      });
      setNotice(ok ? "Sent to the agent." : "The comment could not be sent.");
      if (ok) closeComment();
    } finally {
      setSending(false);
    }
  }, [target, comment, sending, filePath, worktreeId, closeComment]);

  const src = baseUrl ? `${baseUrl}?band-edit=${nonce}&r=${loadCount}` : undefined;

  return (
    <div data-testid="html-visual" className="flex h-full flex-col">
      {notice && (
        <div className="shrink-0 border-b px-2 py-1 text-xs">
          <output data-testid="html-visual__notice" className="text-muted-foreground">
            {notice}
          </output>
        </div>
      )}
      <div ref={stageRef} className="relative min-h-0 flex-1">
        {target && (
          <div
            data-testid="html-visual__comment"
            className="absolute z-10 flex w-80 flex-col gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
            style={{
              top: Math.max(4, target.rect.y + target.rect.h + 8),
              left: Math.max(
                4,
                Math.min(target.rect.x, (stageRef.current?.clientWidth ?? 800) - 330),
              ),
            }}
          >
            <Textarea
              // biome-ignore lint/a11y/noAutofocus: the popover opens on the user's selection to take a comment
              autoFocus
              data-testid="html-visual__comment-input"
              aria-label="Comment for the agent"
              placeholder="What should change here?"
              value={comment}
              rows={3}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeComment();
                else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendComment();
              }}
              className="resize-none text-sm"
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="html-visual__comment-cancel"
                onClick={closeComment}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                data-testid="html-visual__comment-send"
                disabled={!comment.trim() || sending}
                onClick={() => void sendComment()}
              >
                Send to agent
              </Button>
            </div>
          </div>
        )}
        {src && (
          <iframe
            key={src}
            ref={frameRef}
            src={src}
            sandbox="allow-scripts"
            title={`Visual preview of ${filePath}`}
            data-testid="html-visual__frame"
            className="size-full border-0"
            style={{ colorScheme: "light" }}
          />
        )}
      </div>
    </div>
  );
}
