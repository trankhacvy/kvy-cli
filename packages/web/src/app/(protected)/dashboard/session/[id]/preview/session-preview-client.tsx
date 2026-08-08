"use client";

import { SessionPreviewScreen } from "@/features/preview";
import { useSessionIdFromPath } from "@/lib/use-session-id-from-path";

/** Reads the real session id from `window.location` — see `useSessionIdFromPath`'s doc
 * comment for why the sibling `page.tsx`'s `params` prop (and `next/navigation`'s
 * `useParams()`) can't be trusted under static export. */
export function SessionPreviewClient() {
  const id = useSessionIdFromPath();
  if (!id) return null;
  return <SessionPreviewScreen sessionId={id} />;
}
