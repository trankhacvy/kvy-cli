import { SessionTimelineScreen } from "@/components/timeline/SessionTimelineScreen";
import { RequireAuth } from "@/features/auth";

// Static export (next.config.ts) prerenders every route at build time — no
// server ever renders user content (design §5.3), and real session ids are
// only known at runtime (minted by `POST /v1/sessions`, not this build).
// `generateStaticParams` still needs at least one concrete id to emit this
// route's HTML/JS shell at all; `demo` is an arbitrary placeholder — the
// screen itself now always renders live data (`SessionTimelineScreen`'s
// `useLiveRenderItems`/`useLiveSessionControl`), so navigating here (via the
// Home screen's client-side routing) with any real id works the same way,
// reading `id` from the URL at runtime rather than from this list.
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RequireAuth>
      <SessionTimelineScreen sessionId={id} />
    </RequireAuth>
  );
}
