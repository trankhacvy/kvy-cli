"use client";

import { useEffect } from "react";
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
 * a colored-dot favicon (falcon-prd.md FR-7.9: "cheap, high-value web
 * ergonomics"). Pure computation lives in `tab-attention.ts`; this hook is
 * just the DOM side-effect, restored on unmount so leaving the session
 * screen doesn't leave a stale badge behind.
 */
export function useTabAttention(title: string, attention: AttentionState, working: boolean): void {
  useEffect(() => {
    const originalTitle = document.title;
    document.title = computeTabTitle(title, attention, working);
    const restoreFavicon = applyFavicon(faviconDataUri(faviconColor(attention, working)));

    return () => {
      document.title = originalTitle;
      restoreFavicon();
    };
  }, [title, attention, working]);
}
