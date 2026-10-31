import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { AlertCircle, Download, FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeMirrorViewer, getFilePreviewType } from "@/dashboard";
import { hubAssetUrl, hubFetch } from "../lib/hub-config";
import { sharedFileUrl } from "../lib/shared-file";
import { useDirectAssetUrl } from "../lib/use-direct-asset-url";
import { detectLanguageFromFilename, downloadFile } from "./ai-elements/file-preview-utils";
import { MessageResponse } from "./ai-elements/message";

type Loaded =
  | { state: "loading" }
  | { state: "error" }
  | { state: "binary" }
  | { state: "text"; text: string };

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function useSharedText(url: string, enabled: boolean): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoaded({ state: "loading" });
    hubFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        setLoaded(
          isBinary(bytes)
            ? { state: "binary" }
            : { state: "text", text: new TextDecoder().decode(bytes) },
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ state: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [url, enabled]);
  return loaded;
}

function LoadError({ name }: { name: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Could not load ${name}`}
          data-testid="shared-file__error"
          className="text-destructive"
        >
          <AlertCircle className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="text-sm">
        The file could not be loaded. It may be gone.
      </PopoverContent>
    </Popover>
  );
}

/** A file an agent shared, shown read-only in a center tab. */
export function SharedFileLeaf({ worktreeId, filePath }: { worktreeId: string; filePath: string }) {
  const url = sharedFileUrl(worktreeId, filePath);
  const name = filePath.split("/").pop() ?? filePath;
  const kind = getFilePreviewType(name);
  const isHtml = /\.html?$/i.test(name);
  const needsText = !!url && kind !== "image" && kind !== "pdf";
  const loaded = useSharedText(url ?? "", needsText);
  const hubAsset = url ? hubAssetUrl(url) : undefined;
  const assetUrl = useDirectAssetUrl(hubAsset);
  if (!url) return null;

  let body: React.ReactNode;
  if (kind === "image") {
    body = (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        <img
          src={assetUrl}
          alt={name}
          data-testid="shared-file__image"
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  } else if (kind === "pdf") {
    body = (
      <iframe
        src={assetUrl}
        title={name}
        data-testid="shared-file__pdf"
        className="size-full border-0"
      />
    );
  } else if (isHtml && loaded.state === "text") {
    // srcDoc, not src: the hub token rides in a cross-origin asset URL, and a
    // script-enabled frame can read its own location.
    body = (
      <iframe
        srcDoc={loaded.text}
        title={name}
        sandbox="allow-scripts"
        data-testid="shared-file__html"
        className="size-full border-0 bg-white" // theme-lint-ignore-line: an HTML page assumes a white page
      />
    );
  } else if (loaded.state === "loading") {
    body = <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  } else if (loaded.state === "error") {
    body = (
      <div className="flex h-full items-center justify-center">
        <LoadError name={name} />
      </div>
    );
  } else if (loaded.state === "binary") {
    body = (
      <div
        data-testid="shared-file__binary"
        className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"
      >
        <FileIcon className="size-8" />
        <p className="text-sm">No preview for this file type</p>
        <Button
          variant="outline"
          size="sm"
          data-testid="shared-file__binary-download"
          onClick={() => downloadFile(hubAsset ?? "", name)}
        >
          <Download className="size-4" />
          Download
        </Button>
      </div>
    );
  } else if (kind === "markdown") {
    body = (
      <div data-testid="shared-file__markdown" className="h-full overflow-auto p-4">
        <MessageResponse>{loaded.text}</MessageResponse>
      </div>
    );
  } else {
    body = (
      <div data-testid="shared-file__code" className="h-full">
        <CodeMirrorViewer
          content={loaded.text}
          language={detectLanguageFromFilename(name)}
          className="h-full"
        />
      </div>
    );
  }

  return (
    <div
      tabIndex={-1}
      data-band-leaf-root=""
      className="flex h-full w-full flex-col overflow-hidden outline-none"
      data-testid="shared-file"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{name}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Download file"
          data-testid="shared-file__download"
          onClick={() => downloadFile(hubAsset ?? "", name)}
        >
          <Download className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
