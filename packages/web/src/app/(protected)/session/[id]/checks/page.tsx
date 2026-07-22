import { SessionChecksScreen } from "@/features/github-checks";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/session/[id]/git/page.tsx`) — `generateStaticParams` just
// needs one concrete id to emit this route's HTML/JS shell; `demo` is an
// arbitrary placeholder. `SessionChecksScreen` resolves the session's real
// `machineId`/`workspaceId` off the live `['sync']` snapshot at runtime, so
// navigating here (via the timeline header's "Checks" link) with any real
// id works the same way, reading `id` from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionChecksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionChecksScreen sessionId={id} />;
}
