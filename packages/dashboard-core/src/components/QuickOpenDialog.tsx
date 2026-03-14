import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@band/ui";
import { File } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdapter } from "../context";

interface QuickOpenDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
}

export function QuickOpenDialog({
  workspaceId,
  open,
  onOpenChange,
  onOpenFile,
}: QuickOpenDialogProps) {
  const adapter = useAdapter();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || !adapter.searchWorkspaceFiles) return;

    let cancelled = false;
    setLoading(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const delay = query ? 150 : 0;
    debounceRef.current = setTimeout(() => {
      adapter.searchWorkspaceFiles!(workspaceId, query, 50)
        .then((result) => {
          if (!cancelled) setFiles(result.files);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, delay);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [adapter, workspaceId, query, open]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery("");
      setFiles([]);
    }
  }, [open]);

  const handleSelect = useCallback(
    (filePath: string) => {
      onOpenFile(filePath);
      onOpenChange(false);
    },
    [onOpenFile, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="sr-only">
          <DialogTitle>Quick Open</DialogTitle>
          <DialogDescription>Search for files by name</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search files by name..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>{loading ? "Searching..." : "No files found."}</CommandEmpty>
            <CommandGroup>
              {files.map((file) => {
                const fileName = file.split("/").pop() || file;
                return (
                  <CommandItem key={file} value={file} onSelect={() => handleSelect(file)}>
                    <File className="size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 text-sm font-medium">{fileName}</span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{file}</span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
