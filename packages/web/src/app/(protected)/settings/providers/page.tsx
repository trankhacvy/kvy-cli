"use client";

import { ProvidersSettingsScreen } from "@/features/provider-accounts";

/**
 * Settings → Providers (docs/competitive-notes-omnara.md #9 "Provider
 * account inspection + usage metering"). Thin route shell — all real
 * behavior lives in `ProvidersSettingsScreen`, matching this app's
 * "screen owns the logic, the route is a static-export-friendly wrapper"
 * precedent (`features/git-diff/components/SessionGitScreen.tsx`).
 */
export default function ProvidersSettingsPage() {
  return <ProvidersSettingsScreen />;
}
