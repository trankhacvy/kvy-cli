import { SessionRunScreen } from "@/features/run-panel";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/dashboard/session/[id]/git/page.tsx`) — `generateStaticParams` just
// needs one concrete id to emit this route's HTML/JS shell; `demo` is an
// arbitrary placeholder. `SessionRunScreen` resolves the session's real
// `machineId`/`workspaceId` off the live `['sync']` snapshot at runtime, so
// navigating here (via the timeline header's "Setup / Run" link) with any
// real id works the same way, reading `id` from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionRunScreen sessionId={id} />;
}
