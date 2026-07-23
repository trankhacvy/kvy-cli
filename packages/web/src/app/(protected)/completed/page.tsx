"use client";

import { CompletedSessionsScreen } from "@/features/session-list";

/**
 * The Completed Chats screen (docs/features/session-lifecycle-actions.md
 * Phase 5) — sessions marked done, with a Restore action back to Home.
 * Same composition pattern as `(protected)/page.tsx`: renders real, live
 * data by default; auth-gated by the `(protected)` route group's shared
 * `RequireAuth` boundary.
 */
export default function CompletedPage() {
  return <CompletedSessionsScreen />;
}
