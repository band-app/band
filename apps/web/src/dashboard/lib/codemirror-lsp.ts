import {
  jumpToDefinition,
  LSPClient,
  LSPPlugin,
  languageServerExtensions,
  type Transport,
  Workspace,
  type WorkspaceFile,
} from "@codemirror/lsp-client";
import type { ChangeSet, Extension, Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// ---------------------------------------------------------------------------
// LSP language ID mapping (CodeMirror language name -> LSP languageId)
// ---------------------------------------------------------------------------
const LSP_LANGUAGE_IDS: Record<string, string> = {
  typescript: "typescript",
  tsx: "typescriptreact",
  javascript: "javascript",
  jsx: "javascriptreact",
};

/**
 * Languages that have an LSP server configured on the backend.
 * Used to determine whether to create an LSP extension for a file.
 */
export const LSP_SUPPORTED_LANGUAGES = new Set(Object.keys(LSP_LANGUAGE_IDS));

/**
 * Map a CodeMirror language name to the backend `lang` parameter
 * used in the WebSocket URL (e.g., tsx -> typescript).
 */
export function toLspServerLang(cmLanguage: string): string | null {
  switch (cmLanguage) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
      return "typescript";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-file navigation support
// ---------------------------------------------------------------------------

/**
 * Pending cross-file navigation. When the LSP client needs to display
 * a file other than the current one (e.g., go-to-definition), this
 * stores the resolve callback so the new EditorView can be provided
 * once the navigation completes and the editor mounts.
 */
let pendingNavigation: {
  resolve: (view: EditorView | null) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/**
 * Called by the code browser when a new EditorView is mounted after
 * an LSP-triggered cross-file navigation. Resolves the pending
 * displayFile() promise so the library can position the cursor.
 */
export function resolveNavigation(view: EditorView): void {
  if (pendingNavigation) {
    clearTimeout(pendingNavigation.timer);
    pendingNavigation.resolve(view);
    pendingNavigation = null;
  }
}

/**
 * Returns true if there is a pending LSP navigation waiting for
 * an EditorView to resolve.
 */
export function hasPendingNavigation(): boolean {
  return pendingNavigation !== null;
}

// ---------------------------------------------------------------------------
// Custom Workspace — extends DefaultWorkspace with cross-file navigation
// ---------------------------------------------------------------------------

interface InternalWorkspaceFile extends WorkspaceFile {
  uri: string;
  languageId: string;
  version: number;
  doc: Text;
  view: EditorView;
  getView(): EditorView | null;
}

class BandWorkspaceFile implements InternalWorkspaceFile {
  constructor(
    public uri: string,
    public languageId: string,
    public version: number,
    public doc: Text,
    public view: EditorView,
  ) {}

  getView(): EditorView | null {
    return this.view;
  }
}

/**
 * Custom Workspace that supports cross-file navigation by dispatching
 * a CustomEvent when displayFile() is called for an unknown URI.
 */
class BandWorkspace extends Workspace {
  files: BandWorkspaceFile[] = [];
  private fileVersions: Record<string, number> = Object.create(null);
  private rootUri: string;
  private workspaceId: string | undefined;

  constructor(client: LSPClient, rootUri: string, workspaceId?: string) {
    super(client);
    this.rootUri = rootUri;
    this.workspaceId = workspaceId;
  }

  private nextFileVersion(uri: string): number {
    const next = (this.fileVersions[uri] ?? -1) + 1;
    this.fileVersions[uri] = next;
    return next;
  }

  syncFiles(): readonly { file: WorkspaceFile; prevDoc: Text; changes: ChangeSet }[] {
    const result: { file: WorkspaceFile; prevDoc: Text; changes: ChangeSet }[] = [];
    for (const file of this.files) {
      const view = file.getView();
      if (!view) continue;
      const plugin = LSPPlugin.get(view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        result.push({ changes, file, prevDoc: file.doc });
        file.doc = view.state.doc;
        file.version = this.nextFileVersion(file.uri);
        plugin.clear();
      }
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    // If the file is already tracked, update the view reference
    const existing = this.files.find((f) => f.uri === uri);
    if (existing) {
      existing.view = view;
      return;
    }
    const file = new BandWorkspaceFile(
      uri,
      languageId,
      this.nextFileVersion(uri),
      view.state.doc,
      view,
    );
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string): void {
    const file = this.getFile(uri);
    if (file) {
      this.files = this.files.filter((f) => f !== file);
      this.client.didClose(uri);
    }
  }

  displayFile(uri: string): Promise<EditorView | null> {
    // Check if the file is already open
    const file = this.getFile(uri);
    if (file) {
      const view = file.getView();
      if (view) return Promise.resolve(view);
    }

    // Cross-file navigation: dispatch event and wait for the new view
    const filePath = this.uriToWorkspacePath(uri);

    return new Promise<EditorView | null>((resolve) => {
      // Cancel any previous pending navigation
      if (pendingNavigation) {
        clearTimeout(pendingNavigation.timer);
        pendingNavigation.resolve(null);
      }

      // Set up timeout
      const timer = setTimeout(() => {
        if (pendingNavigation) {
          pendingNavigation = null;
          resolve(null);
        }
      }, 5000);

      pendingNavigation = { resolve, timer };

      // Dispatch navigation event to CodeBrowserView.
      //
      // Scope the event to the owning workspace. Multiple workspace subtrees
      // stay mounted at once (MultiWorkspacePanelHost keeps up to
      // `maxCachedWorkspaces` alive, hidden with visibility:hidden), and each
      // one's CodeBrowserView listens for `band:lsp-navigate` on `window`.
      // Without a workspace label, a go-to-definition in the active workspace
      // A would also open the (A-relative) file in hidden workspaces B/C,
      // whose FileViewer then stats it against B/C's own worktree root →
      // ENOENT, and poisons B/C's `band-open-tabs:` localStorage. The listener
      // filters on this id; a missing id falls through to the active
      // workspace (forward-compat). Same shape as `band:open-file`, see
      // issue #539.
      window.dispatchEvent(
        new CustomEvent("band:lsp-navigate", {
          detail: { filePath, workspaceId: this.workspaceId },
        }),
      );
    });
  }

  private uriToWorkspacePath(uri: string): string {
    const root = this.rootUri.endsWith("/") ? this.rootUri : `${this.rootUri}/`;
    if (uri.startsWith(root)) {
      return uri.slice(root.length);
    }
    // Fallback: strip file:// prefix and try to make relative
    const absPath = uri.replace(/^file:\/\//, "");
    const rootPath = root.replace(/^file:\/\//, "");
    if (absPath.startsWith(rootPath)) {
      return absPath.slice(rootPath.length);
    }
    return absPath;
  }
}

// ---------------------------------------------------------------------------
// WebSocket Transport
// ---------------------------------------------------------------------------

/** Transport with an explicit close method so we can shut down the WebSocket. */
interface CloseableTransport extends Transport {
  close(): void;
}

function createWebSocketTransport(url: string): Promise<CloseableTransport> {
  return new Promise<CloseableTransport>((resolve, reject) => {
    const ws = new WebSocket(url);
    let handlers: ((value: string) => void)[] = [];

    ws.onopen = () => {
      resolve({
        send(message: string) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        },
        subscribe(handler: (value: string) => void) {
          handlers.push(handler);
        },
        unsubscribe(handler: (value: string) => void) {
          handlers = handlers.filter((h) => h !== handler);
        },
        close() {
          ws.close();
        },
      });
    };

    ws.onmessage = (e) => {
      const data = typeof e.data === "string" ? e.data : e.data.toString();
      for (const h of handlers) h(data);
    };

    ws.onerror = () => {
      reject(new Error(`WebSocket connection failed: ${url}`));
    };

    ws.onclose = () => {
      // Clear handlers on close
      handlers = [];
    };
  });
}

// ---------------------------------------------------------------------------
// LSP Client cache (one client per WebSocket URL = per workspace+language)
// ---------------------------------------------------------------------------

interface CachedClient {
  client: LSPClient;
  transport: CloseableTransport;
  refCount: number;
}

const clientCache = new Map<string, CachedClient>();

/**
 * Get or create an LSP client for the given WebSocket URL.
 * The client is cached per URL (effectively per workspace+language).
 *
 * `workspaceId` is only consumed on the CREATE path — it's baked into the
 * `BandWorkspace` at construction. On a cache hit it's intentionally ignored:
 * `wsUrl` is built from the workspaceId (`buildLspWsUrl`), so the cache key
 * already partitions clients by workspace and a hit is guaranteed to carry the
 * same workspaceId the caller passed. (If that URL↔workspace coupling ever
 * changes, this assumption must be revisited.)
 */
async function getOrCreateClient(
  wsUrl: string,
  rootUri: string,
  workspaceId?: string,
): Promise<LSPClient> {
  const cached = clientCache.get(wsUrl);
  if (cached) {
    cached.refCount++;
    return cached.client;
  }

  const client = new LSPClient({
    rootUri,
    workspace: (c) => new BandWorkspace(c, rootUri, workspaceId),
    extensions: languageServerExtensions(),
    timeout: 10000,
  });

  const transport = await createWebSocketTransport(wsUrl);
  client.connect(transport);

  clientCache.set(wsUrl, { client, transport, refCount: 1 });
  return client;
}

/**
 * Release a reference to an LSP client. When the last reference
 * is released, sends LSP shutdown/exit, disconnects the client,
 * and closes the WebSocket.
 */
export function releaseLspClient(wsUrl: string): void {
  const cached = clientCache.get(wsUrl);
  if (!cached) return;
  cached.refCount--;
  if (cached.refCount <= 0) {
    // Send LSP shutdown request followed by exit notification.
    // This tells the language server to cleanly terminate.
    cached.client
      .request("shutdown", null)
      .then(() => {
        cached.transport.send(JSON.stringify({ jsonrpc: "2.0", method: "exit", params: null }));
      })
      .catch(() => {
        // Server may already be gone — that's fine
      })
      .finally(() => {
        cached.client.disconnect();
        cached.transport.close();
      });
    clientCache.delete(wsUrl);
  }
}

// ---------------------------------------------------------------------------
// Cmd+hover link underline (visual affordance for Cmd+Click go-to-definition)
// ---------------------------------------------------------------------------

/** Returns the word boundaries around `pos`, or null if not on a word. */
function wordRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const { doc } = view.state;
  if (pos < 0 || pos > doc.length) return null;
  const line = doc.lineAt(pos);
  const text = line.text;
  const col = pos - line.from;
  // Walk backward/forward to find word chars (letters, digits, underscore, $)
  const wordRe = /[\w$]/;
  if (col >= text.length || !wordRe.test(text[col])) return null;
  let from = col;
  let to = col;
  while (from > 0 && wordRe.test(text[from - 1])) from--;
  while (to < text.length - 1 && wordRe.test(text[to + 1])) to++;
  return { from: line.from + from, to: line.from + to + 1 };
}

const linkMark = Decoration.mark({ class: "cm-lsp-cmd-link" });

const cmdClickLinkTheme = EditorView.baseTheme({
  ".cm-lsp-cmd-link": {
    textDecoration: "underline",
    color: "var(--cm-lsp-link-color, #3b82f6)",
    cursor: "pointer",
  },
});

/**
 * ViewPlugin that underlines the word under the mouse when Cmd/Ctrl is held,
 * giving a visual hint that Cmd+Click will jump to definition.
 */
const cmdClickLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private modDown = false;
    private mouseX = -1;
    private mouseY = -1;

    constructor(readonly view: EditorView) {
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onKeyUp = this.onKeyUp.bind(this);
      this.onMouseMove = this.onMouseMove.bind(this);
      this.onBlur = this.onBlur.bind(this);

      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
      view.dom.addEventListener("mousemove", this.onMouseMove);
      window.addEventListener("blur", this.onBlur);
    }

    update(_update: ViewUpdate) {
      // Recompute decoration if doc changes while mod is held
      if (_update.docChanged && this.modDown) {
        this.recompute();
      }
    }

    destroy() {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      this.view.dom.removeEventListener("mousemove", this.onMouseMove);
      window.removeEventListener("blur", this.onBlur);
    }

    private onKeyDown(e: KeyboardEvent) {
      if (e.key === "Meta" || e.key === "Control") {
        this.modDown = true;
        this.recompute();
      }
    }

    private onKeyUp(e: KeyboardEvent) {
      if (e.key === "Meta" || e.key === "Control") {
        this.modDown = false;
        this.decorations = Decoration.none;
      }
    }

    private onMouseMove(e: MouseEvent) {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (this.modDown) {
        this.recompute();
      }
    }

    private onBlur() {
      this.modDown = false;
      this.decorations = Decoration.none;
    }

    private recompute() {
      if (!this.modDown || this.mouseX < 0) {
        this.decorations = Decoration.none;
        return;
      }
      const pos = this.view.posAtCoords({ x: this.mouseX, y: this.mouseY });
      if (pos == null) {
        this.decorations = Decoration.none;
        return;
      }
      const range = wordRangeAt(this.view, pos);
      if (!range) {
        this.decorations = Decoration.none;
        return;
      }
      this.decorations = Decoration.set([linkMark.range(range.from, range.to)]);
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a CodeMirror extension that connects the editor to an LSP server.
 * Returns a promise that resolves to the Extension once the WebSocket is
 * connected and the LSP client is ready.
 *
 * @param wsUrl - WebSocket URL (e.g., `ws://localhost:3000/lsp?workspaceId=X&lang=typescript`)
 * @param rootUri - Workspace root as file URI (e.g., `file:///path/to/workspace`)
 * @param documentUri - Current file as file URI (e.g., `file:///path/to/workspace/src/index.ts`)
 * @param languageId - LSP language ID (e.g., `typescript`, `typescriptreact`)
 * @param workspaceId - Owning workspace id, stamped onto `band:lsp-navigate`
 *   events so hidden sibling workspaces ignore this workspace's
 *   cross-file navigations (see issue #539 pattern).
 */
export async function createLspExtension(
  wsUrl: string,
  rootUri: string,
  documentUri: string,
  languageId?: string,
  workspaceId?: string,
): Promise<Extension> {
  const client = await getOrCreateClient(wsUrl, rootUri, workspaceId);
  return [
    client.plugin(documentUri, languageId),
    // Cmd+Click (Mac) / Ctrl+Click (other) to jump to definition — the
    // library only binds F12 by default.
    EditorView.domEventHandlers({
      click(event: MouseEvent, view: EditorView) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        // Place cursor at click position first
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        view.dispatch({ selection: { anchor: pos } });
        return jumpToDefinition(view);
      },
    }),
    // Underline the word under the mouse when Cmd/Ctrl is held
    cmdClickLinkPlugin,
    cmdClickLinkTheme,
  ];
}

/**
 * Build the WebSocket URL for connecting to the LSP proxy.
 */
export function buildLspWsUrl(workspaceId: string, lang: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/lsp?workspaceId=${encodeURIComponent(workspaceId)}&lang=${encodeURIComponent(lang)}`;
}

/**
 * Build a file URI from a workspace root path and a workspace-relative file path.
 */
export function toFileUri(workspacePath: string, relativePath?: string): string {
  const root = `file://${workspacePath}`;
  if (!relativePath) return root;
  return `${root}/${relativePath}`;
}

/**
 * Get the LSP language ID for a CodeMirror language name.
 */
export function getLspLanguageId(cmLanguage: string): string | undefined {
  return LSP_LANGUAGE_IDS[cmLanguage];
}
