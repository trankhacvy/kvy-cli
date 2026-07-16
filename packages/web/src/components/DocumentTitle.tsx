"use client";

import { useSyncExternalStore } from "react";
import { getTitleSnapshot, subscribeToTitle } from "@/lib/document-title-store";

/**
 * The app's single `<title>` element (falcon-prd.md FR-7.9). Rendered once,
 * near the root, instead of via `app/layout.tsx`'s static `metadata` export
 * — that's the reason this exists at all: Next's metadata-driven `<title>`
 * and a second, independently-rendered `<title>` (e.g. one mutated
 * imperatively, or rendered deeper in the tree by a per-screen hook) both
 * land in `<head>`, and per the HTML spec `document.title` always reflects
 * the *first* `<title>` in tree order — so a competing static title
 * silently wins over a dynamic one every time, no matter how the dynamic
 * one is produced. Keeping exactly one `<title>` fiber for the whole app,
 * driven by `document-title-store`'s external store, sidesteps that
 * entirely: `useTabAttention` pushes/pops an override into the store
 * instead of touching the DOM or rendering a competing element.
 */
export function DocumentTitle() {
  const title = useSyncExternalStore(subscribeToTitle, getTitleSnapshot, getTitleSnapshot);
  return <title>{title}</title>;
}
