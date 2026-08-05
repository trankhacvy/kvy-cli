import { SessionPreviewScreen } from "@/features/preview";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/dashboard/session/[id]/git/page.tsx`)
// — `generateStaticParams` just needs one concrete id to emit this route's
// HTML/JS shell; `demo` is an arbitrary placeholder. `SessionPreviewScreen`
// resolves the session's real `machineId` off the live `['sync']` snapshot
// at runtime, so navigating here (via the timeline header's "Preview" link)
// with any real id works the same way, reading `id` from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionPreviewScreen sessionId={id} />;
}
