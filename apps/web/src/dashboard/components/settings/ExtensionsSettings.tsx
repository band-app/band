import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@band-app/ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCcw, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import {
  BUILTIN_EDITOR,
  EXTENSIONS_QUERY_KEY,
  type ExtensionList,
  editorRef,
  setDefaultForGlob,
  useExtensionDefaults,
  useExtensions,
} from "../../../lib/extensions";
import { hubFetch } from "../../../lib/hub-config";
import { trpc } from "../../../lib/trpc-client";
import { useIsAdmin } from "./DevicesSettings";
import { SettingsRow } from "./SettingsRow";

const MANIFEST_DEFAULT = "__manifest_default__";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** An error as an icon that opens a popover with the text. */
function ErrorIcon({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testid}
          className="shrink-0 rounded-sm text-destructive"
        >
          <CircleAlert className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 break-words text-xs">
        <span data-testid={`${testid}-text`}>{children}</span>
      </PopoverContent>
    </Popover>
  );
}

/** Every distinct selector glob the installed extensions handle. */
function selectorsOf(list: ExtensionList | null): string[] {
  const seen = new Set<string>();
  for (const extension of list?.extensions ?? []) {
    for (const editor of extension.contributes.fileEditors) {
      for (const selector of editor.selector) seen.add(selector);
    }
  }
  return [...seen];
}

/** What a glob opens in when no default is stored: the manifest's default editor, else the built-in viewer. */
function manifestDefaultLabel(list: ExtensionList | null, glob: string): string {
  for (const extension of list?.extensions ?? []) {
    for (const editor of extension.contributes.fileEditors) {
      if (editor.default && editor.selector.includes(glob)) return editor.label;
    }
  }
  return "Built-in viewer";
}

/**
 * Settings > Extensions: the editor extensions installed on the hub, install by URL or upload,
 * remove, reload, and the default editor for each file type. Everything but the list and the
 * defaults is admin only.
 */
export function ExtensionsSettings() {
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const { list, loading } = useExtensions();
  const defaults = useExtensionDefaults();
  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [busy, setBusy] = useState<"url" | "upload" | "reload" | "remove" | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  // A list request still in flight when a change finishes carries the list from before it. Invalidating
  // alone would reuse that request (a query with no data yet is not refetched over a pending fetch),
  // so cancel it first and fetch again.
  const refresh = async () => {
    await queryClient.cancelQueries({ queryKey: EXTENSIONS_QUERY_KEY });
    await queryClient.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
  };

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    setInstallError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setInstallError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const installUrl = () =>
    run("url", async () => {
      await trpc.extensions.install.mutate({
        url: url.trim(),
        sha256: sha256.trim() || undefined,
      });
      setUrl("");
      setSha256("");
    });

  const upload = (file: File) =>
    run("upload", async () => {
      const query = sha256.trim() ? `?sha256=${encodeURIComponent(sha256.trim())}` : "";
      const res = await hubFetch(`/api/extensions/install${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: file,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The upload failed (${res.status})`);
      }
      setSha256("");
    });

  const reload = () =>
    run("reload", async () => {
      await trpc.extensions.reload.mutate();
    });

  const confirmRemove = () => {
    const target = removing;
    if (!target) return;
    setRemoving(null);
    void run("remove", async () => {
      await trpc.extensions.remove.mutate({ id: target.id });
    });
  };

  const extensions = list?.extensions ?? [];
  const errors = list?.errors ?? [];
  const selectors = [...new Set([...selectorsOf(list), ...Object.keys(defaults)])];

  return (
    <>
      {isAdmin ? (
        <>
          <SettingsRow
            variant="stacked"
            label="Install an extension"
            description="From a .tar.gz archive at an https URL, or uploaded from this device. The SHA-256 is optional for a URL that has a .sha256 file next to it."
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                aria-label="Extension archive URL"
                data-testid="settings-extensions__url"
                placeholder="https://example.com/editor-1.0.tar.gz"
                value={url}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
                className="h-8 w-full text-sm sm:flex-1"
              />
              <Input
                aria-label="SHA-256 (optional)"
                data-testid="settings-extensions__sha256"
                placeholder="SHA-256 (optional)"
                value={sha256}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSha256(e.target.value)}
                className="h-8 w-full text-sm sm:w-56"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                data-testid="settings-extensions__install"
                disabled={busy !== null || url.trim() === ""}
                onClick={installUrl}
              >
                {busy === "url" ? "Installing…" : "Install from URL"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="settings-extensions__upload"
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="size-3.5" aria-hidden="true" />
                {busy === "upload" ? "Uploading…" : "Upload archive"}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".gz,.tgz,application/gzip"
                className="hidden"
                data-testid="settings-extensions__file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) upload(file);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                data-testid="settings-extensions__reload"
                disabled={busy !== null}
                onClick={reload}
              >
                <RefreshCcw className="size-3.5" aria-hidden="true" />
                Reload
              </Button>
              {installError ? (
                <ErrorIcon
                  label="The extension could not be installed"
                  testid="settings-extensions__install-error"
                >
                  {installError}
                </ErrorIcon>
              ) : null}
            </div>
          </SettingsRow>
        </>
      ) : null}

      {extensions.map((extension) => (
        <SettingsRow
          key={extension.id}
          variant="stacked"
          label={
            <span data-testid={`settings-extensions__row--${extension.id}`}>
              <span data-testid={`settings-extensions__name--${extension.id}`}>
                {extension.name}
              </span>{" "}
              <span className="font-normal text-muted-foreground">
                {extension.id} · v
                <span data-testid={`settings-extensions__version--${extension.id}`}>
                  {extension.version}
                </span>
              </span>
            </span>
          }
          description={
            <span data-testid={`settings-extensions__editors--${extension.id}`}>
              {extension.contributes.fileEditors
                .map((editor) => `${editor.label} (${editor.selector.join(", ")})`)
                .join("; ")}
            </span>
          }
        >
          {isAdmin ? (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Remove ${extension.name}`}
              data-testid={`settings-extensions__remove--${extension.id}`}
              disabled={busy !== null}
              onClick={() => setRemoving({ id: extension.id, name: extension.name })}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              Remove
            </Button>
          ) : null}
        </SettingsRow>
      ))}

      {errors.map((entry) => (
        <SettingsRow
          key={entry.folder}
          variant="inline"
          label={
            <span data-testid={`settings-extensions__broken--${entry.folder}`}>{entry.folder}</span>
          }
          description="This folder did not load."
        >
          <ErrorIcon
            label={`${entry.folder} failed to load`}
            testid={`settings-extensions__load-error--${entry.folder}`}
          >
            {`${entry.folder}: ${entry.error}`}
          </ErrorIcon>
        </SettingsRow>
      ))}

      {!loading && extensions.length === 0 && errors.length === 0 ? (
        <SettingsRow
          variant="stacked"
          label="No extensions installed"
          description={
            isAdmin
              ? "Install one from a URL or an archive above, or copy a folder into the extensions folder and press Reload."
              : "An admin can install editor extensions."
          }
        />
      ) : null}

      {selectors.map((glob) => {
        const stored = defaults[glob];
        const options = extensions.flatMap((extension) =>
          extension.contributes.fileEditors
            .filter((editor) => editor.selector.includes(glob))
            .map((editor) => ({
              ref: editorRef(extension.id, editor.id),
              label: editor.label,
            })),
        );
        const value = stored ?? MANIFEST_DEFAULT;
        const current =
          stored === undefined
            ? `Manifest default (${manifestDefaultLabel(list, glob)})`
            : stored === BUILTIN_EDITOR
              ? "Built-in viewer"
              : (options.find((o) => o.ref === stored)?.label ?? stored);
        return (
          <SettingsRow key={glob} variant="responsive" label={`Default editor for ${glob}`}>
            {isAdmin ? (
              <Select
                value={value}
                onValueChange={(next) =>
                  setDefaultForGlob(glob, next === MANIFEST_DEFAULT ? null : next)
                }
              >
                <SelectTrigger
                  aria-label={`Default editor for ${glob}`}
                  data-testid={`settings-extensions__default--${glob}`}
                  data-default={stored ?? "manifest"}
                  className="h-8 w-full text-sm sm:w-64"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value={MANIFEST_DEFAULT}
                    data-testid={`settings-extensions__default-option--${glob}--manifest`}
                  >
                    Manifest default ({manifestDefaultLabel(list, glob)})
                  </SelectItem>
                  <SelectItem
                    value={BUILTIN_EDITOR}
                    data-testid={`settings-extensions__default-option--${glob}--builtin`}
                  >
                    Built-in viewer
                  </SelectItem>
                  {stored !== undefined &&
                  stored !== BUILTIN_EDITOR &&
                  !options.some((o) => o.ref === stored) ? (
                    <SelectItem value={stored} disabled>
                      {stored}
                    </SelectItem>
                  ) : null}
                  {options.map((option) => (
                    <SelectItem
                      key={option.ref}
                      value={option.ref}
                      data-testid={`settings-extensions__default-option--${glob}--${option.ref}`}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span
                className="text-sm"
                data-testid={`settings-extensions__default-value--${glob}`}
                data-default={stored ?? "manifest"}
              >
                {current}
              </span>
            )}
          </SettingsRow>
        );
      })}

      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent data-testid="settings-extensions__remove-dialog">
          <DialogTitle>Remove {removing?.name}?</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Its files open in the built-in viewer again. The extension's folder is deleted from the
            hub.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="settings-extensions__remove-confirm"
              onClick={confirmRemove}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
