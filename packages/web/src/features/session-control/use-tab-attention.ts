"use client";

import { useEffect, useId } from "react";
import { clearTitleOverride, setTitleOverride } from "@/lib/document-title-store";
import type { AttentionState } from "./attention";
import { computeTabTitle, faviconColor, faviconDataUri } from "./tab-attention";

/** Finds (or creates) the page's favicon `<link>`, points it at `href`, and
 * returns a restore function — this screen is the only place in the app
 * that touches the favicon today, so on unmount it puts things back exactly
 * as they were (removing the element if it created one) rather than leaving
 * a stale attention-colored dot on whatever the user navigates to next. */
function applyFavicon(href: string): () => void {
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  const existed = link !== null;
  const previousHref = link?.getAttribute("href") ?? null;
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.setAttribute("href", href);

  return () => {
    if (!link) return;
    if (existed && previousHref !== null) {
      link.setAttribute("href", previousHref);
    } else if (!existed) {
      link.remove();
    }
  };
}

/**
 * Reflects a session's attention state in the browser tab — title prefix +
 * a colored-dot favicon (kvy-prd.md FR-7.9: "cheap, high-value web
 * ergonomics"). Pure computation lives in `tab-attention.ts`.
 *
 * The favicon is a plain DOM side effect (this screen is the only place in
 * the app that touches it today, restored on unmount). The title *can't*
 * use the same trick: `app/layout.tsx` used to render a static `metadata`
 * `<title>Kvy</title>`, and a plain `document.title = ...` mutation from
 * a `useEffect` here got silently clobbered by the very next unrelated
 * React re-render anywhere in the tree — confirmed live, the manual
 * assignment never stuck. Rendering our *own* competing `<title>` element
 * doesn't fix it either: per the HTML spec `document.title` always reflects
 * the *first* `<title>` in tree order, so a second, deeper one can lose
 * even while genuinely present in the DOM. The real fix (see
 * `components/DocumentTitle.tsx`) was making that the app's *only*
 * `<title>` fiber, driven by an external store — this hook just pushes/pops
 * this screen's override into that store instead of touching the DOM.
 */
export function useTabAttention(title: string, attention: AttentionState, working: boolean): void {
  const id = useId();

  useEffect(() => {
    setTitleOverride(id, computeTabTitle(title, attention, working));
    return () => clearTitleOverride(id);
  }, [id, title, attention, working]);

  useEffect(() => {
    return applyFavicon(faviconDataUri(faviconColor(attention, working)));
  }, [attention, working]);
}
