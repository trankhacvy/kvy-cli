"use client";

import { MachinesSettingsScreen } from "@/features/machine-settings";

/**
 * Settings → Machines (docs/features/sleep-inhibit.md, docs/
 * competitive-notes-omnara.md #12 "Sleep-inhibit control"). Thin route
 * shell — all real behavior lives in `MachinesSettingsScreen`, matching
 * this app's "screen owns the logic, the route is a static-export-friendly
 * wrapper" precedent (`settings/providers/page.tsx`).
 */
export default function MachinesSettingsPage() {
  return <MachinesSettingsScreen />;
}
