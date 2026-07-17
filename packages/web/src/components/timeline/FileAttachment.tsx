"use client";

import { Download, Paperclip } from "lucide-react";
import { useState } from "react";
import { useSessionControl, useSessionCrypto } from "@/features/session-control";
import { downloadAttachment } from "@/lib/blobs";
import { formatBytes } from "@/lib/format";
import { getToken } from "@/lib/session";
import type { FileItem } from "@/sync/reducer";

type DownloadState = "idle" | "downloading" | "error";

/**
 * Renders a `file` transcript entry and, on click, downloads + decrypts the
 * attachment (the read half of the encrypted attachment path, plan.md §16
 * "4.3 Distribution & self-host" — `Composer`'s attach button is the write
 * half). `item.ref` is the blob-storage `blobId`; decryption reuses the
 * same session blob key `Composer`'s upload path encrypted under
 * (`useSessionCrypto`, one instance per session shared with the rest of
 * this screen).
 */
export function FileAttachment({ item }: { item: FileItem }) {
  const { sessionId } = useSessionControl();
  const cryptoBridge = useSessionCrypto(sessionId);
  const [state, setState] = useState<DownloadState>("idle");

  async function handleDownload() {
    const token = getToken();
    if (!cryptoBridge || !token || state === "downloading") return;
    setState("downloading");
    try {
      const bytes = await downloadAttachment(token, cryptoBridge, item.ref);
      if (!bytes) {
        setState("error");
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      const link = document.createElement("a");
      link.href = url;
      link.download = item.name;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={state === "downloading"}
      className="flex w-fit max-w-[85%] items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
    >
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(item.size)}
          {item.image ? ` · ${item.image.w}×${item.image.h}` : ""}
          {state === "downloading" && " · Downloading…"}
          {state === "error" && " · Download failed — try again"}
        </p>
      </div>
      <Download className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
