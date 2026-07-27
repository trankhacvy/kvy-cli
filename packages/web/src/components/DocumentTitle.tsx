"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { getTitleOverrideSnapshot, subscribeToTitle } from "@/lib/document-title-store";
import { titleForPath } from "@/lib/page-title";

export function DocumentTitle() {
  const pathname = usePathname() ?? "/";
  const override = useSyncExternalStore(
    subscribeToTitle,
    getTitleOverrideSnapshot,
    getTitleOverrideSnapshot,
  );
  const title = override ?? titleForPath(pathname);
  return <title>{title}</title>;
}
