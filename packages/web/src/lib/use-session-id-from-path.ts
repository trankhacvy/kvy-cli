"use client";

import { useEffect, useState } from "react";

const SESSION_ID_PATTERN = /^\/dashboard\/session\/([^/]+)/;

function readSessionIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return window.location.pathname.match(SESSION_ID_PATTERN)?.[1] ?? null;
}

/**
 * The real session id from the browser's current URL — deliberately NOT `next/navigation`'s
 * `useParams()`. Under static export (`output: "export"`), only one concrete id
 * (`generateStaticParams`'s `demo` placeholder) is ever prerendered, and nginx/Vercel rewrite
 * every other id's request to that same shell (`deploy/web/default.conf.template`). Verified
 * empirically that `useParams()` still returns the build-time-baked `demo` in that shell —
 * it reflects Next's embedded router state, not `window.location` — so every real session
 * silently 404'd against `/v1/sessions/demo/...` regardless of which one was opened.
 * `window.location.pathname` is the only value guaranteed to reflect where the browser
 * actually is. Returns `null` on the server and for the one render before the initial
 * client effect runs (avoids a hydration mismatch against the server-rendered `demo` shell).
 */
export function useSessionIdFromPath(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(readSessionIdFromLocation());
  }, []);
  return id;
}
