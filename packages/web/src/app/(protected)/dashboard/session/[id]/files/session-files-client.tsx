"use client";

import { SessionFilesScreen } from "@/features/repo-files";
import { useSessionIdFromPath } from "@/lib/use-session-id-from-path";

/** Reads the real session id from `window.location` — see `useSessionIdFromPath`'s doc
 * comment for why the sibling `page.tsx`'s `params` prop (and `next/navigation`'s
 * `useParams()`) can't be trusted under static export. */
export function SessionFilesClient() {
  const id = useSessionIdFromPath();
  if (!id) return null;
  return <SessionFilesScreen sessionId={id} />;
}
