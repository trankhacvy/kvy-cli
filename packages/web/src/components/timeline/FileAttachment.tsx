"use client";

import { Download, Paperclip } from "lucide-react";
import { useState } from "react";
import { useSessionControl, useSessionCrypto } from "@/features/session-control";
import { downloadAttachment } from "@/lib/blobs";
import { formatBytes } from "@/lib/format";
import { getToken } from "@/lib/session";
import type { FileItem } from "@/sync/reducer";

type DownloadState = "idle" | "downloading" | "error";

/** `envelopeMapper.ts`'s inline-image ref prefix — a transcript image small enough (≤256KB)
 * to inline directly into the wire `file` event rather than go through the blob upload path. */
const INLINE_REF_PREFIX = "inline:";

export function isInlineFileRef(ref: string): boolean {
  return ref.startsWith(INLINE_REF_PREFIX);
}

/** `inline:` refs carry only base64 bytes, no media type — the CLI names the file
 * `image.<ext>` via `envelopeMapper.ts`'s `imageFileName()`, so this is that mapping's
 * inverse. Defaults to PNG for an unrecognized extension. */
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function inferImageMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPE_BY_EXTENSION[ext] ?? "image/png";
}

/**
 * Renders an inline (`ref: "inline:<base64>"`) image directly as an `<img>`
 * — no download/decrypt round trip, the bytes are already sitting plaintext
 * in the envelope. Deliberately hook-free (unlike `FileAttachment` below) so
 * it's unit-testable the same way `tool-cards/registry.test.ts` tests its
 * dispatch: call it directly and inspect the returned element, no DOM/render
 * environment needed.
 */
export function InlineImageAttachment({
  item,
  compact = false,
}: {
  item: FileItem;
  compact?: boolean;
}) {
  const base64 = item.ref.slice(INLINE_REF_PREFIX.length);
  const mimeType = inferImageMimeType(item.name);
  return (
    <img
      src={`data:${mimeType};base64,${base64}`}
      alt={item.name}
      className={
        compact
          ? "max-h-56 max-w-full rounded-md border border-border object-contain"
          : "max-h-80 max-w-full rounded-xl border border-border object-contain"
      }
    />
  );
}

/**
 * Renders a `file` transcript entry; on click, downloads and decrypts the blob.
 * `item.ref` is the blob-storage `blobId`; decryption reuses the session blob key from
 * `useSessionCrypto` (shared with the upload path). An `inline:` ref short-circuits to
 * `InlineImageAttachment` instead.
 */
export function FileAttachment({ item, compact = false }: { item: FileItem; compact?: boolean }) {
  const { sessionId } = useSessionControl();
  const cryptoBridge = useSessionCrypto(sessionId);
  const [state, setState] = useState<DownloadState>("idle");

  if (isInlineFileRef(item.ref)) {
    return <InlineImageAttachment item={item} compact={compact} />;
  }

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
      className={
        compact
          ? "flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
          : "flex w-fit max-w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
      }
    >
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(item.size)}
          {item.image ? ` · ${item.image.w}×${item.image.h}` : ""}
          {state === "downloading" && " · Downloading…"}
          {state === "error" && " · Download failed, try again"}
        </p>
      </div>
      <Download className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
