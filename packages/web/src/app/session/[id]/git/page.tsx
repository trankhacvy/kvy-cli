import { RequireAuth } from "@/features/auth";
import { SessionGitScreen } from "@/features/git-diff";

// Static export (next.config.ts) prerenders every route at build time (same
// constraint as `/session/[id]/page.tsx`) — no server ever renders user
// content (design §5.3), and real session ids are only known at runtime
// (minted by `POST /v1/sessions`, not this build). `generateStaticParams`
// still needs at least one concrete id to emit this route's HTML/JS shell
// at all; `demo` is an arbitrary placeholder — `SessionGitScreen` now always
// resolves the session's real `machineId`/`workspaceId` off the live
// `['sync']` snapshot (`use-sync-snapshot.ts`) rather than the
// `mach-${id}`/`/workspace/${id}` placeholders this route used to fabricate,
// so navigating here (via the timeline header's "Files changed" link) with
// any real id works the same way, reading `id` from the URL at runtime.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionGitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireAuth>
      <SessionGitScreen sessionId={id} />
    </RequireAuth>
  );
}
