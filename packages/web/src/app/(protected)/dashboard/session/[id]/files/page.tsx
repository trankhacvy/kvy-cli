import { SessionFilesScreen } from "@/features/repo-files";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/dashboard/session/[id]/git/page.tsx`) — no server ever renders user
// content (design §5.3), and real session ids are only known at runtime
// (minted by `POST /v1/sessions`, not this build). `generateStaticParams`
// still needs at least one concrete id to emit this route's HTML/JS shell
// at all; `demo` is an arbitrary placeholder — `SessionFilesScreen` always
// resolves the session's real `machineId`/`workspaceId` off the live
// `['sync']` snapshot, so navigating here (via the timeline header's "Repo
// files" link) with any real id works the same way, reading `id` from the
// URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionFilesScreen sessionId={id} />;
}
