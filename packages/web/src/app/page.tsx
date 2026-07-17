"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SessionListScreen } from "@/features/session-list";
import { isSignedIn } from "@/lib/session";

/**
 * The Home screen (design §9.2 "Home" row, falcon-prd.md FR-7.1). Renders
 * real, live session/machine data by default now — `SessionListScreen`'s
 * `useData` defaults to `useLiveSessionListSnapshot`
 * (`features/session-list/live-source.ts`), which reads the sync engine's
 * `['sync']` snapshot and decrypts each session/machine's title client-side.
 *
 * Auth-gated: mirrors `settings/notifications/page.tsx`'s plain
 * `isSignedIn()` check + `router.replace("/signin/")` (this screen doesn't
 * need the crypto bridge itself — only its live data source does, lazily,
 * once mounted). `checked` gates the render so an unauthenticated visitor
 * never sees even a flash of the (empty) session-list UI before being sent
 * to sign in.
 */
export default function Home() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!isSignedIn()) {
      router.replace("/signin/");
      return;
    }
    setChecked(true);
  }, [router]);

  if (!checked) return null;

  return <SessionListScreen />;
}
