import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { patchHtmlText, VISUAL_EDIT_MESSAGE, type VisualEditCommit } from "../lib/html-visual-edit";

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
  getPreviewUrl,
  onApply,
}: HtmlVisualEditorProps) {
  const nonce = useMemo(newNonce, []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [loadCount, setLoadCount] = useState(0);
  const [fetchTick, setFetchTick] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  // Text is editable whenever the file can be saved and the page was annotated.
  const editing = canEdit && !unavailable;
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
      <div className="min-h-0 flex-1">
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
