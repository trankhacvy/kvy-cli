import { Paperclip } from "lucide-react";
import { formatBytes } from "@/lib/format";
import type { FileItem } from "@/sync/reducer";

export function FileAttachment({ item }: { item: FileItem }) {
  return (
    <div className="flex w-fit max-w-[85%] items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(item.size)}
          {item.image ? ` · ${item.image.w}×${item.image.h}` : ""}
        </p>
      </div>
    </div>
  );
}
